// Webhook טלפוניה (סעיף 12).
//
// **אין ספק טלפוניה מוגדר בפרויקט** (נבדק — אין קוד, אין secret, אין
// חיבור). הפונקציה הזו היא נקודת הקצה הגנרית שממתינה לספק שייבחר:
// היא מנרמלת payload לפי מיפוי שמוגדר ב-integration_connections.config,
// כדי שהוספת ספק תהיה **הגדרה ולא כתיבת קוד**.
//
// עד שספק ייבחר ויוגדר, כל בקשה נדחית ב-503 — ולא מתקבלת "בינתיים".
// מסך האינטגרציות מציג "נדרש חיבור ספק טלפוניה" (סעיף 12).
//
// Deploy: supabase functions deploy webhook-telephony --no-verify-jwt

import { admin, loadOfficeDb, saveOfficeDb, uid } from '../_shared/db.ts';
import { json, preflight } from '../_shared/http.ts';
import { hmacSha256Hex, timingSafeEqual, stableHash } from '../_shared/crypto.ts';
import { audit } from '../_shared/audit.ts';
import { normalizePhone, samePhone, todayISO } from '../_shared/security.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = new URL(req.url);
  const officeId = url.searchParams.get('office');
  if (!officeId) return json({ error: 'חסר מזהה משרד ב-URL' }, 400);

  const sb = admin();
  const rawBody = await req.text();

  const { data: conn } = await sb.from('integration_connections')
    .select('office_id, config, status')
    .eq('office_id', officeId).eq('provider', 'telephony').maybeSingle();

  if (!conn || conn.status !== 'connected') {
    return json({ error: 'לא הוגדר ספק טלפוניה למשרד זה' }, 503);
  }

  const config = (conn.config || {}) as Record<string, any>;

  // ---- אימות ----
  //
  // כמו ב-WhatsApp: endpoint פומבי בלי אימות = כל אחד יכול להמציא
  // "שיחה נכנסת" מלקוח ולגרום למערכת ליצור לידים ומשימות. אם הספק לא
  // מספק מנגנון אימות — זהו שיקול לגיטימי לא לבחור בו.
  const secret = config.webhook_secret as string | undefined;
  if (!secret) {
    return json({ error: 'לא הוגדר webhook_secret לספק הטלפוניה' }, 503);
  }
  const sigHeader = req.headers.get(String(config.signature_header || 'x-signature')) || '';
  if (config.signature_scheme === 'hmac_sha256') {
    const expected = await hmacSha256Hex(secret, rawBody);
    if (!timingSafeEqual(sigHeader.replace(/^sha256=/, ''), expected)) {
      await audit(sb, {
        officeId, actorType: 'webhook', action: 'telephony_bad_signature', severity: 'security',
      });
      return json({ error: 'חתימה לא תקינה' }, 401);
    }
  } else if (!timingSafeEqual(sigHeader, secret)) {
    // ברירת מחדל: secret משותף בכותרת, בהשוואה בזמן קבוע.
    await audit(sb, {
      officeId, actorType: 'webhook', action: 'telephony_bad_secret', severity: 'security',
    });
    return json({ error: 'אימות נכשל' }, 401);
  }

  let payload: Record<string, any>;
  try { payload = JSON.parse(rawBody); } catch { return json({ error: 'JSON לא תקין' }, 400); }

  // ---- מיפוי גנרי ----
  //
  // ספקים שונים מחזירים שמות שדות שונים (from/caller/src...). המיפוי
  // מוגדר ב-config ולכן ספק חדש = עדכון JSON, לא deploy.
  const map = (config.field_map || {}) as Record<string, string>;
  const pick = (key: string, fallbacks: string[]): unknown => {
    if (map[key] && payload[map[key]] !== undefined) return payload[map[key]];
    for (const f of fallbacks) if (payload[f] !== undefined) return payload[f];
    return undefined;
  };

  const from = normalizePhone(String(pick('from', ['from', 'caller', 'src', 'source']) || ''));
  const to = String(pick('to', ['to', 'callee', 'dst', 'destination']) || '');
  const status = String(pick('status', ['status', 'event', 'call_status']) || 'unknown').toLowerCase();
  // בלי מזהה שיחה מהספק אין דדופליקציה אפשרית: uid() אקראי בכל מסירה
  // היה מנטרל את comm_messages_external_uniq ויוצר שורה כפולה בכל חזרה
  // של הספק. נגזר מזהה יציב מהמספר ומחלון הזמן במקום.
  const rawCallId = pick('call_id', ['call_id', 'id', 'uuid', 'callId']);
  const externalId = rawCallId
    ? String(rawCallId)
    : `derived-${from || 'unknown'}-${Math.floor(Date.now() / 60000)}`;
  const duration = Number(pick('duration', ['duration', 'duration_seconds', 'billsec']) || 0);
  const direction = String(pick('direction', ['direction']) || 'in').startsWith('out') ? 'out' : 'in';

  if (!from) return json({ error: 'מספר מתקשר חסר או לא תקין' }, 400);

  try {
    await handleCall(sb, officeId, { from, to, status, externalId, duration, direction });
  } catch (e) {
    // 200 בכל מקרה — ספקי טלפוניה חוזרים על webhook שנכשל, ושגיאה
    // נקודתית לא צריכה להפוך לסופת בקשות.
    console.error('[telephony] processing failed', e);
  }
  return json({ received: true });
});

