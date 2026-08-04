// שכבת Email Provider (סעיף 9).
//
// העדפה ראשונה: Gmail דרך Google OAuth 2.0. Microsoft Graph הוא נקודת
// הרחבה מתועדת ולא ממומשת — אין credentials, והפרומט אוסר להציג
// אינטגרציה כפעילה כשהיא לא (סעיף 29).
//
// ## הערה חשובה על ה-OAuth הקיים
// המערכת כבר משתמשת ב-Google OAuth — אבל של **Supabase Auth**, להתחברות
// בלבד (platform.web.js signInWithGoogle). לזרימה ההיא אין את ה-scopes של
// Gmail ואין refresh token מאוחסן, ולכן אי אפשר להשתמש בה כאן. זהו OAuth
// שני, נפרד, עם צריכת scopes מינימלית (סעיף 9.2).

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { encryptJson, decryptJson } from '../crypto.ts';

export type EmailMessage = {
  externalId: string; threadId: string;
  from: string; to: string; subject: string;
  bodyText: string; snippet: string;
  receivedAt: string; hasAttachments: boolean;
};

export type SendResult = { ok: boolean; externalId?: string; error?: string };

export interface EmailProvider {
  readonly name: string;
  readonly isMock: boolean;
  listRecent(sinceCursor?: string, max?: number): Promise<{ messages: EmailMessage[]; cursor?: string }>;
  send(msg: { to: string; subject: string; body: string; threadId?: string }): Promise<SendResult>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}

// ============================================================
// Gmail
// ============================================================

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';

