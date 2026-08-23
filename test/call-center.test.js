// בדיקות מרכז השיחות.
//
// שלוש קבוצות, לפי מה שהן מגנות עליו:
//
//  1. **שער הכלים** — מה AI רשאי לעשות בתיקים של משרד עורכי דין. כלי
//     שנפתח בטעות, פגישה כפולה, או ליד שנפתח עבור הצד שכנגד הם נזק
//     אמיתי ללקוח, לא תקלת תצוגה.
//  2. **החתימה** — endpoint טלפוניה פומבי. חתימה שמתקבלת כשאסור לה, או
//     בקשה ישנה שעוברת, פירושן שכל אחד יכול להמציא שיחות.
//  3. **מנוע הדחיפות** — מה יסומן כדחוף. טעות כאן לא מפילה כלום; היא רק
//     גורמת לכך שהשיחה שבאמת דחופה תיבלע ברעש.
//
// הבדיקות רצות ב-Node, ולכן כל מה שנבדק כאן טהור מ-Deno ומ-DB. מה שדורש
// מסד נתונים (RLS) נבדק סטטית מול קובץ המיגרציה — ראה ההסבר שם.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
// שורה חדשה כקבוע: הטמעתה ישירות בליטרל של הסקריפט ל-python
// שוברת את הקובץ הזה בעצמו.
const NL = String.fromCharCode(10);
const load = (rel) => import('file://' + path.join(ROOT, rel).replace(/\\/g, '/'));

const TOOLS = () => load('supabase/functions/_shared/voice/tools.ts');
const URGENCY = () => load('supabase/functions/_shared/voice/urgency.ts');
const SIGNING = () => load('supabase/functions/_shared/voice/signing.ts');
const LLM = () => load('supabase/functions/_shared/voice/llm.ts');

// ============================================================
// עזרים — CRM בזיכרון
// ============================================================

function makeDb(over) {
  return Object.assign({
    cases: [], clients: [], tasks: [], events: [], docs: [], payments: [], leads: [],
    timeEntries: [], trustTransactions: [], efilingBundles: {}, counters: {}, settings: {},
  }, over || {});
}

/**
 * הקשר כלים עם כתיבה בזיכרון.
 *
 * writeDb/reload הם אותם ווים שהייצור משתמש בהם (ראה VoiceToolCtx) —
 * הבדיקה לא עוקפת את נתיב הכתיבה, היא רק מחליפה את היעד שלו. לכן כל
 * בדיקת כפילות כאן בודקת את הקוד שירוץ באמת.
 */
function makeCtx(over) {
  const state = { db: makeDb((over || {}).db) };
  const ctx = Object.assign({
    sb: null,
    officeId: 'office-1',
    callId: 'call-1',
    callerPhone: '+972501234567',
    clientId: null,
    leadId: null,
    matterId: null,
    settings: {},
    isSimulation: true,
    refresh: (next) => { state.db = next; },
    writeDb: async (mutate) => { mutate(state.db); return state.db; },
    reload: async () => state.db,
  }, over || {});
  Object.defineProperty(ctx, 'db', { get: () => state.db, configurable: true });
  ctx._state = state;
  return ctx;
}

const ALLOW = { enabled: true, available: true, requires_confirmation: false, risk_level: 'low' };

function perms(names, over) {
  const m = new Map();
  for (const n of names) m.set(n, Object.assign({}, ALLOW, (over || {})[n] || {}));
  return m;
}

// מחר, כדי שבדיקות פגישה לא ייפלו על "תאריך שעבר" ולא על סוף שבוע.
function nextWeekday(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays || 1));
  // 5=שישי, 6=שבת בלוח של isoWeekday (0=ראשון)
  while ([5, 6].includes((d.getUTCDay ? d.getDay() : d.getDay()))) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ============================================================
// 1. זיהוי לקוח
// ============================================================

test('lookup_client מזהה לקוח לפי מספר מנורמל ומחזיר סיכום מינימלי', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({
    db: {
      // ⚠ המספר שמור בפורמט מקומי, המתקשר מגיע בפורמט בינלאומי. בלי
      // נרמול, לקוח קיים היה נפתח כליד חדש בכל שיחה.
      clients: [{ id: 'c1', name: 'ישראל ישראלי', phone: '050-1234567' }],
      cases: [
        { id: 'm1', client: 'c1', name: 'תיק הוצאה לפועל', stage: 'דיון', status: 'active', amount: 82000 },
        { id: 'm2', client: 'c1', name: 'תיק סגור', status: 'closed' },
      ],
    },
  });

  const out = await execVoiceTool('lookup_client', { phone: '+972501234567' },
    ALLOW, ctx);

  assert.equal(out.status, 'success');
  assert.equal(out.result.data.found, true);
  assert.equal(out.result.data.client_id, 'c1');
  assert.equal(out.result.data.name, 'ישראל ישראלי');
  assert.equal(out.result.data.active_cases_count, 1, 'תיק סגור לא נספר');

  // ⚠ מה שלא הוחזר חשוב לא פחות ממה שכן: סכום החוב אינו נמסר בטלפון
  // למי שרק הצהיר שהוא הלקוח.
  const serialized = JSON.stringify(out.result);
  assert.ok(!serialized.includes('82000'), 'סכום התיק לא נחשף');
  assert.ok(!serialized.includes('m1'), 'מזהה התיק לא נחשף');
});

test('lookup_client על מתקשר לא מוכר מחזיר found=false ולא נכשל', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({ db: { clients: [{ id: 'c1', name: 'אחר', phone: '0509999999' }] } });

  const out = await execVoiceTool('lookup_client', { phone: '0501234567' }, ALLOW, ctx);
  assert.equal(out.status, 'success');
  assert.equal(out.result.data.found, false);
});