// ============================================================

async function handleCall(
  sb: ReturnType<typeof admin>, officeId: string,
  call: { from: string; to: string; status: string; externalId: string; duration: number; direction: string },
) {
  const db = await loadOfficeDb(sb, officeId);

  const client = db.clients.find((c) =>
    (c.phone && samePhone(String(c.phone), call.from)) ||
    (c.contactPhone && samePhone(String(c.contactPhone), call.from)));
  const matter = client
    ? db.cases.find((c) => c.client === client.id && c.status !== 'closed')
    : null;
  // ייתכן שהמתקשר הוא דווקא הצד שכנגד — חשוב לדעת לפני שמתייחסים אליו כלקוח.
  const debtorCase = !client
    ? db.cases.find((c) => c.debtorPhone && samePhone(String(c.debtorPhone), call.from))
    : null;
  let lead = db.leads.find((l) => l.phone && samePhone(String(l.phone), call.from));

  const missed = ['missed', 'no-answer', 'noanswer', 'busy', 'failed', 'cancel'].includes(call.status);

  // שיחה נכנסת שלא נענתה ממספר לא מוכר → ליד.
  // לא יוצרים ליד מהצד שכנגד: הוא לא לקוח פוטנציאלי, ורישום כזה מזהם
  // את צנרת המכירות ועלול להוביל לשליחת הודעה שיווקית לחייב.
  if (!client && !lead && !debtorCase && call.direction === 'in') {
    const newLead = {
      id: uid(), name: call.from, phone: call.from,
      source: 'phone', status: 'new',
      summary: missed ? 'שיחה נכנסת שלא נענתה' : 'שיחה נכנסת',
      createdAt: new Date().toISOString(),
    };
    await saveOfficeDb(sb, officeId, (d) => { d.leads.unshift(newLead as never); });
    lead = newLead as never;
  }

  const { data: thread } = await sb.from('communication_threads').upsert({
    office_id: officeId, channel: 'call', external_thread_id: call.from,
    participant_name: client?.name || debtorCase?.debtorName || call.from,
    participant_identifier: call.from,
    client_id: client?.id || null,
    matter_id: matter?.id || debtorCase?.id || null,
    lead_id: lead?.id || null,
    status: missed ? 'waiting_reply' : 'open',
    urgency: missed ? 'high' : 'normal',
    last_message_at: new Date().toISOString(),
  }, { onConflict: 'office_id,channel,external_thread_id' }).select('id').single();
  if (!thread) return;

  const label = call.direction === 'in'
    ? (missed ? 'שיחה נכנסת שלא נענתה' : `שיחה נכנסת (${call.duration} שניות)`)
    : `שיחה יוצאת (${call.duration} שניות)`;

  await sb.from('communication_messages').insert({
    office_id: officeId, thread_id: thread.id,
    direction: call.direction === 'out' ? 'out' : 'in', channel: 'call',
    external_message_id: call.externalId,
    sender: call.from, recipient: call.to,
    body_text: label + (debtorCase ? `\n⚠ המספר תואם לחייב בתיק "${debtorCase.name}" — לא לקוח.` : ''),
    status: missed ? 'failed' : 'received',
    received_at: new Date().toISOString(),
    metadata: { call_status: call.status, duration_seconds: call.duration, missed },
  });

  await audit(sb, {
    officeId, actorType: 'webhook', action: missed ? 'missed_call' : 'call_logged',
    entityType: 'call', entityId: call.externalId,
    clientId: client?.id, matterId: matter?.id || debtorCase?.id,
    after: { from: call.from, status: call.status, duration: call.duration },
  });

  // שיחה שלא נענתה → משימת חזרה (סעיף 14.4).
  if (missed && call.direction === 'in') {
    const { data: settings } = await sb.from('ai_settings')
      .select('emergency_stop, automations_paused').eq('office_id', officeId).maybeSingle();
    if (settings?.emergency_stop || settings?.automations_paused) return;

    const { data: agent } = await sb.from('ai_agents')
      .select('id').eq('office_id', officeId)
      .eq('slug', lead && !client ? 'lead-intake' : 'client-service')
      .eq('status', 'active').maybeSingle();
    if (!agent) return;

    // מפתח לפי מספר+יום: חמש שיחות שלא נענו מאותו מספר ביום אחד יוצרות
    // משימת חזרה אחת, לא חמש.
    const key = await stableHash('missed-call', call.from, todayISO());
    await sb.from('ai_jobs').insert({
      office_id: officeId, agent_id: agent.id, job_type: 'missed_call_followup',
      client_id: client?.id || null,
      matter_id: matter?.id || debtorCase?.id || null,
      priority: 3, status: 'queued', trigger_type: 'webhook', idempotency_key: key,
      payload: {
        goal: `שיחה שלא נענתה מהמספר ${call.from}. ` +
          (client ? `המתקשר הוא הלקוח ${client.name}. ` : 'המתקשר אינו מזוהה כלקוח קיים. ') +
          'צור משימת חזרה והכן הודעת המשך מוצעת.',
        phone: call.from, lead_id: lead?.id || null,
      },
    });
  }
}
