// בדיקות ללולאת הלמידה.
//
// learning.ts הוא הקובץ שמחליט מה הסוכן "לומד" ממני. טעות כאן לא מפילה
// כלום — היא רק מטמיעה כלל שגוי ב-prompt של סוכן מנסח, בשקט, לתמיד. לכן
// הוא נכתב טהור (בלי Deno) ונבדק כאן ישירות דרך type-stripping של Node.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SHARED = path.join(__dirname, '..', 'supabase', 'functions', '_shared');
const load = (m) => import('file://' + path.join(SHARED, m).replace(/\\/g, '/'));

let n = 0;
function approval(over) {
  return Object.assign({
    id: 'ap' + (++n),
    agent_id: 'agent-1',
    action_type: 'create_task',
    action_label: 'יצירת משימה',
    status: 'approved',
    proposed_payload: { text: 'לבדוק' },
    edited_payload: null,
    proposed_content: null,
    rejection_reason: null,
    return_instruction: null,
    requested_at: '2026-08-01T10:00:00Z',
  }, over);
}

// ============================================================
// זיהוי תיקון
// ============================================================

test('wasEdited: אישור בלי עריכה אינו נחשב תיקון', async () => {
  const { wasEdited } = await load('learning.ts');

  assert.equal(wasEdited(approval()), false);
  // ⚠ המקרה שקל לפספס: ה-UI שומר edited_payload גם כשלחצת "אשר" בלי
  // לגעת. אם זה ייחשב תיקון, כל אישור נקי ייספר כתיקון — הדפוס
  // "עבודה חוזרת ללא תיקונים" לא היה מזוהה לעולם, ושיעור התיקונים
  // במסך היה מציג 100% תמיד.
  assert.equal(wasEdited(approval({ edited_payload: { text: 'לבדוק' } })), false);
  assert.equal(wasEdited(approval({ edited_payload: { text: 'לבדוק היטב' } })), true);
});

test('diffPayload: מחזיר רק שדות שהשתנו, וחותך תוכן ארוך', async () => {
  const { diffPayload } = await load('learning.ts');

  const diffs = diffPayload(
    { a: 'זהה', b: 'לפני', c: 1 },
    { a: 'זהה', b: 'אחרי', c: 1 },
  );
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].field, 'b');
  assert.equal(diffs[0].before, 'לפני');
  assert.equal(diffs[0].after, 'אחרי');

  // מסמך שלם בתוך ה-prompt של הזיקוק מייקר כל סבב בלי לשפר את הלקח.
  const long = diffPayload({ t: 'x'.repeat(9000) }, { t: 'y'.repeat(9000) });
  assert.equal(long[0].before.length, 4000);
  assert.equal(long[0].after.length, 4000);
});

// ============================================================
// סיגנלים מתיקונים
// ============================================================

test('correctionSignals: מזהה דחייה, החזרה ועריכה', async () => {
  const { correctionSignals } = await load('learning.ts');

  const sigs = correctionSignals([
    approval({ status: 'rejected', rejection_reason: 'לא רלוונטי לתיק' }),
    approval({ status: 'returned', return_instruction: 'נסח בגוף שלישי' }),
    approval({ edited_payload: { text: 'לבדוק היטב' } }),
    approval(),                                   // נקי — לא סיגנל
  ]);

  assert.equal(sigs.length, 3);
  assert.ok(sigs.every((s) => s.kind === 'correction'));
  assert.ok(sigs[0].summary.includes('לא רלוונטי לתיק'));
  assert.ok(sigs[1].summary.includes('נסח בגוף שלישי'));
  assert.ok(sigs[2].summary.includes('לבדוק היטב'));
});

