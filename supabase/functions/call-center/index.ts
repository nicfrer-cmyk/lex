// מרכז שיחות — הצד שפונה אליו ה-CRM בדפדפן.
//
// ## חלוקת עבודה מכוונת
// קריאה של נתונים (שיחות, ציר זמן, תמלול) נעשית **ישירות מהדפדפן** דרך
// supabase-js, כי RLS כבר מגן עליהם ושכבת ביניים רק הייתה מוסיפה השהיה.
// עריכת הגדרות וסוכנים נעשית גם היא ישירות, דרך aiUpdateChecked, שמאמת
// שהשורה באמת נכתבה (מדיניות RLS מסננת שורות ולא זורקת שגיאה — עדכון
// שנחסם חוזר כהצלחה עם אפס שורות).
//
// מה שכן עובר כאן הוא מה שחייב service_role, מפתחות שרת, או החלטה
// שאסור שתתקבל בדפדפן:
//   • סימולציה — יוצרת שיחות ומריצה את הסוכן.
//   • מוכנות לייצור והמתג של שיחות אמיתיות.
//   • בקשות חזרה — עוברות דרך שכבת הפקודות, כמו כל כתיבה של AI.
//   • בדיקות — מריצות את הנתיב האמיתי ומדווחות מה קרה.
//
// Deploy: supabase functions deploy call-center

import { admin, resolveCaller } from '../_shared/db.ts';
import { json, preflight, errorResponse, AppError } from '../_shared/http.ts';
import { audit } from '../_shared/audit.ts';
import {
  startCall, handleUtterance, endCall, postProcessCall, getVoiceLlm,
} from '../_shared/voice/orchestrator.ts';
import { listToolsForAgent } from '../_shared/voice/gateway.ts';
import { checkRateLimit } from '../_shared/voice/signing.ts';
import { normalizePhoneNumber } from '../_shared/voice/phone.ts';
import { VoiceError } from '../_shared/voice/errors.ts';
import {
  evaluateVoiceProductionReadiness, canEnableLiveCalls,
  type ReadinessInput, type ProviderSnapshot,
} from '../_shared/voice/readiness.ts';
import {
  applyOfficeCommand, supabaseCommandStore, buildIdempotencyKey, payloadFingerprint,
} from '../_shared/voice/commands.ts';

const env = (k: string) => Deno.env.get(k) || '';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const sb = admin();
  try {
    const caller = await resolveCaller(req, sb);
    const body = await req.json().catch(() => {
      throw new AppError('bad_json', 'גוף הבקשה אינו JSON תקין', 400);
    });
    const action = String(body.action || '');

    switch (action) {
      case 'status':             return await onStatus(sb, caller.officeId);
      case 'readiness':          return await onReadiness(sb, caller.officeId);
      case 'metrics':            return await onMetrics(sb, caller.officeId, body);
      case 'tools.catalog':      return await onToolsCatalog(sb, caller.officeId, body);
      case 'settings.sync':      return await onSettingsSync(sb, caller, req);
      case 'live_calls.set':     return await onLiveCallsSet(sb, caller, body, req);
      case 'simulate.start':     return await onSimStart(sb, caller, body, req);
      case 'simulate.say':       return await onSimSay(sb, caller, body);
      case 'simulate.end':       return await onSimEnd(sb, caller, body);
      case 'call.postprocess':   return await onPostProcess(sb, caller.officeId, body);
      case 'callback.update':    return await onCallbackUpdate(sb, caller, body, req);
      case 'deadletter.resolve': return await onDeadLetterResolve(sb, caller, body, req);
      case 'test.crm':           return await onTestCrm(sb, caller.officeId);
      case 'test.gateway':       return await onTestGateway(sb, caller.officeId);
      case 'test.tools':         return await onTestTools(sb, caller.officeId);
      case 'test.simulation':    return await onTestSimulation(sb, caller, req);
      case 'test.stt':           return await onTestProvider(sb, caller.officeId, 'stt');
      case 'test.llm':           return await onTestLlm(sb, caller.officeId, body);
      case 'test.tts':           return await onTestProvider(sb, caller.officeId, 'tts');
      case 'test.pipeline':      return await onTestPipeline(sb, caller, req);
      default:
        throw new AppError('unknown_action', `פעולה לא מוכרת: ${action || '(ריק)'}`, 400);
    }
  } catch (e) {
    if (e instanceof VoiceError) {
      return json({ error: e.message, ...e.toUserPayload() }, e.httpStatus);
    }
    return errorResponse(e);
  }
});

type Caller = Awaited<ReturnType<typeof resolveCaller>>;

// ============================================================
// איסוף תמונת המצב
// ============================================================

/**
 * כל מה שדרוש כדי לשפוט מוכנות, בשאילתה אחת מרוכזת.
 *
 * ⚠ מה שנמדד כאן הוא **המצב המדווח**, לא ההגדרה. ספק שהוגדר בסוכן אך
 * שרת הקול מריץ במקומו Mock — ייספר כ-Mock. הגדרה אומרת מה רצינו;
 * ה-heartbeat אומר מה באמת רץ.
 */
