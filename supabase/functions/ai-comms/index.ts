// שליחת הודעות שאושרו + מצב האינטגרציות.
//
// ## למה השליחה כאן ולא בדפדפן
// "אין לבצע פעולה חיצונית לפני שהאישור נשמר בשרת" (סעיף 4.5). הפונקציה
// הזו קוראת את שורת האישור **מהשרת** ומוודאת שהיא במצב approved לפני
// שהיא שולחת משהו. הדפדפן לא יכול "להגיד" שמשהו אושר — הוא רק מבקש
// לשלוח, והשרת בודק.
//
// בנוסף, ה-credentials של Gmail/WhatsApp נמצאים בשרת בלבד; לדפדפן אין
// ואסור שתהיה דרך לשלוח בשמם.
//
// Deploy: supabase functions deploy ai-comms

import { admin, resolveCaller, loadOfficeDb } from '../_shared/db.ts';
import { json, preflight, errorResponse, AppError } from '../_shared/http.ts';
import { audit } from '../_shared/audit.ts';
import { getEmailProvider } from '../_shared/providers/email.ts';
import { getWhatsAppProvider, canSendNow } from '../_shared/providers/whatsapp.ts';
import { getCalendarProvider, TIMEZONE } from '../_shared/providers/calendar.ts';
import { getTelephonyProvider, TELEPHONY_REQUIREMENTS } from '../_shared/providers/telephony.ts';
import { normalizePhone } from '../_shared/security.ts';
import { ALWAYS_APPROVE } from '../_shared/approvals.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const sb = admin();
  try {
    const caller = await resolveCaller(req, sb);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    switch (action) {
      case 'send_approved':      return await sendApproved(sb, caller, body, req);
      case 'integrations_status': return await integrationsStatus(sb, caller);
      case 'create_calendar_event': return await createCalendarEvent(sb, caller, body, req);
      case 'find_free_slots':    return await findFreeSlots(sb, caller, body);
      default:
        throw new AppError('unknown_action', `פעולה לא מוכרת: ${action}`, 400);
    }
  } catch (e) {
    return errorResponse(e);
  }
});

// ============================================================