test('מספר של הצד שכנגד אינו מזוהה כלקוח ואינו נפתח כליד', async () => {
  const { execVoiceTool } = await TOOLS();
  // התרחיש: החייב בתיק מתקשר. הוא לא לקוח פוטנציאלי, ומסירת פרטים אליו
  // היא דליפה על הלקוח שנגדו הוא עומד.
  const ctx = makeCtx({
    db: {
      clients: [{ id: 'c1', name: 'הלקוח', phone: '0501111111' }],
      cases: [{ id: 'm1', client: 'c1', name: 'תביעת חוב', debtorPhone: '050-1234567', status: 'active' }],
    },
  });

  const look = await execVoiceTool('lookup_client', { phone: '+972501234567' }, ALLOW, ctx);
  assert.equal(look.result.data.found, false);
  assert.equal(look.result.data.is_opposing_party, true);

  const lead = await execVoiceTool('create_lead',
    { name: 'החייב', phone: '+972501234567' }, ALLOW, ctx);
  assert.equal(lead.status, 'failed');
  assert.equal(ctx.db.leads.length, 0, 'לא נפתח ליד עבור הצד שכנגד');
});

// ============================================================
// 2. יצירת ליד
// ============================================================

test('create_lead פותח פנייה עם source=voice_ai ומספר מנורמל', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx();

  const out = await execVoiceTool('create_lead', {
    name: 'ישראל', phone: '050-1234567', source: 'voice_ai',
    category: 'הוצאה לפועל', summary: 'קיבל עיקול בחשבון',
  }, ALLOW, ctx);

  assert.equal(out.status, 'success');
  assert.equal(ctx.db.leads.length, 1);
  const lead = ctx.db.leads[0];
  assert.equal(lead.name, 'ישראל');
  assert.equal(lead.source, 'voice_ai');
  assert.equal(lead.phone, '+972501234567');
  assert.equal(lead.status, 'new');
  assert.equal(lead.createdByCall, 'call-1');
});

test('create_lead לא מכפיל פנייה קיימת מאותו מספר — מעדכן אותה', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({
    db: { leads: [{ id: 'l1', name: 'ישראל', phone: '+972501234567', summary: 'פנייה ראשונה' }] },
  });

  const out = await execVoiceTool('create_lead',
    { name: 'ישראל', phone: '0501234567', summary: 'פרט נוסף' }, ALLOW, ctx);

  assert.equal(out.status, 'success');
  assert.equal(out.result.data.created, false);
  assert.equal(ctx.db.leads.length, 1, 'לא נוצרה פנייה כפולה');
  assert.ok(ctx.db.leads[0].summary.includes('פרט נוסף'), 'הפרט החדש נוסף ולא דרס');
  assert.ok(ctx.db.leads[0].summary.includes('פנייה ראשונה'), 'המידע הקודם נשמר');
});

test('create_lead על מספר של לקוח קיים אינו יוצר ליד', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({ db: { clients: [{ id: 'c1', name: 'ותיק', phone: '0501234567' }] } });

  const out = await execVoiceTool('create_lead', { name: 'ותיק', phone: '0501234567' }, ALLOW, ctx);
  assert.equal(out.result.data.created, false);
  assert.equal(out.result.data.client_id, 'c1');
  assert.equal(ctx.db.leads.length, 0);
});

// ============================================================
// 3. יצירת משימה
// ============================================================

test('create_task יוצר משימה בפורמט של מערכת המשימות הקיימת', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({
    db: { cases: [{ id: 'm1', client: 'c1', name: 'תיק', status: 'active' }] },
    clientId: 'c1',
  });

  const out = await execVoiceTool('create_task', {
    title: 'לחזור ללקוח בעניין העיקול',
    description: 'הלקוח דיווח על עיקול בחשבון',
    priority: 'urgent',
    due_date: '2026-09-01',
  }, ALLOW, ctx);

  assert.equal(out.status, 'success');
  const t = ctx.db.tasks[0];
  // השדות חייבים להיות בדיוק אלה של saveTask ב-app.js, אחרת המשימה
  // תיווצר ולא תופיע ברשימת המשימות של המשתמש.
  assert.equal(t.text, 'לחזור ללקוח בעניין העיקול');
  assert.equal(t.due, '2026-09-01');
  assert.equal(t.priority, 'urgent');
  assert.equal(t.done, false);
  assert.equal(t.caseId, 'm1', 'שויכה לתיק הפעיל של הלקוח');
  assert.equal(out.result.entityType, 'task');
});

test('create_task אינו יוצר משימה כפולה זהה באותו תיק', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({ db: { tasks: [{ id: 't1', text: 'לחזור ללקוח', caseId: '', done: false }] } });

  const out = await execVoiceTool('create_task', { title: 'לחזור ללקוח' }, ALLOW, ctx);
  assert.equal(out.status, 'success');
  assert.equal(out.result.data.created, false);
  assert.equal(ctx.db.tasks.length, 1);
});

test('request_human_callback יוצר משימת חזרה דחופה ליום הנוכחי', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({ db: { clients: [{ id: 'c1', name: 'ישראל ישראלי' }] }, clientId: 'c1' });

  const out = await execVoiceTool('request_human_callback',
    { reason: 'מבקש לדבר עם עורך הדין' }, ALLOW, ctx);

  assert.equal(out.status, 'success');
  const t = ctx.db.tasks[0];
  assert.ok(t.text.startsWith('חזרה דחופה ללקוח'), 'הכותרת היא זו שהמפרט דורש');
  assert.ok(t.text.includes('ישראל ישראלי'));
  assert.equal(t.priority, 'urgent');
  assert.ok(t.due, 'נקבע מועד יעד');

  // קריאה שנייה לא מכפילה.
  const again = await execVoiceTool('request_human_callback', { reason: 'שוב' }, ALLOW, ctx);
  assert.equal(again.result.data.created, false);
  assert.equal(ctx.db.tasks.length, 1);
});

// ============================================================
// 4. הערות
// ============================================================

test('create_note מוסיף ליומן התיק ולא דורס אותו', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({
    db: { cases: [{ id: 'm1', name: 'תיק', diary: [{ text: 'רישום קודם', date: '1.1.2026' }] }] },
    matterId: 'm1',
  });

  const out = await execVoiceTool('create_note', { text: 'הלקוח דיווח על עיקול' }, ALLOW, ctx);
  assert.equal(out.status, 'success');
  assert.equal(ctx.db.cases[0].diary.length, 2);
  assert.ok(ctx.db.cases[0].diary[0].text.includes('שיחה טלפונית'));
  assert.equal(ctx.db.cases[0].diary[1].text, 'רישום קודם', 'הרישום הקודם נשמר');
});