async function collectSnapshot(sb: ReturnType<typeof admin>, officeId: string) {
  const [settingsRes, lineRes, gwRes, agentRes, stateRes, toolsRes, dlRes] = await Promise.all([
    sb.from('call_center_settings').select('*').eq('office_id', officeId).maybeSingle(),
    sb.from('phone_lines').select('*').eq('office_id', officeId).order('created_at'),
    sb.from('voice_gateway_status').select('*').eq('office_id', officeId).maybeSingle(),
    sb.from('voice_agents').select('*').eq('office_id', officeId),
    sb.rpc('voice_gateway_state', { p_office_id: officeId }),
    sb.from('agent_tools').select('tool_name, enabled, available').eq('office_id', officeId),
    sb.from('voice_dead_letters').select('id', { count: 'exact', head: true })
      .eq('office_id', officeId).neq('status', 'resolved'),
  ]);

  const settings = settingsRes.data || {};
  const gw = gwRes.data || {};
  const agents = agentRes.data || [];
  const activeAgent = agents.find((a: Record<string, unknown>) => a.is_active);
  const llm = await getVoiceLlm(sb, officeId, null);

  // ⚠ מנוע השפה רץ **בצד ה-CRM** במצב ברירת המחדל, ולכן מצבו נקבע כאן
  // ולא ממה ששרת הקול מדווח. דיווח משם היה מתאר ספק שאינו בשימוש.
  const providers: Record<string, ProviderSnapshot> = {
    ...((gw.providers || {}) as Record<string, ProviderSnapshot>),
    llm: {
      name: llm.name,
      mode: llm.isMock ? 'mock' : 'live',
      healthy: true,
      production_ready: !llm.isMock,
      supports_hebrew: true,
      message: llm.isMock ? 'מצב הדגמה — לא הוגדר מפתח מנוע שפה' : undefined,
    },
  };

  return {
    settings,
    lines: lineRes.data || [],
    line: (lineRes.data || [])[0] || null,
    gateway: gw,
    gatewayState: (stateRes.data as string) || 'never_connected',
    agents,
    activeAgent,
    providers,
    toolsEnabled: (toolsRes.data || []).filter(
      (t: Record<string, unknown>) => t.enabled && t.available).length,
    deadLetters: dlRes.count || 0,
  };
}

function readinessInputFrom(snap: Awaited<ReturnType<typeof collectSnapshot>>): ReadinessInput {
  return {
    gatewayState: snap.gatewayState,
    gatewaySecretConfigured: Boolean(env('VOICE_GATEWAY_SECRET')),
    components: (snap.gateway.components || {}) as Record<string, unknown>,
    providers: snap.providers,
    transport: snap.gateway.transport || snap.settings.media_transport || null,
    outboxPending: Number(snap.gateway.outbox_pending || 0),
    deadLetters: snap.deadLetters,
    phoneLine: snap.line,
    toolsEnabled: snap.toolsEnabled,
    agentActive: Boolean(snap.activeAgent),
    crmReachable: true,   // הקוד הזה רץ בתוך ה-CRM; אם הוא ענה, הוא זמין
    liveCallsEnabled: Boolean(snap.settings.live_calls_enabled),
    emergencyStop: Boolean(snap.settings.emergency_stop),
  };
}

// ============================================================
// מצב מערכת
// ============================================================

/**
 * ⚠ אף שדה כאן אינו מחזיר ערך של סוד — רק "מוגדר / לא מוגדר". מסך מצב
 * שמדפיס מפתח הוא דליפה, וכל מי שפותח אותו רואה אותה.
 */
