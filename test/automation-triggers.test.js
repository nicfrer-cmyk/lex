// בדיקות לטריגרים ולרישום הפעולות של מרכז האוטומציות.
//
// הטריגרים טהורים (מקבלים blob, מחזירים נושאים), ולכן ניתנים לבדיקה
// ישירה. הפעולות נבדקות ברמת החוזה — אילו מהן רגישות ומה הרמה האפקטיבית —
// כי זה החלק שאסור שישתנה בשקט.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'supabase', 'functions', '_shared', 'automation');
const load = (m) => import('file://' + path.join(DIR, m).replace(/\\/g, '/'));

const NOW = new Date('2026-08-04T09:00:00Z');
const ago = (n) => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 10);
const ahead = (n) => new Date(NOW.getTime() + n * 86400000).toISOString().slice(0, 10);

function db(over) {
  return Object.assign({
    cases: [], clients: [], tasks: [], events: [], docs: [],
    payments: [], leads: [], timeEntries: [], trustTransactions: [],
    efilingBundles: {}, counters: {}, settings: {},
  }, over);
}

const run = async (type, database, cfg = {}, extra = {}) => {
  const { TRIGGER_MAP } = await load('triggers.ts');
  return TRIGGER_MAP.get(type).collect(database, cfg, NOW, extra);
};

// ============================================================
// תיקים
// ============================================================

test('matter_inactive: נופל ל-opened כשאין יומן', async () => {
  // ⚠ המלכודת המרכזית. תיק חדש אין לו יומן. בלי הנפילה ל-opened,
  // idleDays מחזיר null וכל תיק חדש נספר כתקוע לנצח — כלומר האוטומציה
  // הייתה מתריעה על כל תיק ביום שנפתח.
  const fresh = { id: 'c1', name: 'חדש', status: 'active', opened: ago(2) };
  const old = { id: 'c2', name: 'ישן', status: 'active', opened: ago(60) };
  const active = { id: 'c3', name: 'פעיל', status: 'active', opened: ago(60),
                   diary: [{ date: ago(1), text: 'שיחה' }] };

  const res = await run('matter_inactive', db({ cases: [fresh, old, active] }), { days: 14 });
  assert.deepEqual(res.map((s) => s.entityId), ['c2']);
});

test('matter_inactive: מדלג על תיקים סגורים', async () => {
  const res = await run('matter_inactive',
    db({ cases: [{ id: 'c1', name: 'סגור', status: 'closed', opened: ago(200) }] }), { days: 14 });
  assert.equal(res.length, 0);
});

test('matter_no_next_action: משימה פתוחה או מועד עתידי מספיקים', async () => {
  const base = { status: 'active', opened: ago(5) };
  const cases = [
    { id: 'a', name: 'ריק', ...base },
    { id: 'b', name: 'עם משימה', ...base },
    { id: 'c', name: 'עם מועד', ...base },
    { id: 'd', name: 'משימה סגורה', ...base },
  ];
  const res = await run('matter_no_next_action', db({
    cases,
    tasks: [{ id: 't1', text: 'x', caseId: 'b', done: false },
            { id: 't2', text: 'y', caseId: 'd', done: true }],
    events: [{ id: 'e1', title: 'דיון', date: ahead(10), caseId: 'c' }],
  }));
  // ⚠ 'd' חייב להיתפס: משימה שהושלמה אינה "פעולה עתידית".
  assert.deepEqual(res.map((s) => s.entityId).sort(), ['a', 'd']);
});

test('matter_incomplete: מוגבל לתיקים חדשים ומפרט מה חסר', async () => {
  const cases = [
    { id: 'new', name: 'חדש חסר', status: 'active', opened: ago(5) },
    { id: 'old', name: 'ישן חסר', status: 'active', opened: ago(300) },
  ];
  const res = await run('matter_incomplete', db({ cases }), { opened_within_days: 30 });

  // ⚠ בלי החסם, הדלקת הכלל הייתה מייצרת התראה על כל תיק ישן במשרד
  // שחסר בו שדה — עשרות התראות ברגע אחד על תיקים שאיש לא מתכוון להשלים.
  assert.deepEqual(res.map((s) => s.entityId), ['new']);
  assert.ok(res[0].data.missingList.includes('לקוח'));
  assert.ok(res[0].data.missingCount >= 5);
});

// ============================================================
// משימות ומועדים
// ============================================================

test('task_overdue: מכבד מינימום ימי איחור ומדלג על שהושלמו', async () => {
  const tasks = [
    { id: 't1', text: 'אתמול', due: ago(1), done: false },
    { id: 't2', text: 'שבוע', due: ago(7), done: false },
    { id: 't3', text: 'הושלמה', due: ago(30), done: true },
    { id: 't4', text: 'עתידית', due: ahead(3), done: false },
    { id: 't5', text: 'ללא מועד', done: false },
  ];
  const all = await run('task_overdue', db({ tasks }), { min_days_late: 1 });
  assert.deepEqual(all.map((s) => s.entityId).sort(), ['t1', 't2']);

  const severe = await run('task_overdue', db({ tasks }), { min_days_late: 7 });
  assert.deepEqual(severe.map((s) => s.entityId), ['t2']);
  assert.equal(severe[0].data.daysLate, 7);
});

