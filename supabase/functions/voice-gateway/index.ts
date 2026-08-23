// AI Tool Gateway + מחזור חיי שיחה — הצד שפונה אליו שרת הקול.
//
// ## מה זה
// זו **השכבה היחידה** שדרכה משהו שרץ מחוץ ל-CRM נוגע בנתונים בשם שיחה.
// אין נתיב אחר: שרת הקול לא מקבל service_role key, לא מתחבר ל-Postgres,
// ולא יכול לשלוח SQL. הוא שולח בקשה חתומה עם שם פעולה, וכל השאר קורה כאן.
//
// ## אימות
// HMAC-SHA256 על `${timestamp}.${nonce}.${body}` (ראה _shared/voice/signing.ts),
// חלון של 5 דקות, ו-nonce חד-פעמי נגד שידור חוזר. בלי VOICE_GATEWAY_SECRET
// כל בקשה נדחית ב-503 — endpoint טלפוניה פומבי בלי אימות הוא דרך לכל אחד
// להזריק "שיחות" ולידים מזויפים למשרד עורכי דין.
//
// ## פעולות
//   call.start        — שיחה נכנסת (אידמפוטנטי לפי external_call_id)
//   call.utterance    — המתקשר אמר משהו → תור של הסוכן
//   call.segment      — קטע תמלול בלבד, בלי תור (שידור חי)
//   call.status       — עדכון מצב (on_hold / transferring / missed)
//   call.end          — סיום, סיכום, תוצאה
//   tools.list        — הכלים המותרים לסוכן (לשרת שמריץ מודל משלו)
//   tool.execute      — הפעלת כלי בודד
//   heartbeat         — "אני חי" כל 30 שניות
//
// Deploy: supabase functions deploy voice-gateway --no-verify-jwt
//   (--no-verify-jwt חובה: לשרת הקול אין משתמש מחובר. האימות הוא ה-HMAC.)

import { admin } from '../_shared/db.ts';
import { json, preflight, errorResponse, AppError } from '../_shared/http.ts';
import { audit } from '../_shared/audit.ts';
import {
  readSignatureHeaders, verifySignature, consumeNonce, pruneNonces, checkRateLimit,
} from '../_shared/voice/signing.ts';
import {
  startCall, handleUtterance, endCall, addSegment, logEvent,
  postProcessCall, setVoiceState, type VoiceState,
} from '../_shared/voice/orchestrator.ts';
import { runStandaloneTool, listToolsForAgent } from '../_shared/voice/gateway.ts';
import { VoiceError } from '../_shared/voice/errors.ts';

const VOICE_SECRET = Deno.env.get('VOICE_GATEWAY_SECRET') || '';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!VOICE_SECRET) {
    // 503 ולא 401: זו תקלת הגדרה בצד שלנו, וההבחנה חשובה למי שמנסה
    // להבין למה שרת הקול לא מצליח להתחבר.
    return json({
      error: 'VOICE_GATEWAY_SECRET לא הוגדר בשרת. מרכז השיחות אינו מקבל בקשות מבחוץ.',
      code: 'gateway_not_configured',
    }, 503);
  }

  const sb = admin();
  const rawBody = await req.text();
  const headers = readSignatureHeaders(req);

  if (!headers.officeId) {
    return json({ error: 'חסרה כותרת X-Voice-Office', code: 'missing_office' }, 400);
  }

  // ---- חתימה ----
  const verdict = await verifySignature(
    VOICE_SECRET, headers, rawBody, Math.floor(Date.now() / 1000));
  if (!verdict.ok) {
    await audit(sb, {
      officeId: headers.officeId, actorType: 'webhook',
      action: 'voice_gateway_' + verdict.code, severity: 'security', req,
    });
    return json({ error: verdict.message, code: verdict.code }, 401);
  }

  // ---- Replay ----
  let fresh: boolean;
  try {
    fresh = await consumeNonce(sb, headers.officeId, headers.nonce);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e), code: 'nonce_error' }, 503);
  }
  if (!fresh) {
    await audit(sb, {
      officeId: headers.officeId, actorType: 'webhook',
      action: 'voice_gateway_replay', severity: 'security', req,
    });
    return json({ error: 'הבקשה כבר עובדה', code: 'replay' }, 409);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return json({ error: 'גוף הבקשה אינו JSON תקין', code: 'bad_json' }, 400);
  }

  const officeId = headers.officeId;
  const action = String(body.action || '');

  try {
    switch (action) {
      case 'call.start':      return await onCallStart(sb, officeId, body, req);
      case 'call.utterance':  return await onUtterance(sb, officeId, body);
      case 'call.segment':    return await onSegment(sb, officeId, body);
      case 'call.status':     return await onStatus(sb, officeId, body);
      case 'call.end':        return await onEnd(sb, officeId, body);
      case 'call.event':      return await onCallEvent(sb, officeId, body);
      case 'call.postprocess': return await onPostProcess(sb, officeId, body);
      case 'tools.list':      return await onToolsList(sb, officeId, body);
      case 'tool.execute':    return await onToolExecute(sb, officeId, body);
      case 'heartbeat':       return await onHeartbeat(sb, officeId, body);
      case 'deadletter.report': return await onDeadLetterReport(sb, officeId, body);
      default:
        throw new AppError('unknown_action', `פעולה לא מוכרת: ${action || '(ריק)'}`, 400);
    }
  } catch (e) {
    // VoiceError נושא retryable, וזה מה ששרת הקול קורא כדי להחליט אם
    // להכניס את הבקשה לתור המקומי. שגיאה גנרית הייתה מאלצת אותו לנחש —
    // ולנחש כאן פירושו או לאבד פנייה, או לנסות לנצח בקשה שלא תצליח.
    if (e instanceof VoiceError) {
      return json(e.toPayload(), e.httpStatus);
    }
    return errorResponse(e);
  }
});

