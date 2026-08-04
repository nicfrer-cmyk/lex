// הצפנת credentials של אינטגרציות.
//
// הפרומט (8.3): "אין לשמור token גלוי", "הצפן refresh tokens".
// integration_connections.encrypted_credentials מכיל את התוצר של encryptJson
// כאן — AES-256-GCM, המפתח רק ב-Supabase secrets (INTEGRATION_ENCRYPTION_KEY),
// לעולם לא בדפדפן ולא ב-git.
//
// GCM ולא CBC כי הוא authenticated: שינוי בשדה ה-ciphertext (למשל ע"י מי
// שהשיג גישת כתיבה ל-DB אבל לא למפתח) גורם ל-decrypt להיכשל במקום להחזיר
// זבל שהקוד ינסה לפרסר.
//
// פורמט: base64(iv[12] || ciphertext+tag). IV אקראי חדש לכל הצפנה — שימוש
// חוזר ב-IV עם GCM שובר את הביטחון של הצופן לחלוטין.

const ENC_KEY_RAW = Deno.env.get('INTEGRATION_ENCRYPTION_KEY') || '';

async function getKey(): Promise<CryptoKey> {
  if (!ENC_KEY_RAW) {
    throw new Error('INTEGRATION_ENCRYPTION_KEY לא מוגדר — לא ניתן להצפין credentials');
  }
  // המפתח בסביבה הוא טקסט חופשי; SHA-256 עליו נותן בדיוק 32 בייט ל-AES-256
  // בלי לדרוש מבעל המשרד לייצר מפתח בפורמט מסוים.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ENC_KEY_RAW));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function encryptJson(value: unknown): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );
  const combined = new Uint8Array(iv.length + cipher.length);
  combined.set(iv, 0);
  combined.set(cipher, iv.length);
  return toBase64(combined);
}

export async function decryptJson<T = unknown>(payload: string): Promise<T> {
  const key = await getKey();
  const combined = fromBase64(payload);
  const iv = combined.slice(0, 12);
  const cipher = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** מפתח idempotency יציב — אותו קלט תמיד נותן אותו מפתח. */
export async function stableHash(...parts: unknown[]): Promise<string> {
  const s = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p ?? null))).join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * השוואה בזמן קבוע — לאימות חתימות webhook.
 * השוואת מחרוזות רגילה (a === b) יוצאת מוקדם בבייט הראשון שנבדל, ומדליפה
 * דרך זמן התגובה כמה תווים ניחשו נכון. עם webhook פומבי זה תוקף אמיתי.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HMAC-SHA256 בהקסה — לאימות webhook של WhatsApp/Meta. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