test('create_note מוסיף להערות הלקוח בלי למחוק מה שהמשתמש כתב', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({
    db: { clients: [{ id: 'c1', name: 'ישראל', notes: 'לקוח ותיק, מעדיף מייל' }] },
    clientId: 'c1',
  });

  await execVoiceTool('create_note', { text: 'ביקש לקבוע פגישה' }, ALLOW, ctx);
  assert.ok(ctx.db.clients[0].notes.includes('לקוח ותיק, מעדיף מייל'));
  assert.ok(ctx.db.clients[0].notes.includes('ביקש לקבוע פגישה'));
});

// ============================================================
// 5. יומן ופגישות
// ============================================================

test('freeSlotsForDay מדלג על חלונות תפוסים ועל סוף שבוע', async () => {
  const { freeSlotsForDay, timeToMinutes } = await TOOLS();

  // 2026-08-24 = יום שני.
  const slots = freeSlotsForDay('2026-08-24', [{ startMin: 10 * 60, endMin: 11 * 60 }], 60);
  const times = slots.map((s) => s.time);
  assert.ok(times.includes('09:00'));
  assert.ok(!times.includes('10:00'), 'שעה תפוסה לא מוצעת');
  assert.ok(!times.includes('10:30'), 'חפיפה חלקית לא מוצעת');
  assert.ok(times.includes('11:00'));
  // מחוץ לשעות העבודה
  assert.ok(!times.includes('08:30'));
  assert.ok(!times.some((t) => timeToMinutes(t) + 60 > 18 * 60));

  // 2026-08-28 = יום שישי, 2026-08-29 = שבת.
  assert.equal(freeSlotsForDay('2026-08-28', [], 60).length, 0);
  assert.equal(freeSlotsForDay('2026-08-29', [], 60).length, 0);
});

test('busyFromEvents: אירוע ללא שעה חוסם את כל היום', async () => {
  const { busyFromEvents } = await TOOLS();
  const busy = busyFromEvents([
    { date: '2026-08-24', time: '10:00' },
    { date: '2026-08-24' },
    { date: '2026-08-25', time: '10:00' },
  ], '2026-08-24');
  assert.equal(busy.length, 2);
  assert.deepEqual(busy[1], { startMin: 0, endMin: 1440 });
});

test('create_appointment קובע פגישה ביומן הפנימי', async () => {
  const { execVoiceTool } = await TOOLS();
  const date = nextWeekday(3);
  const ctx = makeCtx({ db: { clients: [{ id: 'c1', name: 'ישראל' }] }, clientId: 'c1' });

  const out = await execVoiceTool('create_appointment',
    { date, time: '10:30', duration_minutes: 60 }, ALLOW, ctx);

  assert.equal(out.status, 'success', out.result.message);
  assert.equal(ctx.db.events.length, 1);
  const e = ctx.db.events[0];
  // שדות היומן חייבים להתאים ל-saveEvent ב-app.js.
  assert.equal(e.date, date);
  assert.equal(e.time, '10:30');
  assert.equal(e.type, 'meeting');
  assert.equal(e.durationMinutes, 60);
  assert.ok(e.title.includes('ישראל'));
});

test('create_appointment מונע Double Booking', async () => {
  const { execVoiceTool } = await TOOLS();
  const date = nextWeekday(3);
  const ctx = makeCtx({ db: { events: [{ id: 'e1', date, time: '10:00', title: 'דיון' }] } });

  // חופפת חלקית לאירוע קיים בן שעה.
  const clash = await execVoiceTool('create_appointment', { date, time: '10:30' }, ALLOW, ctx);
  assert.equal(clash.status, 'failed');
  assert.ok(/תפוס/.test(clash.result.message));
  assert.equal(ctx.db.events.length, 1, 'לא נוצרה פגישה חופפת');

  // מועד פנוי — כן.
  const ok = await execVoiceTool('create_appointment', { date, time: '12:00' }, ALLOW, ctx);
  assert.equal(ok.status, 'success');
  assert.equal(ctx.db.events.length, 2);
});

test('create_appointment דוחה סוף שבוע ותאריך שעבר', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx();

  const sat = await execVoiceTool('create_appointment',
    { date: '2026-08-29', time: '10:00' }, ALLOW, ctx);
  assert.equal(sat.status, 'failed');
  assert.ok(/סוף השבוע/.test(sat.result.message));

  const past = await execVoiceTool('create_appointment',
    { date: '2020-01-06', time: '10:00' }, ALLOW, ctx);
  assert.equal(past.status, 'failed');
  assert.equal(ctx.db.events.length, 0);
});

test('check_calendar מחזיר רק שעות פנויות, בלי תוכן היומן', async () => {
  const { execVoiceTool } = await TOOLS();
  const date = nextWeekday(2);
  const ctx = makeCtx({
    db: { events: [{ id: 'e1', date, time: '09:00', title: 'דיון סודי בתיק כהן' }] },
  });

  const out = await execVoiceTool('check_calendar',
    { from_date: date, days: 1, duration_minutes: 60, max_slots: 5 }, ALLOW, ctx);

  assert.equal(out.status, 'success');
  const serialized = JSON.stringify(out.result);
  assert.ok(!serialized.includes('כהן'), 'תוכן היומן אינו נחשף למתקשר');
  assert.ok(!out.result.data.slots.some((s) => s.time === '09:00'));
});

// ============================================================
// 6. שערי הרשאה
// ============================================================

test('כלי שאינו מוקצה לסוכן נחסם ולא מבוצע', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx();

  const out = await execVoiceTool('create_task', { title: 'משימה' }, null, ctx);
  assert.equal(out.status, 'blocked');
  assert.equal(ctx.db.tasks.length, 0);
});

test('כלי מושבת וכלי לא-זמין נחסמים, עם סיבות שונות', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx();

  const disabled = await execVoiceTool('create_task', { title: 'x' },
    { enabled: false, available: true, requires_confirmation: false, risk_level: 'low' }, ctx);
  assert.equal(disabled.status, 'blocked');
  assert.ok(/מושבת/.test(disabled.result.message));

  const unavailable = await execVoiceTool('create_task', { title: 'x' },
    { enabled: true, available: false, requires_confirmation: false, risk_level: 'low',
      unavailable_reason: 'חסר ספק' }, ctx);
  assert.equal(unavailable.status, 'blocked');
  assert.equal(unavailable.result.message, 'חסר ספק');

  assert.equal(ctx.db.tasks.length, 0);
});

