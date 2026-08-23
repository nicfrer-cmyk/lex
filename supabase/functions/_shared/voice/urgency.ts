// מנוע הדחיפות.
//
// ## הבעיה עם התאמת מילות מפתח
// "קיבלתי עיקול" ו-"רציתי לשאול אם עיקול זה משהו שאתם מטפלים בו" מכילים
// את אותה מילה ואינם אותו מצב. מנוע שמסתמך על מילות מפתח בלבד יסמן את
// שניהם דחוף, ואחרי שבוע של התראות שווא איש לא יסתכל על סימון הדחיפות —
// ואז השיחה שבאמת דחופה תיבלע. המפרט אומר את זה במפורש: "אל תסתמך רק על
// Keyword matching".
//
// ## המבנה
// שלושה מקורות, והחזק שבהם גובר:
//
//   1. **המודל** — מסווג את השיחה בהקשר מלא. זה המקור העיקרי.
//   2. **מילות מפתח** (ניתנות לעריכה ב-voice_agents.urgency_rules) —
//      **תקרה** ולא רצפה: הן יכולות להעלות עד 'high' לכל היותר בעצמן.
//      'critical' דורש הסכמה של המודל, כי critical פירושו להעיר אדם.
//   3. **הקשר** — מועד קרוב שנאמר בשיחה, לקוח קיים, מתקשר חוזר.
//
// ## למה זה קובץ טהור
// אין כאן DB, אין רשת, אין Deno. זו הלוגיקה שקובעת מה יסומן כדחוף במשרד
// עורכי דין — היא חייבת להיות ניתנת לבדיקה ישירה. ראה test/call-center.test.js.

export type Urgency = 'low' | 'normal' | 'high' | 'critical';

export const URGENCY_ORDER: Urgency[] = ['low', 'normal', 'high', 'critical'];

export function urgencyRank(u: Urgency | string | null | undefined): number {
  const i = URGENCY_ORDER.indexOf(String(u) as Urgency);
  return i < 0 ? 1 : i;  // ברירת מחדל: normal
}

export function maxUrgency(a: Urgency, b: Urgency): Urgency {
  return urgencyRank(a) >= urgencyRank(b) ? a : b;
}

export type UrgencyRules = {
  keywords?: Partial<Record<Urgency, string[]>>;
  boosters?: {
    deadline_within_days?: number;
    existing_client?: boolean;
    repeat_caller_within_hours?: number;
  };
  /** התקרה שמילות מפתח לבדן יכולות להגיע אליה. */
  max_from_keywords?: Urgency;
};

export const DEFAULT_URGENCY_RULES: UrgencyRules = {
  keywords: {
    critical: ['מעצר', 'צו מעצר', 'פינוי היום', 'דיון מחר', 'דיון היום'],
    high: [
      'עיקול', 'עוקל', 'חשבון חסום', 'חשבון מעוקל', 'פינוי', 'צו',
      'הוצאה לפועל', 'דדליין', 'מועד אחרון', 'היום', 'מחר',
      'אזהרה', 'התראה', 'כינוס', 'הליך',
    ],
    normal: ['פגישה', 'ייעוץ', 'שאלה', 'עדכון', 'מסמך'],
  },
  boosters: {
    deadline_within_days: 3,
    existing_client: false,
    repeat_caller_within_hours: 24,
  },
  max_from_keywords: 'high',
};

export type UrgencyContext = {
  /** מה שנאמר בשיחה עד כה. */
  transcript: string;
  /** הסיווג של המודל, אם כבר סיווג. */
  modelUrgency?: Urgency | null;
  /** מועד שהמודל חילץ מהשיחה (YYYY-MM-DD). */
  deadlineISO?: string | null;
  /** התאריך של היום, YYYY-MM-DD. מוזרק ולא נקרא מהשעון — בדיקה
   *  תלוית-שעון נכשלת בחצות ואז אף אחד לא מאמין לה. */
  todayISO: string;
  isExistingClient?: boolean;
  /** שעות מאז השיחה הקודמת מאותו מספר; null אם אין קודמת. */
  hoursSincePreviousCall?: number | null;
};

export type UrgencyVerdict = {
  urgency: Urgency;
  /** הסבר קריא לאדם — מוצג במסך, ולא רק בלוג. סיווג בלי נימוק אינו
   *  ניתן לערעור, ולכן אינו ניתן לתיקון. */
  reasons: string[];
  matchedKeywords: string[];
};