// ============================================================

async function onCallStart(
  sb: ReturnType<typeof admin>, officeId: string,
  body: Record<string, unknown>, req: Request,
) {
  const externalCallId = String(body.call_id || '').trim();
  const callerPhone = String(body.from || '').trim();
  if (!externalCallId) throw new AppError('missing_call_id', 'חסר מזהה שיחה', 400);
  if (!callerPhone) throw new AppError('missing_from', 'חסר מספר מתקשר', 400);

  // ---- מגבלת קצב ----
  // ⚠ הבדיקה היא לפני יצירת השיחה ולא אחריה: שיחה שנוצרה כבר יצרה ליד
  // ומשימה, ואין טעם להגביל אחרי שהנזק נעשה.
  const { data: settings } = await sb.from('call_center_settings')
    .select('max_calls_per_hour_per_number, emergency_stop, live_calls_enabled')
    .eq('office_id', officeId).maybeSingle();

  if (settings?.emergency_stop) {
    throw new VoiceError('EMERGENCY_STOP', 'emergency stop is on');
  }

  // המפסק הראשי. גם כשה-SIP מחובר ו-Asterisk עונה, שיחה אמיתית לא
  // מטופלת עד שאדם מורשה הדליק את המתג במסך. תשתית שהתחברה אינה
  // החלטה לענות ללקוחות בשם המשרד.
  //
  // שיחת סימולציה אינה עוברת כאן כלל — היא נכנסת דרך call-center עם JWT.
  if (!settings?.live_calls_enabled) {
    await audit(sb, {
      officeId, actorType: 'webhook', action: 'voice_call_rejected_live_disabled',
      severity: 'warning', after: { from: callerPhone }, req,
    });
    throw new VoiceError('LIVE_CALLS_DISABLED',
      'live_calls_enabled=false - the call was not answered by the agent');
  }

  const limit = Number(settings?.max_calls_per_hour_per_number ?? 12);
  const rl = await checkRateLimit(sb, officeId, 'call:' + callerPhone, limit);
  if (!rl.allowed) {
    await audit(sb, {
      officeId, actorType: 'webhook', action: 'voice_rate_limited',
      severity: 'warning', after: { phone: callerPhone, count: rl.count }, req,
    });
    throw new VoiceError('RATE_LIMITED',
      `${rl.count} calls from ${callerPhone} in the current hour (limit ${limit})`);
  }

  const result = await startCall(sb, officeId, {
    externalCallId,
    callerPhone,
    calledPhone: body.to ? String(body.to) : undefined,
    direction: body.direction === 'outbound' ? 'outbound' : 'inbound',
    isSimulation: false,
  });

  return json({
    ok: true,
    call_id: result.session.id,
    created: result.created,
    greeting: result.greeting,
    agent: result.agent ? { id: result.agent.id, name: result.agent.name } : null,
    provider_mode: result.providerMode,
    client_id: result.session.client_id,
  });
}

