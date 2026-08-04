// מנוע התנאים של מרכז האוטומציות (סעיף 19 במפרט).
//
// טהור לחלוטין — בלי Deno, בלי רשת, בלי DB. זו הלוגיקה שקובעת על מי
// אוטומציה פועלת, ולכן היא חייבת להיות ניתנת לבדיקה אוטומטית: טעות כאן
// לא מפילה כלום, היא רק שולחת תזכורת ללקוח הלא נכון.
//
// ## היחס למנוע הקיים
// `matchesConditions` ב-ai-cron תומך ברשימה שטוחה של תנאים ב-AND בלבד.
// המפרט דורש AND/OR מקונן. המנוע כאן מחליף אותו ותומך לאחור: מערך שטוח
// מתפרש כ-AND, בדיוק כמו קודם, כך שכל הכללים הקיימים ממשיכים לעבוד.

export type Primitive = string | number | boolean | null | undefined;

/** תנאי בודד. `field` נתמך בנקודות: "matter.status", "client.email". */
export type Condition = {
  field: string;
  op: string;
  value?: unknown;
  /** מבטל רגישות לאותיות גדולות בהשוואות טקסט. */
  ci?: boolean;
};

/** קבוצה לוגית. */
export type ConditionGroup = {
  all?: ConditionNode[];   // AND
  any?: ConditionNode[];   // OR
  none?: ConditionNode[];  // NOR — "אף אחד מאלה"
};

export type ConditionNode = Condition | ConditionGroup;

export type EvalTrace = {
  field: string;
  op: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
  /** הסבר בעברית — נשמר ב-automation_runs.reason. */
  explain: string;
};

export type EvalResult = { passed: boolean; trace: EvalTrace[] };

// ============================================================

function isGroup(n: ConditionNode): n is ConditionGroup {
  return !!n && typeof n === 'object' &&
    ('all' in n || 'any' in n || 'none' in n) && !('field' in n);
}

/**
 * שליפת ערך בנתיב מנוקד.
 *
 * מחזיר undefined לכל נתיב שבור במקום לזרוק. אוטומציה שנופלת כי תיק אחד
 * חסר שדה הייתה מפסיקה לעבוד על **כל** התיקים — עדיף שהתנאי פשוט לא
 * יתקיים על אותה רשומה.
 */
export function getPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  let cur: unknown = obj;
  for (const part of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function asNum(v: unknown): number {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : NaN;
}

function asStr(v: unknown, ci?: boolean): string {
  const s = v == null ? '' : String(v);
  return ci ? s.toLowerCase() : s;
}

/** ריק אמיתי. שים לב ש-0 ו-false **אינם** ריקים. */
function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

const OP_HE: Record<string, string> = {
  eq: 'שווה ל', neq: 'שונה מ', gt: 'גדול מ', gte: 'גדול או שווה ל',
  lt: 'קטן מ', lte: 'קטן או שווה ל', in: 'נמצא ברשימה', nin: 'לא נמצא ברשימה',
  contains: 'מכיל', not_contains: 'לא מכיל', starts_with: 'מתחיל ב',
  ends_with: 'מסתיים ב', exists: 'קיים', empty: 'ריק',
  is_true: 'נכון', is_false: 'לא נכון',
  older_than_days: 'ישן מ־(ימים)', newer_than_days: 'חדש מ־(ימים)',
  within_next_days: 'בתוך X הימים הקרובים', overdue_by_days: 'באיחור של (ימים)',
  regex: 'תואם ביטוי',
};

/**
 * הפרש בימים בין תאריך לבין now.
 * חיובי = בעבר. שלילי = בעתיד.
 */
function daysAgo(v: unknown, now: number): number {
  if (v == null || v === '') return NaN;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(t)) return NaN;
  return (now - t) / 86400000;
}

// ============================================================