async function sendApproved(
  sb: ReturnType<typeof admin>, caller: Awaited<ReturnType<typeof resolveCaller>>,
  body: Record<string, unknown>, req: Request,
) {
  const approvalId = String(body.approval_id || '');
  if (!approvalId) throw new AppError('bad_request', 'חסר approval_id', 400);

  // ---- קריאת האישור מהשרת ----
  const { data: approval, error } = await sb.from('ai_approvals')
    .select('*').eq('id', approvalId).eq('office_id', caller.officeId).maybeSingle();
  if (error) throw new AppError('db_error', error.message, 500);
  if (!approval) throw new AppError('not_found', 'האישור לא נמצא.', 404);

  // ---- הבדיקה שהכול תלוי בה ----
  if (approval.status !== 'approved') {
    await audit(sb, {
      officeId: caller.officeId, actorType: 'user', userId: caller.userId,
      action: 'send_without_approval_blocked', entityType: 'ai_approval', entityId: approvalId,
      severity: 'security', after: { status: approval.status }, req,
    });
    throw new AppError('not_approved',
      `לא ניתן לשלוח: הפעולה במצב "${approval.status}" ולא במצב מאושר.`, 409);
  }
  if (approval.applied_at) {
    return json({ ok: true, already_sent: true, message: 'ההודעה כבר נשלחה.' });
  }

  // תפיסה אטומית של השורה לפני השליחה. הבדיקה לעיל לבדה היא read-then-act:
  // שתי בקשות במקביל (לחיצה כפולה, או retry של הדפדפן על תשובה איטית) היו
  // שתיהן רואות approved+applied_at=null ושולחות — כלומר הלקוח מקבל את
  // אותה הודעה פעמיים. ה-UPDATE המותנה מצליח רק לאחת מהן.
  const { data: claimed, error: claimErr } = await sb.from('ai_approvals')
    .update({ applied_at: new Date().toISOString() })
    .eq('id', approvalId).eq('status', 'approved').is('applied_at', null)
    .select('id');
  if (claimErr) throw new AppError('db_error', claimErr.message, 500);
  if (!claimed || !claimed.length) {
    return json({ ok: true, already_sent: true, message: 'ההודעה כבר בטיפול או נשלחה.' });
  }

  // ---- הרשאת תפקיד ----
  if (!['owner', 'lawyer'].includes(caller.role)) {
    throw new AppError('forbidden', 'רק עורך דין או בעל המשרד יכולים לשלוח הודעה מאושרת.', 403);
  }
  // פעולות מהרשימה הקשיחה — בעל המשרד בלבד, גם אחרי אישור.
  if (ALWAYS_APPROVE.has(approval.action_type) && caller.role !== 'owner') {
    throw new AppError('forbidden',
      'פעולה זו מסווגת כרגישה במיוחד ורק בעל המשרד יכול לבצע אותה.', 403);
  }

  // ---- מפסק הודעות יוצאות ----
  const { data: settings } = await sb.from('ai_settings')
    .select('outbound_messages_paused, emergency_stop').eq('office_id', caller.officeId).maybeSingle();
  if (settings?.emergency_stop) throw new AppError('emergency_stop', 'עצירת חירום פעילה.', 423);
  if (settings?.outbound_messages_paused) {
    throw new AppError('outbound_paused', 'שליחת הודעות יוצאות מושהית בהגדרות.', 423);
  }

  // edited_payload גובר על proposed_payload — זה מה שהופך "עריכה ואישור"
  // (סעיף 4.5) לאמיתי ולא לתצוגה בלבד.
  const payload = (approval.edited_payload || approval.proposed_payload || {}) as Record<string, unknown>;
  const content = String(payload.body || approval.proposed_content || '');

  // הערוץ נקבע לפי השדה המפורש שהכלי שם ב-payload. הנפילות למטה הן רשת
  // ביטחון בלבד, עבור אישורים ישנים שנשמרו לפני שהשדה נוסף: נוכחות `subject`
  // מעידה על מייל אפילו כש-`to` ריק. בלי הסדר הזה, טיוטת מייל שהסתמכה על
  // כתובת הלקוח השמורה הייתה נשלחת כהודעת WhatsApp לטלפון שלו.
  const channel = String(
    payload.channel
    || (payload.to && String(payload.to).includes('@') ? 'email' : null)
    || (payload.subject ? 'email' : 'whatsapp'),
  );

  const db = await loadOfficeDb(sb, caller.officeId);
  const client = payload.clientId ? db.clients.find((c) => c.id === payload.clientId) : null;

  let result: { ok: boolean; externalId?: string; error?: string };
  let recipient = '';

  if (channel === 'email') {
    recipient = String(payload.to || client?.email || '');
    if (!recipient) throw new AppError('no_recipient', 'לא נמצאה כתובת מייל לנמען.', 400);
    const provider = await getEmailProvider(sb, caller.officeId);
    if (provider.isMock) {
      // ⚠ mock **חייב** להיכשל כאן. הוא מחזיר ok:true בכוונה כדי שניתן יהיה
      // לבדוק את הזרימה, אבל אם נמשיך עם ok:true — ההודעה תירשם כ-'sent',
      // האישור יסומן 'applied' (ולכן לא ניתן יהיה לשלוח שוב), והמשתמש יראה
      // "ההודעה נשלחה". במשרד עורכי דין זה לקוח שלא קיבל הודעה ואיש לא יודע.
      throw new AppError('provider_mock',
        'Gmail אינו מחובר (מצב הדגמה) — ההודעה לא נשלחה. חבר חשבון במסך החיבורים.', 503);
    }
    result = await provider.send({
      to: recipient, subject: String(payload.subject || 'הודעה מהמשרד'), body: content,
    });
  } else {
    recipient = normalizePhone(String(payload.to || client?.phone || '')) || '';
    if (!recipient) throw new AppError('no_recipient', 'לא נמצא מספר טלפון תקין לנמען.', 400);

    // opt-out ושעות פעילות — בדיקה בקוד, לא בהנחיה לסוכן (סעיף 11).
    const { data: conn } = await sb.from('integration_connections')
      .select('config').eq('office_id', caller.officeId).eq('provider', 'whatsapp').maybeSingle();
    const optOuts = ((conn?.config as Record<string, unknown>)?.opt_out_numbers as string[]) || [];
    const gate = canSendNow((conn?.config || {}) as Record<string, unknown>,
      optOuts.some((n) => normalizePhone(n) === recipient));
    if (!gate.ok) throw new AppError('send_blocked', `לא ניתן לשלוח כעת: ${gate.reason}`, 423);

    const provider = await getWhatsAppProvider(sb, caller.officeId);
    if (provider.isMock) {
      throw new AppError('provider_mock',
        'WhatsApp אינו מחובר (מצב הדגמה) — ההודעה לא נשלחה. חבר חשבון במסך החיבורים.', 503);
    }
    result = await provider.sendText(recipient, content);
  }

  // ---- תיעוד ----
  const { data: thread } = await sb.from('communication_threads').upsert({
    office_id: caller.officeId, channel,
    external_thread_id: channel === 'email' ? recipient : recipient,
    participant_name: client?.name || recipient, participant_identifier: recipient,
    client_id: (payload.clientId as string) || null,
    matter_id: (payload.caseId as string) || null,
    status: 'open', last_message_at: new Date().toISOString(),
  }, { onConflict: 'office_id,channel,external_thread_id' }).select('id').single();

  if (thread) {
    await sb.from('communication_messages').insert({
      office_id: caller.officeId, thread_id: thread.id, direction: 'out', channel,
      external_message_id: result.externalId || null,
      recipient, subject: (payload.subject as string) || null, body_text: content,
      status: result.ok ? 'sent' : 'failed',
      sent_at: result.ok ? new Date().toISOString() : null,
      requires_approval: true, approval_id: approvalId,
      generated_by_agent_id: approval.agent_id,
      error: result.ok ? null : result.error,
    });
  }

  // בכישלון משחררים את התפיסה (applied_at חוזר ל-null) כדי שניתן יהיה
  // לנסות שוב אחרי תיקון; בהצלחה משאירים את החותמת שנקבעה בתפיסה.
  await sb.from('ai_approvals').update({
    status: result.ok ? 'applied' : 'approved',
    applied_at: result.ok ? approval.applied_at || new Date().toISOString() : null,
    apply_error: result.ok ? null : result.error,
  }).eq('id', approvalId);

  await audit(sb, {
    officeId: caller.officeId, actorType: 'user', userId: caller.userId,
    agentId: approval.agent_id, runId: approval.run_id,
    clientId: approval.client_id, matterId: approval.matter_id,
    action: result.ok ? 'message_sent' : 'message_send_failed',
    entityType: 'communication', entityId: result.externalId || approvalId,
    after: { channel, recipient, chars: content.length, error: result.error },
    severity: result.ok ? 'info' : 'warning', req,
  });

  return json({ ok: result.ok, external_id: result.externalId, error: result.error, channel, recipient });
}

