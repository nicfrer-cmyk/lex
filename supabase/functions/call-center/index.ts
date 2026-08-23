// מרכז שיחות — הצד שפונה אליו ה-CRM בדפדפן.
//
// ## חלוקת עבודה מכוונת
// קריאה של נתונים (שיחות, ציר זמן, תמלול) נעשית **ישירות מהדפדפן** דרך
// supabase-js, כי RLS כבר מגן עליהם ושכבת ביניים רק הייתה מוסיפה השהיה.
// עריכת הגדרות וסוכנים נעשית גם היא ישירות, דרך aiUpdateChecked, שמאמת
// שהשורה באמת נכתבה (מדיניות RLS מסננת שורות ולא זורקת שגיאה — עדכון
// שנחסם חוזר כהצלחה עם אפס שורות).
//
// מה שכן עובר כאן הוא מה שחייב service_role או מפתחות שרת:
//   • סימולציה — יוצרת שיחות ומריצה את הסוכן. הדפדפן לא כותב ל-call_*.
//   • מצב מערכת — קורא סודות שרת כדי לומר מה מוגדר ומה לא.
//   • בדיקות — מריצות את הנתיב האמיתי ומדווחות מה קרה.
//
// Deploy: supabase functions deploy call-center

import { admin, resolveCaller } from '../_shared/db.ts';
import { json, preflight, errorResponse, AppError } from '../_shared/http.ts';
import { audit } from '../_shared/audit.ts';
import { startCall, handleUtterance, endCall, getVoiceLlm } from '../_shared/voice/orchestrator.ts';
import { listToolsForAgent } from '../_shared/voice/gateway.ts';
import { checkRateLimit } from '../_shared/voice/signing.ts';
import { normalizePhone } from '../_shared/security.ts';

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
      case 'status':          return await onStatus(sb, caller.officeId);
      case 'tools.catalog':   return await onToolsCatalog(sb, caller.officeId, body);
      case 'settings.sync':   return await onSettingsSync(sb, caller);
      case 'simulate.start':  return await onSimStart(sb, caller, body, req);
      case 'simulate.say':    return await onSimSay(sb, caller, body);
      case 'simulate.end':    return await onSimEnd(sb, caller, body);
      case 'test.crm':        return await onTestCrm(sb, caller.officeId);
      case 'test.gateway':    return await onTestGateway(sb, caller.officeId);
      case 'test.tools':      return await onTestTools(sb, caller.officeId);
      case 'test.simulation': return await onTestSimulation(sb, caller, req);
      default:
        throw new AppError('unknown_action', `פעולה לא מוכרת: ${action || '(ריק)'}`, 400);
    }
  } catch (e) {
    return errorResponse(e);
  }
});

type Caller = Awaited<ReturnType<typeof resolveCaller>>;

// ============================================================
// מצב מערכת
// ============================================================

/**
 * ⚠ אף שדה כאן אינו מחזיר ערך של סוד — רק "מוגדר / לא מוגדר". מסך מצב
 * שמדפיס מפתח הוא דליפה, וכל מי שפותח אותו רואה אותו.
 */
