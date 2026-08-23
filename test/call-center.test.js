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
const COMMANDS = () => load('supabase/functions/_shared/voice/commands.ts');
const READINESS = () => load('supabase/functions/_shared/voice/readiness.ts');
const PHONE = () => load('supabase/functions/_shared/voice/phone.ts');
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
    // ⚠ writeDb מדמה את saveOfficeDb: הוא מריץ את המוטציה על ה-blob
    // הנוכחי. הבדיקות לא עוקפות את נתיב הכתיבה, הן רק מחליפות את
    // היעד שלו — ולכן כל בדיקת כפילות כאן בודקת את הקוד שירוץ באמת.
    writeDb: async (mutate) => { mutate(state.db); return state.db; },
    reload: async () => state.db,
  }, over || {});
  Object.defineProperty(ctx, 'db', { get: () => state.db, configurable: true });
  ctx._state = state;
  return ctx;
}

/**
 * הקשר עם רישום פקודות.
 *
 * ⚠ נדרש לכל כלי שכותב: runCommand נכשל במפורש בלי רישום, כדי
 * שאידמפוטנטיות לא תיעלם בשקט בייצור. הרישום בזיכרון מממש את **אותה**
 * סמנטיקה של הרישום ב-DB, ולכן הבדיקות בודקות התנהגות אמיתית ולא
 * חיקוי שלה.
 */