// ============================================================

async function integrationsStatus(
  sb: ReturnType<typeof admin>, caller: Awaited<ReturnType<typeof resolveCaller>>,
) {
  // encrypted_credentials לא נבחר. אף פעם.
  const { data: conns } = await sb.from('integration_connections')
    .select('provider, status, account_name, token_expires_at, last_sync_at, last_error, config')
    .eq('office_id', caller.officeId);

  const [email, wa, cal, tel] = await Promise.all([
    getEmailProvider(sb, caller.officeId),
    getWhatsAppProvider(sb, caller.officeId),
    getCalendarProvider(sb, caller.officeId),
    getTelephonyProvider(sb, caller.officeId),
  ]);

  const byProvider = new Map((conns || []).map((c) => [c.provider, c]));

  const describe = (key: string, label: string, isMock: boolean, envReady: boolean) => {
    const conn = byProvider.get(key);
    return {
      provider: key, label,
      // "מחובר" רק כשיש חיבור אמיתי **וגם** הספק אינו mock. אינטגרציה
      // לא מוצגת כפעילה כשהיא לא (סעיף 29).
      status: isMock ? (envReady ? 'not_connected' : 'not_configured') : (conn?.status || 'disconnected'),
      mock: isMock,
      env_ready: envReady,
      account: conn?.account_name || null,
      token_expires_at: conn?.token_expires_at || null,
      last_sync_at: conn?.last_sync_at || null,
      last_error: conn?.last_error || null,
    };
  };

  const googleEnv = !!(Deno.env.get('GOOGLE_CLIENT_ID') && Deno.env.get('GOOGLE_CLIENT_SECRET'));
  const waEnv = !!(Deno.env.get('WHATSAPP_TOKEN') && Deno.env.get('WHATSAPP_PHONE_NUMBER_ID'));

  return json({
    integrations: [
      describe('google_gmail', 'Gmail', email.isMock, googleEnv),
      describe('google_calendar', 'יומן Google', cal.isMock, googleEnv),
      describe('whatsapp', 'WhatsApp Business', wa.isMock, waEnv),
      describe('telephony', 'טלפוניה', tel.isMock, false),
    ],
    telephony_requirements: TELEPHONY_REQUIREMENTS,
    ai_provider: {
      mode: Deno.env.get('AI_PROVIDER_MODE') || 'live',
      key_present: !!Deno.env.get('ANTHROPIC_API_KEY'),
    },
    // "תזמון: לא פעיל" עד שמישהו מגדיר cron. לא מעמידים פנים שהמערכת
    // אוטונומית כשאין מי שיפעיל אותה (ראה ai-cron/index.ts).
    scheduler: { cron_secret_set: !!Deno.env.get('CRON_SECRET') },
  });
}

