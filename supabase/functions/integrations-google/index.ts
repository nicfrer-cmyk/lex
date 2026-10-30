// Google OAuth — Gmail + Calendar (סעיפים 9.2, 10).
//
// זהו OAuth **שני ונפרד** מזה של Supabase Auth שמשמש להתחברות
// (platform.web.js signInWithGoogle). לזרימת ההתחברות אין scopes של Gmail
// ואין refresh token שמאוחסן, ולכן אי אפשר להשתמש בה כאן.
//
// נתיבים (?action=):
//   connect     → מחזיר URL להסכמה
//   callback    → Google מפנה לכאן; מחליף code ב-tokens ושומר מוצפן
//   disconnect  → מבטל את ה-token מול Google ומוחק אותו אצלנו
//   status      → מצב החיבור (בלי credentials, לעולם)
//   test        → בדיקת חיבור אמיתית
//   sync        → משיכת מיילים חדשים לתיבה האחודה
//
// Deploy: supabase functions deploy integrations-google
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, INTEGRATION_ENCRYPTION_KEY, SITE_URL

import { admin, resolveCaller, loadOfficeDb } from '../_shared/db.ts';
import { json, preflight, errorResponse, AppError, CORS_HEADERS } from '../_shared/http.ts';
import { encryptJson, stableHash } from '../_shared/crypto.ts';
import { audit } from '../_shared/audit.ts';
import { GOOGLE_SCOPES, getEmailProvider } from '../_shared/providers/email.ts';
import { getCalendarProvider } from '../_shared/providers/calendar.ts';
import { detectInjection } from '../_shared/security.ts';

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SITE_URL = Deno.env.get('SITE_URL') || '';
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/integrations-google?action=callback`;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const url = new URL(req.url);
  const action = url.searchParams.get('action') || 'status';
  const sb = admin();

  try {
    // ה-callback מגיע מדפדפן שמופנה ע"י Google — אין בו כותרת Authorization.
    // הזהות נשמרת ב-state (חתום), ראה handleCallback.
    if (action === 'callback') return await handleCallback(sb, url);

    const caller = await resolveCaller(req, sb);

    if (action === 'connect') {
      if (caller.role !== 'owner') {
        throw new AppError('forbidden', 'רק בעל המשרד יכול לחבר חשבונות.', 403);
      }
      return await handleConnect(sb, caller);
    }
    if (action === 'disconnect') {
      if (caller.role !== 'owner') {
        throw new AppError('forbidden', 'רק בעל המשרד יכול לנתק חשבונות.', 403);
      }
      return await handleDisconnect(sb, caller, url.searchParams.get('provider') || '');
    }
    if (action === 'test') return await handleTest(sb, caller);
    if (action === 'sync') return await handleSync(sb, caller);
    if (action === 'status') return await handleStatus(sb, caller);

    throw new AppError('unknown_action', 'פעולה לא מוכרת', 400);
  } catch (e) {
    return errorResponse(e);
  }
});

// ============================================================

async function handleConnect(
  sb: ReturnType<typeof admin>, caller: Awaited<ReturnType<typeof resolveCaller>>,
) {
  if (!GOOGLE_CLIENT_ID) {
    throw new AppError('not_configured',
      'GOOGLE_CLIENT_ID לא הוגדר בשרת. ראה docs/AI_CENTER_INTEGRATIONS.md להקמת הפרויקט ב-Google Cloud.', 503);
  }

  // ה-state נושא את זהות המשרד דרך הסיבוב אצל Google, וגם מגן מפני CSRF:
  // callback שמגיע עם state שלא נוצר על ידינו נדחה. חתימה ולא מזהה גולמי,
  // כדי שלא יהיה אפשר להמציא state של משרד אחר.
  const nonce = crypto.randomUUID();
  const signature = await stableHash(caller.officeId, caller.userId, nonce,
    Deno.env.get('INTEGRATION_ENCRYPTION_KEY') || '');
  const state = btoa(JSON.stringify({
    o: caller.officeId, u: caller.userId, n: nonce, s: signature.slice(0, 32),
  }));

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GOOGLE_SCOPES);
  // access_type=offline + prompt=consent הם התנאי לקבלת refresh_token.
  // בלי prompt=consent, חיבור חוזר של אותו חשבון מחזיר access_token בלבד,
  // והחיבור "נשבר" שקט אחרי שעה.
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);

  return json({ url: authUrl.toString() });
}

async function handleCallback(sb: ReturnType<typeof admin>, url: URL) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  const done = (msg: string, ok: boolean) => new Response(
    `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
     <title>חיבור Google</title>
     <style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f4f6fa;
     color:#0f1729;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
     .box{background:#fff;padding:32px;border-radius:16px;text-align:center;max-width:420px;
     box-shadow:0 4px 16px rgba(15,23,41,.08)}
     h1{font-size:18px;margin:0 0 8px}p{color:#4b5768;font-size:14px;margin:0}</style></head>
     <body><div class="box"><h1>${ok ? '✓ החיבור הושלם' : '✗ החיבור נכשל'}</h1>
     <p>${String(msg).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string))}</p><p style="margin-top:12px;font-size:12px">אפשר לסגור את החלון הזה.</p></div>
     <script>setTimeout(function(){try{window.close()}catch(e){}
     ${SITE_URL ? `if(!window.closed)location.href=${JSON.stringify(SITE_URL)}` : ''}},2500)</script>
     </body></html>`,
    { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8', ...CORS_HEADERS } },
  );

  if (error) return done(`Google החזיר שגיאה: ${error}`, false);
  if (!code || !state) return done('חסרים פרמטרים בתשובה מ-Google.', false);

  let parsed: { o: string; u: string; n: string; s: string };
  try {
    parsed = JSON.parse(atob(state));
  } catch {
    return done('פרמטר state לא תקין.', false);
  }

  // אימות ה-state — חוסם callback מזויף.
  const expected = await stableHash(parsed.o, parsed.u, parsed.n,
    Deno.env.get('INTEGRATION_ENCRYPTION_KEY') || '');
  if (expected.slice(0, 32) !== parsed.s) {
    await audit(sb, {
      officeId: parsed.o, actorType: 'system', action: 'oauth_state_mismatch',
      severity: 'security', after: { provider: 'google' },
    });
    return done('אימות הבקשה נכשל (state לא תואם).', false);
  }

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
    }),
  });
  const tokens = await tokenResp.json();
  if (!tokenResp.ok || !tokens.refresh_token) {
    return done(
      tokens.error_description || tokens.error ||
      'לא התקבל refresh token. נסה לנתק את ההרשאה בחשבון Google ולחבר מחדש.', false);
  }

  // מי החשבון שחובר — מוצג במסך האינטגרציות.
  let accountEmail = '';
  try {
    const me = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (me.ok) accountEmail = (await me.json()).email || '';
  } catch { /* לא קריטי */ }

  const encrypted = await encryptJson({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry: Date.now() + (tokens.expires_in || 3600) * 1000,
  });
  const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();

  // אותם tokens משרתים גם Gmail וגם Calendar (scope אחד), אבל נשמרים
  // כשתי שורות כדי שאפשר יהיה לנתק אחד בלי השני.
  for (const provider of ['google_gmail', 'google_calendar']) {
    await sb.from('integration_connections').upsert({
      office_id: parsed.o, provider, connection_type: 'oauth',
      account_name: accountEmail, account_identifier: accountEmail,
      status: 'connected', scopes: GOOGLE_SCOPES.split(' '),
      encrypted_credentials: encrypted, token_expires_at: expiresAt,
      last_error: null, created_by: parsed.u,
    }, { onConflict: 'office_id,provider' });
  }

  await audit(sb, {
    officeId: parsed.o, actorType: 'user', userId: parsed.u,
    action: 'integration_connected', entityType: 'integration', entityId: 'google',
    after: { account: accountEmail }, severity: 'info',
  });

  return done(`חשבון ${accountEmail || 'Google'} חובר בהצלחה ל-Gmail וליומן.`, true);
}

async function handleDisconnect(
  sb: ReturnType<typeof admin>, caller: Awaited<ReturnType<typeof resolveCaller>>, provider: string,
) {
  const providers = provider ? [provider] : ['google_gmail', 'google_calendar'];

  // ביטול מול Google עצמו, לא רק מחיקה אצלנו — אחרת ההרשאה נשארת פעילה
  // בחשבון של בעל המשרד והוא לא יודע שהיא שם (סעיף 8.3: "אפשר revoke").
  const { data: conn } = await sb.from('integration_connections')
    .select('encrypted_credentials').eq('office_id', caller.officeId)
    .eq('provider', providers[0]).maybeSingle();
  if (conn?.encrypted_credentials) {
    try {
      const { decryptJson } = await import('../_shared/crypto.ts');
      const creds = await decryptJson<{ refresh_token: string }>(conn.encrypted_credentials);
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: creds.refresh_token }),
      });
    } catch (e) {
      // גם אם הביטול מול Google נכשל — ממשיכים למחוק אצלנו. השארת
      // credentials אצלנו אחרי שהמשתמש ביקש ניתוק גרועה יותר.
      console.error('[google] revoke failed', e);
    }
  }

  await sb.from('integration_connections').delete()
    .eq('office_id', caller.officeId).in('provider', providers);

  await audit(sb, {
    officeId: caller.officeId, actorType: 'user', userId: caller.userId,
    action: 'integration_disconnected', entityType: 'integration', entityId: providers.join(','),
    severity: 'warning',
  });
  return json({ ok: true, disconnected: providers });
}

async function handleTest(
  sb: ReturnType<typeof admin>, caller: Awaited<ReturnType<typeof resolveCaller>>,
) {
  const email = await getEmailProvider(sb, caller.officeId);
  const cal = await getCalendarProvider(sb, caller.officeId);
  const [emailTest, calTest] = await Promise.all([email.testConnection(), cal.testConnection()]);

  for (const [provider, result] of [['google_gmail', emailTest], ['google_calendar', calTest]] as const) {
    await sb.from('integration_connections').update({
      last_error: result.ok ? null : result.error,
      status: result.ok ? 'connected' : 'error',
    }).eq('office_id', caller.officeId).eq('provider', provider);
  }

  return json({
    gmail: { ...emailTest, mock: email.isMock },
    calendar: { ...calTest, mock: cal.isMock },
  });
}

async function handleStatus(
  sb: ReturnType<typeof admin>, caller: Awaited<ReturnType<typeof resolveCaller>>,
) {
  // בכוונה לא בוחרים encrypted_credentials. גם אם RLS היה מאפשר —
  // אין סיבה שהעמודה הזו תעבור אי פעם ברשת אל הדפדפן.
  const { data } = await sb.from('integration_connections')
    .select('provider, status, account_name, token_expires_at, last_sync_at, last_error')
    .eq('office_id', caller.officeId);
  return json({
    connections: data || [],
    configured: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
  });
}

/**
 * משיכת מיילים חדשים לתיבה האחודה.
 *
 * שיוך אוטומטי ללקוח/תיק לפי כתובת השולח. השיוך הוא **הצעה ולא קביעה** —
 * הוא נשמר על השרשור, וכל פעולה שנגזרת ממנו עדיין עוברת אישור.
 */
async function handleSync(
  sb: ReturnType<typeof admin>, caller: Awaited<ReturnType<typeof resolveCaller>>,
) {
  const provider = await getEmailProvider(sb, caller.officeId);
  if (provider.isMock) {
    return json({ ok: false, mock: true, synced: 0, message: 'Gmail אינו מחובר — אין מה לסנכרן.' });
  }

  const { data: conn } = await sb.from('integration_connections')
    .select('sync_cursor').eq('office_id', caller.officeId)
    .eq('provider', 'google_gmail').maybeSingle();

  const { messages, cursor } = await provider.listRecent(conn?.sync_cursor || undefined, 25);
  const db = await loadOfficeDb(sb, caller.officeId);

  let inserted = 0;
  for (const m of messages) {
    const senderEmail = (m.from.match(/<([^>]+)>/)?.[1] || m.from).toLowerCase().trim();
    const client = db.clients.find((c) => String(c.email || '').toLowerCase().trim() === senderEmail);
    const matter = client
      ? db.cases.find((c) => c.client === client.id && c.status !== 'closed')
      : null;

    const { data: thread } = await sb.from('communication_threads').upsert({
      office_id: caller.officeId, channel: 'email', external_thread_id: m.threadId,
      subject: m.subject, participant_name: m.from, participant_identifier: senderEmail,
      client_id: client?.id || null, matter_id: matter?.id || null,
      status: 'waiting_reply',      // הודעה נכנסת = ממתין לתשובה שלנו
      last_message_at: m.receivedAt,
    }, { onConflict: 'office_id,channel,external_thread_id' }).select('id').single();
    if (!thread) continue;

    // תוכן מייל נכנס הוא תוכן חיצוני. הסימון נשמר כאן כדי שה-UI יציג
    // אזהרה, וכדי שהסוכן יקבל אותו כבר מסומן.
    const scan = detectInjection(m.bodyText);

    const { error } = await sb.from('communication_messages').insert({
      office_id: caller.officeId, thread_id: thread.id, direction: 'in', channel: 'email',
      external_message_id: m.externalId, sender: m.from, recipient: m.to,
      subject: m.subject, body_text: m.bodyText.slice(0, 100_000),
      status: 'received', received_at: m.receivedAt,
      metadata: { snippet: m.snippet, hasAttachments: m.hasAttachments,
                  injection_suspected: scan.suspected, injection_matches: scan.matches },
    });
    // 23505 = ההודעה כבר נקלטה בסנכרון קודם. זו התנהגות תקינה
    // (Gmail מחזיר חפיפה בין סבבים) ולא שגיאה.
    if (!error) inserted++;
  }

  await sb.from('integration_connections').update({
    last_sync_at: new Date().toISOString(), sync_cursor: cursor, last_error: null,
  }).eq('office_id', caller.officeId).eq('provider', 'google_gmail');

  return json({ ok: true, fetched: messages.length, inserted });
}
