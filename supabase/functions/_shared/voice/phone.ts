// נרמול מספרי טלפון — הפורמט הקנוני במערכת הוא E.164.
//
// ## למה זה קריטי דווקא כאן
// אותו אדם מופיע ב-CRM כ-050-1234567, בוואטסאפ כ-972501234567, ובשיחה
// נכנסת כ-+972501234567. בלי צורה קנונית אחת, לקוח ותיק נפתח כליד חדש
// בכל שיחה, ובקשת חזרה נרשמת על מספר שאיש לא יזהה.
//
// ## היחס ל-normalizePhone הקיים
// `normalizePhone` ב-security.ts כבר ממיר ל-+972 והוא בשימוש בכל
// המערכת (וואטסאפ, טלפוניה, כלים). **הוא לא משוכפל כאן ולא מוחלף** —
// הקובץ הזה קורא לו ומוסיף מעליו מה שחסר: אימות אורך, סיווג סוג הקו,
// ותיעוד הסיבה כשמספר נדחה.
//
// ההפרדה חשובה: `normalizePhone` מחזיר '+9725012345' גם למספר בן שמונה
// ספרות, כי הוא בודק טווח אורך גנרי (9-15) ולא את כללי המספור הישראלי.
// לזיהוי לקוח זה מספיק; ל"האם אפשר לחייג לזה בחזרה" זה לא.
//
// טהור מ-Deno ומ-DB — ראה test/call-center.test.js.

import { normalizePhone } from '../security.ts';

export type PhoneKind = 'mobile' | 'landline' | 'toll_free' | 'international' | 'unknown';

export type NormalizedPhone = {
  /** מה שנמסר, אחרי חיתוך רווחים בלבד. נשמר לצד המנורמל. */
  raw: string;
  /** E.164, או null כשלא ניתן לנרמל. */
  normalized: string | null;
  valid: boolean;
  kind: PhoneKind;
  /** להצגה: 050-123-4567. לעולם לא לאחסון או להשוואה. */
  display: string;
  /** למה נדחה. ריק כשתקין. */
  reason: string;
};

// אורכי המספור הישראלי, בספרות שאחרי קידומת המדינה (972).
//   נייד / VoIP:  5X, 7X  → 9 ספרות   (+9725XXXXXXXX)
//   קווי:         2,3,4,8,9 → 8 ספרות (+9723XXXXXXX)
const IL_MOBILE_PREFIX = /^(5|7)/;
const IL_LANDLINE_PREFIX = /^(2|3|4|8|9)/;
const IL_TOLL_FREE_PREFIX = /^(1[78]00)/;

/**
 * הפונקציה המרכזית. כל זיהוי מתקשר, כל בקשת חזרה וכל שמירת מספר
 * עוברים דרכה.
 */
export function normalizePhoneNumber(input: unknown): NormalizedPhone {
  const raw = String(input ?? '').trim();
  const empty: NormalizedPhone = {
    raw, normalized: null, valid: false, kind: 'unknown', display: raw, reason: '',
  };

  if (!raw) return { ...empty, reason: 'לא נמסר מספר' };

  // ⚠ 1-700 / 1-800 מזוהים לפני הנרמול הכללי. הם מספרי שירות ואינם
  // ניתנים להמרה ל-E.164 בצורה שאפשר לחייג אליה מחו"ל; המרה שלהם
  // הייתה מייצרת מספר שנראה תקין ואינו קיים.
  const digitsOnly = raw.replace(/\D/g, '');
  if (IL_TOLL_FREE_PREFIX.test(digitsOnly)) {
    return {
      raw, normalized: null, valid: false, kind: 'toll_free',
      display: formatDisplay(digitsOnly),
      reason: 'מספר שירות (1-700/1-800) — לא ניתן לנרמול ל-E.164',
    };
  }

  const normalized = normalizePhone(raw);
  if (!normalized) {
    return { ...empty, reason: 'מספר לא תקין' };
  }

  // מספר שאינו ישראלי: מקובל כמות שהוא אם הוא E.164 סביר.
  if (!normalized.startsWith('+972')) {
    return {
      raw, normalized, valid: true, kind: 'international',
      display: normalized, reason: '',
    };
  }

  const national = normalized.slice(4);   // מה שאחרי +972

  if (IL_MOBILE_PREFIX.test(national)) {
    const valid = national.length === 9;
    return {
      raw, normalized, valid, kind: 'mobile',
      display: formatDisplay('0' + national),
      reason: valid ? '' : `מספר נייד באורך ${national.length + 1} ספרות במקום 10`,
    };
  }

  if (IL_LANDLINE_PREFIX.test(national)) {
    const valid = national.length === 8;
    return {
      raw, normalized, valid, kind: 'landline',
      display: formatDisplay('0' + national),
      reason: valid ? '' : `מספר קווי באורך ${national.length + 1} ספרות במקום 9`,
    };
  }

  return {
    raw, normalized, valid: false, kind: 'unknown',
    display: formatDisplay('0' + national),
    reason: 'קידומת ישראלית לא מוכרת',
  };
}

/** E.164 בלבד, או null. קיצור לנתיבים שלא צריכים את שאר המידע. */
export function toE164(input: unknown): string | null {
  const r = normalizePhoneNumber(input);
  return r.normalized;
}

/**
 * ⚠ ההשוואה **לא** מסתמכת רק על E.164. מספר שנשמר ב-CRM בפורמט שגוי
 * (רווח מיותר, קידומת חסרה) לא ינורמל, ואז לקוח קיים היה נפתח כליד
 * חדש. הנפילה להשוואת תשע הספרות האחרונות היא מה שמונע את זה, והיא
 * אותה נפילה שכבר קיימת ב-samePhone שבשימוש בשאר המערכת.
 */
export function samePhoneNumber(a: unknown, b: unknown): boolean {
  const na = toE164(a), nb = toE164(b);
  if (na && nb) return na === nb;
  const da = String(a ?? '').replace(/\D/g, '').slice(-9);
  const db = String(b ?? '').replace(/\D/g, '').slice(-9);
  return da.length === 9 && da === db;
}

/** 0501234567 → 050-123-4567. תצוגה בלבד. */
export function formatDisplay(value: string): string {
  const d = String(value ?? '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('0')) {
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  }
  if (d.length === 9 && d.startsWith('0')) {
    return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  }
  return value;
}

/** E.164 → תצוגה מקומית. משמש במסכים ובהקראה למתקשר. */
export function displayFromE164(e164: unknown): string {
  const s = String(e164 ?? '');
  if (s.startsWith('+972')) return formatDisplay('0' + s.slice(4));
  return s;
}

/** המספר הציבורי של המשרד, בצורתו הקנונית. */
export const OFFICE_PHONE_E164 = '+972552745790';