async function onStatus(sb: ReturnType<typeof admin>, officeId: string) {
  const [settingsRes, lineRes, gwRes, agentRes, stateRes] = await Promise.all([
    sb.from('call_center_settings').select('*').eq('office_id', officeId).maybeSingle(),
    sb.from('phone_lines').select('*').eq('office_id', officeId).order('created_at'),
    sb.from('voice_gateway_status').select('*').eq('office_id', officeId).maybeSingle(),
    sb.from('voice_agents').select('id,name,slug,is_active,llm_provider,llm_model,voice_provider,stt_provider')
      .eq('office_id', officeId),
    sb.rpc('voice_gateway_state', { p_office_id: officeId }),
  ]);

  const settings = settingsRes.data || {};
  const gw = gwRes.data || {};
  const gatewayState = (stateRes.data as string) || 'never_connected';

  // מצב ספק ה-AI נקבע באותה פונקציה שמשמשת שיחה אמיתית — לא בהערכה
  // נפרדת, שהייתה יכולה לומר "live" בזמן ששיחה רצה ב-mock.
  const agents = agentRes.data || [];
  const llm = await getVoiceLlm(sb, officeId, null);

  const components = (gw.components || {}) as Record<string, unknown>;

  return json({
    ok: true,
    phone: settings.public_office_phone || null,
    lines: lineRes.data || [],
    agents,
    settings: {
      human_transfer_number: settings.human_transfer_number || null,
      recording_enabled: Boolean(settings.recording_enabled),
      ai_enabled: settings.ai_enabled !== false,
      emergency_stop: Boolean(settings.emergency_stop),
      simulation_enabled: settings.simulation_enabled !== false,
      transcript_retention_days: settings.transcript_retention_days ?? 0,
      recording_retention_days: settings.recording_retention_days ?? 0,
      call_metadata_retention_days: settings.call_metadata_retention_days ?? 0,
    },
    components: {
      crm_api: { state: 'connected', detail: 'Supabase Edge Function' },
      supabase: { state: 'connected', detail: 'RLS פעיל' },
      voice_gateway: {
        state: gatewayState,
        detail: gw.last_heartbeat_at
          ? `heartbeat אחרון: ${gw.last_heartbeat_at}`
          : 'טרם התקבל heartbeat',
        version: gw.version || null,
        active_calls: gw.active_calls ?? 0,
        queued_events: gw.queued_events ?? 0,
        last_error: gw.last_error || null,
      },
      asterisk: {
        state: String(components.asterisk || 'not_configured'),
        detail: 'נדרשת התקנת שרת הקול',
      },
      sip: {
        state: String(components.sip || 'not_configured'),
        detail: 'נדרשים פרטי ספק SIP',
      },
      stt: { state: String(components.stt || 'mock'), detail: 'תמלול' },
      llm: { state: llm.isMock ? 'mock' : 'live', detail: llm.name },
      tts: { state: String(components.tts || 'mock'), detail: 'הקראה' },
    },
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

async function onToolsCatalog(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const tools = await listToolsForAgent(sb, officeId, body.agent_id ? String(body.agent_id) : null);
  return json({ ok: true, tools });
}

/**
 * מסנכרן זמינות כלים מול ההגדרות בפועל.
 *
 * ⚠ הליבה כאן היא transfer_call. הוא זמין **רק** כשהוגדר מספר העברה
 * שאינו המספר הציבורי. אם הם זהים, ההעברה הייתה מחזירה את השיחה למקום
 * שממנו היא הופנתה — לולאת ניתוב. הבדיקה בקוד ולא בהנחיה, כי הגדרה
 * שגויה במסך לא יכולה להיות מרחק של קליק מלולאה.
 */
async function onSettingsSync(sb: ReturnType<typeof admin>, caller: Caller) {
  if (caller.role !== 'owner') {
    throw new AppError('forbidden', 'סנכרון הגדרות מותר לבעל המשרד בלבד', 403);
  }
  const changed = await syncToolAvailability(sb, caller.officeId);
  return json({ ok: true, changed });
}

async function syncToolAvailability(
  sb: ReturnType<typeof admin>, officeId: string,
): Promise<string[]> {
  const { data: settings } = await sb.from('call_center_settings')
    .select('human_transfer_number, public_office_phone').eq('office_id', officeId).maybeSingle();

  const transfer = normalizePhone(String(settings?.human_transfer_number || '')) ||
    String(settings?.human_transfer_number || '').trim();
  const publicNum = normalizePhone(String(settings?.public_office_phone || '')) ||
    String(settings?.public_office_phone || '').trim();

  const sameAsPublic = Boolean(transfer && publicNum && transfer === publicNum);
  const available = Boolean(transfer) && !sameAsPublic;
  const reason = !transfer
    ? 'לא הוגדר מספר העברה לנציג. במקום העברה נוצרת משימת חזרה.'
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
// סימולציה
// ============================================================
//
// ⚠ הסימולציה **אינה** ארגז חול. היא מריצה את אותו orchestrator, אותו
// Tool Gateway ואותה כתיבה — ולכן ליד, משימה ופגישה שנוצרים בה הם
// אמיתיים ומופיעים ב-CRM. זו כל הנקודה: המפרט דורש לראות "משימה שנוצרה
// במערכת הקיימת". השיחה מסומנת is_simulation=true כדי שאפשר יהיה לסנן
// אותה מדוחות, והמסך אומר את זה במפורש לפני ההרצה.

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
  const phone = normalizePhone(phoneRaw) || phoneRaw;

  // גם לסימולציה יש מגבלת קצב: היא כותבת ל-CRM, ולולאה בטעות במסך
  // יכולה לייצר מאות לידים.
  const rl = await checkRateLimit(sb, caller.officeId, 'sim:' + caller.userId, 30);
  if (!rl.allowed) {
    throw new AppError('rate_limited', 'בוצעו יותר מדי שיחות בדיקה בשעה האחרונה. נסה שוב מאוחר יותר.', 429);
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

  // הודעה ראשונה אופציונלית — כך "התחל שיחת סימולציה" עם טקסט מוכן
  // מריץ את כל הזרימה בלחיצה אחת.
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
  return json({ ok: true, summary: result.summary, outcome: result.outcome });
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
// "תקין" בלי לגעת בכלום הוא גרוע מהיעדרו — הוא יוצר אמון שגוי בדיוק
// במקום שבו צריך לדעת את האמת.

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
    return json({ ok: false, ms: Date.now() - t0, detail: e instanceof Error ? e.message : String(e) });
  }
}

async function onTestGateway(sb: ReturnType<typeof admin>, officeId: string) {
  const { data: gw } = await sb.from('voice_gateway_status')
    .select('last_heartbeat_at, version, last_error').eq('office_id', officeId).maybeSingle();
  const { data: state } = await sb.rpc('voice_gateway_state', { p_office_id: officeId });

  if (!env('VOICE_GATEWAY_SECRET')) {
    return json({
      ok: false, state: 'not_configured',
      detail: 'VOICE_GATEWAY_SECRET לא הוגדר בשרת. שרת הקול לא יוכל להתחבר.',
    });
  }
  if (!gw?.last_heartbeat_at) {
    return json({
      ok: false, state: 'never_connected',
      detail: 'טרם התקבל heartbeat משרת הקול. זהו המצב הצפוי כל עוד שרת הקול לא הותקן.',
    });
  }
  const seconds = Math.round((Date.now() - Date.parse(gw.last_heartbeat_at)) / 1000);
  return json({
    ok: state === 'online', state: state || 'offline',
    detail: `heartbeat אחרון לפני ${seconds} שניות${gw.version ? ` · גרסה ${gw.version}` : ''}` +
      (gw.last_error ? ` · שגיאה אחרונה: ${gw.last_error}` : ''),
  });
}

/**
 * בודק את שער הכלים מקצה לקצה בלי לגעת בנתונים: מריץ את lookup_client,
 * שהוא קורא-בלבד, על שיחת בדיקה זמנית שנסגרת מיד.
 */
async function onTestTools(sb: ReturnType<typeof admin>, officeId: string) {
  const externalCallId = 'selftest-' + crypto.randomUUID();
  try {
    const started = await startCall(sb, officeId, {
      externalCallId, callerPhone: '+972500000000',
      direction: 'inbound', isSimulation: true,
    });
    const { runStandaloneTool } = await import('../_shared/voice/gateway.ts');
    const outcome = await runStandaloneTool(sb, officeId, started.session.id,
      'lookup_client', { phone: '+972500000000' });

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
 * בדיקה מלאה: פותחת שיחת סימולציה, אומרת משפט אחד, מסיימת — ומדווחת
 * אילו פעולות בוצעו בפועל. זו הבדיקה שמוכיחה שהמערכת עובדת מקצה לקצה
 * בלי טלפוניה.
 */
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
      summary: ended.summary,
      outcome: ended.outcome,
      detail: `השיחה רצה מקצה לקצה. סווגה כ"${turn.category}" בדחיפות ${turn.urgency}, ` +
        `בוצעו ${turn.actions.filter((a) => a.status === 'success').length} פעולות.`,
    });
  } catch (e) {
    return json({ ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