async function onStatus(sb: ReturnType<typeof admin>, officeId: string) {
  const snap = await collectSnapshot(sb, officeId);
  const readiness = evaluateVoiceProductionReadiness(readinessInputFrom(snap));
  const s = snap.settings;
  const components = (snap.gateway.components || {}) as Record<string, unknown>;

  return json({
    ok: true,
    phone: s.public_office_phone || null,
    lines: snap.lines,
    agents: snap.agents.map((a: Record<string, unknown>) => ({
      id: a.id, name: a.name, slug: a.slug, is_active: a.is_active,
      llm_provider: a.llm_provider, llm_model: a.llm_model,
      voice_provider: a.voice_provider, stt_provider: a.stt_provider,
    })),
    settings: {
      human_transfer_number: s.human_transfer_number || null,
      recording_enabled: Boolean(s.recording_enabled),
      transcript_enabled: s.transcript_enabled !== false,
      ai_enabled: s.ai_enabled !== false,
      emergency_stop: Boolean(s.emergency_stop),
      simulation_enabled: s.simulation_enabled !== false,
      live_calls_enabled: Boolean(s.live_calls_enabled),
      live_calls_enabled_at: s.live_calls_enabled_at || null,
      transcript_retention_days: s.transcript_retention_days ?? 0,
      recording_retention_days: s.recording_retention_days ?? 0,
      call_metadata_retention_days: s.call_metadata_retention_days ?? 0,
      max_call_duration_seconds: s.max_call_duration_seconds ?? 600,
      silence_timeout_ms: s.silence_timeout_ms ?? 8000,
      barge_in_enabled: s.barge_in_enabled !== false,
      callback_sla_hours: s.callback_sla_hours ?? 0,
      identity_policy: s.identity_policy || 'strict',
      media_transport: s.media_transport || 'audiosocket',
    },
    providers: snap.providers,
    readiness,
    components: {
      crm_api: { state: 'connected', detail: 'Supabase Edge Function' },
      supabase: { state: 'connected', detail: 'RLS פעיל' },
      voice_gateway: {
        state: snap.gatewayState,
        detail: snap.gateway.last_heartbeat_at
          ? `heartbeat אחרון: ${snap.gateway.last_heartbeat_at}`
          : 'טרם התקבל heartbeat',
        version: snap.gateway.version || null,
        active_calls: snap.gateway.active_calls ?? 0,
        outbox_pending: snap.gateway.outbox_pending ?? 0,
        outbox_dead_letter: snap.gateway.outbox_dead_letter ?? 0,
        transport: snap.gateway.transport || null,
        last_error: snap.gateway.last_error || null,
      },
      asterisk: { state: String(components.asterisk || 'not_configured'),
        detail: 'נדרשת התקנת שרת הקול' },
      sip: { state: String(snap.line?.sip_status || components.sip || 'not_configured'),
        detail: 'נדרשים פרטי ספק SIP' },
      stt: providerComponent(snap.providers.stt, 'תמלול'),
      llm: providerComponent(snap.providers.llm, 'מנוע שפה'),
      tts: providerComponent(snap.providers.tts, 'הקראה'),
    },
    dead_letters: snap.deadLetters,
    server_config: {
      voice_gateway_secret: Boolean(env('VOICE_GATEWAY_SECRET')),
      voice_gateway_url: env('VOICE_GATEWAY_URL') || null,
      anthropic_key: Boolean(env('ANTHROPIC_API_KEY')),
      human_transfer_env: Boolean(env('HUMAN_TRANSFER_NUMBER')),
      recording_env: env('CALL_RECORDING_ENABLED') || 'false',
      public_office_phone_env: env('PUBLIC_OFFICE_PHONE') || null,
    },
  });
}

/** ⚠ mock מדווח כ-mock ולא כ-connected — ראה readiness.ts. */
function providerComponent(p: ProviderSnapshot | undefined, label: string) {
  if (!p) return { state: 'not_configured', detail: `${label} — לא דווח` };
  if (p.production_ready && p.healthy !== false) {
    return { state: 'live', detail: `${p.name || label} פעיל` };
  }
  if (p.healthy === false) {
    return { state: 'error', detail: p.message || `${p.name || label} אינו מגיב` };
  }
  return { state: 'mock', detail: p.message || `${p.name || label} במצב הדגמה` };
}

async function onReadiness(sb: ReturnType<typeof admin>, officeId: string) {
  const snap = await collectSnapshot(sb, officeId);
  const readiness = evaluateVoiceProductionReadiness(readinessInputFrom(snap));
  return json({ ok: true, ...readiness, live_calls_enabled: Boolean(snap.settings.live_calls_enabled) });
}

async function onMetrics(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const days = Math.min(90, Math.max(1, Number(body.days) || 7));
  const { data, error } = await sb.rpc('voice_latency_stats',
    { p_office_id: officeId, p_days: days });
  if (error) throw new AppError('db_error', error.message, 500);
  return json({ ok: true, days, ...(data || {}) });
}

async function onToolsCatalog(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const tools = await listToolsForAgent(sb, officeId, body.agent_id ? String(body.agent_id) : null);
  return json({ ok: true, tools });
}

// ============================================================
// שיחות אמיתיות — המתג
// ============================================================

/**
 * ⚠ שני שערים, ושניהם נדרשים.
 *
 * הראשון: המערכת חייבת לעבור בדיקת מוכנות. הפעלה על מערכת עם TTS
 * במצב הדגמה פירושה שהמתקשר הראשון לא ישמע דבר.
 * השני: ההפעלה היא של בעל המשרד בלבד. גם מערכת מוכנה לחלוטין לא
 * מדליקה את עצמה — קבלת שיחות בשם המשרד היא החלטה, לא תוצאה.
 */