async function onUtterance(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const callId = String(body.call_id || '');
  const text = String(body.text || '').trim();
  if (!callId) throw new AppError('missing_call_id', 'חסר מזהה שיחה', 400);
  if (!text) throw new AppError('empty_text', 'הטקסט ריק', 400);

  // המדדים ש-STT ו-TTS מייצרים נמדדים בשרת הקול; ה-CRM לא יכול לתזמן
  // אותם ואין טעם שינחש. הם מגיעים כאן ומצטרפים למה שנמדד בצד הזה.
  const m = (body.metrics || {}) as Record<string, unknown>;
  const result = await handleUtterance(sb, officeId, callId, text, {
    confidence: body.confidence != null ? Number(body.confidence) : undefined,
    metrics: {
      turnIndex: m.turn_index != null ? Number(m.turn_index) : undefined,
      sttLatencyMs: m.stt_latency_ms != null ? Number(m.stt_latency_ms) : undefined,
      ttsFirstAudioMs: m.tts_first_audio_ms != null ? Number(m.tts_first_audio_ms) : undefined,
      ttsTotalMs: m.tts_total_ms != null ? Number(m.tts_total_ms) : undefined,
      interrupted: m.interrupted === true,
    },
  });
  return json({ ok: true, ...result });
}

async function onSegment(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const callId = String(body.call_id || '');
  if (!callId) throw new AppError('missing_call_id', 'חסר מזהה שיחה', 400);
  const speaker = ['caller', 'agent', 'human', 'system'].includes(String(body.speaker))
    ? String(body.speaker) as 'caller' | 'agent' | 'human' | 'system'
    : 'caller';

  const sequence = await addSegment(sb, officeId, callId, speaker, String(body.text || ''), {
    sequence: body.sequence != null ? Number(body.sequence) : undefined,
    startedAtMs: body.started_at_ms != null ? Number(body.started_at_ms) : undefined,
    endedAtMs: body.ended_at_ms != null ? Number(body.ended_at_ms) : undefined,
    confidence: body.confidence != null ? Number(body.confidence) : undefined,
  });
  return json({ ok: true, sequence });
}

async function onStatus(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const callId = String(body.call_id || '');
  const status = String(body.status || '');
  const allowed = ['ringing', 'answering', 'active', 'on_hold', 'transferring', 'missed', 'failed'];
  if (!callId) throw new AppError('missing_call_id', 'חסר מזהה שיחה', 400);
  if (!allowed.includes(status)) throw new AppError('bad_status', `סטטוס לא מוכר: ${status}`, 400);

  const { data, error } = await sb.from('call_sessions')
    .update({ status }).eq('id', callId).eq('office_id', officeId).select('id');
  if (error) throw new AppError('db_error', error.message, 500);
  if (!data?.length) throw new AppError('not_found', 'השיחה לא נמצאה', 404);

  await logEvent(sb, officeId, callId, 'CALL_STATUS_CHANGED', { status });
  return json({ ok: true });
}

async function onEnd(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const callId = String(body.call_id || '');
  if (!callId) throw new AppError('missing_call_id', 'חסר מזהה שיחה', 400);
  const status = ['completed', 'failed', 'missed'].includes(String(body.status))
    ? String(body.status) as 'completed' | 'failed' | 'missed' : 'completed';

  const result = await endCall(sb, officeId, callId, {
    status,
    outcome: body.outcome ? String(body.outcome) : undefined,
    durationSeconds: body.duration_seconds != null ? Number(body.duration_seconds) : undefined,
  });
  // מוחזר מיד. הסיכום המלא רץ אחרי הניתוק (call.postprocess), כי
  // המתנה לסיכום לפני ניתוק משאירה את המתקשר בקו מול שקט.
  return json({
    ok: true, summary: result.summary, outcome: result.outcome,
    duration_seconds: result.session.duration_seconds,
    post_call_queued: result.postCallQueued,
  });
}