async function makeWritableCtx(over) {
  const { memoryCommandStore } = await COMMANDS();
  const ctx = makeCtx(over);
  ctx.commandStore = (over && over.commandStore) || memoryCommandStore();
  ctx.agentId = 'agent-1';
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
  const ctx = await makeWritableCtx({
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
  // ⚠ 'blocked' ולא 'failed': זו מדיניות שסירבה, לא פעולה שהשתבשה.
  // ההבחנה מגיעה עד המסך — ⛔ "נחסמה" עם הסיבה, במקום 🔴 "נכשלה"
  // שנקרא כמו תקלה שצריך לתקן.
  assert.equal(lead.status, 'blocked');
  assert.ok(/צד שכנגד/.test(lead.result.message));
  assert.equal(ctx.db.leads.length, 0, 'לא נפתח ליד עבור הצד שכנגד');
});

// ============================================================
// 2. יצירת ליד
// ============================================================

test('create_lead פותח פנייה עם source=voice_ai ומספר מנורמל', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = await makeWritableCtx();

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
  const ctx = await makeWritableCtx({
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
  const ctx = await makeWritableCtx({ db: { clients: [{ id: 'c1', name: 'ותיק', phone: '0501234567' }] } });

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
  const ctx = await makeWritableCtx({
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
  const ctx = await makeWritableCtx({ db: { tasks: [{ id: 't1', text: 'לחזור ללקוח', caseId: '', done: false }] } });

  const out = await execVoiceTool('create_task', { title: 'לחזור ללקוח' }, ALLOW, ctx);
  assert.equal(out.status, 'success');
  assert.equal(out.result.data.created, false);
  assert.equal(ctx.db.tasks.length, 1);
});

test('request_human_callback יוצר משימת חזרה דחופה ליום הנוכחי', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = await makeWritableCtx({ db: { clients: [{ id: 'c1', name: 'ישראל ישראלי' }] }, clientId: 'c1' });

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
  const ctx = await makeWritableCtx({
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
  const ctx = await makeWritableCtx({
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
  const ctx = await makeWritableCtx({ db: { clients: [{ id: 'c1', name: 'ישראל' }] }, clientId: 'c1' });

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
  const ctx = await makeWritableCtx({ db: { events: [{ id: 'e1', date, time: '10:00', title: 'דיון' }] } });

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
  const ctx = await makeWritableCtx();

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
  const ctx = await makeWritableCtx();

  const out = await execVoiceTool('create_task', { title: 'משימה' }, null, ctx);
  assert.equal(out.status, 'blocked');
  assert.equal(ctx.db.tasks.length, 0);
});

test('כלי מושבת וכלי לא-זמין נחסמים, עם סיבות שונות', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = await makeWritableCtx();

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
  const ctx = await makeWritableCtx();

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

// ============================================================
// 13. קונקורנטיות — משתמש וסוכן כותבים יחד
// ============================================================
//
// ⚠ זו הבדיקה שמגנה על הנכס היקר ביותר במערכת. כל ה-CRM הוא jsonb יחיד,
// וכתיבה היא read-modify-write על שורה שלמה. אם המוטציה של הסוכן הייתה
// "כתוב את הבלוב שקראתי", עריכה של עורך הדין באותה שנייה הייתה נמחקת
// בלי שאיש ידע. הבדיקה מדמה בדיוק את המרוץ הזה.

/**
 * מדמה את saveOfficeDb: קורא, מחיל את המוטציה, וכותב **רק** אם הגרסה
 * לא זזה. `onFirstRead` מזריק כתיבה מקבילה, כמו משתמש ששמר בינתיים.
 */
function makeConcurrentWriter(state, onFirstRead) {
  let reads = 0;
  const stats = { attempts: 0 };
  return {
    stats,
    write: async (mutate) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        stats.attempts++;
        const versionAtRead = state.version;
        // עותק עמוק — saveOfficeDb מקבל blob טרי מהשרת בכל ניסיון.
        const draft = JSON.parse(JSON.stringify(state.db));

        if (reads++ === 0 && onFirstRead) onFirstRead(state);

        mutate(draft);

        if (state.version === versionAtRead) {
          state.db = draft;
          state.version++;
          return state.db;
        }
        // הגרסה זזה → מישהו כתב בינתיים → קוראים מחדש ומחילים שוב.
      }
      throw new Error('write_conflict');
    },
  };
}

test('שינוי של משתמש ושינוי של הסוכן — שניהם שורדים', async () => {
  const { applyOfficeCommand, memoryCommandStore } = await COMMANDS();

  const state = {
    version: 1,
    db: makeDb({ clients: [{ id: 'c1', name: 'ישראל', notes: 'הערה מקורית' }] }),
  };

  // ⚠ בזמן שהסוכן מחיל את הפקודה, עורך הדין שומר עריכה בכרטיס הלקוח.
  const writer = makeConcurrentWriter(state, (st) => {
    st.db.clients[0].notes = 'עורך הדין ערך את הכרטיס';
    st.db.clients[0].phone = '050-9999999';
    st.version++;
  });

  const result = await applyOfficeCommand({
    commandId: 'cmd-1', callId: 'call-1', idempotencyKey: 'k-concurrent',
    type: 'create_task',
    payload: { title: 'לחזור ללקוח', client_id: 'c1' },
    actor: { type: 'agent' },
  }, { store: memoryCommandStore(), write: writer.write });

  assert.equal(result.ok, true);
  // המוטציה הורצה פעמיים: פעם ראשונה נדחתה, פעם שנייה על נתונים טריים.
  assert.equal(result.conflictRetries, 1, 'זוהתה התנגשות אחת');
  assert.ok(writer.stats.attempts >= 2);

  // ⚠ שני השינויים קיימים. זה כל העניין.
  assert.equal(state.db.clients[0].notes, 'עורך הדין ערך את הכרטיס',
    'עריכת המשתמש לא נדרסה');
  assert.equal(state.db.clients[0].phone, '050-9999999');
  assert.equal(state.db.tasks.length, 1, 'המשימה של הסוכן נשמרה');
  assert.equal(state.db.tasks[0].text, 'לחזור ללקוח');
});

test('התנגשות חוזרת מדווחת ולא נבלעת', async () => {
  const { applyOfficeCommand, memoryCommandStore } = await COMMANDS();
  const state = { version: 1, db: makeDb() };
  // כותב שנכשל תמיד — כמו עומס עריכה מתמשך.
  const write = async () => { throw new Error('write_conflict'); };

  await assert.rejects(
    applyOfficeCommand({
      commandId: 'c', callId: null, idempotencyKey: 'k-always-conflict',
      type: 'create_task', payload: { title: 'משימה' }, actor: { type: 'agent' },
    }, { store: memoryCommandStore(), write }),
    /write_conflict/);
  assert.equal(state.db.tasks.length, 0);
});

// ============================================================
// 14. אידמפוטנטיות
// ============================================================

test('אותו tool_call_id פעמיים — פעולה אחת בלבד', async () => {
  const { execVoiceTool } = await TOOLS();
  const { memoryCommandStore } = await COMMANDS();
  const store = memoryCommandStore();

  const ctx = await makeWritableCtx({ commandStore: store });
  ctx.toolCallId = 'toolu_abc123';

  const first = await execVoiceTool('create_task',
    { title: 'לבדוק את התיק' }, ALLOW, ctx);
  const second = await execVoiceTool('create_task',
    { title: 'לבדוק את התיק' }, ALLOW, ctx);

  assert.equal(first.status, 'success');
  assert.equal(second.status, 'success');
  assert.equal(first.result.data.replayed, false);
  // ⚠ הפעם השנייה מוחזרת מהרישום ולא מבוצעת. זה מה שהופך retry אחרי
  // timeout לבטוח.
  assert.equal(second.result.data.replayed, true, 'הפעולה השנייה שוחזרה');
  assert.equal(ctx.db.tasks.length, 1, 'נוצרה משימה אחת בלבד');
  assert.equal(second.result.entityId, first.result.entityId, 'אותה משימה הוחזרה');
});

test('פגישה: retry עם אותו tool_call_id אינו יוצר כפילות', async () => {
  const { execVoiceTool } = await TOOLS();
  const { memoryCommandStore } = await COMMANDS();
  const date = nextWeekday(3);
  const ctx = await makeWritableCtx({ commandStore: memoryCommandStore() });
  ctx.toolCallId = 'toolu_appt_1';

  const a = await execVoiceTool('create_appointment', { date, time: '11:00' }, ALLOW, ctx);
  const b = await execVoiceTool('create_appointment', { date, time: '11:00' }, ALLOW, ctx);

  assert.equal(a.status, 'success', a.result.message);
  assert.equal(b.status, 'success', b.result.message);
  assert.equal(ctx.db.events.length, 1, 'נקבעה פגישה אחת בלבד');
  assert.equal(b.result.data.replayed, true);
  assert.equal(b.result.entityId, a.result.entityId);
});

test('בקשה חדשה עם tool_call_id אחר — פעולה חדשה, לא כפילות שנחסמה', async () => {
  const { execVoiceTool } = await TOOLS();
  const { memoryCommandStore } = await COMMANDS();
  const date = nextWeekday(3);
  const ctx = await makeWritableCtx({ commandStore: memoryCommandStore() });

  // ⚠ מתקשר שביקש באמת שתי פגישות. אילו המפתח לא כלל את tool_call_id,
  // השנייה הייתה נחסמת כ"כפילות" והלקוח היה מקבל אחת.
  ctx.toolCallId = 'toolu_1';
  const a = await execVoiceTool('create_appointment', { date, time: '11:00' }, ALLOW, ctx);
  ctx.toolCallId = 'toolu_2';
  const b = await execVoiceTool('create_appointment', { date, time: '14:00' }, ALLOW, ctx);

  assert.equal(a.status, 'success');
  assert.equal(b.status, 'success', b.result.message);
  assert.equal(ctx.db.events.length, 2, 'שתי פגישות שונות נקבעו');
});

test('רישום פקודות חסר נכשל במפורש ולא כותב בשקט', async () => {
  const { execVoiceTool } = await TOOLS();
  // ⚠ ctx בלי commandStore ובלי sb. אילו הקוד היה יוצר רישום חדש בשקט,
  // אידמפוטנטיות הייתה נעלמת בייצור בלי שאיש ישים לב.
  const ctx = makeCtx();
  const out = await execVoiceTool('create_task', { title: 'משימה' }, ALLOW, ctx);
  assert.equal(out.status, 'failed');
  assert.ok(/אידמפוטנטיות/.test(out.result.message), out.result.message);
  assert.equal(ctx.db.tasks.length, 0);
});

// ============================================================
// 15. בקשת חזרה
// ============================================================

test('request_human_callback יוצר metadata מובנה ומלא', async () => {
  const { execVoiceTool } = await TOOLS();
  const { memoryCommandStore } = await COMMANDS();
  const ctx = await makeWritableCtx({
    db: { clients: [{ id: 'c1', name: 'ישראל ישראלי' }] },
    clientId: 'c1', commandStore: memoryCommandStore(),
  });

  const out = await execVoiceTool('request_human_callback', {
    reason: 'קיבל עיקול ורוצה לדבר עם עורך הדין',
    preferred_time: 'מחר אחרי 16:00',
    urgency: 'high',
  }, ALLOW, ctx);

  assert.equal(out.status, 'success');
  const cb = ctx.db.tasks[0].callback;
  assert.ok(cb, 'נוצר metadata של בקשת חזרה');
  assert.equal(cb.status, 'waiting');
  assert.equal(cb.attemptCount, 0);
  assert.equal(cb.lastAttemptAt, null);
  assert.equal(cb.completedAt, null);
  assert.equal(cb.urgency, 'high');
  assert.equal(cb.callerName, 'ישראל ישראלי');
  assert.equal(cb.callerPhone, '+972501234567', 'המספר נשמר מנורמל');
  assert.equal(cb.preferredCallbackTime, 'מחר אחרי 16:00');
  assert.equal(cb.sourceCallId, 'call-1');
  assert.ok(cb.createdAt);
  // המשימה עצמה חייבת להיראות במסך המשימות הקיים.
  assert.equal(ctx.db.tasks[0].done, false);
  assert.equal(ctx.db.tasks[0].priority, 'urgent');
});

test('מחזור החיים של בקשת חזרה: לא ענה → נדחה → הושלם', async () => {
  const { applyOfficeCommand, memoryCommandStore } = await COMMANDS();
  const state = { version: 1, db: makeDb() };
  const write = async (mutate) => { mutate(state.db); return state.db; };
  const store = memoryCommandStore();
  let n = 0;
  const run = (type, payload) => applyOfficeCommand({
    commandId: 'c' + (++n), callId: 'call-1', idempotencyKey: 'k' + n,
    type, payload, actor: { type: 'user', id: 'u1' },
  }, { store, write });

  await run('create_callback', { reason: 'רוצה לדבר', phone: '0501234567', name: 'דנה' });
  const taskId = state.db.tasks[0].id;

  await run('update_callback', { task_id: taskId, status: 'no_answer' });
  let cb = state.db.tasks[0].callback;
  assert.equal(cb.status, 'no_answer');
  assert.equal(cb.attemptCount, 1, 'ניסיון נספר');
  assert.ok(cb.lastAttemptAt);
  assert.equal(state.db.tasks[0].done, false, 'המשימה נשארת פתוחה');

  await run('update_callback', { task_id: taskId, status: 'reschedule',
    preferred_time: 'מחר בבוקר' });
  cb = state.db.tasks[0].callback;
  // ⚠ "נדחה למועד אחר" אינו ניסיון חיוג. ספירתו הייתה מציגה לקוח כמי
  // שניסו להשיגו חמש פעמים כשלא ניסו כלל.
  assert.equal(cb.attemptCount, 1, 'דחייה אינה נספרת כניסיון');
  assert.equal(cb.preferredCallbackTime, 'מחר בבוקר');

  await run('update_callback', { task_id: taskId, status: 'completed' });
  cb = state.db.tasks[0].callback;
  assert.equal(cb.status, 'completed');
  assert.ok(cb.completedAt);
  // סגירת הבקשה סוגרת את המשימה — אחרת היא נשארת ברשימה לנצח.
  assert.equal(state.db.tasks[0].done, true);
});

test('בקשת חזרה כפולה מאותו מספר אינה נפתחת פעמיים', async () => {
  const { applyOfficeCommand, memoryCommandStore } = await COMMANDS();
  const state = { version: 1, db: makeDb() };
  const write = async (mutate) => { mutate(state.db); return state.db; };
  const store = memoryCommandStore();

  await applyOfficeCommand({
    commandId: 'a', callId: 'call-1', idempotencyKey: 'ka', type: 'create_callback',
    payload: { reason: 'ראשון', phone: '050-1234567' }, actor: { type: 'agent' },
  }, { store, write });

  // שיחה שנייה, מספר בפורמט אחר — עדיין אותו אדם.
  const second = await applyOfficeCommand({
    commandId: 'b', callId: 'call-2', idempotencyKey: 'kb', type: 'create_callback',
    payload: { reason: 'שני', phone: '+972501234567' }, actor: { type: 'agent' },
  }, { store, write });

  assert.equal(second.deduped, true);
  assert.equal(state.db.tasks.length, 1, 'בקשת חזרה אחת בלבד');
});

test('בקשת חזרה מועשרת כשהשם והמועד מגיעים בהמשך', async () => {
  const { applyOfficeCommand, memoryCommandStore } = await COMMANDS();
  const state = { db: makeDb() };
  const write = async (mutate) => { mutate(state.db); return state.db; };
  const store = memoryCommandStore();
  let n = 0;
  const run = (type, payload) => applyOfficeCommand({
    commandId: 'c' + (++n), callId: 'call-1', idempotencyKey: 'k' + n,
    type, payload, actor: { type: 'agent' },
  }, { store, write });

  // ⚠ הסדר בשיחה דחופה: קודם רושמים בקשת חזרה (הטלפון בידינו), רק
  // אחר כך שואלים לשם. מתקשר מתוח שינתק באמצע לא ייעלם.
  await run('create_callback', { reason: 'קיבל עיקול', phone: '0501234567', urgency: 'high' });
  let cb = state.db.tasks[0].callback;
  assert.ok(/^[\d\-+ ()]+$/.test(cb.callerName), 'בשלב זה השם הוא המספר');
  assert.ok(!/·.*·/.test(state.db.tasks[0].text), 'המספר אינו מוכפל בכותרת');

  // המתקשר מוסר שם ומועד מועדף — הקריאה השנייה משלימה ולא נזרקת.
  const second = await run('create_callback', {
    reason: 'רוצה לדבר היום', phone: '+972501234567',
    name: 'ישראל ישראלי', preferred_time: 'אחרי 16:00', urgency: 'critical',
  });

  assert.equal(second.deduped, true, 'לא נפתחה בקשה שנייה');
  assert.equal(state.db.tasks.length, 1);
  cb = state.db.tasks[0].callback;
  assert.equal(cb.callerName, 'ישראל ישראלי', 'השם הושלם');
  assert.equal(cb.preferredCallbackTime, 'אחרי 16:00', 'המועד המועדף נשמר');
  assert.ok(/ישראל ישראלי/.test(state.db.tasks[0].text), 'כותרת המשימה עודכנה');
  // דחיפות עולה בלבד: מידע חדש יכול להחמיר הערכה, לא להרגיע אותה.
  assert.equal(cb.urgency, 'critical');
  assert.ok(cb.reason.includes('קיבל עיקול') && cb.reason.includes('רוצה לדבר היום'),
    'שתי הסיבות נשמרו');
});

test('create_lead משלים את שם הפונה בבקשת חזרה פתוחה', async () => {
  const { applyOfficeCommand, memoryCommandStore } = await COMMANDS();
  const state = { db: makeDb() };
  const write = async (mutate) => { mutate(state.db); return state.db; };
  const store = memoryCommandStore();
  let n = 0;
  const run = (type, payload) => applyOfficeCommand({
    commandId: 'c' + (++n), callId: 'call-1', idempotencyKey: 'k' + n,
    type, payload, actor: { type: 'agent' },
  }, { store, write });

  await run('create_callback', { reason: 'עיקול', phone: '0501234567' });
  await run('create_lead', { name: 'דנה כהן', phone: '0501234567', source: 'voice_ai' });

  const cb = state.db.tasks[0].callback;
  // ⚠ בלי ההשלמה, רשימת "ממתינים לחזרה" הייתה מציגה מספר טלפון בזמן
  // שהשם כבר ידוע — ועורך הדין שמתקשר חזרה לא היה יודע למי הוא פונה.
  assert.equal(cb.callerName, 'דנה כהן');
  assert.ok(/דנה כהן/.test(state.db.tasks[0].text));
  assert.equal(state.db.tasks[0].leadId, state.db.leads[0].id, 'הבקשה קושרה לפנייה');
});

test('השלמה אינה דורסת שם שנמסר במפורש', async () => {
  const { applyOfficeCommand, memoryCommandStore } = await COMMANDS();
  const state = { db: makeDb() };
  const write = async (mutate) => { mutate(state.db); return state.db; };
  const store = memoryCommandStore();
  let n = 0;
  const run = (type, payload) => applyOfficeCommand({
    commandId: 'c' + (++n), callId: 'call-1', idempotencyKey: 'k' + n,
    type, payload, actor: { type: 'agent' },
  }, { store, write });

  await run('create_callback', { reason: 'עיקול', phone: '0501234567', name: 'ישראל' });
  // ⚠ ליד בשם אחר (בן משפחה שהתקשר, טעות הקלדה) לא רשאי לדרוס שם
  // שהמתקשר מסר במפורש.
  await run('create_lead', { name: 'מישהו אחר', phone: '0501234567' });
  assert.equal(state.db.tasks[0].callback.callerName, 'ישראל');
});

// ============================================================
// 16. נרמול מספרי טלפון
// ============================================================

test('normalizePhoneNumber ממיר לפורמט E.164', async () => {
  const { normalizePhoneNumber } = await PHONE();

  const mobile = normalizePhoneNumber('0501234567');
  assert.equal(mobile.normalized, '+972501234567');
  assert.equal(mobile.valid, true);
  assert.equal(mobile.kind, 'mobile');
  assert.equal(mobile.display, '050-123-4567');

  // כל הצורות שאותו אדם מופיע בהן במערכת.
  for (const raw of ['050-123-4567', '050 123 4567', '+972501234567',
                     '972501234567', '00972501234567', '(050) 123-4567']) {
    assert.equal(normalizePhoneNumber(raw).normalized, '+972501234567', raw);
  }
});

test('normalizePhoneNumber מטפל בקווים נייחים ובכל הקידומות', async () => {
  const { normalizePhoneNumber } = await PHONE();
  const cases = [
    ['021234567', '+97221234567'],
    ['031234567', '+97231234567'],
    ['041234567', '+97241234567'],
    ['081234567', '+97281234567'],
    ['091234567', '+97291234567'],
    ['0771234567', '+972771234567'],
  ];
  for (const [raw, expected] of cases) {
    const r = normalizePhoneNumber(raw);
    assert.equal(r.normalized, expected, raw);
    assert.equal(r.valid, true, `${raw} אמור להיות תקין`);
  }
});

test('normalizePhoneNumber דוחה מספרים באורך שגוי ומספרי שירות', async () => {
  const { normalizePhoneNumber } = await PHONE();

  // ⚠ נייד קצר בספרה. normalizePhone הגנרי היה מקבל אותו (הוא בודק
  // טווח אורך רחב), ולכן הסיווג כאן הוא מה שמונע בקשת חזרה למספר
  // שאי אפשר לחייג אליו.
  const short = normalizePhoneNumber('05012345');
  assert.equal(short.valid, false);
  assert.ok(/ספרות/.test(short.reason), short.reason);

  const tollFree = normalizePhoneNumber('1-800-123-456');
  assert.equal(tollFree.valid, false);
  assert.equal(tollFree.kind, 'toll_free');

  assert.equal(normalizePhoneNumber('').valid, false);
  assert.equal(normalizePhoneNumber('שלום').valid, false);
});

test('samePhoneNumber מזהה את אותו אדם בפורמטים שונים', async () => {
  const { samePhoneNumber } = await PHONE();
  assert.equal(samePhoneNumber('0501234567', '+972501234567'), true);
  assert.equal(samePhoneNumber('050-123-4567', '972501234567'), true);
  assert.equal(samePhoneNumber('0501234567', '0501234568'), false);
  assert.equal(samePhoneNumber('', '0501234567'), false);
});

test('המספר הציבורי מוגדר בפורמט E.164', async () => {
  const { OFFICE_PHONE_E164, normalizePhoneNumber, displayFromE164 } = await PHONE();
  assert.equal(OFFICE_PHONE_E164, '+972552745790');
  assert.equal(normalizePhoneNumber('0552745790').normalized, OFFICE_PHONE_E164);
  assert.equal(displayFromE164(OFFICE_PHONE_E164), '055-274-5790');
});

// ============================================================
// 17. זהות — Caller ID אינו אימות
// ============================================================

test('התאמת מספר אינה verified ואינה מספיקה לפרטי תיק', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({
    db: {
      clients: [{ id: 'c1', name: 'ישראל ישראלי', phone: '0501234567' }],
      cases: [{ id: 'm1', client: 'c1', name: 'תיק הוצאה לפועל',
                stage: 'דיון', status: 'active' }],
    },
    // ברירת המחדל של המערכת.
    identityStatus: 'phone_match', identityPolicy: 'strict',
  });

  const out = await execVoiceTool('lookup_client', { phone: '0501234567' }, ALLOW, ctx);
  assert.equal(out.status, 'success');
  assert.equal(out.result.data.found, true);
  assert.equal(out.result.data.identity_status, 'phone_match');
  assert.equal(out.result.data.may_disclose_case_details, false);

  // ⚠ שם הלקוח כן נמסר (פנייה בשם היא נוהג מקובל), אבל שם התיק ושלב
  // ההליך — לא. מה שלא נשלח לא יכול להיאמר למי שהשיג טלפון.
  const serialized = JSON.stringify(out.result);
  assert.ok(serialized.includes('ישראל ישראלי'), 'השם נמסר');
  assert.ok(!serialized.includes('תיק הוצאה לפועל'), 'שם התיק לא נמסר');
  assert.ok(!serialized.includes('דיון'), 'שלב ההליך לא נמסר');
});

test('זהות שאומתה כן מאפשרת מסירת פרטי תיק', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({
    db: {
      clients: [{ id: 'c1', name: 'ישראל ישראלי', phone: '0501234567' }],
      cases: [{ id: 'm1', client: 'c1', name: 'תיק הוצאה לפועל',
                stage: 'דיון', status: 'active' }],
    },
    identityStatus: 'verified',
  });
  const out = await execVoiceTool('lookup_client', { phone: '0501234567' }, ALLOW, ctx);
  assert.equal(out.result.data.may_disclose_case_details, true);
  assert.ok(JSON.stringify(out.result).includes('תיק הוצאה לפועל'));
});

test('מדיניות מקלה מאפשרת מסירה על סמך התאמת מספר', async () => {
  const { execVoiceTool } = await TOOLS();
  const ctx = makeCtx({
    db: {
      clients: [{ id: 'c1', name: 'ישראל', phone: '0501234567' }],
      cases: [{ id: 'm1', client: 'c1', name: 'תיק א', status: 'active' }],
    },
    identityStatus: 'phone_match', identityPolicy: 'phone_match_ok',
  });
  const out = await execVoiceTool('lookup_client', { phone: '0501234567' }, ALLOW, ctx);
  assert.equal(out.result.data.may_disclose_case_details, true);
});

// ============================================================
// 18. מוכנות לייצור
// ============================================================

function readyInput(over) {
  return Object.assign({
    gatewayState: 'online',
    gatewaySecretConfigured: true,
    components: { asterisk: 'configured', sip: 'registered' },
    providers: {
      stt: { name: 'faster-whisper', mode: 'real', healthy: true, production_ready: true },
      llm: { name: 'anthropic', mode: 'real', healthy: true, production_ready: true },
      tts: { name: 'local', mode: 'real', healthy: true, production_ready: true },
    },
    transport: 'audiosocket',
    outboxPending: 0,
    deadLetters: 0,
    phoneLine: { public_number: '+972552745790', is_active: true, sip_status: 'registered' },
    toolsEnabled: 8,
    agentActive: true,
    crmReachable: true,
    liveCallsEnabled: false,
    emergencyStop: false,
  }, over || {});
}

test('מערכת מלאה — ready=true', async () => {
  const { evaluateVoiceProductionReadiness } = await READINESS();
  const r = evaluateVoiceProductionReadiness(readyInput());
  assert.equal(r.ready, true, r.blocking_reasons.join('; '));
  assert.equal(r.blocking_reasons.length, 0);
  assert.equal(r.progress, 100);
});

test('TTS במצב הדגמה חוסם — למרות שהוא בריא', async () => {
  const { evaluateVoiceProductionReadiness } = await READINESS();
  // ⚠ הבדיקה המרכזית של כל המנוע. Mock עונה, מהיר, לא קורס — והוא
  // מחזיר שקט. מערכת שבודקת healthy בלבד הייתה מדווחת ירוק.
  const r = evaluateVoiceProductionReadiness(readyInput({
    providers: Object.assign(readyInput().providers, {
      tts: { name: 'mock', mode: 'mock', healthy: true, production_ready: false,
             message: 'מצב הדגמה' },
    }),
  }));
  assert.equal(r.ready, false);
  assert.ok(r.blocking_reasons.some(x => /הקראה/.test(x)), r.blocking_reasons.join('; '));
  const tts = r.checks.find(c => c.key === 'tts');
  assert.equal(tts.state, 'mock');
  assert.equal(tts.severity, 'blocking');
});

test('כשל סגור: מידע חסר פירושו לא מוכן', async () => {
  const { evaluateVoiceProductionReadiness } = await READINESS();

  // ⚠ never_connected אינו "כנראה בסדר" — הוא הסימן הבטוח ביותר
  // שאין שרת קול.
  assert.equal(evaluateVoiceProductionReadiness(
    readyInput({ gatewayState: 'never_connected' })).ready, false);
  assert.equal(evaluateVoiceProductionReadiness(
    readyInput({ gatewaySecretConfigured: false })).ready, false);
  assert.equal(evaluateVoiceProductionReadiness(
    readyInput({ providers: {} })).ready, false);
  assert.equal(evaluateVoiceProductionReadiness(
    readyInput({ toolsEnabled: 0 })).ready, false);
  assert.equal(evaluateVoiceProductionReadiness(
    readyInput({ agentActive: false })).ready, false);
  assert.equal(evaluateVoiceProductionReadiness(
    readyInput({ phoneLine: null })).ready, false);
  assert.equal(evaluateVoiceProductionReadiness(
    readyInput({ transport: null, components: { asterisk: 'configured', sip: 'registered' } })).ready,
    false);
  assert.equal(evaluateVoiceProductionReadiness(
    readyInput({ emergencyStop: true })).ready, false);
});

test('פעולות שלא סונכרנו הן אזהרה ולא חסם', async () => {
  const { evaluateVoiceProductionReadiness } = await READINESS();
  // ⚠ חסימה כאן הייתה מונעת דווקא את התאוששות המערכת: פעולות ממתינות
  // מעידות על תקלה שכבר קרתה, לא על אי-יכולת לענות לשיחה חדשה.
  const r = evaluateVoiceProductionReadiness(readyInput({ deadLetters: 3 }));
  assert.equal(r.ready, true);
  assert.ok(r.warnings.some(x => /סנכרון/.test(x)), r.warnings.join('; '));
});

test('canEnableLiveCalls חוסם כשיש חסמים', async () => {
  const { evaluateVoiceProductionReadiness, canEnableLiveCalls } = await READINESS();

  const blocked = canEnableLiveCalls(evaluateVoiceProductionReadiness(
    readyInput({ providers: { tts: { mode: 'mock', healthy: true, production_ready: false } } })));
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reason.length > 0);

  assert.equal(canEnableLiveCalls(
    evaluateVoiceProductionReadiness(readyInput())).allowed, true);
});

// ============================================================
// 19. Snapshot של תצורת הסוכן
// ============================================================

test('תצורת הסוכן נשמרת בפתיחת השיחה ואינה מתעדכנת אחריה', () => {
  const orch = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/_shared/voice/orchestrator.ts'), 'utf8');

  // ⚠ ה-snapshot חייב להיכתב פעם אחת, ב-insert. אילו הוא היה מתעדכן
  // אחר כך, prompt שהשתנה בצהריים היה משנה למפרע את מה ששיחה של הבוקר
  // "התנהלה לפיו" — וזו בדיוק השאלה שנשאלת כשמישהו מתלונן.
  const insertIdx = orch.indexOf('agent_snapshot: agent');
  assert.ok(insertIdx > 0, 'agent_snapshot נכתב ב-insert');

  const updates = [...orch.matchAll(/\.update\(\{([\s\S]{0,900}?)\}\)/g)].map(m => m[1]);
  for (const body of updates) {
    for (const field of ['agent_snapshot', 'prompt_hash', 'tools_policy_version',
                         'agent_config_version']) {
      assert.ok(!body.includes(field + ':'),
        `${field} לא אמור להתעדכן אחרי פתיחת השיחה`);
    }
  }

  // וכל השדות אכן קיימים בסכמה.
  const mig = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260823000000_call_center_production_hardening.sql'),
    'utf8');
  for (const col of ['agent_config_version', 'prompt_version', 'prompt_hash',
                     'tools_policy_version', 'llm_provider', 'llm_model',
                     'stt_provider', 'stt_model', 'tts_provider', 'tts_model',
                     'agent_snapshot']) {
    assert.ok(mig.includes(`add column if not exists ${col}`), `חסרה עמודה ${col}`);
  }
});

test('הסכמה החדשה additive בלבד', () => {
  const mig = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260823000000_call_center_production_hardening.sql'),
    'utf8');
  // ⚠ מיגרציה שמוחקת עמודה או טבלה שוברת שיחות שכבר נשמרו, ואת הקוד
  // שקורא אותן. הבדיקה כאן היא מה שיעצור שינוי כזה לפני שהוא מגיע
  // לייצור.
  assert.ok(!/drop\s+column/i.test(mig), 'אין מחיקת עמודות');
  assert.ok(!/drop\s+table(?!\s+if\s+exists\s+public\.voice_request_nonces)/i.test(mig),
    'אין מחיקת טבלאות');
  assert.ok(!/truncate/i.test(mig), 'אין truncate');
  assert.ok(!/alter\s+column[\s\S]{0,40}type/i.test(mig), 'אין שינוי טיפוס עמודה');
});

test('שכבת המוטציה מוגבלת לרשימת פקודות סגורה', async () => {
  const { COMMAND_MUTATORS } = await COMMANDS();
  const mig = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260823000000_call_center_production_hardening.sql'),
    'utf8');

  // ⚠ ה-AI לא מספק פונקציית mutate — הוא שולח שם מתוך רשימה. הרשימה
  // בקוד וברמת ה-DB חייבות להיות זהות, אחרת פקודה תיחסם רק באחד
  // מהמקומות ותתגלה כשגיאה מוזרה בייצור.
  const inCode = Object.keys(COMMAND_MUTATORS).sort();
  const m = mig.match(/command_type text not null check \(command_type in \(([\s\S]*?)\)\)/);
  assert.ok(m, 'נמצאה רשימת הפקודות ב-DB');
  const inDb = [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort();
  assert.deepEqual(inCode, inDb, 'הרשימות זהות');
});

// ============================================================
// 20. שרת הקול — Outbox, dead letter, barge-in, ספקי Mock
// ============================================================
//
// ⚠ הקוד הזה ב-Python ורץ במכונה אחרת, אבל הוא חלק מאותה מערכת: ה-
// Outbox הוא מה שמונע אובדן פנייה, ו-ProviderStatus.mock הוא מה שמונע
// הכרזת מוכנות שגויה. בדיקה שלהם דרך shell היא הדרך להחזיק את שניהם
// תחת `npm test` אחד.
//
// מדולג בסביבה בלי Python — ה-CRM עצמו אינו תלוי בו.

function runPython(t, script) {
  const { execFileSync } = require('node:child_process');
  try {
    return execFileSync('python', ['-c', script], {
      encoding: 'utf8', cwd: path.join(ROOT, 'services/voice-gateway/orchestrator'),
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
    }).trim();
  } catch (e) {
    if (/not recognized|ENOENT|No such file/i.test(String(e.message))) {
      t.skip('Python אינו זמין בסביבה הזו');
      return null;
    }
    throw new Error(String(e.stderr || e.message).slice(0, 800));
  }
}

test('ספק Mock מדווח healthy אך לא production_ready', (t) => {
  const out = runPython(t, [
    'import sys, json; sys.path.insert(0, ".")',
    'from app.capabilities import ProviderStatus',
    'from app.tts.base import MockTTSProvider',
    'from app.stt.base import MockSTTProvider',
    'from app.llm.base import MockLLMProvider',
    'res = {k: p.capabilities().as_dict() for k, p in {',
    '  "tts": MockTTSProvider(), "stt": MockSTTProvider(), "llm": MockLLMProvider()}.items()}',
    'print(json.dumps(res, ensure_ascii=False))',
  ].join(NL));
  if (out === null) return;

  const res = JSON.parse(out);
  for (const kind of ['tts', 'stt', 'llm']) {
    // ⚠ שני הדגלים, ובמפורש. השירות פועל — ואי אפשר לענות איתו לטלפון.
    assert.equal(res[kind].healthy, true, `${kind} אמור להיות healthy`);
    assert.equal(res[kind].production_ready, false,
      `${kind} לעולם לא production_ready במצב mock`);
    assert.equal(res[kind].mode, 'mock');
    assert.ok(res[kind].message.length > 0, `${kind} מסביר למה`);
  }
});

test('Outbox: ה-CRM לא זמין → הפעולה נשמרת; חזר → נשלחת ונמחקת', (t) => {
  const out = runPython(t, [
    'import sys, json, asyncio, tempfile, os; sys.path.insert(0, ".")',
    'from app.crm.outbox import Outbox',
    'async def main():',
    '    ob = Outbox(os.path.join(tempfile.mkdtemp(), "o.db"), max_retries=5)',
    '    await ob.start()',
    '    await ob.add("call.start", {"from": "+972501234567"}, idempotency_key="k1")',
    '    queued = await ob.counts()',
    '    batch = await ob.next_batch()',
    '    entry = batch[0]',
    '    await ob.mark_completed(entry.id)',
    '    done = await ob.counts()',
    '    print(json.dumps({"queued": queued, "done": done,',
    '                      "action": entry.action, "idem": entry.idempotency_key,',
    '                      "payload": entry.payload}, ensure_ascii=False))',
    'asyncio.run(main())',
  ].join(NL));
  if (out === null) return;

  const r = JSON.parse(out);
  assert.equal(r.queued.pending, 1, 'הפעולה נשמרה כשה-CRM לא היה זמין');
  assert.equal(r.action, 'call.start');
  // ⚠ מפתח האידמפוטנטיות שורד את התור. בלעדיו, שליחה חוזרת הייתה
  // יוצרת שיחה שנייה — כלומר התור היה הופך למנגנון לייצור כפילויות.
  assert.equal(r.idem, 'k1');
  assert.equal(r.payload.from, '+972501234567');
  assert.equal(r.done.completed, 1);
  assert.ok(!r.done.pending, 'לא נשארה פעולה ממתינה');
});

test('Outbox: מיצוי הניסיונות מעביר ל-dead_letter ולא מוחק', (t) => {
  const out = runPython(t, [
    'import sys, json, asyncio, tempfile, os; sys.path.insert(0, ".")',
    'from app.crm.outbox import Outbox',
    'async def main():',
    '    ob = Outbox(os.path.join(tempfile.mkdtemp(), "o.db"), max_retries=3)',
    '    await ob.start()',
    '    i = await ob.add("tool.execute", {"tool": "create_appointment"})',
    '    dead = []',
    '    for _ in range(3):',
    '        dead.append(await ob.mark_failed(i, "connection refused"))',
    '    counts = await ob.counts()',
    '    dl = await ob.dead_letters()',
    '    print(json.dumps({"dead_flags": dead, "counts": counts,',
    '                      "n": len(dl), "attempts": dl[0].attempt_count,',
    '                      "err": dl[0].last_error}, ensure_ascii=False))',
    'asyncio.run(main())',
  ].join(NL));
  if (out === null) return;

  const r = JSON.parse(out);
  assert.deepEqual(r.dead_flags, [false, false, true], 'הועבר ל-dead_letter רק במיצוי');
  assert.equal(r.counts.dead_letter, 1);
  // ⚠ הפעולה **נשארת**. פנייה של לקוח שלא נרשמה חייבת להיות ניתנת
  // לאיתור ולטיפול; מחיקה בשקט היא בדיוק מה שהמפרט אוסר.
  assert.equal(r.n, 1, 'הפעולה נשמרה ולא נמחקה');
  assert.equal(r.attempts, 3);
  assert.ok(/connection refused/.test(r.err));
});

test('barge-in: דיבור בזמן הקראה מפעיל השתקה', (t) => {
  const out = runPython(t, [
    'import sys, json; sys.path.insert(0, ".")',
    'from app.audio.vad import BargeInPolicy, BargeInConfig',
    'frame_silence = b"\\x00\\x00" * 320',
    'frame_loud = b"\\x00\\x40" * 320',
    'p = BargeInPolicy(BargeInConfig(grace_ms=0, min_speech_frames=5))',
    'p.on_speech_started()',
    'quiet = [p.push(frame_silence) for _ in range(10)]',
    'loud = [p.push(frame_loud) for _ in range(10)]',
    'p2 = BargeInPolicy(BargeInConfig(enabled=False))',
    'p2.on_speech_started()',
    'off = [p2.push(frame_loud) for _ in range(20)]',
    'p3 = BargeInPolicy(BargeInConfig(grace_ms=400, min_speech_frames=2))',
    'p3.on_speech_started()',
    'grace = [p3.push(frame_loud) for _ in range(5)]',
    'print(json.dumps({"quiet": any(quiet), "loud": any(loud),',
    '                  "disabled": any(off), "in_grace": any(grace)}))',
  ].join(NL));
  if (out === null) return;

  const r = JSON.parse(out);
  assert.equal(r.quiet, false, 'שקט אינו הפרעה');
  assert.equal(r.loud, true, 'דיבור רצוף מפעיל השתקה');
  // ⚠ כשהמתג כבוי, המדיניות לא מפעילה השתקה — אחרת הסוכנת הייתה
  // נקטעת בלי שהתעבורה יודעת להפסיק, והתמלול היה קולט את קולה שלה.
  assert.equal(r.disabled, false, 'barge-in כבוי אינו מפעיל');
  // ⚠ חלון החסד מונע מהד של המילה האחרונה של המתקשר לקטוע את המשפט
  // הראשון של הסוכנת.
  assert.equal(r.in_grace, false, 'חלון החסד מגן על תחילת המשפט');
});

test('AudioSocketTransport תומך בהפסקת השמעה; WebSocket מצהיר שהוא שלד', (t) => {
  const out = runPython(t, [
    'import sys, json; sys.path.insert(0, ".")',
    'from app.media.audiosocket import AudioSocketTransport',
    'from app.media.websocket import WebSocketMediaTransport',
    'a = AudioSocketTransport("127.0.0.1", 8090).health().as_dict()',
    'w = WebSocketMediaTransport("127.0.0.1", 8091).health().as_dict()',
    'print(json.dumps({"audiosocket": a, "websocket": w}, ensure_ascii=False))',
  ].join(NL));
  if (out === null) return;

  const r = JSON.parse(out);
  assert.equal(r.audiosocket.supports_barge_in, true);
  // ⚠ שלד שמדווח production_ready היה מאפשר להדליק שיחות אמיתיות מעליו
  // — Asterisk היה מתחבר, השיחה הייתה נענית, ואיש לא היה שומע דבר.
  assert.equal(r.websocket.production_ready, false, 'שלד לעולם לא מוכן לייצור');
  assert.equal(r.websocket.healthy, true, 'המודול עצמו תקין');
  assert.ok(r.websocket.message.length > 0, 'מסביר שהוא שלד');
});

// ============================================================
// 21. שגיאות מובנות
// ============================================================

test('לכל קוד שגיאה יש הודעה בעברית והחלטת retry', async () => {
  const { VoiceError, isRetryable, humanMessage } = await load(
    'supabase/functions/_shared/voice/errors.ts');

  const e = new VoiceError('CRM_UNAVAILABLE', 'ECONNREFUSED 10.0.0.1:443', 'call-9');
  const payload = e.toPayload();
  assert.equal(payload.code, 'CRM_UNAVAILABLE');
  assert.equal(payload.retryable, true);
  assert.equal(payload.call_id, 'call-9');
  assert.ok(payload.human_message.length > 0);
  assert.equal(payload.technical_message, 'ECONNREFUSED 10.0.0.1:443');

  // ⚠ ה-payload שמוצג למשתמש אינו כולל את הפרטים הטכניים.
  const user = e.toUserPayload();
  assert.ok(!('technical_message' in user), 'אין stack/פרטים טכניים ב-UI');
  assert.ok(!JSON.stringify(user).includes('ECONNREFUSED'));

  // retryable הוא החלטה: מה שלא ישתנה מעצמו לא מנוסה שוב.
  assert.equal(isRetryable('SIGNATURE_INVALID'), false);
  assert.equal(isRetryable('TOOL_NOT_ALLOWED'), false);
  assert.equal(isRetryable('LIVE_CALLS_DISABLED'), false);
  assert.equal(isRetryable('CRM_UNAVAILABLE'), true);
  assert.equal(isRetryable('TOOL_TIMEOUT'), true);
  assert.ok(humanMessage('TTS_UNAVAILABLE').includes('הקראה'));
});

test('הודעה ייעודית דורסת את ההודעה הגנרית של הקוד', async () => {
  const { VoiceError } = await load('supabase/functions/_shared/voice/errors.ts');
  // ⚠ אותו קוד משרת מצבים שונים. למודל שמדבר עם המתקשר צריך להיאמר
  // "המועד תפוס", לא הסבר על גרסאות נתונים.
  const e = new VoiceError('CRM_CONFLICT', 'double booking', null,
    'המועד כבר תפוס ביומן. יש להציע מועד אחר.');
  assert.ok(/תפוס/.test(e.message));
  assert.equal(e.code, 'CRM_CONFLICT');
  assert.equal(e.technical, 'double booking');
});