async function onLiveCallsSet(
  sb: ReturnType<typeof admin>, caller: Caller, body: Record<string, unknown>, req: Request,
) {
  if (caller.role !== 'owner') {
    throw new AppError('forbidden', 'הפעלת שיחות אמיתיות מותרת לבעל המשרד בלבד', 403);
  }
  const enable = body.enabled === true;

  if (enable) {
    const snap = await collectSnapshot(sb, caller.officeId);
    const readiness = evaluateVoiceProductionReadiness(readinessInputFrom(snap));
    const verdict = canEnableLiveCalls(readiness);
    if (!verdict.allowed) {
      return json({
        ok: false, code: 'NOT_PRODUCTION_READY',
        error: verdict.reason,
        blocking_reasons: readiness.blocking_reasons,
      }, 409);
    }
  }

  const { data: before } = await sb.from('call_center_settings')
    .select('live_calls_enabled').eq('office_id', caller.officeId).maybeSingle();

  const { error } = await sb.from('call_center_settings').update({
    live_calls_enabled: enable,
    live_calls_enabled_at: enable ? new Date().toISOString() : null,
    live_calls_enabled_by: enable ? caller.userId : null,
  }).eq('office_id', caller.officeId);
  if (error) throw new AppError('db_error', error.message, 500);

  await audit(sb, {
    officeId: caller.officeId, actorType: 'user', userId: caller.userId,
    action: enable ? 'voice_live_calls_enabled' : 'voice_live_calls_disabled',
    entityType: 'call_center_settings', entityId: caller.officeId,
    severity: 'security',
    before: { live_calls_enabled: before?.live_calls_enabled ?? false },
    after: { live_calls_enabled: enable },
    req,
  });

  return json({ ok: true, live_calls_enabled: enable });
}

async function onSettingsSync(sb: ReturnType<typeof admin>, caller: Caller, req: Request) {
  if (caller.role !== 'owner') {
    throw new AppError('forbidden', 'סנכרון הגדרות מותר לבעל המשרד בלבד', 403);
  }
  const changed = await syncToolAvailability(sb, caller.officeId);
  await audit(sb, {
    officeId: caller.officeId, actorType: 'user', userId: caller.userId,
    action: 'voice_settings_synced', after: { changed }, req,
  });
  return json({ ok: true, changed });
}

/**
 * מסנכרן זמינות כלים מול ההגדרות בפועל.
 *
 * ⚠ הליבה כאן היא transfer_call. הוא זמין **רק** כשהוגדר מספר העברה
 * שאינו המספר הציבורי. אם הם זהים, ההעברה הייתה מחזירה את השיחה למקום
 * שממנו היא הופנתה — לולאת ניתוב. הבדיקה בקוד ולא בהנחיה, כי הגדרה
 * שגויה במסך לא יכולה להיות מרחק של קליק מלולאה.
 *
 * (החלטת המוצר היא שאין העברה חיה כלל, ולכן בפועל השדה נשאר ריק
 * וה-transfer נשאר כבוי — אבל השער נשאר במקומו ולא הוסר.)
 */
async function syncToolAvailability(
  sb: ReturnType<typeof admin>, officeId: string,
): Promise<string[]> {
  const { data: settings } = await sb.from('call_center_settings')
    .select('human_transfer_number, public_office_phone').eq('office_id', officeId).maybeSingle();

  const transfer = normalizePhoneNumber(settings?.human_transfer_number).normalized ||
    String(settings?.human_transfer_number || '').trim();
  const publicNum = normalizePhoneNumber(settings?.public_office_phone).normalized ||
    String(settings?.public_office_phone || '').trim();

  const sameAsPublic = Boolean(transfer && publicNum && transfer === publicNum);
  const available = Boolean(transfer) && !sameAsPublic;
  const reason = !transfer
    ? 'לא הוגדר מספר העברה לנציג. במקום העברה נוצרת בקשת חזרה.'
    : sameAsPublic
      ? 'מספר ההעברה זהה למספר הציבורי — העברה אליו הייתה יוצרת לולאת ניתוב.'
      : null;

  const { data } = await sb.from('agent_tools')
    .update({ available, unavailable_reason: reason })
    .eq('office_id', officeId).eq('tool_name', 'transfer_call')
    .select('id');

  return data?.length ? ['transfer_call'] : [];
}

// ============================================================
// בקשות חזרה
// ============================================================

/**
 * עדכון סטטוס בקשת חזרה מהמסך.
 *
 * ⚠ עובר דרך שכבת הפקודות ולא דרך saveDB בדפדפן, למרות שהמשימה חיה
 * ב-blob. הסיבה: בקשת חזרה עשויה להתעדכן גם ע"י הסוכן (שיחה חוזרת
 * מאותו מספר) וגם ע"י אדם באותו רגע. שני נתיבי כתיבה שונים לאותו שדה
 * הם בדיוק המקום שבו "סימנתי שחזרתי" נמחק בשקט.
 */