async function createCalendarEvent(
  sb: ReturnType<typeof admin>, caller: Awaited<ReturnType<typeof resolveCaller>>,
  body: Record<string, unknown>, req: Request,
) {
  // approval_id חובה, לא רשות. כשהבדיקה הייתה מותנית ב-`if (approvalId)`,
  // השמטת הפרמטר עקפה אותה לגמרי — וכל חבר משרד (כולל מזכיר/ה) יכול היה
  // לכתוב אירועים שרירותיים ליומן המשרד בלי שום אישור.
  const approvalId = String(body.approval_id || '');
  if (!approvalId) {
    throw new AppError('approval_required', 'יצירת אירוע ביומן דורשת אישור שנשמר בשרת.', 409);
  }
  if (!['owner', 'lawyer'].includes(caller.role)) {
    throw new AppError('forbidden', 'רק עורך דין או בעל המשרד יכולים ליצור אירוע ביומן.', 403);
  }

  const { data: settings } = await sb.from('ai_settings')
    .select('emergency_stop').eq('office_id', caller.officeId).maybeSingle();
  if (settings?.emergency_stop) throw new AppError('emergency_stop', 'עצירת חירום פעילה.', 423);

  // תפיסה אטומית, כמו בשליחת הודעה: בלעדיה אותו אישור היה יכול ליצור את
  // אותו אירוע שוב ושוב בכל לחיצה.
  const { data: claimed } = await sb.from('ai_approvals')
    .update({ applied_at: new Date().toISOString() })
    .eq('id', approvalId).eq('office_id', caller.officeId)
    .eq('status', 'approved').is('applied_at', null)
    .select('id');
  if (!claimed || !claimed.length) {
    throw new AppError('not_approved',
      'האירוע לא נוצר: האישור אינו במצב מאושר, או שכבר בוצע.', 409);
  }

  const provider = await getCalendarProvider(sb, caller.officeId);
  const releaseClaim = () => sb.from('ai_approvals')
    .update({ applied_at: null }).eq('id', approvalId);

  if (provider.isMock) {
    await releaseClaim();
    throw new AppError('provider_mock',
      'יומן Google אינו מחובר (מצב הדגמה) — האירוע לא נוצר.', 503);
  }

  const result = await provider.createEvent({
    title: String(body.title || 'אירוע'),
    start: String(body.start), end: String(body.end),
    location: body.location ? String(body.location) : undefined,
    description: body.description ? String(body.description) : undefined,
  });

  await sb.from('ai_approvals').update(
    result.ok
      ? { status: 'applied' }
      : { status: 'approved', applied_at: null, apply_error: result.error },
  ).eq('id', approvalId);

  await audit(sb, {
    officeId: caller.officeId, actorType: 'user', userId: caller.userId,
    action: result.ok ? 'calendar_event_created' : 'calendar_event_failed',
    entityType: 'calendar_event', entityId: result.externalId || null,
    after: { title: body.title, start: body.start, error: result.error },
    severity: result.ok ? 'info' : 'warning', req,
  });

  return json({ ...result, timezone: TIMEZONE });
}

async function findFreeSlots(
  sb: ReturnType<typeof admin>, caller: Awaited<ReturnType<typeof resolveCaller>>,
  body: Record<string, unknown>,
) {
  const provider = await getCalendarProvider(sb, caller.officeId);
  if (provider.isMock) return json({ slots: [], mock: true, message: 'היומן אינו מחובר.' });
  const slots = await provider.findFreeSlots(
    String(body.from), String(body.to), Number(body.minutes) || 30);
  return json({ slots, mock: false, timezone: TIMEZONE });
}
