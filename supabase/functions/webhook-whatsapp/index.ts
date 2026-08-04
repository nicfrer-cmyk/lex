// Webhook נכנס של WhatsApp Business Cloud API (סעיף 11).
//
// שני מסלולים:
//   GET  — אימות ה-webhook מול Meta (hub.challenge)
//   POST — הודעות ועדכוני סטטוס
//
// ## אבטחה — למה זה קריטי כאן במיוחד
// זהו endpoint פומבי (--no-verify-jwt; ל-Meta אין JWT שלנו). בלי אימות
// חתימה, כל אחד ברשת יכול לשלוח POST ולגרום למערכת ליצור לידים מזויפים,
// לשייך הודעות ללקוחות אמיתיים, ולהפעיל סוכנים על חשבון המשרד.
// לכן: אימות HMAC-SHA256 של גוף הבקשה מול APP_SECRET, בהשוואה בזמן קבוע.
// אם WHATSAPP_APP_SECRET לא מוגדר — הבקשה **נדחית**, ולא מתקבלת "בינתיים".
//
// Deploy: supabase functions deploy webhook-whatsapp --no-verify-jwt
// URL ל-Meta: https://<project>.supabase.co/functions/v1/webhook-whatsapp

import { admin, loadOfficeDb, saveOfficeDb, uid } from '../_shared/db.ts';
import { json, preflight, CORS_HEADERS } from '../_shared/http.ts';
import { hmacSha256Hex, timingSafeEqual, stableHash } from '../_shared/crypto.ts';
import { audit } from '../_shared/audit.ts';
import { normalizePhone, samePhone, detectInjection } from '../_shared/security.ts';

const VERIFY_TOKEN = Deno.env.get('WHATSAPP_VERIFY_TOKEN') || '';
const APP_SECRET = Deno.env.get('WHATSAPP_APP_SECRET') || '';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const url = new URL(req.url);

  // ---- אימות ה-webhook מול Meta ----
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && VERIFY_TOKEN && token && timingSafeEqual(token, VERIFY_TOKEN)) {
      return new Response(challenge || '', { status: 200, headers: CORS_HEADERS });
    }
    return new Response('Forbidden', { status: 403, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const rawBody = await req.text();

  // ---- אימות חתימה ----
  if (!APP_SECRET) {
    console.error('[whatsapp] WHATSAPP_APP_SECRET לא מוגדר — הבקשה נדחתה');
    return json({ error: 'webhook לא מוגדר' }, 503);
  }
  const sigHeader = req.headers.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + await hmacSha256Hex(APP_SECRET, rawBody);
  if (!timingSafeEqual(sigHeader, expected)) {
    console.error('[whatsapp] חתימה לא תואמת — בקשה נדחתה');
    return json({ error: 'חתימה לא תקינה' }, 401);
  }

  const sb = admin();
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: 'JSON לא תקין' }, 400);
  }

  // ה-try/catch עוטף כל הודעה בנפרד, ולא את הלולאה כולה. עטיפה חיצונית
  // אחת גרמה לכך שכשל בהודעה אחת (למשל saveOfficeDb שמיצה את הניסיונות
  // וזרק write_conflict) הפיל את כל שאר ההודעות באותה מנה — ומכיוון
  // שהתשובה נשארה 200, Meta לעולם לא שלחה אותן שוב. הן פשוט אבדו.
  let failed = 0;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      // איזה משרד? לפי מזהה מספר הטלפון העסקי ששמור בחיבור.
      // ללא התאמה — אין לנו לאן לשייך, ולא מנחשים.
      const { data: conn } = await sb.from('integration_connections')
        .select('office_id, config').eq('provider', 'whatsapp')
        .eq('account_identifier', String(phoneNumberId)).maybeSingle();
      if (!conn) {
        console.warn('[whatsapp] אין חיבור למספר', phoneNumberId);
        continue;
      }

      for (const msg of value.messages || []) {
        try {
          await handleIncoming(sb, conn.office_id, msg, value);
        } catch (e) {
          failed++;
          console.error('[whatsapp] message failed', msg?.id, e);
        }
      }
      for (const st of value.statuses || []) {
        try {
          await handleStatus(sb, conn.office_id, st);
        } catch (e) {
          console.error('[whatsapp] status failed', st?.id, e);
        }
      }
    }
  }

  // 200 גם כשהיו כשלים נקודתיים: Meta חוזרת על webhook שנכשל, וזה הופך
  // באג בהודעה אחת לסופת בקשות על כל המנה. הכשלים נרשמים ללוג.
  return json({ received: true, failed });
});

// ============================================================

