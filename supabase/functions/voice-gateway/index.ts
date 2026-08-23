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
} from '../_shared/voice/orchestrator.ts';
import { runStandaloneTool, listToolsForAgent } from '../_shared/voice/gateway.ts';

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
      case 'tools.list':      return await onToolsList(sb, officeId, body);
      case 'tool.execute':    return await onToolExecute(sb, officeId, body);
      case 'heartbeat':       return await onHeartbeat(sb, officeId, body);
      default:
        throw new AppError('unknown_action', `פעולה לא מוכרת: ${action || '(ריק)'}`, 400);
    }
  } catch (e) {
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
    .select('max_calls_per_hour_per_number, emergency_stop')
    .eq('office_id', officeId).maybeSingle();

  if (settings?.emergency_stop) {
    return json({ error: 'מרכז השיחות מושבת (עצירת חירום)', code: 'emergency_stop' }, 423);
  }

  const limit = Number(settings?.max_calls_per_hour_per_number ?? 12);
  const rl = await checkRateLimit(sb, officeId, 'call:' + callerPhone, limit);
  if (!rl.allowed) {
    await audit(sb, {
      officeId, actorType: 'webhook', action: 'voice_rate_limited',
      severity: 'warning', after: { phone: callerPhone, count: rl.count }, req,
    });
    return json({ error: 'חריגה ממגבלת השיחות מהמספר הזה', code: 'rate_limited' }, 429);
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

  const result = await handleUtterance(sb, officeId, callId, text, {
    confidence: body.confidence != null ? Number(body.confidence) : undefined,
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
  return json({
    ok: true, summary: result.summary, outcome: result.outcome,
    duration_seconds: result.session.duration_seconds,
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
    (body.input || {}) as Record<string, unknown>);

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

async function onHeartbeat(
  sb: ReturnType<typeof admin>, officeId: string, body: Record<string, unknown>,
) {
  const { error } = await sb.from('voice_gateway_status').upsert({
    office_id: officeId,
    last_heartbeat_at: new Date().toISOString(),
    version: body.version ? String(body.version) : null,
    components: (body.components || {}) as Record<string, unknown>,
    active_calls: Number(body.active_calls) || 0,
    queued_events: Number(body.queued_events) || 0,
    last_error: body.last_error ? String(body.last_error).slice(0, 500) : null,
  }, { onConflict: 'office_id' });
  if (error) throw new AppError('db_error', error.message, 500);

  // ניקוי nonces ישנים כאן ולא ב-cron נפרד: שרת פעיל מנקה אחרי עצמו,
  // ושרת שאינו פעיל לא מייצר nonces חדשים.
  await pruneNonces(sb);

  return json({ ok: true, server_time: new Date().toISOString() });
}