async function onToolsList(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const tools = await listToolsForAgent(sb, officeId, body.agent_id ? String(body.agent_id) : null);
  return json({ ok: true, tools });
}

async function onToolExecute(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const callId = String(body.call_id || '');
  const toolName = String(body.tool || '');
  if (!callId) throw new AppError('missing_call_id', 'חסר מזהה שיחה', 400);
  if (!toolName) throw new AppError('missing_tool', 'חסר שם כלי', 400);

  const outcome = await runStandaloneTool(sb, officeId, callId, toolName,
    (body.input || {}) as Record<string, unknown>, {
      toolCallId: body.tool_call_id ? String(body.tool_call_id) : null,
      schemaVersion: body.schema_version ? String(body.schema_version) : '1',
    });

  // צורת תשובה מפורשת ולא spread: `outcome.result` מכיל בעצמו `ok`, ופיזור
  // אחרי שדה מפורש דורס אותו בשקט. כאן הערכים במקרה זהים, אבל שדה שנראה
  // מוגדר ובעצם נדרס הוא בדיוק סוג הקוד שנשבר בשינוי הבא. בנוסף, שמות
  // snake_case תואמים לשאר ה-API שהצד השני צורך.
  return json({
    ok: outcome.result.ok,
    status: outcome.status,
    message: outcome.result.message,
    data: outcome.result.data ?? null,
    entity_type: outcome.result.entityType ?? null,
    entity_id: outcome.result.entityId ?? null,
  });
}

/**
 * אירועי מכונת המצבים והמדידה משרת הקול.
 *
 * STT ו-TTS קורים שם, ולכן רק שם אפשר למדוד אותם. בלי הנתיב הזה, ציר
 * הזמן היה מראה "המודל התחיל" ו"המודל סיים" בלי מה שקרה סביבם — וכשמישהו
 * שואל למה השיחה נשמעה איטית, התשובה הייתה חסרה בדיוק במקום שבו היא
 * בדרך כלל נמצאת.
 */