async function onCallbackUpdate(
  sb: ReturnType<typeof admin>, caller: Caller, body: Record<string, unknown>, req: Request,
) {
  const taskId = String(body.task_id || '');
  const status = String(body.status || '');
  if (!taskId) throw new AppError('missing_task', 'חסר מזהה משימה', 400);

  const payload = {
    task_id: taskId,
    status,
    preferred_time: body.preferred_time,
    note: body.note,
  };

  const { saveOfficeDb } = await import('../_shared/db.ts');
  const result = await applyOfficeCommand({
    commandId: crypto.randomUUID(),
    callId: body.call_id ? String(body.call_id) : null,
    toolCallId: null,
    agentId: null,
    idempotencyKey: buildIdempotencyKey({
      callId: null, type: 'update_callback',
      // חותמת זמן במפתח: עדכון סטטוס הוא פעולה חוזרת ומכוונת ("לא ענה"
      // פעמיים ביום הם שני ניסיונות אמיתיים), ולכן אסור שהשני ייחסם
      // כפילות של הראשון.
      fingerprint: payloadFingerprint(payload) + ':' + Date.now(),
    }),
    type: 'update_callback',
    payload,
    actor: { type: 'user', id: caller.userId },
  }, {
    store: supabaseCommandStore(sb, caller.officeId),
    write: (mutate) => saveOfficeDb(sb, caller.officeId, mutate),
  });

  await audit(sb, {
    officeId: caller.officeId, actorType: 'user', userId: caller.userId,
    action: 'callback_status_changed', entityType: 'task', entityId: taskId,
    after: { status }, req,
  });

  // צורה מפורשת ולא spread: `result` מכיל בעצמו `ok`, ופיזור אחרי שדה
  // מפורש דורס אותו בשקט. שדה שנראה מוגדר ובעצם נדרס הוא בדיוק סוג
  // הקוד שנשבר בשינוי הבא.
  return json({
    ok: result.ok,
    replayed: result.replayed,
    message: result.message,
    entity_type: result.entityType ?? null,
    entity_id: result.entityId ?? null,
    data: result.data ?? null,
  });
}

// ============================================================
// פעולות שלא סונכרנו
// ============================================================

async function onDeadLetterResolve(
  sb: ReturnType<typeof admin>, caller: Caller, body: Record<string, unknown>, req: Request,
) {
  if (caller.role !== 'owner') {
    throw new AppError('forbidden', 'טיפול בפעולות שלא סונכרנו מותר לבעל המשרד בלבד', 403);
  }
  const id = String(body.id || '');
  if (!id) throw new AppError('missing_id', 'חסר מזהה', 400);

  const { error } = await sb.from('voice_dead_letters').update({
    status: 'resolved',
    resolved_by: caller.userId,
    resolved_at: new Date().toISOString(),
    resolution_note: String(body.note || '').slice(0, 500),
  }).eq('id', id).eq('office_id', caller.officeId);
  if (error) throw new AppError('db_error', error.message, 500);

  await audit(sb, {
    officeId: caller.officeId, actorType: 'user', userId: caller.userId,
    action: 'voice_dead_letter_resolved', entityType: 'voice_dead_letter', entityId: id, req,
  });
  return json({ ok: true });
}

// ============================================================
// סימולציה
// ============================================================
//
// ⚠ הסימולציה **אינה** ארגז חול. היא מריצה את אותו orchestrator, אותה
// שכבת פקודות ואותה כתיבה — ולכן ליד, משימה ופגישה שנוצרים בה אמיתיים
// ומופיעים ב-CRM. זו כל הנקודה: המפרט דורש לראות "משימה שנוצרה במערכת
// הקיימת". השיחה מסומנת is_simulation=true כדי שאפשר יהיה לסנן אותה.

async function onSimStart(
  sb: ReturnType<typeof admin>, caller: Caller, body: Record<string, unknown>, req: Request,
) {
  const { data: settings } = await sb.from('call_center_settings')
    .select('simulation_enabled, emergency_stop').eq('office_id', caller.officeId).maybeSingle();
  if (settings?.simulation_enabled === false) {
    throw new AppError('simulation_disabled', 'מצב הבדיקה מושבת בהגדרות', 403);
  }

  const phoneRaw = String(body.caller_phone || '').trim();
  if (!phoneRaw) throw new AppError('missing_phone', 'יש להזין מספר מתקשר', 400);
  const info = normalizePhoneNumber(phoneRaw);
  const phone = info.normalized || phoneRaw;

  const rl = await checkRateLimit(sb, caller.officeId, 'sim:' + caller.userId, 30);
  if (!rl.allowed) {
    throw new AppError('rate_limited',
      'בוצעו יותר מדי שיחות בדיקה בשעה האחרונה. נסה שוב מאוחר יותר.', 429);
  }

  const externalCallId = 'sim-' + crypto.randomUUID();
  const result = await startCall(sb, caller.officeId, {
    externalCallId, callerPhone: phone,
    direction: 'inbound', isSimulation: true,
    agentId: body.agent_id ? String(body.agent_id) : null,
  });

  await audit(sb, {
    officeId: caller.officeId, actorType: 'user', userId: caller.userId,
    action: 'call_simulation_started', entityType: 'call', entityId: result.session.id,
    after: { phone }, req,
  });

  let firstTurn = null;
  if (body.message && String(body.message).trim()) {
    firstTurn = await handleUtterance(
      sb, caller.officeId, result.session.id, String(body.message).trim());
  }

  return json({
    ok: true,
    call_id: result.session.id,
    external_call_id: externalCallId,
    greeting: result.greeting,
    provider_mode: result.providerMode,
    phone_valid: info.valid,
    phone_warning: info.valid ? null : info.reason,
    agent: result.agent ? { id: result.agent.id, name: result.agent.name } : null,
    turn: firstTurn,
  });
}