test('event_passed_unmarked: רישום ביומן אחרי המועד מנטרל', async () => {
  const cases = [
    { id: 'c1', name: 'לא תועד', status: 'active', diary: [{ date: ago(20), text: 'ישן' }] },
    { id: 'c2', name: 'תועד', status: 'active', diary: [{ date: ago(1), text: 'הדיון התקיים' }] },
  ];
  const events = [
    { id: 'e1', title: 'דיון א', date: ago(5), caseId: 'c1' },
    { id: 'e2', title: 'דיון ב', date: ago(5), caseId: 'c2' },
  ];
  const res = await run('event_passed_unmarked', db({ cases, events }), { grace_days: 1 });
  // ⚠ בלי בדיקת "יומן אחרי התאריך", כל דיון היסטורי במשרד היה נחשב
  // לא מטופל לנצח.
  assert.deepEqual(res.map((s) => s.entityId), ['e1']);
});

test('event_conflict: נושא אחד לכל התנגשות ולא אחד לכל אירוע', async () => {
  const events = [
    { id: 'e1', title: 'דיון', date: ahead(3), time: '09:00' },
    { id: 'e2', title: 'פגישה', date: ahead(3), time: '09:00' },
    { id: 'e3', title: 'לבד', date: ahead(4), time: '11:00' },
  ];
  const res = await run('event_conflict', db({ events }));
  // ⚠ נושא לכל אירוע היה מייצר שתי התראות זהות על אותה התנגשות.
  assert.equal(res.length, 1);
  assert.equal(res[0].data.count, 2);
});

test('event_without_prep_task: משימה כלשהי בתיק מנטרלת', async () => {
  const events = [
    { id: 'e1', title: 'בלי הכנה', date: ahead(5), caseId: 'c1' },
    { id: 'e2', title: 'עם הכנה', date: ahead(5), caseId: 'c2' },
  ];
  const res = await run('event_without_prep_task', db({
    events, tasks: [{ id: 't1', text: 'להכין', caseId: 'c2', done: false }],
  }), { days: 14 });
  assert.deepEqual(res.map((s) => s.entityId), ['e1']);
});

// ============================================================
// לקוחות ומסמכים
// ============================================================

test('client_no_update: לוקח את התיק הפעיל ביותר, לא את הממוצע', async () => {
  const clients = [{ id: 'cl1', name: 'כהן' }];
  const cases = [
    { id: 'a', client: 'cl1', status: 'active', name: 'תיק שקט', opened: ago(90) },
    { id: 'b', client: 'cl1', status: 'active', name: 'תיק פעיל', opened: ago(90),
      diary: [{ date: ago(2), text: 'עדכון' }] },
  ];
  // ⚠ Math.min ולא ממוצע: ללקוח יש תיק שנגעו בו לפני יומיים, ולכן הוא
  // **לא** "לקוח שלא קיבל עדכון". ממוצע היה מסמן אותו בטעות.
  const res = await run('client_no_update', db({ clients, cases }), { days: 30 });
  assert.equal(res.length, 0);
});

test('document_unlinked / unanalyzed', async () => {
  const docs = [
    { id: 'd1', name: 'יתום', filePath: 'x' },
    { id: 'd2', name: 'משויך', caseId: 'c1', filePath: 'y' },
    { id: 'd3', name: 'נותח', caseId: 'c1', filePath: 'z', aiAnalyzedAt: ago(1) },
    { id: 'd4', name: 'ללא קובץ', caseId: 'c1' },
  ];
  const unlinked = await run('document_unlinked', db({ docs }));
  assert.deepEqual(unlinked.map((s) => s.entityId), ['d1']);

  // ⚠ ללא filePath אין מה לנתח — d4 חייב להידלג, אחרת הסוכן מוזמן
  // בתשלום על רשומה ריקה.
  const unan = await run('document_unanalyzed', db({ docs }));
  assert.deepEqual(unan.map((s) => s.entityId).sort(), ['d1', 'd2']);
});

test('thread_no_reply: רק שרשור שההודעה האחרונה בו נכנסת', async () => {
  const threads = [
    { id: 'a', channel: 'whatsapp', lastDirection: 'in',
      last_message_at: new Date(NOW.getTime() - 6 * 3600000).toISOString(), participant_name: 'דנה' },
    { id: 'b', channel: 'whatsapp', lastDirection: 'out',
      last_message_at: new Date(NOW.getTime() - 20 * 3600000).toISOString(), participant_name: 'רון' },
    { id: 'c', channel: 'whatsapp', lastDirection: 'in',
      last_message_at: new Date(NOW.getTime() - 1 * 3600000).toISOString(), participant_name: 'טרי' },
  ];
  const res = await run('thread_no_reply', db(), { hours: 4 }, { threads });
  // ⚠ 'b' — ההודעה האחרונה יוצאת, הכדור אצלם. 'c' — עברה שעה בלבד.
  assert.deepEqual(res.map((s) => s.entityId), ['a']);
  assert.equal(res[0].data.waitedHours, 6);
});