async function onCallEvent(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const callId = String(body.call_id || '');
  const eventType = String(body.event || '').toUpperCase();
  if (!callId) throw new AppError('missing_call_id', 'חסר מזהה שיחה', 400);
  if (!eventType) throw new AppError('missing_event', 'חסר סוג אירוע', 400);

  // רשימה סגורה: ציר הזמן נקרא ע"י אדם, וסוגי אירוע חופשיים משרת חיצוני
  // היו הופכים אותו לזרם טקסט שאי אפשר לסנן או לתרגם.
  const KNOWN = new Set([
    'LISTENING_STARTED', 'USER_SPEECH_STARTED', 'USER_SPEECH_ENDED',
    'STT_STARTED', 'STT_COMPLETED', 'LLM_STARTED', 'LLM_FIRST_TOKEN',
    'TOOL_STARTED', 'TOOL_COMPLETED', 'TTS_STARTED', 'TTS_FIRST_AUDIO',
    'TTS_COMPLETED', 'BARGE_IN', 'SILENCE_TIMEOUT', 'AUDIO_LOST',
  ]);
  if (!KNOWN.has(eventType)) {
    throw new AppError('unknown_event', `סוג אירוע לא מוכר: ${eventType}`, 400);
  }

  await logEvent(sb, officeId, callId, eventType,
    (body.payload || {}) as Record<string, unknown>);

  if (body.state) {
    await setVoiceState(sb, officeId, callId, String(body.state) as VoiceState);
  }

  // הפרעה ושתיקה נספרות על השיחה — הן מדדי איכות, לא רק אירועים.
  if (eventType === 'BARGE_IN' || eventType === 'SILENCE_TIMEOUT') {
    const col = eventType === 'BARGE_IN' ? 'interruptions_count' : 'silence_events';
    const { data: cur } = await sb.from('call_sessions')
      .select(col).eq('id', callId).maybeSingle();
    await sb.from('call_sessions')
      .update({ [col]: (Number((cur as Record<string, unknown>)?.[col]) || 0) + 1 })
      .eq('id', callId);
  }

  return json({ ok: true });
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
 * פעולה שמיצתה את כל הניסיונות בשרת הקול.
 *
 * נשמרת ב-CRM ולא רק בקובץ על השרת. פעולה שנכשלה סופית היא פנייה של
 * לקוח שלא נרשמה, והמפרט אוסר לאבד אותה בשקט. מהרגע שהיא כאן, היא
 * מופיעה במסך ומישהו יכול לטפל בה.
 */
async function onDeadLetterReport(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const outboxId = String(body.outbox_id || '');
  if (!outboxId) throw new AppError('missing_outbox_id', 'חסר מזהה פעולה', 400);

  const { error } = await sb.from('voice_dead_letters').upsert({
    office_id: officeId,
    outbox_id: outboxId,
    call_external_id: body.call_external_id ? String(body.call_external_id) : null,
    call_id: body.call_id ? String(body.call_id) : null,
    tool_call_id: body.tool_call_id ? String(body.tool_call_id) : null,
    idempotency_key: body.idempotency_key ? String(body.idempotency_key) : null,
    endpoint: body.endpoint ? String(body.endpoint) : null,
    action: body.action_name ? String(body.action_name) : null,
    payload: (body.payload || {}) as Record<string, unknown>,
    attempt_count: Number(body.attempt_count) || 0,
    last_error: body.last_error ? String(body.last_error).slice(0, 1000) : null,
    error_code: body.error_code ? String(body.error_code) : null,
    status: 'dead_letter',
  }, { onConflict: 'office_id,outbox_id' });
  if (error) throw new AppError('db_error', error.message, 500);

  await audit(sb, {
    officeId, actorType: 'system', action: 'voice_dead_letter_recorded',
    entityType: 'voice_dead_letter', entityId: outboxId,
    severity: 'warning',
    after: { action: body.action_name, attempts: body.attempt_count },
  });

  return json({ ok: true });
}

async function onHeartbeat(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const { error } = await sb.from('voice_gateway_status').upsert({
    office_id: officeId,
    last_heartbeat_at: new Date().toISOString(),
    version: body.version ? String(body.version) : null,
    components: (body.components || {}) as Record<string, unknown>,
    // כאן מגיע ההבדל בין healthy לבין production_ready. ספק Mock מדווח
    // healthy=true ו-production_ready=false, ומנוע המוכנות חוסם לפי
    // השני. דיווח שמשמיט את ההבחנה היה מציג ירוק על מערכת אילמת.
    providers: (body.providers || {}) as Record<string, unknown>,
    transport: body.transport ? String(body.transport) : null,
    active_calls: Number(body.active_calls) || 0,
    queued_events: Number(body.queued_events) || 0,
    outbox_pending: Number(body.outbox_pending) || 0,
    outbox_dead_letter: Number(body.outbox_dead_letter) || 0,
    live_calls_accepted: body.live_calls_accepted === true,
    last_error: body.last_error ? String(body.last_error).slice(0, 500) : null,
  }, { onConflict: 'office_id' });
  if (error) throw new AppError('db_error', error.message, 500);

  // שרת הקול צריך לדעת אם מותר לו לענות. אין טעם שיענה לשיחה ואז יגלה
  // שהיא נדחית — המתקשר כבר שמע צלצול.
  const { data: settings } = await sb.from('call_center_settings')
    .select('live_calls_enabled, emergency_stop, max_call_duration_seconds, ' +
            'silence_timeout_ms, barge_in_enabled, recording_enabled')
    .eq('office_id', officeId).maybeSingle();

  // ניקוי nonces ישנים כאן ולא ב-cron נפרד: שרת פעיל מנקה אחרי עצמו,
  // ושרת שאינו פעיל לא מייצר nonces חדשים.
  await pruneNonces(sb);

  return json({
    ok: true,
    server_time: new Date().toISOString(),
    // תצורה שהשרת אמור לאכוף מצידו. מקור אמת אחד — ההגדרות ב-CRM.
    config: {
      live_calls_enabled: Boolean(settings?.live_calls_enabled),
      emergency_stop: Boolean(settings?.emergency_stop),
      max_call_duration_seconds: settings?.max_call_duration_seconds ?? 600,
      silence_timeout_ms: settings?.silence_timeout_ms ?? 8000,
      barge_in_enabled: settings?.barge_in_enabled !== false,
      recording_enabled: Boolean(settings?.recording_enabled),
    },
  });
}