test('כלי לא מוכר נחסם', async () => {
  const { execVoiceTool } = await TOOLS();
  const out = await execVoiceTool('drop_database', {}, ALLOW, makeCtx());
  assert.equal(out.status, 'blocked');
});

test('עצירת חירום חוסמת כל כלי, כולל קריאה בלבד', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({ settings: { emergency_stop: true } });
  const out = await execVoiceTool('lookup_client', { phone: '0501234567' }, ALLOW, ctx);
  assert.equal(out.status, 'blocked');
});

test('סכימה דוחה שדה לא מוכר ושדה חובה חסר', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx();

  // ⚠ הקלט מגיע ממודל שמאזין למתקשר. שדה מוברח הוא וקטור תקיפה אמיתי.
  const extra = await execVoiceTool('create_task',
    { title: 'משימה', assigned_to_user_id: 'admin' }, ALLOW, ctx);
  assert.equal(extra.status, 'failed');
  assert.ok(/לא מוכרים/.test(extra.result.message));

  const missing = await execVoiceTool('create_task', { description: 'בלי כותרת' }, ALLOW, ctx);
  assert.equal(missing.status, 'failed');

  const badPriority = await execVoiceTool('create_task',
    { title: 'משימה', priority: 'catastrophic' }, ALLOW, ctx);
  assert.equal(badPriority.status, 'failed');

  assert.equal(ctx.db.tasks.length, 0);
});

// ============================================================
// 7. העברת שיחה — הגנת לולאת הניתוב
// ============================================================

test('transfer_call ללא מספר העברה נכשל ומפנה לבקשת חזרה', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({ settings: { public_office_phone: '0552745790' } });

  const out = await execVoiceTool('transfer_call', { reason: 'ביקש נציג' }, ALLOW, ctx);
  assert.equal(out.status, 'failed');
  assert.ok(/request_human_callback/.test(out.result.message));
});

test('transfer_call למספר הציבורי נחסם — לולאת ניתוב', async () => {
  const { execVoiceTool } = await TOOLS();
  // ⚠ התרחיש המדויק שהמפרט מזהיר מפניו: השיחה הופנתה מ-0552745790 אל
  // ה-AI. העברה חזרה לאותו מספר מחזירה אותה לעצמה.
  const ctx = makeCtx({
    settings: { public_office_phone: '0552745790', human_transfer_number: '055-274-5790' },
  });

  const out = await execVoiceTool('transfer_call', {}, ALLOW, ctx);
  assert.equal(out.status, 'failed');
  assert.ok(/לולאת ניתוב/.test(out.result.message));
});

test('transfer_call למספר שונה מותר', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({
    settings: { public_office_phone: '0552745790', human_transfer_number: '0501112222' },
    isSimulation: false,
  });

  const out = await execVoiceTool('transfer_call', { reason: 'ביקש נציג' }, ALLOW, ctx);
  assert.equal(out.status, 'success');
  assert.equal(out.result.data.transfer_requested, true);
});

test('send_message אינו מתחזה לשליחה כשאין ספק', async () => {
  const { execVoiceTool } = await TOOLS();
  const out = await execVoiceTool('send_message', { text: 'הודעה' }, ALLOW, makeCtx());
  assert.equal(out.status, 'failed');
  assert.ok(/לא הוגדר ספק/.test(out.result.message));
});

// ============================================================
// 8. חתימת HMAC
// ============================================================

test('חתימה תקינה מתקבלת', async () => {
  const { signRequest, verifySignature } = await SIGNING();
  const body = JSON.stringify({ action: 'call.start', from: '0501234567' });
  const now = 1_800_000_000;
  const sig = await signRequest('s3cr3t', String(now), 'nonce-1', body);

  const r = await verifySignature('s3cr3t',
    { officeId: 'o', timestamp: String(now), nonce: 'nonce-1', signature: sig }, body, now);
  assert.equal(r.ok, true);
});

test('חתימה שגויה נדחית', async () => {
  const { signRequest, verifySignature } = await SIGNING();
  const body = '{"action":"call.start"}';
  const now = 1_800_000_000;
  const sig = await signRequest('s3cr3t', String(now), 'n1', body);

  const wrongSecret = await verifySignature('wrong',
    { officeId: 'o', timestamp: String(now), nonce: 'n1', signature: sig }, body, now);
  assert.equal(wrongSecret.ok, false);
  assert.equal(wrongSecret.code, 'bad_signature');

  // ⚠ הגוף חתום, ולא רק הכותרות: בלי זה אפשר היה לקחת בקשה לגיטימית
  // ולהחליף בה את מספר המתקשר.
  const tampered = await verifySignature('s3cr3t',
    { officeId: 'o', timestamp: String(now), nonce: 'n1', signature: sig },
    '{"action":"call.start","from":"0509999999"}', now);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.code, 'bad_signature');
});

test('בקשה שפג תוקפה נדחית — לשני הכיוונים', async () => {
  const { signRequest, verifySignature, SIGNATURE_WINDOW_SECONDS } = await SIGNING();
  const body = '{}';
  const ts = 1_800_000_000;
  const sig = await signRequest('s', String(ts), 'n', body);
  const h = { officeId: 'o', timestamp: String(ts), nonce: 'n', signature: sig };

  const old = await verifySignature('s', h, body, ts + SIGNATURE_WINDOW_SECONDS + 1);
  assert.equal(old.ok, false);
  assert.equal(old.code, 'expired');

  // שעון שרת שרץ קדימה — חריגה לכיוון השני היא חריגה גם היא.
  const future = await verifySignature('s', h, body, ts - SIGNATURE_WINDOW_SECONDS - 1);
  assert.equal(future.ok, false);
  assert.equal(future.code, 'expired');

  const inWindow = await verifySignature('s', h, body, ts + SIGNATURE_WINDOW_SECONDS - 1);
  assert.equal(inWindow.ok, true);
});