export function evalCondition(
  c: Condition, ctx: unknown, now: number = Date.now(),
): EvalTrace {
  const actual = getPath(ctx, c.field);
  const want = c.value;
  let passed = false;

  switch (c.op) {
    case 'eq':  passed = asStr(actual, c.ci) === asStr(want, c.ci); break;
    case 'neq': passed = asStr(actual, c.ci) !== asStr(want, c.ci); break;

    // השוואות מספריות מחזירות false על NaN ולא זורקות: שדה סכום ריק
    // פשוט לא עובר את התנאי.
    case 'gt':  passed = asNum(actual) >  asNum(want); break;
    case 'gte': passed = asNum(actual) >= asNum(want); break;
    case 'lt':  passed = asNum(actual) <  asNum(want); break;
    case 'lte': passed = asNum(actual) <= asNum(want); break;

    case 'in':
      passed = Array.isArray(want) && want.map((x) => asStr(x, c.ci)).includes(asStr(actual, c.ci));
      break;
    case 'nin':
      passed = !Array.isArray(want) || !want.map((x) => asStr(x, c.ci)).includes(asStr(actual, c.ci));
      break;

    case 'contains':     passed = asStr(actual, c.ci).includes(asStr(want, c.ci)); break;
    case 'not_contains': passed = !asStr(actual, c.ci).includes(asStr(want, c.ci)); break;
    case 'starts_with':  passed = asStr(actual, c.ci).startsWith(asStr(want, c.ci)); break;
    case 'ends_with':    passed = asStr(actual, c.ci).endsWith(asStr(want, c.ci)); break;

    case 'exists': passed = !isEmpty(actual); break;
    case 'empty':  passed = isEmpty(actual); break;

    // ⚠ הבדל מ-eq: מטפל ב-truthiness ולא בהשוואת מחרוזות. `done: false`
    // מול eq/"false" עבד במקרה כי שניהם הופכים ל-"false", אבל `done`
    // חסר לגמרי היה נותן "" ולא עובר — וזה בדיוק המצב של משימה ישנה.
    case 'is_true':  passed = actual === true || actual === 'true' || actual === 1; break;
    case 'is_false': passed = !(actual === true || actual === 'true' || actual === 1); break;

    case 'older_than_days': {
      const d = daysAgo(actual, now);
      passed = Number.isFinite(d) && d > asNum(want);
      break;
    }
    case 'newer_than_days': {
      const d = daysAgo(actual, now);
      passed = Number.isFinite(d) && d >= 0 && d < asNum(want);
      break;
    }
    case 'within_next_days': {
      const d = daysAgo(actual, now);
      // d שלילי = בעתיד. -d הוא מספר הימים עד המועד.
      passed = Number.isFinite(d) && d <= 0 && -d <= asNum(want);
      break;
    }
    case 'overdue_by_days': {
      const d = daysAgo(actual, now);
      passed = Number.isFinite(d) && d > asNum(want);
      break;
    }

    case 'regex': {
      // ⚠ ביטוי שהמשתמש כתב יכול להיות שגוי תחבירית. זריקה כאן הייתה
      // מפילה את כל הכלל; במקום זה התנאי פשוט לא מתקיים.
      try { passed = new RegExp(String(want), c.ci ? 'i' : '').test(asStr(actual)); }
      catch { passed = false; }
      break;
    }

    // אופרטור לא מוכר נכשל **סגור**. הכיוון ההפוך היה גורם לאוטומציה
    // לפעול על כל הרשומות בגלל שגיאת הקלדה בשם האופרטור.
    default: passed = false;
  }

  const opHe = OP_HE[c.op] || c.op;
  const showVal = want === undefined ? '' : ` ${JSON.stringify(want)}`;
  return {
    field: c.field, op: c.op, expected: want, actual, passed,
    explain: `${c.field} (${JSON.stringify(actual ?? null)}) ${opHe}${showVal} → ${passed ? 'מתקיים' : 'לא מתקיים'}`,
  };
}

