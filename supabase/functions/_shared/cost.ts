// חישוב עלות ואכיפת תקציב.
//
// התעריפים מיושרים עם מה ש-ai-proxy/index.ts:29-32 כבר משתמש בו (haiku 1/5,
// sonnet 3/15 ל-מיליון טוקנים), כדי ששני המסלולים לא יראו שני מספרים
// שונים לאותה קריאה.
//
// חשוב: מרכז ה-AI **לא** עובר דרך ai-proxy ולכן לא נספר במכסת ה-200
// שלו. זו החלטה מכוונת — מכסה שטוחה של 200 קריאות בחודש היא מגבלה של
// צ'אט אנושי, וסוכן אוטונומי אחד יכול לשרוף אותה ביום ולנעול את המשתמש
// מחוץ לצ'אט. במקום זה יש כאן תקציב **בדולרים** (ai_settings), שהוא גם
// מה שהפרומט מבקש בסעיף 21.

export type ModelRate = { in: number; out: number };  // USD למיליון טוקנים

// תעריפי הספק, דולר למיליון טוקנים. haiku ו-sonnet-4-6 מיושרים במכוון עם
// ai-proxy/index.ts:29-32, כדי ששני המסלולים לא יראו מספר שונה לאותה קריאה.
export const MODEL_RATES: Record<string, ModelRate> = {
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'claude-haiku-4-5':          { in: 1, out: 5 },
  'claude-sonnet-4-6':         { in: 3, out: 15 },
  'claude-sonnet-5':           { in: 3, out: 15 },
  'claude-opus-4-6':           { in: 5, out: 25 },
  'claude-opus-4-7':           { in: 5, out: 25 },
  'claude-opus-4-8':           { in: 5, out: 25 },
  'claude-opus-5':             { in: 5, out: 25 },
  'claude-fable-5':            { in: 10, out: 50 },
};

const DEFAULT_RATE: ModelRate = { in: 3, out: 15 };

export function rateFor(model: string): ModelRate {
  if (MODEL_RATES[model]) return MODEL_RATES[model];
  // מודל לא מוכר (גרסה שיצאה אחרי כתיבת הקוד) — מזהים לפי המשפחה במקום
  // להחזיר 0. אומדן גבוה מדי גורם לעצירה מוקדמת; אומדן של 0 גורם לחריגת
  // תקציב בלי שום התראה. מבין השניים, עצירה מוקדמת עדיפה בהרבה.
  const m = model.toLowerCase();
  if (m.includes('haiku')) return MODEL_RATES['claude-haiku-4-5-20251001'];
  if (m.includes('fable') || m.includes('mythos')) return MODEL_RATES['claude-fable-5'];
  if (m.includes('opus')) return MODEL_RATES['claude-opus-5'];
  return DEFAULT_RATE;
}

/**
 * האם המודל מקבל את הפרמטר temperature.
 *
 * הוא הוסר מדור 4.7 ואילך (Opus 4.7/4.8/5, Sonnet 5, Fable 5) ומוחזר משם
 * כשגיאת 400. ai_agents.default_model ניתן לעריכה ע"י בעל המשרד מהמסך,
 * ולכן שליחה עיוורת של temperature הייתה מפילה **כל** הרצה של סוכן שהמודל
 * שלו שונה לאחד מהחדשים.
 *
 * allow-list ולא deny-list בכוונה: מודל שייצא אחרי כתיבת הקוד ייפול לצד
 * הבטוח (לא נשלח) במקום להפיל הרצות. השמטת הפרמטר אף פעם לא נכשלת;
 * שליטה בסגנון באותם מודלים נעשית בהנחיה.
 *
 * יושב כאן ולא ב-provider.ts כדי שיהיה בר-בדיקה: provider.ts קורא ל-
 * Deno.env ברמת המודול ולכן Node לא יכול לייבא אותו.
 */
export function acceptsTemperature(model: string): boolean {
  const m = model.toLowerCase();
  if (/opus-(4-7|4-8|5)|sonnet-5|fable|mythos/.test(m)) return false;
  return /haiku|sonnet-4-(5|6)|opus-4-(5|6)/.test(m);
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const r = rateFor(model);
  const cost = (inputTokens / 1_000_000) * r.in + (outputTokens / 1_000_000) * r.out;
  return Math.round(cost * 1e6) / 1e6;   // 6 ספרות — קריאה בודדת עולה שברירי סנט
}

/**
 * אומדן טוקנים לפני שליחה, לבדיקת תקציב מראש.
 * עברית צורכת יותר טוקנים לתו מאנגלית (בממוצע ~2.5 תווים לטוקן מול ~4).
 * מקדם 2.7 הוא אומדן שמרני מכוון — עדיף להעריך גבוה ולעצור, מאשר לגלות
 * חריגה אחרי שהחשבון כבר נשלח.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  const hebrewChars = (text.match(/[֐-׿]/g) || []).length;
  const ratio = hebrewChars > text.length * 0.3 ? 2.7 : 3.8;
  return Math.ceil(text.length / ratio);
}

export type BudgetState = {
  todayCost: number; monthCost: number;
  dailyBudget: number; monthlyBudget: number;
  dailyPct: number; monthlyPct: number;
  exceeded: boolean; warn70: boolean; warn90: boolean;
  action: 'allow' | 'downgrade' | 'stop';
};

export function evaluateBudget(
  todayCost: number, monthCost: number,
  dailyBudget: number, monthlyBudget: number,
  onExceeded: 'stop' | 'downgrade',
): BudgetState {
  const dailyPct = dailyBudget > 0 ? todayCost / dailyBudget : 0;
  const monthlyPct = monthlyBudget > 0 ? monthCost / monthlyBudget : 0;
  const worst = Math.max(dailyPct, monthlyPct);
  const exceeded = worst >= 1;
  return {
    todayCost, monthCost, dailyBudget, monthlyBudget, dailyPct, monthlyPct, exceeded,
    warn70: worst >= 0.7 && worst < 0.9,
    warn90: worst >= 0.9 && worst < 1,
    action: exceeded ? onExceeded : 'allow',
  };
}