/** נרמול לצורך התאמה: הסרת ניקוד, רווחים כפולים וסימני פיסוק דבקים. */
function normalize(text: string): string {
  return String(text || '')
    .replace(/[֑-ׇ]/g, '')          // טעמים וניקוד
    .replace(/[.,!?;:"'()\[\]־–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ביטויי שלילה/היפותטיקה שמנטרלים מילת מפתח שמופיעה אחריהם.
 *
 * ⚠ זה מה שמבדיל בין "קיבלתי עיקול" לבין "אם יהיה עיקול" ו-"רציתי לשאול
 * על עיקול". בלי זה כל שיחת בירור נספרת כחירום.
 */
const HYPOTHETICAL_MARKERS = [
  'אם יהיה', 'אם יגיע', 'במקרה ש', 'רציתי לשאול', 'רק לשאול', 'שאלה כללית',
  'האם אתם מטפלים', 'האם אתם עוסקים', 'סתם שאלה', 'לא קיבלתי', 'עוד לא',
  'אין לי', 'למנוע', 'כדי שלא', 'שלא יהיה', 'בעתיד', 'עבור חבר', 'בשביל חבר',
];

function isHypothetical(text: string, keywordIndex: number): boolean {
  // חלון של 40 תווים לפני המילה. ארוך מספיק כדי לתפוס "רציתי לשאול אם
  // במקרה שיגיע אליי עיקול", קצר מספיק כדי לא לגרור שלילה ממשפט קודם.
  const before = text.slice(Math.max(0, keywordIndex - 40), keywordIndex);
  return HYPOTHETICAL_MARKERS.some((m) => before.includes(m));
}

export function scoreUrgency(ctx: UrgencyContext, rulesRaw?: UrgencyRules | null): UrgencyVerdict {
  const rules: UrgencyRules = {
    ...DEFAULT_URGENCY_RULES,
    ...(rulesRaw || {}),
    keywords: { ...DEFAULT_URGENCY_RULES.keywords, ...(rulesRaw?.keywords || {}) },
    boosters: { ...DEFAULT_URGENCY_RULES.boosters, ...(rulesRaw?.boosters || {}) },
  };

  const text = normalize(ctx.transcript);
  const reasons: string[] = [];
  const matchedKeywords: string[] = [];

  // ---- 1. מילות מפתח, עם בדיקת הקשר ----
  let keywordUrgency: Urgency = 'low';
  for (const level of ['critical', 'high', 'normal'] as const) {
    for (const kw of rules.keywords?.[level] || []) {
      const needle = normalize(kw);
      if (!needle) continue;
      const idx = text.indexOf(needle);
      if (idx < 0) continue;
      if (isHypothetical(text, idx)) {
        reasons.push(`"${kw}" הופיע בהקשר היפותטי ולא נספר`);
        continue;
      }
      matchedKeywords.push(kw);
      keywordUrgency = maxUrgency(keywordUrgency, level);
    }
  }

  // התקרה: מילות מפתח לבדן לא מגיעות ל-critical.
  const cap = (rules.max_from_keywords || 'high') as Urgency;
  if (urgencyRank(keywordUrgency) > urgencyRank(cap)) {
    reasons.push(`סימון לפי מילות מפתח הוגבל ל-${cap}`);
    keywordUrgency = cap;
  }
  if (matchedKeywords.length) {
    reasons.push(`מונחים שזוהו: ${matchedKeywords.join(', ')}`);
  }

  // ---- 2. סיווג המודל ----
  let urgency: Urgency = keywordUrgency === 'low' ? 'normal' : keywordUrgency;
  if (ctx.modelUrgency && URGENCY_ORDER.includes(ctx.modelUrgency)) {
    if (urgencyRank(ctx.modelUrgency) > urgencyRank(urgency)) {
      reasons.push(`הסוכן סיווג את השיחה כ-${ctx.modelUrgency}`);
    }
    urgency = maxUrgency(urgency, ctx.modelUrgency);
  }

  // ---- 3. מגברי הקשר ----
  const boosters = rules.boosters || {};

  if (ctx.deadlineISO && boosters.deadline_within_days != null) {
    const days = daysBetween(ctx.todayISO, ctx.deadlineISO);
    if (days !== null && days >= 0 && days <= boosters.deadline_within_days) {
      const bumped = days === 0 ? 'critical' : 'high';
      if (urgencyRank(bumped) > urgencyRank(urgency)) {
        reasons.push(days === 0 ? 'המועד הוא היום' : `מועד בעוד ${days} ימים`);
        urgency = bumped as Urgency;
      }
    }
  }

  if (boosters.existing_client && ctx.isExistingClient && urgencyRank(urgency) < urgencyRank('high')) {
    reasons.push('לקוח קיים של המשרד');
    urgency = 'high';
  }

  if (boosters.repeat_caller_within_hours != null &&
      ctx.hoursSincePreviousCall != null &&
      ctx.hoursSincePreviousCall <= boosters.repeat_caller_within_hours &&
      urgencyRank(urgency) < urgencyRank('high')) {
    reasons.push(`המתקשר פנה שוב בתוך ${Math.round(ctx.hoursSincePreviousCall)} שעות`);
    urgency = 'high';
  }

  if (!reasons.length) reasons.push('לא זוהו סימני דחיפות');
  return { urgency, reasons, matchedKeywords };
}

function daysBetween(fromISO: string, toISO: string): number | null {
  const a = Date.parse(String(fromISO).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(String(toISO).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

// ============================================================
// סיווג נושא
// ============================================================

/** תחומי הפעילות. משמש לתיוג השיחה ולסינון בהיסטוריה. */
export const CALL_CATEGORIES = [
  'הוצאה לפועל', 'חוזים', 'נזיקין', 'משפחה', 'עבודה', 'פלילי',
  'מקרקעין', 'חברות ומסחר', 'צוואות וירושות', 'גבייה', 'כללי',
] as const;

/** רמז ראשוני לסיווג — המודל הוא הקובע, זה רק ערך פתיחה סביר. */
export function guessCategory(transcript: string): string {
  const t = normalize(transcript);
  const table: Array<[string, string[]]> = [
    ['הוצאה לפועל', ['הוצאה לפועל', 'עיקול', 'עוקל', 'תיק איחוד', 'כינוס', 'חשבון חסום', 'הגבלה']],
    ['משפחה', ['גירושין', 'גירושים', 'להתגרש', 'מזונות', 'משמורת', 'הסכם ממון', 'בית דין רבני', 'צו הרחקה']],
    ['עבודה', ['פיטורין', 'פיטורים', 'פיטרו', 'שימוע', 'פיצויי פיטורין', 'שכר עבודה', 'הטרדה במקום העבודה']],
    ['פלילי', ['מעצר', 'חקירה', 'משטרה', 'כתב אישום', 'תלונה פלילית']],
    ['מקרקעין', ['פינוי', 'שכירות', 'דירה', 'טאבו', 'ליקויי בנייה', 'תמא']],
    ['נזיקין', ['תאונה', 'תאונת דרכים', 'נזק גוף', 'ביטוח לאומי', 'רשלנות רפואית']],
    ['חוזים', ['חוזה', 'הסכם', 'הפרת הסכם', 'סעיף']],
    ['צוואות וירושות', ['צוואה', 'ירושה', 'עיזבון', 'צו קיום']],
    ['גבייה', ['חוב', 'שיק', 'שיקים', 'לא שילם', 'גבייה']],
    ['חברות ומסחר', ['חברה בעמ', 'שותפות', 'רשם החברות', 'מניות']],
  ];
  for (const [cat, needles] of table) {
    if (needles.some((n) => t.includes(normalize(n)))) return cat;
  }
  return 'כללי';
}

// ============================================================
// נרמול דחיפות מטקסט חופשי
// ============================================================

/**
 * ממפה דחיפות בטקסט חופשי לערך שסכימת הכלי מקבלת.
 *
 * ⚠ נמדד בייצור: ספק קול חיצוני שלח `urgency: "דחוף מאוד"`, הסכימה
 * דחתה ("ערך לא מותר"), ו**בקשת החזרה אבדה כליל** — מתקשר עם עיקולים
 * ביקש שיחזרו אליו ולא נרשם דבר. מודל שמדבר עברית יחזיר עברית, וזה
 * צפוי; לדרוש ממנו enum באנגלית זו דרישה שתישבר שוב.
 *
 * ערך שאינו מזוהה מוחזר כ-undefined ולא כשגיאה, והכלי נופל לברירת
 * המחדל שלו. דחיפות שגויה היא רעש; בקשה שאבדה היא לקוח שלא חזרו אליו.
 */
export function normalizeUrgency(raw: unknown): Urgency | undefined {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return undefined;
  if (URGENCY_ORDER.includes(v as Urgency)) return v as Urgency;

  // ⚠ הסדר כאן הוא כל הנכונות, ושתי המלכודות הן אותה מלכודת: ביטוי
  // קצר שמוכל בתוך ביטוי ארוך יותר בעל משמעות הפוכה.
  //
  //   "לא דחוף"  מכיל "דחוף"  → בדיקת שלילה חייבת לקדום
  //   "דחוף מאוד" מכיל "דחוף" → ההחמרה חייבת לקדום
  //
  // זו אותה מלכודת בדיוק ש-isHypothetical למעלה נבנה בשבילה, וכאן היא
  // חוזרת על מחרוזת קצרה במקום על משפט.
  if (/(לא\s*דחוף|לא\s*בהול|not\s*urgent|non[-\s]?urgent)/.test(v)) return 'low';
  if (/(דחוף\s*מאוד|very\s*urgent|extremely\s*urgent)/.test(v)) return 'critical';
  if (/(קריטי|בהול|מיידי|חירום|emergency|asap|immediate|critical)/.test(v)) return 'critical';
  if (/(דחוף|גבוה|urgent|high)/.test(v)) return 'high';
  if (/(רגיל|בינוני|normal|medium|standard)/.test(v)) return 'normal';
  if (/(נמוך|low|minor)/.test(v)) return 'low';
  return undefined;
}
