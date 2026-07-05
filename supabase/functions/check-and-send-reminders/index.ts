// LexTrack — daily reminder check: hearings tomorrow, tasks due today, and cases
// with no diary activity in 14+ days ("stuck"). Sends a Web Push notification per
// item to every subscribed device for that office, and records what was sent so the
// same item never gets re-notified (see sent_reminders / push_subscriptions,
// fix15.sql).
//
// Deploy: `supabase functions deploy check-and-send-reminders --no-verify-jwt`
//   (--no-verify-jwt because this is invoked by a cron schedule, not a logged-in user)
// Secret: `supabase secrets set VAPID_KEYS='{"publicKey":{...},"privateKey":{...}}'`
//   (the exact JSON this project's VAPID keypair was generated as — see ROADMAP.md
//   for how it was generated; the public half is also hardcoded in
//   platform.web.js's VAPID_PUBLIC_KEY, they must match)
// Scheduling: this function does nothing on its own until something calls it on a
// timer — see ROADMAP.md for the pg_cron setup needed (couldn't enable that
// extension myself; a raw `create extension` felt like exactly the kind of
// direct-schema-change worth asking about first, same reasoning as fix12-15).
//
// *** USES A LIBRARY I COULD NOT TEST LIVE — @negrel/webpush (JSR), the Deno-native
// implementation of the Web Push RFCs (8291/8292). I verified its documented API
// shape (ApplicationServer.new/subscribe/pushTextMessage) via its README and example
// code, not by actually sending a push and confirming delivery — there was no way to
// do that without a real subscribed browser. If the very first real reminder run
// fails, check the error against @negrel/webpush's actual README (github.com/negrel/webpush)
// before assuming something else is wrong. ***

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ApplicationServer } from 'jsr:@negrel/webpush';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_KEYS = JSON.parse(Deno.env.get('VAPID_KEYS')!);
const SITE_URL = Deno.env.get('SITE_URL') || 'https://zesty-marigold-0edcb2.netlify.app';
const STUCK_CASE_DAYS = 14;

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Mirrors app.js's daysSinceHE, minus the DD.MM.YYYY(he-IL) parsing since this
// function only ever sees ISO (YYYY-MM-DD) dates from date-only <input type=date>
// fields and toLocaleString('he-IL') diary timestamps — different date shape,
// simpler parse.
function daysSince(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const datePart = dateStr.split(',')[0].trim();
  const d = new Date(datePart);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

Deno.serve(async (_req) => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const appServer = await ApplicationServer.new({
    contactInformation: 'mailto:support@lextrack.app',
    vapidKeys: VAPID_KEYS,
  });

  const { data: offices, error: officesErr } = await supabase
    .from('app_data').select('office_id, data')
    .in('office_id', (await supabase.from('push_subscriptions').select('office_id')).data?.map((r: { office_id: string }) => r.office_id) || []);
  if (officesErr) return new Response(officesErr.message, { status: 500 });

  const today = todayISO();
  const tomorrow = tomorrowISO();
  let sentCount = 0;

  for (const office of offices || []) {
    const db = office.data || {};
    const officeId = office.office_id;
    const items: { type: 'hearing' | 'task' | 'stuck_case'; id: string; title: string; body: string }[] = [];

    for (const e of db.events || []) {
      if (e.date === tomorrow) {
        items.push({ type: 'hearing', id: e.id, title: '🗓 תזכורת דיון מחר', body: `${e.type || 'דיון'}: ${e.title || ''}${e.time ? ' בשעה ' + e.time : ''}` });
      }
    }
    for (const t of db.tasks || []) {
      if (!t.done && t.due === today) {
        items.push({ type: 'task', id: t.id, title: '✅ משימה להיום', body: t.text || '' });
      }
    }
    for (const c of db.cases || []) {
      if (c.status === 'closed') continue;
      const lastActivity = (c.diary && c.diary.length) ? c.diary[c.diary.length - 1].date : c.opened;
      const days = daysSince(lastActivity);
      if (days !== null && days >= STUCK_CASE_DAYS) {
        items.push({ type: 'stuck_case', id: c.id, title: '⚠ תיק ללא טיפול', body: `"${c.name}" — ${days} ימים ללא עדכון ביומן הטיפול` });
      }
    }
    if (!items.length) continue;

    // Filter out anything already sent (see sent_reminders' primary key).
    const { data: already } = await supabase
      .from('sent_reminders').select('item_type, item_id').eq('office_id', officeId);
    const alreadySet = new Set((already || []).map((r: { item_type: string; item_id: string }) => `${r.item_type}:${r.item_id}`));
    const toSend = items.filter(i => !alreadySet.has(`${i.type}:${i.id}`));
    if (!toSend.length) continue;

    const { data: subs } = await supabase
      .from('push_subscriptions').select('endpoint, p256dh, auth_key').eq('office_id', officeId);
    if (!subs || !subs.length) continue;

    for (const item of toSend) {
      for (const sub of subs) {
        try {
          const subscriber = await appServer.subscribe({
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth_key },
          });
          await subscriber.pushTextMessage(
            JSON.stringify({ title: item.title, body: item.body, url: SITE_URL }),
            {},
          );
          sentCount++;
        } catch (e) {
          console.error(`push send failed for office ${officeId}, item ${item.type}:${item.id}:`, e);
          // A dead/expired subscription (410 Gone) is expected over time as devices
          // are uninstalled/permissions revoked — not fatal, just means this
          // particular device stops getting reminders. Clean it up so future runs
          // don't keep retrying it.
          if (String(e).includes('410')) {
            await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
          }
        }
      }
      await supabase.from('sent_reminders').insert({ office_id: officeId, item_type: item.type, item_id: item.id });
    }
  }

  return new Response(JSON.stringify({ ok: true, sent: sentCount }), { headers: { 'content-type': 'application/json' } });
});