test('correctionSignals: תיקון תוכן חופשי מושלם מ-proposed_content', async () => {
  const { correctionSignals } = await load('learning.ts');

  // ⚠ המקרה היקר ביותר: עורך הדין שכתב מחדש טיוטה. ה-payload אינו מכיל
  // body/text, ולכן ה-UI שומר את הטקסט תחת `_content`. בלי ההשלמה מ-
  // proposed_content, ה"לפני" היה null והמזקק היה מקבל נוסח חדש בלי מה
  // שהוחלף — כלומר לא יכול היה להסיק שום לקח מהתיקון.
  const sigs = correctionSignals([approval({
    action_type: 'draft_legal_document',
    proposed_payload: { matterId: 'c1' },
    proposed_content: 'טיוטה: הנתבע חייב לשלם.',
    edited_payload: { matterId: 'c1', _content: 'טיוטה: הנתבעת חייבת לשלם.' },
  })]);

  assert.equal(sigs.length, 1);
  const d = sigs[0].evidence.diffs.find((x) => x.field === 'תוכן');
  assert.ok(d, 'שדה התוכן חייב להופיע בשם קריא ולא כ-_content');
  assert.equal(d.before, 'טיוטה: הנתבע חייב לשלם.');
  assert.equal(d.after, 'טיוטה: הנתבעת חייבת לשלם.');
});

test('correctionSignals: דחייה בלי סיבה אינה מלמדת דבר', async () => {
  const { correctionSignals } = await load('learning.ts');
  // בלי סיבה אין ממה לזקק לקח — והמצאת סיבה היא בדיוק מה שאסור.
  assert.equal(correctionSignals([approval({ status: 'rejected' })]).length, 0);
  assert.equal(correctionSignals([approval({ status: 'returned' })]).length, 0);
});

// ============================================================
// עבודה חוזרת ללא תיקונים
// ============================================================

test('repetitionSignals: מציע עצמאות רק אחרי N אישורים נקיים ברצף', async () => {
  const { repetitionSignals } = await load('learning.ts');
  const autonomy = new Map([['agent-1', 2]]);
  const always = new Set();

  const clean = (k) => Array.from({ length: k }, () => approval());

  assert.equal(repetitionSignals(clean(4), 5, autonomy, always).length, 0);

  const sigs = repetitionSignals(clean(5), 5, autonomy, always);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].kind, 'repetition');
  assert.equal(sigs[0].occurrences, 5);
  assert.equal(sigs[0].evidence.currentAutonomy, 2);
});

test('repetitionSignals: תיקון אחד מבטל את הדפוס כולו', async () => {
  const { repetitionSignals } = await load('learning.ts');
  const autonomy = new Map([['agent-1', 2]]);

  // ⚠ הכלל המהותי. "כמעט תמיד נכון" אינו בסיס להסרת אישור אנושי במערכת
  // שמפיקה מסמכים משפטיים — 20 אישורים נקיים ותיקון אחד לא שקולים
  // ל-20 אישורים נקיים.
  const rows = Array.from({ length: 20 }, () => approval());
  rows.push(approval({ edited_payload: { text: 'שונה' } }));
  assert.equal(repetitionSignals(rows, 5, autonomy, new Set()).length, 0);

  const rows2 = Array.from({ length: 20 }, () => approval());
  rows2.push(approval({ status: 'rejected', rejection_reason: 'לא' }));
  assert.equal(repetitionSignals(rows2, 5, autonomy, new Set()).length, 0);
});

test('repetitionSignals: פעולות ברשימה הקשיחה לעולם לא מועמדות', async () => {
  const { repetitionSignals } = await load('learning.ts');
  const { ALWAYS_APPROVE } = await load('approvals.ts');
  const autonomy = new Map([['agent-1', 2]]);

  // ⚠ ההגנה החשובה ביותר בקובץ הזה: בלעדיה, 50 טיוטות משפטיות שאושרו
  // נקי היו מייצרות הצעה להסיר את האישור על ניסוח מסמכים משפטיים —
  // כלומר הלמידה הייתה מפרקת בדיוק את המחסום שהמערכת קיימת בשבילו.
  const rows = Array.from({ length: 50 },
    () => approval({ action_type: 'draft_legal_document' }));
  assert.equal(repetitionSignals(rows, 5, autonomy, ALWAYS_APPROVE).length, 0);

  // ובדיקה שהרשימה באמת מגיעה מהמקור האחד ולא הועתקה לכאן
  for (const slug of ['transfer_funds', 'file_to_court', 'send_legal_notice']) {
    assert.ok(ALWAYS_APPROVE.has(slug), slug + ' חייב להיות ברשימה הקשיחה');
  }
});