/**
 * ⚠ תאימות בין השפות.
 *
 * שרת הקול חותם ב-Python, ה-CRM מאמת ב-TypeScript. חוסר התאמה בבייט
 * אחד — קידוד, סדר, רווח — הופך **כל** בקשה משרת הקול ל-401, וזה נראה
 * למי שמאבחן כמו "השרת לא עונה" ולא כמו "החתימה לא תואמת". גוף בעברית
 * נבדק במפורש: זה המקום שבו קידוד UTF-8 שגוי היה מתגלה.
 *
 * מדולג בסביבה בלי Python — ה-CRM עצמו אינו תלוי בו.
 */
test('חתימת Python מתקבלת ע"י המאמת של ה-CRM', async (t) => {
  const { execFileSync } = require('node:child_process');
  const { signRequest, verifySignature } = await SIGNING();

  const cases = [
    { secret: 's3cr3t', ts: '1800000000', nonce: 'abc123', body: '{"action":"heartbeat"}' },
    { secret: 'long-secret-with-dashes', ts: '1', nonce: 'n', body: '' },
    { secret: 'סוד', ts: '1799999999', nonce: 'ז', body: '{"from":"ישראל ישראלי"}' },
  ];

  for (const c of cases) {
    let pySig;
    try {
      pySig = execFileSync('python', ['-c', [
        'import sys, json',
        "sys.path.insert(0, 'services/voice-gateway/orchestrator')",
        'from app.security.signer import sign',
        'a = json.loads(sys.stdin.read())',
        'print(sign(a["secret"], a["ts"], a["nonce"], a["body"]))',
      ].join(NL)], {
        input: JSON.stringify(c), encoding: 'utf8', cwd: ROOT,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      }).trim();
    } catch (e) {
      t.skip('Python אינו זמין בסביבה הזו');
      return;
    }

    const jsSig = await signRequest(c.secret, c.ts, c.nonce, c.body);
    assert.equal(pySig, jsSig, `החתימות נבדלות עבור גוף: ${c.body}`);

    const verdict = await verifySignature(c.secret,
      { officeId: 'o', timestamp: c.ts, nonce: c.nonce, signature: pySig },
      c.body, Number(c.ts));
    assert.equal(verdict.ok, true, 'חתימת Python נדחתה ע"י המאמת');
  }
});

test('כותרות חסרות נדחות לפני כל בדיקה אחרת', async () => {
  const { verifySignature } = await SIGNING();
  const r = await verifySignature('s',
    { officeId: 'o', timestamp: '', nonce: '', signature: '' }, '{}', 1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'missing_headers');
});

test('חותמת זמן שאינה מספר נדחית', async () => {
  const { verifySignature } = await SIGNING();
  const r = await verifySignature('s',
    { officeId: 'o', timestamp: 'now', nonce: 'n', signature: 'x' }, '{}', 1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_timestamp');
});

// ============================================================
// 9. מנוע דחיפות
// ============================================================

test('מונח חירום מעלה דחיפות, אבל לא מעבר לתקרה', async () => {
  const { scoreUrgency } = await URGENCY();
  const v = scoreUrgency({
    transcript: 'קיבלתי היום עיקול בחשבון הבנק', todayISO: '2026-08-22',
  });
  assert.equal(v.urgency, 'high');
  assert.ok(v.matchedKeywords.includes('עיקול'));
  // ⚠ critical פירושו להעיר אדם. מילת מפתח לבדה לא מספיקה לכך.
  assert.ok(v.urgency !== 'critical');
});

test('מונח בהקשר היפותטי אינו מסמן חירום', async () => {
  const { scoreUrgency } = await URGENCY();
  // זו הבדיקה שמונעת את הכשל שהופך את סימון הדחיפות לחסר ערך: אחרי
  // שבוע של התראות שווא, השיחה שבאמת דחופה נבלעת.
  const v = scoreUrgency({
    transcript: 'רציתי לשאול אם אתם מטפלים בעיקול', todayISO: '2026-08-22',
  });
  assert.equal(v.urgency, 'normal');
  assert.equal(v.matchedKeywords.length, 0);
});

test('סיווג המודל גובר כשהוא חמור יותר, ולא מוריד דחיפות', async () => {
  const { scoreUrgency } = await URGENCY();

  const up = scoreUrgency({
    transcript: 'יש לי בעיה', modelUrgency: 'critical', todayISO: '2026-08-22',
  });
  assert.equal(up.urgency, 'critical');

  // ⚠ מודל שמזלזל לא יכול להוריד דחיפות שמונח חד-משמעי הצדיק.
  const down = scoreUrgency({
    transcript: 'קיבלתי צו פינוי', modelUrgency: 'low', todayISO: '2026-08-22',
  });
  assert.equal(down.urgency, 'high');
});

test('מועד היום מעלה ל-critical, מועד קרוב ל-high', async () => {
  const { scoreUrgency } = await URGENCY();

  const today = scoreUrgency({
    transcript: 'יש לי דיון', deadlineISO: '2026-08-22', todayISO: '2026-08-22',
  });
  assert.equal(today.urgency, 'critical');

  const soon = scoreUrgency({
    transcript: 'צריך להגיש מסמך', deadlineISO: '2026-08-24', todayISO: '2026-08-22',
  });
  assert.equal(soon.urgency, 'high');

  // מועד רחוק אינו מעלה כלום.
  const far = scoreUrgency({
    transcript: 'צריך להגיש מסמך', deadlineISO: '2026-12-01', todayISO: '2026-08-22',
  });
  assert.equal(far.urgency, 'normal');
});

test('כללי דחיפות ניתנים להחלפה מההגדרות', async () => {
  const { scoreUrgency } = await URGENCY();
  const v = scoreUrgency(
    { transcript: 'יש בעיה עם הרישיון שלי', todayISO: '2026-08-22' },
    { keywords: { high: ['רישיון'] } },
  );
  assert.equal(v.urgency, 'high');
  assert.ok(v.matchedKeywords.includes('רישיון'));
});

test('כל סיווג מגיע עם נימוק קריא', async () => {
  const { scoreUrgency } = await URGENCY();
  const quiet = scoreUrgency({ transcript: 'שלום, רק רציתי לברר משהו', todayISO: '2026-08-22' });
  assert.ok(quiet.reasons.length > 0, 'סיווג בלי נימוק אינו ניתן לערעור');
});

test('guessCategory מסווג נושאים נפוצים', async () => {
  const { guessCategory } = await URGENCY();
  assert.equal(guessCategory('קיבלתי עיקול בחשבון'), 'הוצאה לפועל');
  assert.equal(guessCategory('אני רוצה להתגרש'), 'משפחה');
  assert.equal(guessCategory('פיטרו אותי בלי שימוע'), 'עבודה');
  assert.equal(guessCategory('שלום, מה שלומך'), 'כללי');
});

// ============================================================
// 10. המתכנן (מצב הדגמה) — אותו נתיב כמו שיחה אמיתית
// ============================================================

const SIM_TOOLS = [
  'lookup_client', 'lookup_lead', 'create_lead', 'create_task',
  'create_note', 'check_calendar', 'create_appointment', 'request_human_callback',
].map((name) => ({ name, description: '', input_schema: {} }));

function turnReq(history, over) {
  return Object.assign({
    systemPrompt: '', history, tools: SIM_TOOLS,
    model: 'test', temperature: 0.3, callerPhone: '+972501234567',
  }, over || {});
}

test('המתכנן מתחיל תמיד בזיהוי המתקשר', async () => {
  const { MockVoiceLlm } = await LLM();
  const llm = new MockVoiceLlm();
  const r = await llm.turn(turnReq([{ role: 'caller', text: 'שלום, יש לי עיקול' }]));
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, 'lookup_client');
});