test('daily_digest: רץ רק בחלון השעה שהוגדרה', async () => {
  const { TRIGGER_MAP } = await load('triggers.ts');
  const t = TRIGGER_MAP.get('daily_digest');
  const at = (h) => new Date(`2026-08-04T${String(h).padStart(2, '0')}:30:00+03:00`);

  assert.equal(t.collect(db(), { hour: 8 }, at(8), {}).length, 1);
  assert.equal(t.collect(db(), { hour: 8 }, at(13), {}).length, 0);
  assert.equal(t.collect(db(), { hour: 8 }, at(3), {}).length, 0);
});

// ============================================================
// חוזה הפעולות
// ============================================================

test('פעולות רגישות לעולם אינן רצות ב-auto', async () => {
  const { ACTIONS, ACTION_MAP, effectiveLevel } = await load('actions.ts');

  // ⚠ המחסום המרכזי של המודול. הגדרה שגויה במסך אינה יכולה להיות
  // מרחק של קליק מפעולה בלתי הפיכה על תיק משפטי.
  for (const a of ACTIONS.filter((x) => x.sensitive)) {
    assert.equal(effectiveLevel(a, 'auto'), 'prepare',
      `${a.type} רגישה וחייבת לרדת ל-prepare`);
  }
  for (const a of ACTIONS.filter((x) => !x.sensitive)) {
    assert.equal(effectiveLevel(a, 'auto'), 'auto');
  }
  // notify לעולם לא מוסלם ע"י ההגדרה
  assert.equal(effectiveLevel(ACTION_MAP.get('create_task'), 'notify'), 'notify');
});

test('הפעולות הרגישות הן בדיוק אלה שצריכות להיות', async () => {
  const { ACTIONS } = await load('actions.ts');
  const sensitive = ACTIONS.filter((a) => a.sensitive).map((a) => a.type).sort();
  // רשימה מפורשת: הוספת פעולה רגישה חדשה בלי לעדכן כאן תפיל את הבדיקה
  // ותכריח החלטה מודעת, במקום שהיא תיכנס בשקט.
  assert.deepEqual(sensitive, ['draft_message', 'set_case_status', 'webhook']);
});

test('render מחליף תבניות ולא מפיל על נתיב חסר', async () => {
  const { render } = await load('actions.ts');
  const ctx = { subject: { label: 'תיק כהן', data: { name: 'כהן', amount: 5000 } },
                reason: 'עברו 18 יום', ruleName: 'תיק תקוע' };

  assert.equal(render('בדיקת {{subject.label}}', ctx), 'בדיקת תיק כהן');
  assert.equal(render('{{matter.name}} — ₪{{matter.amount}}', ctx), 'כהן — ₪5000');
  assert.equal(render('{{reason}}', ctx), 'עברו 18 יום');
  // ⚠ נתיב שבור מחזיר מחרוזת ריקה. זריקה כאן הייתה מפילה את הפעולה
  // כולה בגלל שגיאת הקלדה בתבנית טקסט.
  assert.equal(render('[{{nope.deep.path}}]', ctx), '[]');
});

test('לכל פעולה יש describe שאינו נוגע בנתונים', async () => {
  const { ACTIONS } = await load('actions.ts');
  const ctx = {
    subject: { entityType: 'matter', entityId: 'c1', label: 'תיק', data: { name: 'כהן' } },
    reason: 'סיבה', ruleName: 'כלל', dryRun: true,
  };
  // describe הוא מה שמוצג ב"בדיקה ללא ביצוע". אם הוא זורק, מצב הבדיקה
  // — התכונה שכל הביטחון בהדלקת אוטומציה נשען עליה — נשבר.
  for (const a of ACTIONS) {
    const s = a.describe({ text: 'x', title: 'y', url: 'https://a.b', agent: 'z' }, ctx);
    assert.equal(typeof s, 'string', `${a.type}: describe חייב להחזיר מחרוזת`);
    assert.ok(s.length > 0, `${a.type}: describe ריק`);
  }
});

test('כל טריגר בקטלוג מחזיר מערך על blob ריק', async () => {
  const { TRIGGERS } = await load('triggers.ts');
  // מסד ריק הוא המצב של כל משרד חדש. טריגר שנופל עליו היה שובר את
  // הטיק כולו ביום הראשון של כל לקוח חדש.
  for (const t of TRIGGERS) {
    const res = t.collect(db(), {}, NOW, { threads: [] });
    assert.ok(Array.isArray(res), `${t.type} לא החזיר מערך`);
  }
});
