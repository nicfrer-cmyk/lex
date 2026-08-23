// חתימת בקשות בין שרת הקול (Voice Gateway) לבין ה-CRM.
//
// ## למה זה קיים
// שרת הקול רץ על מכונה נפרדת, בלי משתמש מחובר ובלי JWT. ה-endpoint שהוא
// פונה אליו חייב להיות פומבי — ולכן, בלי אימות, כל אחד באינטרנט יכול
// לשלוח "התקבלה שיחה מ-050-1234567, הלקוח מבקש את פרטי התיק". במשרד
// עורכי דין זו דליפת מידע, לא אי-נוחות.
//
// ## הסכימה
//   X-Voice-Office     — מזהה המשרד
//   X-Voice-Timestamp  — שניות Unix
//   X-Voice-Nonce      — מזהה חד-פעמי לבקשה
//   X-Voice-Signature  — HMAC-SHA256 בהקסה של  `${timestamp}.${nonce}.${body}`
//
// שלוש ההגנות, וכל אחת סוגרת פרצה שהאחרות משאירות פתוחה:
//
//  1. **חתימה** — מוכיחה שמי ששלח מחזיק בסוד. גם הגוף חתום, ולכן אי אפשר
//     לקחת בקשה לגיטימית ולשנות בה את מספר המתקשר.
//  2. **חלון זמן** — בקשה בת יותר מ-5 דקות נדחית. מצמצם את חלון השידור
//     החוזר, אבל **לא סוגר אותו**.
//  3. **nonce** — מפתח ראשי בטבלה. שידור חוזר של אותה בקשה חתומה, גם
//     בתוך החלון, נכשל ב-insert. זו ההגנה שבאמת עוצרת replay.
//
// ⚠ הסוד לא נמצא בקוד ולא ב-git. הוא ב-VOICE_GATEWAY_SECRET (secret של
// Supabase) ובקובץ ה-.env של שרת הקול. אם הוא לא מוגדר — כל בקשה נדחית
// ב-503, בכוונה. endpoint טלפוניה פומבי בלי אימות גרוע מהיעדר טלפוניה.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { hmacSha256Hex, timingSafeEqual } from '../crypto.ts';

/** חלון הזמן המותר, בשניות. */
export const SIGNATURE_WINDOW_SECONDS = 300;

export type SignatureHeaders = {
  officeId: string;
  timestamp: string;
  nonce: string;
  signature: string;
};

export type VerifyResult =
  | { ok: true }
  | { ok: false; code: 'missing_headers' | 'bad_timestamp' | 'expired' | 'bad_signature'; message: string };

/** המחרוזת שנחתמת. חייבת להיות זהה בשני הצדדים — ראה orchestrator/crm/signer.py. */
export function signingPayload(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}.${nonce}.${body}`;
}

export async function signRequest(
  secret: string, timestamp: string, nonce: string, body: string,
): Promise<string> {
  return hmacSha256Hex(secret, signingPayload(timestamp, nonce, body));
}

/**
 * אימות "טהור" — בלי DB. בודק את הפורמט, את חלון הזמן ואת החתימה.
 *
 * ⚠ הוא **לא** בודק replay. מי שקורא לו חייב לצרוף את consumeNonce.
 * ההפרדה מכוונת: זה החלק שאפשר וצריך לבדוק ביחידה, וההפרדה היא מה
 * שמאפשר לבדוק אותו בלי מסד נתונים.
 */
export async function verifySignature(
  secret: string, headers: SignatureHeaders, body: string, nowSeconds: number,
): Promise<VerifyResult> {
  if (!headers.timestamp || !headers.signature || !headers.nonce) {
    return { ok: false, code: 'missing_headers', message: 'חסרות כותרות חתימה' };
  }

  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, code: 'bad_timestamp', message: 'חותמת זמן לא תקינה' };
  }
  // Math.abs ולא רק (now - ts): שעון שרת קול שרץ קדימה היה מייצר בקשות
  // "מהעתיד" שעוברות לנצח. חריגה לשני הכיוונים היא חריגה.
  if (Math.abs(nowSeconds - ts) > SIGNATURE_WINDOW_SECONDS) {
    return { ok: false, code: 'expired', message: 'הבקשה פגה או שהשעון אינו מסונכרן' };
  }

  const expected = await signRequest(secret, headers.timestamp, headers.nonce, body);
  // השוואה בזמן קבוע — השוואה רגילה מדליפה דרך זמן התגובה כמה תווים
  // ניחשו נכון, וזה תוקף אמיתי מול endpoint פומבי.
  if (!timingSafeEqual(headers.signature.trim().toLowerCase(), expected)) {
    return { ok: false, code: 'bad_signature', message: 'חתימה לא תקינה' };
  }
  return { ok: true };
}

export function readSignatureHeaders(req: Request): SignatureHeaders {
  return {
    officeId: req.headers.get('x-voice-office') || '',
    timestamp: req.headers.get('x-voice-timestamp') || '',
    nonce: req.headers.get('x-voice-nonce') || '',
    signature: req.headers.get('x-voice-signature') || '',
  };
}

/**
 * Replay protection. מחזיר false אם ה-nonce כבר נראה.
 *
 * ה-insert הוא הבדיקה: מפתח ראשי על העמודה, ולכן "בדוק ואז הכנס" —
 * שהוא race condition קלאסי — לא קיים כאן כלל.
 */
export async function consumeNonce(
  sb: SupabaseClient, officeId: string, nonce: string,
): Promise<boolean> {
  const { error } = await sb.from('voice_request_nonces')
    .insert({ nonce, office_id: officeId });
  if (!error) return true;
  // 23505 = unique_violation → כבר נראה.
  if ((error as { code?: string }).code === '23505') return false;
  // תקלת DB אחרת: לא מכריזים על הבקשה כתקינה. במערכת אבטחה, "לא הצלחתי
  // לבדוק" חייב להתנהג כמו "נכשל".
  throw new Error('אימות ה-nonce נכשל: ' + error.message);
}

/**
 * ניקוי nonces ישנים. נקרא מנתיב ה-heartbeat, ולכן אין צורך ב-cron נפרד:
 * שרת קול פעיל מנקה אחרי עצמו, ושרת שאינו פעיל לא מייצר nonces חדשים.
 */
export async function pruneNonces(sb: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - SIGNATURE_WINDOW_SECONDS * 4000).toISOString();
  await sb.from('voice_request_nonces').delete().lt('created_at', cutoff);
}

// ============================================================
// מגבלת קצב
// ============================================================

export type RateLimitResult = { allowed: boolean; count: number; limit: number };

/**
 * חלון שעה מתגלגל לפי מפתח (בדרך כלל מספר המתקשר).
 *
 * הספירה נעשית ב-upsert + increment ולא ב-select-then-update, כדי ששתי
 * שיחות במקביל לא ייספרו כאחת.
 */
export async function checkRateLimit(
  sb: SupabaseClient, officeId: string, bucketKey: string, limit: number,
): Promise<RateLimitResult> {
  const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();

  const { data, error } = await sb.rpc('voice_rate_bump', {
    p_office: officeId, p_key: bucketKey, p_window: windowStart,
  });
  if (error) {
    // הפונקציה עדיין לא הותקנה, או תקלה נקודתית. מגבלת קצב היא הגנה
    // משנית — כשל בה לא צריך לחסום שיחה אמיתית מלקוח.
    console.warn('[voice] rate limit check failed', error.message);
    return { allowed: true, count: 0, limit };
  }
  const count = Number(data) || 0;
  return { allowed: count <= limit, count, limit };
}