test('repetitionSignals: סוכן שכבר בתקרת העצמאות לא מקבל הצעה', async () => {
  const { repetitionSignals } = await load('learning.ts');
  const rows = Array.from({ length: 30 }, () => approval());
  assert.equal(repetitionSignals(rows, 5, new Map([['agent-1', 4]]), new Set()).length, 0);
});

// ============================================================
// משימות חוזרות וכשלים
// ============================================================

test('recurringTaskSignals: מנרמל מזהים כדי לזהות את אותה משימה', async () => {
  const { recurringTaskSignals } = await load('learning.ts');

  const runs = [1, 2, 3, 4, 5].map((i) => ({
    agent_id: 'agent-1', trigger_type: 'manual', goal: `סכם לי את תיק מספר ${i}`,
  }));
  const sigs = recurringTaskSignals(runs, 5);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].occurrences, 5);

  // הרצות מאוטומציה אינן "עבודה ידנית חוזרת" — הן כבר אוטומטיות.
  const auto = runs.map((r) => ({ ...r, trigger_type: 'automation' }));
  assert.equal(recurringTaskSignals(auto, 5).length, 0);
});

test('failureSignals: מקבץ לפי קוד שגיאה מעל הסף', async () => {
  const { failureSignals } = await load('learning.ts');

  const runs = [
    ...Array.from({ length: 3 }, () => ({
      agent_id: 'agent-1', status: 'failed', error_code: 'no_tools', error_message: 'אין כלים',
    })),
    { agent_id: 'agent-1', status: 'failed', error_code: 'other', error_message: 'פעם אחת' },
    { agent_id: 'agent-1', status: 'completed', error_code: null, error_message: null },
  ];
  const sigs = failureSignals(runs, 3);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].actionType, 'no_tools');
  assert.equal(sigs[0].occurrences, 3);
});

// ============================================================
// קיבוץ וביטחון
// ============================================================

test('groupSignals: מאחד לפי dedupeKey ואינו משנה את המקור', async () => {
  const { correctionSignals, groupSignals } = await load('learning.ts');

  const sigs = correctionSignals([
    approval({ status: 'rejected', rejection_reason: 'סיבה א' }),
    approval({ status: 'rejected', rejection_reason: 'סיבה ב' }),
  ]);
  const before = JSON.stringify(sigs[0].evidence);

  const grouped = groupSignals(sigs);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].occurrences, 2);
  assert.ok(grouped[0].summary.includes('סיבה א'));
  assert.ok(grouped[0].summary.includes('סיבה ב'));
  // הקיבוץ לא רשאי לזהם את הראיות המקוריות — הן נשמרות ב-DB כהוכחה
  // למה התובנה נוצרה, וזהו כל מה שמאפשר להסביר אותה בדיעבד.
  assert.equal(JSON.stringify(sigs[0].evidence), before);
});

test('confidenceFor: מקרה בודד אינו מתחזה לדפוס', async () => {
  const { confidenceFor } = await load('learning.ts');

  const one = confidenceFor({ kind: 'correction', occurrences: 1 });
  const many = confidenceFor({ kind: 'correction', occurrences: 5 });
  assert.ok(one < 0.6, 'תיקון בודד חייב להיות בביטחון נמוך');
  assert.ok(many > one);
  assert.ok(confidenceFor({ kind: 'repetition', occurrences: 100 }) <= 0.95,
    'ביטחון לעולם אינו מגיע ל-1 — אין כאן ודאות');
});