/**
 * הערכת עץ תנאים.
 *
 * מערך שטוח = AND, לתאימות לאחור עם הכללים שכבר קיימים ב-DB.
 * רשימה ריקה = עובר (אין תנאים = חל על הכל), בדיוק כמו במנוע הקיים.
 */
export function evaluate(
  node: ConditionNode | ConditionNode[] | null | undefined,
  ctx: unknown,
  now: number = Date.now(),
): EvalResult {
  const trace: EvalTrace[] = [];
  const passed = walk(node, ctx, now, trace);
  return { passed, trace };
}

function walk(
  node: ConditionNode | ConditionNode[] | null | undefined,
  ctx: unknown, now: number, trace: EvalTrace[],
): boolean {
  if (node == null) return true;

  if (Array.isArray(node)) {
    if (!node.length) return true;
    return node.every((n) => walk(n, ctx, now, trace));
  }

  if (isGroup(node)) {
    // ⚠ every/some על מערך ריק מחזירים true/false בהתאמה. `any: []` היה
    // מחזיר false ופוסל את הכלל כולו בשקט — התנהגות שאף אחד לא מתכוון
    // אליה כשהוא מוחק את התנאי האחרון בקבוצה. קבוצה ריקה = אין הגבלה.
    if (node.all?.length) {
      if (!node.all.every((n) => walk(n, ctx, now, trace))) return false;
    }
    if (node.any?.length) {
      // ⚠ ללא short-circuit בכוונה: ה-trace הוא ההסבר שהמשתמש רואה, ו-
      // some היה מפסיק אחרי ההתאמה הראשונה ומשאיר אותו חלקי.
      const results = node.any.map((n) => walk(n, ctx, now, trace));
      if (!results.some(Boolean)) return false;
    }
    if (node.none?.length) {
      const results = node.none.map((n) => walk(n, ctx, now, trace));
      if (results.some(Boolean)) return false;
    }
    return true;
  }

  const t = evalCondition(node as Condition, ctx, now);
  trace.push(t);
  return t.passed;
}

/**
 * הסבר בשפה אנושית להצגה במסך (סעיף 21).
 * מציג רק את התנאים שהכריעו — רשימה של 12 תנאים שכולם עברו אינה הסבר.
 */
export function explainResult(res: EvalResult, ruleName: string): string {
  if (!res.trace.length) return `הכלל "${ruleName}" חל על כל הרשומות מסוג זה (ללא תנאים).`;
  const decisive = res.passed ? res.trace.filter((t) => t.passed) : res.trace.filter((t) => !t.passed);
  const lines = (decisive.length ? decisive : res.trace).slice(0, 5).map((t) => '• ' + t.explain);
  return res.passed
    ? `הכלל "${ruleName}" הופעל משום ש:\n${lines.join('\n')}`
    : `הכלל "${ruleName}" לא הופעל משום ש:\n${lines.join('\n')}`;
}

/**
 * שעות שקטות (סעיף 30).
 *
 * ⚠ חלון שחוצה חצות (20:00–08:00) הוא ההגדרה השכיחה, ובדיקה נאיבית של
 * `from <= t && t <= to` הייתה מחזירה false תמיד עבורו — כלומר שעות
 * שקטות פשוט לא היו עובדות אף פעם.
 */
export function inQuietHours(
  quiet: { days?: number[]; from?: string; to?: string } | null | undefined,
  at: Date, timeZone = 'Asia/Jerusalem',
): boolean {
  if (!quiet) return false;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const hh = Number(get('hour'));
  const mm = Number(get('minute'));
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wd = wdMap[get('weekday')] ?? -1;

  if (quiet.days?.length && quiet.days.includes(wd)) return true;
  if (!quiet.from || !quiet.to) return false;

  const toMin = (s: string) => {
    const [h, m] = String(s).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const now = hh * 60 + mm;
  const from = toMin(quiet.from);
  const to = toMin(quiet.to);

  return from <= to ? (now >= from && now < to) : (now >= from || now < to);
}