async function onSimSay(
  sb: ReturnType<typeof admin>, caller: Caller, body: Record<string, unknown>,
) {
  const callId = String(body.call_id || '');
  const text = String(body.text || '').trim();
  if (!callId) throw new AppError('missing_call_id', 'חסר מזהה שיחה', 400);
  if (!text) throw new AppError('empty_text', 'הטקסט ריק', 400);

  await assertSimulation(sb, caller.officeId, callId);
  const turn = await handleUtterance(sb, caller.officeId, callId, text);
  return json({ ok: true, ...turn });
}

async function onSimEnd(
  sb: ReturnType<typeof admin>, caller: Caller, body: Record<string, unknown>,
) {
  const callId = String(body.call_id || '');
  if (!callId) throw new AppError('missing_call_id', 'חסר מזהה שיחה', 400);
  await assertSimulation(sb, caller.officeId, callId);

  const result = await endCall(sb, caller.officeId, callId, { status: 'completed' });
  // במסך הבדיקה מריצים את העיבוד מיד — המשתמש ממתין לתוצאה ורוצה
  // לראות את הסיכום המלא, בניגוד לשיחה אמיתית שבה הניתוק קודם.
  const post = await postProcessCall(sb, caller.officeId, callId);

  return json({
    ok: true,
    summary: post.summary || result.summary,
    outcome: result.outcome,
    post_processed: post.processed,
  });
}

async function onPostProcess(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const callId = String(body.call_id || '');
  if (!callId) throw new AppError('missing_call_id', 'חסר מזהה שיחה', 400);
  const r = await postProcessCall(sb, officeId, callId);
  return json({ ok: true, ...r });
}

/**
 * ⚠ השער שמונע מהדפדפן לנהוג בשיחה אמיתית.
 *
 * בלעדיו, משתמש היה יכול לשלוח simulate.say עם מזהה של שיחה חיה ולשים
 * מילים בפי המתקשר — ומהן ייווצרו משימות ופגישות אמיתיות. הבדיקה כאן
 * ולא ב-UI, כי ה-UI אינו גבול אבטחה.
 */
async function assertSimulation(
  sb: ReturnType<typeof admin>, officeId: string, callId: string,
): Promise<void> {
  const { data } = await sb.from('call_sessions')
    .select('is_simulation').eq('id', callId).eq('office_id', officeId).maybeSingle();
  if (!data) throw new AppError('not_found', 'השיחה לא נמצאה', 404);
  if (!data.is_simulation) {
    throw new AppError('not_simulation', 'לא ניתן להזין טקסט לשיחה אמיתית ממסך הבדיקה', 403);
  }
}

// ============================================================
// בדיקות
// ============================================================
//
// כל בדיקה מריצה את הנתיב האמיתי ומדווחת מה קרה. כפתור בדיקה שמחזיר
// "תקין" בלי לגעת בכלום גרוע מהיעדרו — הוא יוצר אמון שגוי בדיוק במקום
// שבו צריך לדעת את האמת.

async function onTestCrm(sb: ReturnType<typeof admin>, officeId: string) {
  const t0 = Date.now();
  try {
    const { loadOfficeDb } = await import('../_shared/db.ts');
    const db = await loadOfficeDb(sb, officeId);
    return json({
      ok: true, ms: Date.now() - t0,
      detail: `נטענו ${db.clients.length} לקוחות, ${db.cases.length} תיקים, ${db.tasks.length} משימות.`,
    });
  } catch (e) {
    return json({ ok: false, ms: Date.now() - t0,
      detail: e instanceof Error ? e.message : String(e) });
  }
}

async function onTestGateway(sb: ReturnType<typeof admin>, officeId: string) {
  const { data: gw } = await sb.from('voice_gateway_status')
    .select('last_heartbeat_at, version, last_error, outbox_pending')
    .eq('office_id', officeId).maybeSingle();
  const { data: state } = await sb.rpc('voice_gateway_state', { p_office_id: officeId });

  if (!env('VOICE_GATEWAY_SECRET')) {
    return json({ ok: false, state: 'not_configured', code: 'SIP_NOT_CONFIGURED',
      detail: 'VOICE_GATEWAY_SECRET לא הוגדר בשרת. שרת הקול לא יוכל להתחבר.' });
  }
  if (!gw?.last_heartbeat_at) {
    return json({ ok: false, state: 'never_connected', code: 'VOICE_GATEWAY_OFFLINE',
      detail: 'טרם התקבל heartbeat משרת הקול. זהו המצב הצפוי כל עוד שרת הקול לא הותקן.' });
  }
  const seconds = Math.round((Date.now() - Date.parse(gw.last_heartbeat_at)) / 1000);
  return json({
    ok: state === 'online', state: state || 'offline',
    detail: `heartbeat אחרון לפני ${seconds} שניות${gw.version ? ` · גרסה ${gw.version}` : ''}` +
      (Number(gw.outbox_pending) > 0 ? ` · ${gw.outbox_pending} פעולות ממתינות` : '') +
      (gw.last_error ? ` · שגיאה אחרונה: ${gw.last_error}` : ''),
  });
}