async function handleIncoming(
  sb: ReturnType<typeof admin>, officeId: string,
  msg: Record<string, any>, value: Record<string, any>,
) {
  const from = normalizePhone(String(msg.from || ''));
  if (!from) return;

  const profileName = value?.contacts?.[0]?.profile?.name || '';
  const body = msg.text?.body
    || msg.button?.text
    || msg.interactive?.list_reply?.title
    || `[${msg.type || 'מדיה'}]`;

  const db = await loadOfficeDb(sb, officeId);

  // מי זה? לקוח קיים / ליד קיים / חדש.
  const client = db.clients.find((c) =>
    (c.phone && samePhone(String(c.phone), from)) ||
    (c.contactPhone && samePhone(String(c.contactPhone), from)));
  const matter = client
    ? db.cases.find((c) => c.client === client.id && c.status !== 'closed')
    : null;
  let lead = db.leads.find((l) => l.phone && samePhone(String(l.phone), from));

  // פנייה ממספר לא מוכר → ליד חדש.
  //
  // זה אחד המקומות הבודדים שבהם השרת כותב ל-app_data ישירות. מוצדק כאן
  // כי אין דפדפן בצד השני של webhook, והאלטרנטיבה — לאבד את הפנייה עד
  // שמישהו יפתח את המערכת — גרועה יותר. saveOfficeDb מוגן ב-optimistic
  // concurrency, כך שאם המשתמש כותב באותו רגע, הכתיבה תיכשל ותנסה שוב
  // במקום לדרוס. ראה ההערה ב-_shared/db.ts.
  if (!client && !lead) {
    const newLead = {
      id: uid(), name: profileName || from, phone: from,
      source: 'whatsapp', status: 'new',
      summary: body.slice(0, 500),
      createdAt: new Date().toISOString(),
    };
    await saveOfficeDb(sb, officeId, (d) => { d.leads.unshift(newLead as never); });
    lead = newLead as never;

    await audit(sb, {
      officeId, actorType: 'webhook', action: 'lead_created_from_whatsapp',
      entityType: 'lead', entityId: newLead.id, after: { phone: from, name: profileName },
    });
  }

  const { data: thread } = await sb.from('communication_threads').upsert({
    office_id: officeId, channel: 'whatsapp', external_thread_id: from,
    participant_name: profileName || client?.name || from, participant_identifier: from,
    client_id: client?.id || null, matter_id: matter?.id || null,
    lead_id: lead?.id || null,
    status: 'waiting_reply',
    last_message_at: new Date(Number(msg.timestamp || Date.now() / 1000) * 1000).toISOString(),
  }, { onConflict: 'office_id,channel,external_thread_id' }).select('id').single();
  if (!thread) return;

  const scan = detectInjection(body);

  const { error } = await sb.from('communication_messages').insert({
    office_id: officeId, thread_id: thread.id, direction: 'in', channel: 'whatsapp',
    external_message_id: String(msg.id), sender: from,
    body_text: body, status: 'received',
    received_at: new Date(Number(msg.timestamp || Date.now() / 1000) * 1000).toISOString(),
    metadata: { type: msg.type, profileName,
                injection_suspected: scan.suspected, injection_matches: scan.matches },
  });
  // 23505 = ההודעה כבר נקלטה. Meta שולח webhook פעמיים לא פעם, וזה בדיוק
  // מה שהאינדקס הייחודי על external_message_id נועד לתפוס.
  if (error && error.code === '23505') return;

  // עדכון unread — הודעה נכנסת שלא נקראה.
  // מונה מצטבר ולא קבוע 1: קביעה קשיחה הציגה חמש הודעות שלא נקראו כאחת.
  const { data: cur } = await sb.from('communication_threads')
    .select('unread_count').eq('id', thread.id).maybeSingle();
  await sb.from('communication_threads').update({
    unread_count: (Number(cur?.unread_count) || 0) + 1,
    status: 'waiting_reply',
  }).eq('id', thread.id);

  // ליד חדש → הפעלת סוכן קליטת לידים (רק לליד, לא ללקוח קיים).
  if (lead && !client) await triggerLeadAgent(sb, officeId, lead.id, body);
}

async function handleStatus(
  sb: ReturnType<typeof admin>, officeId: string, st: Record<string, any>,
) {
  // sent → delivered → read, וגם failed. ממופה לסטטוסים שלנו כדי שהמסך
  // יראה מה קרה להודעה שנשלחה.
  const map: Record<string, string> = {
    sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed',
  };
  const status = map[String(st.status)] || null;
  if (!status || !st.id) return;

  await sb.from('communication_messages').update({
    status,
    error: st.errors?.[0]?.title || null,
  }).eq('office_id', officeId).eq('external_message_id', String(st.id));
}

/**
 * מפעיל את סוכן קליטת הלידים.
 *
 * לא קורא ל-ai-gateway (אין JWT של משתמש ב-webhook) אלא יוצר job ישירות.
 * ה-idempotency key מבוסס על הליד והיום — כדי ש-5 הודעות רצופות מאותו ליד
 * לא יפתחו 5 הרצות בתשלום.
 */
async function triggerLeadAgent(
  sb: ReturnType<typeof admin>, officeId: string, leadId: string, firstMessage: string,
) {
  const { data: settings } = await sb.from('ai_settings')
    .select('emergency_stop, automations_paused').eq('office_id', officeId).maybeSingle();
  if (settings?.emergency_stop || settings?.automations_paused) return;

  const { data: agent } = await sb.from('ai_agents')
    .select('id').eq('office_id', officeId).eq('slug', 'lead-intake')
    .eq('status', 'active').maybeSingle();
  if (!agent) return;

  const key = await stableHash('wa-lead', leadId, new Date().toISOString().slice(0, 10));
  await sb.from('ai_jobs').insert({
    office_id: officeId, agent_id: agent.id, job_type: 'process_lead',
    priority: 2, status: 'queued', trigger_type: 'webhook', idempotency_key: key,
    payload: {
      goal: 'התקבלה פנייה חדשה בוואטסאפ. סווג, דרג, אתר מידע חסר והכן הודעת תשובה מוצעת.',
      lead_id: leadId,
      first_message: firstMessage.slice(0, 2000),
    },
  });
}
