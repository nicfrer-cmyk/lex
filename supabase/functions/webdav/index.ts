// LexTrack — WebDAV bridge in front of Supabase Storage, so desktop Word can open a
// document directly via its own built-in `ms-word:ofe|u|<url>` protocol handler: no
// download, no separate "open this special file" step — a real Word window backed by
// this URL, saving back here on every Ctrl+S. This is exactly the mechanism
// SharePoint/OneDrive use for "Edit in Desktop App" (WebDAV, RFC 4918), not a
// Microsoft-exclusive trick — Supabase Storage just doesn't speak WebDAV on its own,
// so this function translates the handful of WebDAV verbs Word actually needs
// (OPTIONS, PROPFIND, GET, PUT, LOCK, UNLOCK) into Storage/Postgres calls.
//
// Deploy: `supabase functions deploy webdav --no-verify-jwt`
//   (--no-verify-jwt because Word's WebDAV client authenticates via HTTP Basic Auth,
//   not a Supabase session token — there's no way for Word to present one)
//
// URL shape this function expects (see app.js's `wordEditUrl()` for how it's built):
//   /webdav/{officeId}/{docId}/{anything — ignored, exists only so Word shows a real
//   filename in its title bar instead of a bare doc id}
//
// Honest caveat, not papered over: this was built and deployed without the ability to
// test against a real Word installation (no Windows+Word test rig available in the
// environment this was written in). The protocol handling below follows RFC 4918 and
// the specific headers/behaviors documented as required for Word's WebDAV client
// (MS-Author-Via, DAV capability headers, LOCK/UNLOCK with a real lock token) as
// closely as reasonably possible, but real-world Word version quirks are the kind of
// thing that surface once tested for real — that first real test is the next step,
// not a formality.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'documents';
const LOCK_TTL_MS = 20 * 60 * 1000; // Word renews an active lock periodically while open

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};
function mimeTypeFor(filename: string): string {
  const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
  return MIME_MAP[ext] || 'application/octet-stream';
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="LexTrack"' } });
}

interface AuthedUser { userId: string; officeId: string; }

// Word's WebDAV client authenticates with HTTP Basic Auth — username/password prompt
// on first connect (Windows Credential Manager can remember it after that). The
// "password" here is the random token generated once in Settings; only its hash is
// ever stored (see fix17.sql), so this looks the token up by its hash, not the token.
async function authenticate(req: Request): Promise<AuthedUser | null> {
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Basic ')) return null;
  let decoded: string;
  try { decoded = atob(auth.slice(6)); } catch { return null; }
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  const email = decoded.slice(0, sep).trim().toLowerCase();
  const token = decoded.slice(sep + 1);
  if (!email || !token) return null;

  const tokenHash = await sha256Hex(token);
  const { data, error } = await admin
    .from('webdav_credentials')
    .select('user_id, office_id, token_hash')
    .eq('email', email)
    .maybeSingle();
  if (error || !data || data.token_hash !== tokenHash) return null;
  return { userId: data.user_id, officeId: data.office_id };
}

interface DocRef { filePath: string; ext: string; name: string; }

// db.docs doesn't live in its own table — it's an array inside the office's single
// app_data JSON blob (the whole app's data model, see platform.web.js's
// loadDB/saveDB). Resolving a docId means loading that blob and finding it, same as
// the client does — but PUT never needs to touch the blob itself, only the Storage
// bytes filePath already points at, since filePath doesn't change on edit.
async function resolveDoc(officeId: string, docId: string): Promise<DocRef | null> {
  const { data, error } = await admin.from('app_data').select('data').eq('office_id', officeId).maybeSingle();
  if (error || !data) return null;
  const docs = (data.data && data.data.docs) || [];
  const doc = docs.find((d: any) => d.id === docId);
  if (!doc || !doc.filePath) return null;
  return { filePath: doc.filePath, ext: doc.ext || '', name: doc.origName || doc.name || 'document' };
}

