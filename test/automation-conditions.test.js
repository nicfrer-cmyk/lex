// בדיקות למנוע התנאים של מרכז האוטומציות.
//
// זו הלוגיקה שקובעת על מי אוטומציה פועלת. טעות כאן לא מפילה שום דבר —
// היא רק שולחת תזכורת גבייה ללקוח הלא נכון, או מפספסת מועד. לכן היא
// נכתבה טהורה ונבדקת ישירות.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const P = path.join(__dirname, '..', 'supabase', 'functions', '_shared', 'automation', 'conditions.ts');
const load = () => import('file://' + P.replace(/\\/g, '/'));

// זמן קבוע — בדיקות תלויות-שעון נכשלות בחצות ואז אף אחד לא מאמין להן.
const NOW = Date.parse('2026-08-04T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const daysAhead = (n) => new Date(NOW + n * 86400000).toISOString();

// ============================================================
// אופרטורים
// ============================================================

test('getPath: נתיב מנוקד, ונתיב שבור מחזיר undefined ולא זורק', async () => {
  const { getPath } = await load();
  const ctx = { matter: { status: 'active', client: { name: 'כהן' } } };

  assert.equal(getPath(ctx, 'matter.status'), 'active');
  assert.equal(getPath(ctx, 'matter.client.name'), 'כהן');
  // ⚠ תיק בודד שחסר שדה לא רשאי להפיל את הכלל על כל שאר התיקים.
  assert.equal(getPath(ctx, 'matter.missing.deep.path'), undefined);
  assert.equal(getPath(null, 'a.b'), undefined);
});

test('eq/neq/in משווים כטקסט, עם ci אופציונלי', async () => {
  const { evalCondition } = await load();
  const ctx = { status: 'Active', amount: 5000 };

  assert.equal(evalCondition({ field: 'status', op: 'eq', value: 'Active' }, ctx).passed, true);
  assert.equal(evalCondition({ field: 'status', op: 'eq', value: 'active' }, ctx).passed, false);
  assert.equal(evalCondition({ field: 'status', op: 'eq', value: 'active', ci: true }, ctx).passed, true);
  assert.equal(evalCondition({ field: 'amount', op: 'eq', value: 5000 }, ctx).passed, true);
  assert.equal(evalCondition({ field: 'status', op: 'in', value: ['Active', 'open'] }, ctx).passed, true);
  assert.equal(evalCondition({ field: 'status', op: 'nin', value: ['closed'] }, ctx).passed, true);
});

test('השוואות מספריות על שדה ריק נכשלות ולא זורקות', async () => {
  const { evalCondition } = await load();
  // ⚠ תיק בלי סכום הוא מצב רגיל לגמרי במערכת הזו (4 מתוך 4 התיקים
  // במשרד הזה נפתחו בלי סכום). NaN חייב להיכשל בשקט.
  assert.equal(evalCondition({ field: 'amount', op: 'gt', value: 1000 }, {}).passed, false);
  assert.equal(evalCondition({ field: 'amount', op: 'lt', value: 1000 }, { amount: '' }).passed, false);
  assert.equal(evalCondition({ field: 'amount', op: 'gte', value: 1000 }, { amount: '5000' }).passed, true);
});

test('empty/exists: אפס ו-false אינם נחשבים ריקים', async () => {
  const { evalCondition } = await load();
  const e = (ctx, op) => evalCondition({ field: 'v', op }, ctx).passed;

  assert.equal(e({ v: '' }, 'empty'), true);
  assert.equal(e({}, 'empty'), true);
  assert.equal(e({ v: [] }, 'empty'), true);
  // ⚠ המלכודת: יתרה 0 היא ערך אמיתי. אילו 0 היה "ריק", אוטומציית
  // "חשבון נאמנות ללא יתרה" הייתה מדלגת בדיוק על המקרה שהיא מחפשת.
  assert.equal(e({ v: 0 }, 'empty'), false);
  assert.equal(e({ v: false }, 'empty'), false);
  assert.equal(e({ v: 0 }, 'exists'), true);
});

test('is_false תופס גם שדה חסר לגמרי', async () => {
  const { evalCondition } = await load();
  // ⚠ משימה ישנה נשמרה בלי `done`. eq:"false" היה נכשל עליה, ולכן
  // "משימה שלא הושלמה" הייתה מפספסת את המשימות הישנות ביותר —
  // בדיוק אלה שהכי חשוב לתפוס.
  assert.equal(evalCondition({ field: 'done', op: 'is_false' }, {}).passed, true);
  assert.equal(evalCondition({ field: 'done', op: 'is_false' }, { done: false }).passed, true);
  assert.equal(evalCondition({ field: 'done', op: 'is_false' }, { done: true }).passed, false);
  assert.equal(evalCondition({ field: 'done', op: 'is_true' }, { done: true }).passed, true);
});

test('אופרטור לא מוכר נכשל סגור', async () => {
  const { evalCondition } = await load();
  // ⚠ הכיוון ההפוך היה גורם לשגיאת הקלדה בשם אופרטור להפעיל את
  // האוטומציה על **כל** הרשומות במשרד.
  assert.equal(evalCondition({ field: 'x', op: 'לא-קיים', value: 1 }, { x: 1 }).passed, false);
});

test('regex שגוי לא מפיל את הכלל', async () => {
  const { evalCondition } = await load();
  assert.equal(evalCondition({ field: 'name', op: 'regex', value: '[' }, { name: 'א' }).passed, false);
  assert.equal(evalCondition({ field: 'name', op: 'regex', value: '^כה' }, { name: 'כהן' }).passed, true);
});

// ============================================================
// אופרטורי זמן
// ============================================================

test('older_than_days / within_next_days מבדילים עבר מעתיד', async () => {
  const { evalCondition } = await load();
  const e = (v, op, value) => evalCondition({ field: 'd', op, value }, { d: v }, NOW).passed;

  assert.equal(e(daysAgo(20), 'older_than_days', 14), true);
  assert.equal(e(daysAgo(10), 'older_than_days', 14), false);
  // ⚠ תאריך עתידי אינו "ישן". בלי ההבחנה, דיון שנקבע לעוד חודש היה
  // נספר כתיק שלא נגעו בו 30 יום.
  assert.equal(e(daysAhead(30), 'older_than_days', 14), false);

  assert.equal(e(daysAhead(3), 'within_next_days', 7), true);
  assert.equal(e(daysAhead(10), 'within_next_days', 7), false);
  assert.equal(e(daysAgo(3), 'within_next_days', 7), false);   // כבר עבר
});

test('תאריך לא תקין נכשל בשקט', async () => {
  const { evalCondition } = await load();
  assert.equal(evalCondition({ field: 'd', op: 'older_than_days', value: 5 }, { d: '' }, NOW).passed, false);
  assert.equal(evalCondition({ field: 'd', op: 'older_than_days', value: 5 }, { d: 'בקרוב' }, NOW).passed, false);
});

// ============================================================
// עצי AND / OR / NONE
// ============================================================

test('מערך שטוח הוא AND — תאימות לאחור לכללים הקיימים', async () => {
  const { evaluate } = await load();
  const ctx = { status: 'active', amount: 5000 };

  // הכללים שכבר יושבים ב-DB נשמרו בפורמט הזה. שינוי משמעות היה משנה
  // בשקט את ההתנהגות של אוטומציות שכבר רצות.
  assert.equal(evaluate([
    { field: 'status', op: 'eq', value: 'active' },
    { field: 'amount', op: 'gt', value: 1000 },
  ], ctx, NOW).passed, true);

  assert.equal(evaluate([
    { field: 'status', op: 'eq', value: 'active' },
    { field: 'amount', op: 'gt', value: 99999 },
  ], ctx, NOW).passed, false);
});

test('ללא תנאים — חל על הכל', async () => {
  const { evaluate } = await load();
  assert.equal(evaluate([], {}, NOW).passed, true);
  assert.equal(evaluate(null, {}, NOW).passed, true);
});

test('all / any / none מקוננים', async () => {
  const { evaluate } = await load();
  const ctx = { status: 'active', type: 'debt', amount: 5000, closed: false };

  assert.equal(evaluate({
    all: [
      { field: 'status', op: 'eq', value: 'active' },
      { any: [
        { field: 'type', op: 'eq', value: 'debt' },
        { field: 'type', op: 'eq', value: 'general' },
      ] },
      { none: [{ field: 'closed', op: 'is_true' }] },
    ],
  }, ctx, NOW).passed, true);

  // any שאף אחד ממנו לא מתקיים פוסל
  assert.equal(evaluate({
    all: [{ any: [
      { field: 'type', op: 'eq', value: 'x' },
      { field: 'type', op: 'eq', value: 'y' },
    ] }],
  }, ctx, NOW).passed, false);

  // none שאחד ממנו כן מתקיים פוסל
  assert.equal(evaluate({
    none: [{ field: 'status', op: 'eq', value: 'active' }],
  }, ctx, NOW).passed, false);
});

test('קבוצה ריקה אינה פוסלת', async () => {
  const { evaluate } = await load();
  // ⚠ some([]) === false. בלי הטיפול המפורש, מחיקת התנאי האחרון מתוך
  // any הייתה משביתה את הכלל כולו בשקט — והמשתמש היה רואה אוטומציה
  // דלוקה שלא עושה כלום, בלי שום הודעת שגיאה.
  assert.equal(evaluate({ any: [] }, {}, NOW).passed, true);
  assert.equal(evaluate({ all: [], any: [], none: [] }, {}, NOW).passed, true);
});

test('ה-trace שומר את כל הענפים של any ולא עוצר בראשון', async () => {
  const { evaluate } = await load();
  // ה-trace הוא ההסבר שהמשתמש רואה במסך "למה זה הופעל". short-circuit
  // היה משאיר אותו חלקי ולא ניתן להבנה.
  const res = evaluate({ any: [
    { field: 'a', op: 'eq', value: 1 },
    { field: 'b', op: 'eq', value: 2 },
    { field: 'c', op: 'eq', value: 3 },
  ] }, { a: 1, b: 2, c: 3 }, NOW);
  assert.equal(res.passed, true);
  assert.equal(res.trace.length, 3);
});

test('explainResult מנסח בעברית ומציג את התנאים שהכריעו', async () => {
  const { evaluate, explainResult } = await load();
  const res = evaluate([{ field: 'days', op: 'gt', value: 14 }], { days: 18 }, NOW);
  const txt = explainResult(res, 'תיק ללא פעילות');

  assert.ok(txt.includes('תיק ללא פעילות'));
  assert.ok(txt.includes('הופעל משום ש'));
  assert.ok(txt.includes('18'));
});

// ============================================================
// שעות שקטות
// ============================================================

test('inQuietHours: חלון שחוצה חצות', async () => {
  const { inQuietHours } = await load();
  const q = { from: '20:00', to: '08:00' };
  const at = (iso) => new Date(iso);

  // ⚠ הבדיקה שהמנוע הנאיבי היה נכשל בה: 20:00–08:00 הוא ההגדרה
  // הטבעית ביותר, ו-from<=t<=to היה מחזיר false תמיד עבורה.
  assert.equal(inQuietHours(q, at('2026-08-04T22:00:00+03:00')), true);   // 22:00
  assert.equal(inQuietHours(q, at('2026-08-04T03:00:00+03:00')), true);   // 03:00
  assert.equal(inQuietHours(q, at('2026-08-04T12:00:00+03:00')), false);  // צהריים
  assert.equal(inQuietHours(q, at('2026-08-04T08:00:00+03:00')), false);  // בדיוק בגבול
});

test('inQuietHours: ימי מנוחה — שישי ושבת', async () => {
  const { inQuietHours } = await load();
  // 2026-08-08 הוא שבת, 2026-08-07 שישי, 2026-08-04 שלישי.
  const q = { days: [5, 6] };
  assert.equal(inQuietHours(q, new Date('2026-08-08T12:00:00+03:00')), true);
  assert.equal(inQuietHours(q, new Date('2026-08-07T12:00:00+03:00')), true);
  assert.equal(inQuietHours(q, new Date('2026-08-04T12:00:00+03:00')), false);
});

test('inQuietHours: ללא הגדרה — אין שעות שקטות', async () => {
  const { inQuietHours } = await load();
  assert.equal(inQuietHours(null, new Date()), false);
  assert.equal(inQuietHours({}, new Date()), false);
});