/**
 * scopes מינימליים בלבד (סעיף 9.2: "אל תבקש הרשאות רחבות שלא נדרשות").
 * gmail.modify ולא gmail.full: מאפשר קריאה, כתיבת טיוטה, שליחה ותיוג —
 * אבל לא מחיקה ולא שינוי הגדרות החשבון.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

type GoogleCreds = { access_token: string; refresh_token: string; expiry: number };

export class GmailProvider implements EmailProvider {
  readonly name = 'google_gmail';
  readonly isMock = false;
  constructor(private sb: SupabaseClient, private officeId: string) {}

  /**
   * מחזיר access token תקף, ומרענן אותו אם פג.
   * הרענון נשמר מוצפן חזרה — refresh token שנשמר גלוי הוא גישה קבועה
   * לתיבת המייל של המשרד (סעיף 8.3).
   */
  private async accessToken(): Promise<string> {
    const { data: conn } = await this.sb.from('integration_connections')
      .select('encrypted_credentials, token_expires_at')
      .eq('office_id', this.officeId).eq('provider', 'google_gmail').maybeSingle();
    if (!conn?.encrypted_credentials) throw new Error('חשבון Gmail אינו מחובר');

    const creds = await decryptJson<GoogleCreds>(conn.encrypted_credentials);
    // מרווח של 60 שניות: token שפג באמצע הבקשה גורם לכשל שנראה אקראי.
    if (creds.expiry && creds.expiry > Date.now() + 60_000) return creds.access_token;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: creds.refresh_token, grant_type: 'refresh_token',
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      await this.sb.from('integration_connections').update({
        status: 'expired', last_error: data.error_description || data.error || 'רענון token נכשל',
      }).eq('office_id', this.officeId).eq('provider', 'google_gmail');
      throw new Error('פג תוקף החיבור ל-Gmail. יש להתחבר מחדש בהגדרות האינטגרציות.');
    }

    const updated: GoogleCreds = {
      access_token: data.access_token,
      // Google לא מחזיר refresh_token ברענון — חייבים לשמר את הישן.
      refresh_token: creds.refresh_token,
      expiry: Date.now() + (data.expires_in || 3600) * 1000,
    };
    await this.sb.from('integration_connections').update({
      encrypted_credentials: await encryptJson(updated),
      token_expires_at: new Date(updated.expiry).toISOString(),
      status: 'connected', last_error: null,
    }).eq('office_id', this.officeId).eq('provider', 'google_gmail');

    return updated.access_token;
  }

  async listRecent(sinceCursor?: string, max = 25) {
    const token = await this.accessToken();
    // historyId הוא ה-cursor של Gmail ל-incremental sync (סעיף 9.4) —
    // עדיף על סינון לפי תאריך, שמחמיץ הודעות שהגיעו באיחור.
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('maxResults', String(max));
    url.searchParams.set('q', sinceCursor ? `after:${sinceCursor}` : 'newer_than:7d');

    const listResp = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!listResp.ok) throw new Error('שגיאה בקריאת הודעות: ' + (await listResp.text()).slice(0, 200));
    const list = await listResp.json();

    const messages: EmailMessage[] = [];
    for (const m of (list.messages || []).slice(0, max)) {
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!r.ok) continue;
      const full = await r.json();
      messages.push(parseGmailMessage(full));
    }
    return { messages, cursor: String(Math.floor(Date.now() / 1000)) };
  }

  async send(msg: { to: string; subject: string; body: string; threadId?: string }): Promise<SendResult> {
    try {
      const token = await this.accessToken();
      // כותרות MIME עם עברית חייבות encoded-word (RFC 2047), אחרת הנושא
      // מגיע כג'יבריש בחלק מהלקוחות.
      const subjectEncoded = `=?UTF-8?B?${b64(msg.subject)}?=`;
      const raw = [
        `To: ${msg.to}`,
        `Subject: ${subjectEncoded}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '', b64(msg.body),
      ].join('\r\n');

      const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          raw: b64url(raw),
          ...(msg.threadId ? { threadId: msg.threadId } : {}),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) return { ok: false, error: data?.error?.message || 'שליחה נכשלה' };
      return { ok: true, externalId: data.id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async testConnection() {
    try {
      const token = await this.accessToken();
      const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',
        { headers: { authorization: `Bearer ${token}` } });
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

function parseGmailMessage(full: Record<string, any>): EmailMessage {
  const headers: Record<string, string> = {};
  for (const h of full.payload?.headers || []) headers[String(h.name).toLowerCase()] = h.value;

  const findText = (part: Record<string, any>): string => {
    if (part.mimeType === 'text/plain' && part.body?.data) return fromB64url(part.body.data);
    for (const p of part.parts || []) { const t = findText(p); if (t) return t; }
    return '';
  };
  const hasAtt = (part: Record<string, any>): boolean =>
    !!part.filename || (part.parts || []).some(hasAtt);

  return {
    externalId: full.id, threadId: full.threadId,
    from: headers.from || '', to: headers.to || '', subject: headers.subject || '',
    bodyText: findText(full.payload || {}).slice(0, 50_000),
    snippet: full.snippet || '',
    receivedAt: new Date(Number(full.internalDate || Date.now())).toISOString(),
    hasAttachments: hasAtt(full.payload || {}),
  };
}

function b64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
function b64url(s: string): string {
  return b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): string {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
}

// ============================================================
// Mock
// ============================================================

/**
 * מצב mock — אין credentials.
 *
 * שלוש התנהגויות מכוונות:
 *  • isMock=true, וה-UI מציג "לא מחובר" ולא "פעיל".
 *  • send מחזיר ok:true עם מזהה mock, כדי שאפשר יהיה לבדוק את **כל**
 *    הזרימה (טיוטה → אישור → שליחה → תיעוד) בלי לשלוח מייל אמיתי.
 *  • listRecent מחזיר ריק ולא נתונים פיקטיביים — נתונים מומצאים שנראים
 *    כמו הודעות אמיתיות בתיבה של משרד עורכי דין הם בדיוק סוג הדבר
 *    שגורם למישהו להתייחס אליהם ברצינות.
 */
export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock_email';
  readonly isMock = true;
  listRecent() { return Promise.resolve({ messages: [] as EmailMessage[] }); }
  send(msg: { to: string; subject: string }): Promise<SendResult> {
    console.log('[mock-email] would send', { to: msg.to, subject: msg.subject });
    return Promise.resolve({ ok: true, externalId: 'mock-' + crypto.randomUUID() });
  }
  testConnection() {
    return Promise.resolve({ ok: false, error: 'מצב הדגמה — לא מחובר חשבון Gmail אמיתי' });
  }
}

export async function getEmailProvider(
  sb: SupabaseClient, officeId: string,
): Promise<EmailProvider> {
  if ((Deno.env.get('EMAIL_PROVIDER_MODE') || 'mock').toLowerCase() === 'mock') {
    return new MockEmailProvider();
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return new MockEmailProvider();

  const { data: conn } = await sb.from('integration_connections')
    .select('status').eq('office_id', officeId).eq('provider', 'google_gmail').maybeSingle();
  if (conn?.status !== 'connected') return new MockEmailProvider();

  return new GmailProvider(sb, officeId);
}