function parsePath(pathname: string): { officeId: string; docId: string } | null {
  // pathname arrives as /webdav/{officeId}/{docId}/{ignored...}
  const parts = pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'webdav') return null;
  return { officeId: parts[1], docId: parts[2] };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const parsed = parsePath(url.pathname);
  if (!parsed) return new Response('Not Found', { status: 404 });

  // OPTIONS is Word's capability-probe — must NOT require auth (it's how the client
  // decides a server is WebDAV-capable at all, before it ever prompts for
  // credentials), so this branches before authenticate().
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'DAV': '1,2',
        'MS-Author-Via': 'DAV', // Word specifically checks for this to offer WebDAV editing
        'Allow': 'OPTIONS, GET, HEAD, PUT, PROPFIND, LOCK, UNLOCK',
        'Content-Length': '0',
      },
    });
  }

  const user = await authenticate(req);
  if (!user) return unauthorized();
  if (user.officeId !== parsed.officeId) return new Response('Forbidden', { status: 403 });

  const doc = await resolveDoc(parsed.officeId, parsed.docId);
  if (!doc) return new Response('Not Found', { status: 404 });
  const lockPath = `${parsed.officeId}/${parsed.docId}`;
  const mimeType = mimeTypeFor(doc.name) || mimeTypeFor(`x.${doc.ext}`);

  if (req.method === 'HEAD' || req.method === 'GET') {
    const { data, error } = await admin.storage.from(BUCKET).download(doc.filePath);
    if (error || !data) return new Response('Not Found', { status: 404 });
    const bytes = new Uint8Array(await data.arrayBuffer());
    const headers = {
      'Content-Type': mimeType,
      'Content-Length': String(bytes.length),
      'ETag': `"${bytes.length}-${parsed.docId}"`,
    };
    if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(bytes, { status: 200, headers });
  }

  if (req.method === 'PROPFIND') {
    const { data } = await admin.storage.from(BUCKET).download(doc.filePath);
    const size = data ? (await data.arrayBuffer()).byteLength : 0;
    const href = `${url.pathname}`;
    const body = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${xmlEscape(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${xmlEscape(doc.name)}</D:displayname>
        <D:getcontentlength>${size}</D:getcontentlength>
        <D:getcontenttype>${mimeType}</D:getcontenttype>
        <D:getlastmodified>${new Date().toUTCString()}</D:getlastmodified>
        <D:getetag>"${size}-${parsed.docId}"</D:getetag>
        <D:resourcetype/>
        <D:supportedlock>
          <D:lockentry>
            <D:lockscope><D:exclusive/></D:lockscope>
            <D:locktype><D:write/></D:locktype>
          </D:lockentry>
        </D:supportedlock>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    return new Response(body, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
  }

  if (req.method === 'LOCK') {
    const { data: existing } = await admin.from('webdav_locks').select('lock_token, locked_by, expires_at').eq('path', lockPath).maybeSingle();
    const now = Date.now();
    const stillLockedByOther = existing && existing.locked_by !== user.userId && new Date(existing.expires_at).getTime() > now;
    if (stillLockedByOther) {
      return new Response('Locked', { status: 423 });
    }
    const lockToken = `opaquelocktoken:${crypto.randomUUID()}`;
    const expiresAt = new Date(now + LOCK_TTL_MS).toISOString();
    await admin.from('webdav_locks').upsert({ path: lockPath, lock_token: lockToken, office_id: user.officeId, locked_by: user.userId, expires_at: expiresAt }, { onConflict: 'path' });
    const body = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>0</D:depth>
      <D:timeout>Second-${Math.floor(LOCK_TTL_MS / 1000)}</D:timeout>
      <D:locktoken><D:href>${lockToken}</D:href></D:locktoken>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${lockToken}>` } });
  }

  if (req.method === 'UNLOCK') {
    const ifHeader = req.headers.get('lock-token') || req.headers.get('If') || '';
    await admin.from('webdav_locks').delete().eq('path', lockPath).eq('locked_by', user.userId);
    return new Response(null, { status: 204 });
  }

  if (req.method === 'PUT') {
    const { data: existing } = await admin.from('webdav_locks').select('locked_by, expires_at').eq('path', lockPath).maybeSingle();
    const lockedByOther = existing && existing.locked_by !== user.userId && new Date(existing.expires_at).getTime() > Date.now();
    if (lockedByOther) return new Response('Locked', { status: 423 });

    const bytes = new Uint8Array(await req.arrayBuffer());
    const { error } = await admin.storage.from(BUCKET).upload(doc.filePath, bytes, { upsert: true, contentType: mimeType });
    if (error) return new Response('Internal Server Error: ' + error.message, { status: 500 });
    return new Response(null, { status: 204 });
  }

  // DELETE/MKCOL/COPY/MOVE/PROPPATCH etc. — deliberately not supported. This bridge
  // exists to edit one already-uploaded document in place, not to manage files/
  // folders over WebDAV.
  return new Response('Method Not Allowed', { status: 405, headers: { 'Allow': 'OPTIONS, GET, HEAD, PUT, PROPFIND, LOCK, UNLOCK' } });
});