async function onTestTools(sb: ReturnType<typeof admin>, officeId: string) {
  const externalCallId = 'selftest-' + crypto.randomUUID();
  try {
    const started = await startCall(sb, officeId, {
      externalCallId, callerPhone: '+972500000000',
      direction: 'inbound', isSimulation: true,
    });
    const { runStandaloneTool } = await import('../_shared/voice/gateway.ts');
    const outcome = await runStandaloneTool(sb, officeId, started.session.id,
      'lookup_client', { phone: '+972500000000' },
      { toolCallId: 'selftest-' + Date.now() });

    const tools = await listToolsForAgent(sb, officeId, started.session.agent_id);
    const enabled = tools.filter((t) => t.enabled && t.available).length;

    await endCall(sb, officeId, started.session.id,
      { status: 'completed', outcome: 'information_only' });

    return json({
      ok: outcome.status === 'success',
      detail: `שער הכלים הגיב. ${enabled} כלים זמינים מתוך ${tools.length}. ` +
        `תשובת lookup_client: ${outcome.result.message}`,
      tools_enabled: enabled, tools_total: tools.length,
    });
  } catch (e) {
    return json({ ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * בדיקת ספק בודד (STT/TTS).
 *
 * ⚠ ספק Mock מחזיר `ok:false` עם הקוד NOT_PRODUCTION_READY — **לא**
 * הצלחה. זו הדרישה המרכזית: בדיקה שמדווחת הצלחה על מנוע שמחזיר שקט
 * היא בדיוק מה שגורם לאדם לחבר מספר אמיתי ולגלות את הבעיה מהלקוח.
 */
async function onTestProvider(
  sb: ReturnType<typeof admin>, officeId: string, kind: 'stt' | 'tts',
) {
  const snap = await collectSnapshot(sb, officeId);
  const p = snap.providers[kind];
  const label = kind === 'stt' ? 'מנוע התמלול' : 'מנוע ההקראה';

  if (!p) {
    return json({ ok: false, code: kind === 'stt' ? 'STT_UNAVAILABLE' : 'TTS_UNAVAILABLE',
      detail: `${label} לא דווח ע"י שרת הקול. יש לוודא ששרת הקול רץ.` });
  }
  if (p.healthy === false) {
    return json({ ok: false, code: kind === 'stt' ? 'STT_UNAVAILABLE' : 'TTS_UNAVAILABLE',
      detail: p.message || `${label} אינו מגיב.` });
  }
  if (!p.production_ready) {
    return json({
      ok: false, code: 'NOT_PRODUCTION_READY',
      provider: p,
      detail: `${label} (${p.name || 'mock'}) פעיל אך במצב הדגמה — אינו מתאים לשיחות אמיתיות.`,
    });
  }
  return json({ ok: true, provider: p,
    detail: `${label} (${p.name}) פעיל ומוכן` +
      (p.average_latency_ms ? ` · ${p.average_latency_ms}ms` : '') });
}

/** בדיקת מנוע השפה — שולחת טקסט אמיתי דרך אותו adapter של שיחה. */
async function onTestLlm(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const t0 = Date.now();
  try {
    const llm = await getVoiceLlm(sb, officeId, null);
    const text = String(body.text || 'שלום, אני רוצה לקבוע פגישה.');
    const resp = await llm.turn({
      systemPrompt: 'את מזכירה דיגיטלית של משרד עורכי דין. השיבי במשפט אחד.',
      history: [{ role: 'caller', text }],
      tools: [], model: 'claude-haiku-4-5-20251001', temperature: 0.3,
      callerPhone: null,
    });
    const ms = Date.now() - t0;

    if (llm.isMock) {
      return json({
        ok: false, code: 'NOT_PRODUCTION_READY', ms, reply: resp.text,
        detail: `מנוע השפה ענה תוך ${ms}ms אך הוא במצב הדגמה — אינו מתאים לשיחות אמיתיות.`,
      });
    }
    return json({ ok: true, ms, reply: resp.text,
      detail: `מנוע השפה (${llm.name}) ענה תוך ${ms}ms.` });
  } catch (e) {
    return json({ ok: false, code: 'LLM_UNAVAILABLE', ms: Date.now() - t0,
      detail: e instanceof Error ? e.message : String(e) });
  }
}

async function onTestSimulation(
  sb: ReturnType<typeof admin>, caller: Caller, req: Request,
) {
  const externalCallId = 'selftest-sim-' + crypto.randomUUID();
  try {
    const started = await startCall(sb, caller.officeId, {
      externalCallId, callerPhone: '+972500000000',
      direction: 'inbound', isSimulation: true,
    });
    const turn = await handleUtterance(sb, caller.officeId, started.session.id,
      'שלום, יש לי עיקול בחשבון ואני רוצה שעורך הדין יחזור אליי היום.');
    const ended = await endCall(sb, caller.officeId, started.session.id, { status: 'completed' });
    const post = await postProcessCall(sb, caller.officeId, started.session.id);

    await audit(sb, {
      officeId: caller.officeId, actorType: 'user', userId: caller.userId,
      action: 'call_center_selftest', entityType: 'call', entityId: started.session.id, req,
    });

    return json({
      ok: true,
      call_id: started.session.id,
      provider_mode: turn.providerMode,
      urgency: turn.urgency,
      category: turn.category,
      actions: turn.actions,
      summary: post.summary || ended.summary,
      outcome: ended.outcome,
      detail: `השיחה רצה מקצה לקצה. סווגה כ"${turn.category}" בדחיפות ${turn.urgency}, ` +
        `בוצעו ${turn.actions.filter((a) => a.status === 'success').length} פעולות.`,
    });
  } catch (e) {
    return json({ ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * הצינור המלא: STT → LLM → כלי → TTS.
 *
 * ⚠ נכשל כ-NOT_PRODUCTION_READY כשאחד הספקים במצב הדגמה, גם אם כל
 * השלבים "עברו". זו בדיוק הדרישה: בדיקת צינור שמדווחת הצלחה על מערכת
 * אילמת היא הדבר שיגרום לחבר מספר אמיתי בביטחון מוטעה.
 */
async function onTestPipeline(
  sb: ReturnType<typeof admin>, caller: Caller, req: Request,
) {
  const stages: Array<{ stage: string; ok: boolean; detail: string; ms?: number }> = [];
  const snap = await collectSnapshot(sb, caller.officeId);

  // ---- STT ----
  const stt = snap.providers.stt;
  stages.push({
    stage: 'STT',
    ok: Boolean(stt?.production_ready),
    detail: !stt ? 'לא דווח ספק תמלול'
      : stt.production_ready ? `${stt.name} פעיל`
      : `${stt.name || 'mock'} במצב הדגמה`,
  });

  // ---- LLM + כלי (הצינור האמיתי) ----
  let callId: string | null = null;
  try {
    const t0 = Date.now();
    const started = await startCall(sb, caller.officeId, {
      externalCallId: 'pipeline-' + crypto.randomUUID(),
      callerPhone: '+972500000000', direction: 'inbound', isSimulation: true,
    });
    callId = started.session.id;
    const turn = await handleUtterance(sb, caller.officeId, callId,
      'שלום, קוראים לי בדיקה. קיבלתי עיקול ואני רוצה שעורך הדין יחזור אליי.');

    stages.push({
      stage: 'LLM', ok: turn.providerMode === 'live', ms: Date.now() - t0,
      detail: turn.providerMode === 'live'
        ? 'מנוע השפה ענה' : 'מנוע השפה במצב הדגמה',
    });
    stages.push({
      stage: 'כלים',
      ok: turn.actions.some((a) => a.status === 'success'),
      detail: turn.actions.length
        ? turn.actions.map((a) => `${a.tool}: ${a.status}`).join(', ')
        : 'לא בוצעו פעולות',
    });

    await endCall(sb, caller.officeId, callId, { status: 'completed' });
    await postProcessCall(sb, caller.officeId, callId);
  } catch (e) {
    stages.push({ stage: 'LLM', ok: false,
      detail: e instanceof Error ? e.message : String(e) });
  }

  // ---- TTS ----
  const tts = snap.providers.tts;
  stages.push({
    stage: 'TTS',
    ok: Boolean(tts?.production_ready),
    detail: !tts ? 'לא דווח מנוע הקראה'
      : tts.production_ready ? `${tts.name} פעיל`
      : `${tts.name || 'mock'} במצב הדגמה — המתקשר לא ישמע דבר`,
  });

  const allOk = stages.every((st) => st.ok);
  await audit(sb, {
    officeId: caller.officeId, actorType: 'user', userId: caller.userId,
    action: 'voice_pipeline_test', after: { ok: allOk }, req,
  });

  return json({
    ok: allOk,
    code: allOk ? null : 'NOT_PRODUCTION_READY',
    stages,
    call_id: callId,
    detail: allOk
      ? 'הצינור המלא עבר בהצלחה — המערכת מוכנה לשיחות אמיתיות.'
      : 'הצינור לא עבר במלואו. השלבים שנכשלו מסומנים למטה; כל עוד הם קיימים, ' +
        'שיחה אמיתית לא תישמע כראוי.',
  });
}