/**
 * מריץ את המתכנן כלולאה, בדיוק כפי שה-orchestrator עושה: כל קריאת כלי
 * חוזרת כ-tool_result להיסטוריה, והמתכנן ממשיך משם. עוצר כשהסוכן דיבר.
 */
async function runTurns(llm, history, called, maxSteps) {
  for (let i = 0; i < (maxSteps || 8); i++) {
    const r = await llm.turn(turnReq(history));
    if (!r.toolCalls.length) { history.push({ role: 'agent', text: r.text }); return r; }
    for (const tc of r.toolCalls) {
      called.push(tc.name);
      history.push({ role: 'tool_call', id: tc.id, name: tc.name, input: tc.input });
      history.push({
        role: 'tool_result', id: tc.id, name: tc.name, ok: true,
        message: 'בוצע', data: fakeToolData(tc.name),
      });
    }
  }
  return null;
}

test('שיחה דחופה: משימת החזרה נוצרת לפני ששואלים לשם', async () => {
  const { MockVoiceLlm } = await LLM();
  const llm = new MockVoiceLlm({ urgency: 'high' });

  const history = [{
    role: 'caller',
    text: 'שלום, יש לי עיקול בחשבון ואני רוצה שעורך הדין יחזור אליי היום.',
  }];
  const called = [];

  const first = await runTurns(llm, history, called);

  // ⚠ הסדר הוא העיקר בבדיקה הזו. מתקשר מתוח עלול לנתק באמצע; אם היינו
  // שואלים לשם לפני שרשמנו את בקשת החזרה, פנייה דחופה הייתה נעלמת בלי
  // זכר. הטלפון כבר בידינו — הוא כל מה שדרוש כדי לחזור.
  assert.ok(called.includes('lookup_client'), 'זיהוי לקוח');
  assert.ok(called.includes('request_human_callback'), 'נוצרה בקשת חזרה');
  assert.ok(
    called.indexOf('request_human_callback') < called.indexOf('create_lead') ||
    !called.includes('create_lead'),
    'בקשת החזרה נרשמה לפני פתיחת הפנייה');
  assert.ok(/איך קוראים לך/.test(first.text), 'רק אחר כך נשאל השם');

  // המתקשר עונה — ומכאן נפתחת הפנייה ונרשמת ההערה.
  history.push({ role: 'caller', text: 'קוראים לי ישראל ישראלי' });
  await runTurns(llm, history, called);

  assert.ok(called.includes('create_lead'), 'נפתחה פנייה למתקשר לא מוכר');
  const leadCall = history.find((m) => m.role === 'tool_call' && m.name === 'create_lead');
  assert.equal(leadCall.input.name, 'ישראל ישראלי');
  assert.ok(called.includes('create_note'), 'נרשמה הערה');

  const lastAgent = history.filter((m) => m.role === 'agent').pop();
  assert.ok(lastAgent && lastAgent.text.length > 0, 'הסוכן סיים בדיבור, לא בשתיקה');
});

test('שיחה מלאה: בקשת פגישה → בדיקת יומן, הצעה, וקביעה אחרי אישור', async () => {
  const { MockVoiceLlm } = await LLM();
  const llm = new MockVoiceLlm({ urgency: 'normal' });

  const history = [{
    role: 'caller',
    text: 'היי, קוראים לי ישראל. קיבלתי היום עיקול בחשבון ואני רוצה לקבוע פגישה.',
  }];
  const called = [];
  let offered = false;

  for (let i = 0; i < 12; i++) {
    const r = await llm.turn(turnReq(history));
    if (!r.toolCalls.length) {
      history.push({ role: 'agent', text: r.text });
      if (/מועדים פנויים/.test(r.text)) {
        // המתקשר מאשר את המועד שהוצע.
        offered = true;
        history.push({ role: 'caller', text: 'כן, מתאים לי' });
        continue;
      }
      break;
    }
    for (const tc of r.toolCalls) {
      called.push(tc.name);
      history.push({ role: 'tool_call', id: tc.id, name: tc.name, input: tc.input });
      history.push({
        role: 'tool_result', id: tc.id, name: tc.name, ok: true,
        message: 'בוצע', data: fakeToolData(tc.name),
      });
    }
  }

  assert.ok(called.includes('create_lead'), 'הליד נפתח בשם שנמסר');
  const leadCall = history.find((m) => m.role === 'tool_call' && m.name === 'create_lead');
  assert.equal(leadCall.input.name, 'ישראל');
  assert.equal(leadCall.input.source, 'voice_ai');
  assert.equal(leadCall.input.category, 'הוצאה לפועל');

  assert.ok(called.includes('check_calendar'), 'נבדק יומן');
  assert.ok(offered, 'הוצעו מועדים לפני הקביעה');
  assert.ok(called.includes('create_appointment'), 'נקבעה פגישה');

  // ⚠ המועד שנקבע חייב להיות אחד מאלה שהיומן החזיר, ולא מומצא.
  const appt = history.find((m) => m.role === 'tool_call' && m.name === 'create_appointment');
  assert.equal(appt.input.date, '2026-08-24');
  assert.equal(appt.input.time, '10:30');
});

