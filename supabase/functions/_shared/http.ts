// CORS + תשובות JSON — משותף לכל פונקציות מרכז ה-AI.
//
// ההערה ב-ai-proxy/index.ts:37-43 מתעדת בדיוק למה זה חייב להיות על *כל*
// תשובה כולל OPTIONS: בלי זה הדפדפן חוסם את הבקשה לפני שהיא מגיעה לקוד
// בכלל, וזה נראה כמו "Failed to send a request to the Edge Function" —
// תקלה שהתגלתה רק על טלפון אמיתי, כי fetch של Node לא אוכף CORS.
// אותה מלכודת בדיוק תחזור כאן אם מישהו יחזיר Response ידנית בלי ההדרים.

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-idempotency-key',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  return null;
}

/** שגיאה עם הודעה בעברית למשתמש + קוד יציב ללוגים. */
export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export function errorResponse(e: unknown) {
  if (e instanceof AppError) return json({ error: e.message, code: e.code }, e.status);
  const msg = e instanceof Error ? e.message : String(e);
  // לא מחזירים stack ללקוח — עלול להכיל שמות טבלאות/נתיבים.
  console.error('[ai-center] unhandled', e);
  return json({ error: 'שגיאה בשרת: ' + msg, code: 'internal' }, 500);
}