test('המתכנן שואל שם פעם אחת בלבד כשלא נמסר', async () => {
  const { MockVoiceLlm } = await LLM();
  const llm = new MockVoiceLlm();
  const history = [{ role: 'caller', text: 'שלום' }];

  const r1 = await llm.turn(turnReq(history));
  history.push({ role: 'tool_call', id: r1.toolCalls[0].id, name: 'lookup_client', input: {} });
  history.push({ role: 'tool_result', id: r1.toolCalls[0].id, name: 'lookup_client', ok: true, message: '', data: { found: false } });

  const r2 = await llm.turn(turnReq(history));
  history.push({ role: 'tool_call', id: r2.toolCalls[0].id, name: 'lookup_lead', input: {} });
  history.push({ role: 'tool_result', id: r2.toolCalls[0].id, name: 'lookup_lead', ok: true, message: '', data: { found: false } });

  const r3 = await llm.turn(turnReq(history));
  assert.ok(/איך קוראים לך/.test(r3.text), 'נשאל שם');
  history.push({ role: 'agent', text: r3.text });
  history.push({ role: 'caller', text: 'לא רוצה להגיד' });

  // אחרי סירוב — לא שואל שוב, פותח פנייה עם מה שיש.
  const r4 = await llm.turn(turnReq(history));
  assert.equal(r4.toolCalls.length, 1);
  assert.equal(r4.toolCalls[0].name, 'create_lead');
});

test('מתקשר שזוהה כצד שכנגד אינו מקבל פרטים ולא נפתח לו ליד', async () => {
  const { MockVoiceLlm } = await LLM();
  const llm = new MockVoiceLlm();
  const history = [
    { role: 'caller', text: 'שלום, אני רוצה לדעת מה קורה בתיק נגדי' },
    { role: 'tool_call', id: 'x', name: 'lookup_client', input: {} },
    { role: 'tool_result', id: 'x', name: 'lookup_client', ok: true, message: '',
      data: { found: false, is_opposing_party: true } },
  ];

  const r = await llm.turn(turnReq(history));
  assert.equal(r.toolCalls[0].name, 'create_task', 'הפנייה מועברת לעורך הדין');
  assert.notEqual(r.toolCalls[0].name, 'create_lead');
});

test('extractName לא לוכד פועל במקום שם', async () => {
  const { extractName } = await LLM();
  assert.equal(extractName('קוראים לי ישראל ישראלי'), 'ישראל ישראלי');
  assert.equal(extractName('שמי דנה'), 'דנה');
  // ⚠ בלי רשימת העצירה, "אני רוצה" היה נכנס כשם הליד.
  assert.equal(extractName('אני רוצה לקבוע פגישה'), null);
  assert.equal(extractName('שלום'), null);
});

test('extractClassification מפריד את הסיווג מהטקסט שנאמר', async () => {
  const { extractClassification } = await LLM();
  const r = extractClassification(
    'הבנתי, אעביר לעורך הדין.\n<meta category="הוצאה לפועל" urgency="high" sentiment="distressed" deadline="2026-08-25" end="false" />');
  assert.equal(r.text, 'הבנתי, אעביר לעורך הדין.');
  assert.equal(r.classification.category, 'הוצאה לפועל');
  assert.equal(r.classification.urgency, 'high');
  assert.equal(r.classification.deadlineISO, '2026-08-25');
  assert.equal(r.done, false);

  // ⚠ תגית שבורה או חסרה לא מוחקת את מה שנאמר למתקשר.
  const noMeta = extractClassification('רק טקסט');
  assert.equal(noMeta.text, 'רק טקסט');
  assert.deepEqual(noMeta.classification, {});
});

test('toAnthropicMessages ממזג בלוקים עוקבים לפי כללי ה-API', async () => {
  const { toAnthropicMessages } = await LLM();
  const msgs = toAnthropicMessages([
    { role: 'caller', text: 'שלום' },
    { role: 'tool_call', id: 'a', name: 't1', input: {} },
    { role: 'tool_call', id: 'b', name: 't2', input: {} },
    { role: 'tool_result', id: 'a', name: 't1', ok: true, message: 'ok' },
    { role: 'tool_result', id: 'b', name: 't2', ok: true, message: 'ok' },
    { role: 'agent', text: 'סיימתי' },
  ]);

  // ⚠ ה-API דוחה הודעות assistant רצופות ודורש שכל tool_result יחזור
  // בהודעת user. מיזוג שגוי כאן מפיל כל שיחה חיה.
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content.length, 2, 'שתי קריאות הכלי מוזגו');
  assert.equal(msgs[2].role, 'user');
  assert.equal(msgs[2].content.length, 2, 'שתי התוצאות מוזגו');
  assert.equal(msgs[3].role, 'assistant');
});

function fakeToolData(name) {
  if (name === 'lookup_client') return { found: false };
  if (name === 'lookup_lead') return { found: false };
  if (name === 'create_lead') return { created: true, lead_id: 'l1' };
  if (name === 'check_calendar') {
    return { slots: [{ date: '2026-08-24', time: '10:30' }, { date: '2026-08-24', time: '12:00' }] };
  }
  if (name === 'create_appointment') return { created: true, date: '2026-08-24', time: '10:30' };
  if (name === 'create_task') return { created: true, task_id: 't1' };
  if (name === 'request_human_callback') return { created: true, task_id: 't2' };
  return {};
}

// ============================================================
// 11. אידמפוטנטיות של מפתח הפעולה
// ============================================================

test('canonicalize נותן אותו מפתח לאותו קלט בסדר שונה', async () => {
  const { canonicalize } = await load('supabase/functions/_shared/voice/gateway.ts');
  // ⚠ זה מה שמונע פגישה כפולה: retry שמגיע עם אותם שדות בסדר אחר חייב
  // לייצר את אותו idempotency_key.
  assert.equal(
    JSON.stringify(canonicalize({ b: 2, a: 1 })),
    JSON.stringify(canonicalize({ a: 1, b: 2 })));

  // שדות ריקים מושמטים — "" ו-undefined מהמודל אינם הבדל אמיתי.
  assert.equal(
    JSON.stringify(canonicalize({ a: 1, note: '' })),
    JSON.stringify(canonicalize({ a: 1 })));

  // קלט שונה באמת → מפתח שונה.
  assert.notEqual(
    JSON.stringify(canonicalize({ time: '10:30' })),
    JSON.stringify(canonicalize({ time: '12:00' })));
});

// ============================================================
// 12. RLS — בדיקה סטטית של המיגרציה
// ============================================================
//
// ⚠ אי אפשר לאכוף RLS בלי Postgres, אבל אפשר לאכוף את **הכוונה**: אם
// מישהו יוסיף בעתיד policy של insert לטבלת שיחות, הדפדפן יוכל להמציא
// שיחות מלקוחות — והבדיקה הזו תיפול לפני שזה יגיע לייצור. זו בדיוק
// הטעות שקל לעשות ("צריך להוסיף שורה מהמסך") ובלתי אפשרי להבחין בה
// אחר כך.

const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260822000000_call_center.sql'), 'utf8');

const CALL_DATA_TABLES = ['call_sessions', 'call_transcript_segments', 'call_events', 'call_actions'];
const CONFIG_TABLES = ['phone_lines', 'voice_agents', 'agent_tools', 'call_center_settings'];
const ALL_TABLES = CALL_DATA_TABLES.concat(CONFIG_TABLES,
  ['voice_gateway_status', 'voice_request_nonces', 'voice_rate_limits']);

test('RLS מופעל על כל טבלה של מרכז השיחות', () => {
  for (const t of ALL_TABLES) {
    assert.ok(
      MIGRATION.includes(`alter table public.${t} enable row level security`),
      `RLS לא הופעל על ${t}`);
  }
});

test('טבלאות השיחה אינן ניתנות לכתיבה מהדפדפן', () => {
  for (const t of CALL_DATA_TABLES) {
    const policies = [...MIGRATION.matchAll(
      new RegExp(`create policy "[^"]+" on public\\.${t}\\s+for (\\w+)`, 'g'))]
      .map((m) => m[1]);
    assert.ok(policies.length > 0, `אין policy כלל על ${t}`);
    assert.deepEqual(policies, ['select'],
      `${t} חייבת להיות קריאה בלבד מהדפדפן; נמצא: ${policies.join(', ')}`);
  }
});

test('טבלאות ההגדרה ניתנות לעריכה לבעל המשרד בלבד', () => {
  for (const t of CONFIG_TABLES) {
    const write = MIGRATION.match(
      new RegExp(`create policy "[^"]+" on public\\.${t}\\s+for all using \\(([^)]+)\\)`));
    assert.ok(write, `אין policy כתיבה על ${t}`);
    assert.ok(/is_office_owner/.test(write[1]),
      `כתיבה ל-${t} חייבת להיות מוגבלת לבעל המשרד`);
  }
});

test('כל קריאה מסוננת לפי חברות במשרד', () => {
  const selects = [...MIGRATION.matchAll(
    /create policy "[^"]+" on public\.(\w+)\s+for select using \(([^)]+)\)/g)];
  assert.ok(selects.length >= ALL_TABLES.length - 2, 'חסרות מדיניויות קריאה');
  for (const [, table, expr] of selects) {
    assert.ok(/is_office_member/.test(expr),
      `קריאה מ-${table} אינה מסוננת לפי משרד`);
  }
});

test('טבלאות הפנימיות של האבטחה אינן חשופות לדפדפן כלל', () => {
  // nonces ו-rate limits: service_role בלבד. policy כלשהי עליהן פירושה
  // שדפדפן יכול לקרוא או למחוק אותן — ולעקוף בכך את הגנת ה-replay.
  for (const t of ['voice_request_nonces', 'voice_rate_limits']) {
    assert.ok(!new RegExp(`create policy "[^"]+" on public\\.${t}`).test(MIGRATION),
      `${t} לא אמורה להיות נגישה מהדפדפן`);
  }
});

test('פונקציות security definer מוודאות חברות במשרד', () => {
  // ⚠ security definer עוקף RLS. בלי בדיקה מפורשת בגוף הפונקציה, כל
  // משתמש מחובר היה יכול לשלוח מזהה של משרד אחר ולקבל את המונים שלו.
  const stats = MIGRATION.slice(MIGRATION.indexOf('function public.call_center_stats'));
  assert.ok(/if not is_office_member\(p_office_id\)/.test(stats.slice(0, 1500)),
    'call_center_stats חייבת לאמת חברות במשרד');
});

test('הקלטה כבויה כברירת מחדל ואין מחיקה אוטומטית', () => {
  assert.ok(/recording_enabled boolean not null default false/.test(MIGRATION));
  assert.ok(/recording_status text not null default 'disabled'/.test(MIGRATION));
  // 0 = ללא מחיקה. שינוי ברירת המחדל הזו הוא מחיקת ראיות בתיק משפטי.
  assert.ok(/transcript_retention_days int not null default 0/.test(MIGRATION));
  assert.ok(/retention_enforcement boolean not null default false/.test(MIGRATION));
});

test('אילוצי אידמפוטנטיות קיימים ברמת הסכמה', () => {
  // בלי אלה, retry של שרת הקול היה יוצר שיחה, קטע תמלול או פעולה כפולים —
  // וכל ההגנה בקוד היא רק שכבה שנייה.
  assert.ok(/unique \(office_id, external_call_id\)/.test(MIGRATION));
  assert.ok(/unique \(call_id, sequence\)/.test(MIGRATION));
  assert.ok(/unique \(call_id, idempotency_key\)/.test(MIGRATION));
});

test('הקו הראשי נזרע כלא-מוגדר ולא כמחובר', () => {
  const seed = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260822000001_call_center_seed.sql'), 'utf8');
  assert.ok(seed.includes('0552745790'));
  assert.ok(seed.includes('המספר הראשי של המשרד'));
  // הצגת "מחובר" כשאין ספק טלפוניה = שיחות שנופלות בלי שאיש יודע.
  assert.ok(/'not_configured', 'not_configured'/.test(seed));
  // transfer_call ו-send_message חייבים להיזרע כלא-זמינים.
  assert.ok(/\('transfer_call',\s+true,\s+true,\s+'high',\s+false/.test(seed));
  assert.ok(/\('send_message',\s+true,\s+true,\s+'high',\s+false/.test(seed));
});
