// Web/cloud implementation of the Platform abstraction. Bundled by build.mjs (esbuild)
// because it needs @supabase/supabase-js, buffer, and docxtemplater resolved.
// Phase 1: office-scoped multi-tenancy — every stored thing is keyed by office_id
// (an office = one law firm; see supabase-schema-phase1.sql), not by the raw user_id
// like Phase 2 did. app.js and template-manager.js still only ever call this façade.
import { Buffer } from 'buffer';
import Docxtemplater from 'docxtemplater';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

window.Buffer = Buffer;
window.process = window.process || { browser: true, env: {}, version: '' };

// persistSession:false is a deliberate product decision, not the Supabase default:
// this app holds client debt/legal data, so every fresh open of the app (closing and
// reopening the tab/PWA, not just a same-tab reload) requires signing in again,
// instead of silently restoring whatever session was last active on this device.
// detectSessionInUrl (default true, unaffected by this) still lets the password-reset
// email link log the user in for that one recovery flow.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
window.supabaseClient = supabase; // used by auth.js for sign in/up/out + session state

// docx and pizzip are loaded separately as plain <script> tags (prebuilt UMD bundles,
// vendor/docx.umd.js and vendor/pizzip.min.js).
window.__req = function (name) {
  if (name === 'docx') return window.docx;
  if (name === 'pizzip') return window.PizZip;
  if (name === 'docxtemplater') return Docxtemplater;
  throw new Error('Unknown module: ' + name);
};

const BUCKET = 'documents';

// Resolved once per session and cached — a user belongs to exactly one office (see
// schema comments on why v1 doesn't support multi-office membership/switching).
let _officeCache = null; // { officeId, role }

async function currentOffice() {
  if (_officeCache) return _officeCache;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('לא מחובר');
  const { data, error } = await supabase
    .from('office_members')
    .select('office_id, role')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('לא נמצא משרד מקושר למשתמש הזה');
  _officeCache = { officeId: data.office_id, role: data.role };
  return _officeCache;
}
function clearOfficeCache() { _officeCache = null; }

function bytesToBlob(buffer) {
  return new Blob([buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)]);
}
async function blobToByteArray(blob) {
  const ab = await blob.arrayBuffer();
  return Array.from(new Uint8Array(ab));
}

// Supabase Storage rejects object keys containing Hebrew (or most non-ASCII) characters
// with "Invalid key" — confirmed against the live bucket, not assumed. Every path this
// file builds from a human-entered name (uploaded docs, generated report/ATF/POA
// filenames, template library folder/file names — almost always Hebrew in this app)
// must go through this reversible, collision-free encoding instead of the raw name.
function toSafeKey(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromSafeKey(key) {
  let b64 = key.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return decodeURIComponent(escape(atob(b64)));
}

window.Platform = {
  isMobile: false,

  // ---- auth ----
  async signUp(email, password) {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    // New account = new solo office, owned by them — UNLESS they arrived via an
    // invite link (?invite=token), in which case auth.js redeems that invite right
    // after this resolves, which creates their membership in the INVITING office
    // instead. Auto-creating a solo office here too would both give them a stray
    // extra office AND make the invite redemption fail (a user may only ever
    // belong to one office in v1 — see supabase-schema-phase1.sql).
    const hasInvite = new URLSearchParams(location.search).has('invite');
    if (data.session && data.user && !hasInvite) {
      // Generate the office's id client-side and insert with return=minimal (no
      // automatic select-back) — right after creating the office, the user isn't a
      // member of it YET (that's the next statement), so the follow-up select an
      // .insert().select() would normally do fails the offices_select_member RLS
      // policy and Postgres reports it as "new row violates row-level security
      // policy" even though the insert itself succeeded. Knowing the id upfront
      // sidesteps the read entirely.
      const officeId = crypto.randomUUID();
      const { error: officeErr } = await supabase
        .from('offices').insert({ id: officeId, name: 'המשרד שלי' });
      if (officeErr) throw officeErr;
      const { error: memberErr } = await supabase
        .from('office_members').insert({ office_id: officeId, user_id: data.user.id, role: 'owner' });
      if (memberErr) throw memberErr;
    }
  },
  async signIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    clearOfficeCache();
  },
  async signOut() {
    await supabase.auth.signOut();
    clearOfficeCache();
  },
  async resetPasswordForEmail(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) throw error;
  },
  async updatePassword(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
  },
  async getUser() {
    const { data: { user } } = await supabase.auth.getUser();
    return user;
  },
  async getRole() {
    const { role } = await currentOffice();
    return role;
  },
  async getOfficeInfo() {
    const { officeId } = await currentOffice();
    const { data, error } = await supabase.from('offices').select('name, vat_rate').eq('id', officeId).single();
    if (error) throw error;
    return data;
  },
  async updateOfficeInfo({ name, vatRate }) {
    const { officeId, role } = await currentOffice();
    if (role !== 'owner') throw new Error('רק בעל המשרד יכול לערוך הגדרות אלה');
    const { error } = await supabase.from('offices').update({ name, vat_rate: vatRate }).eq('id', officeId);
    if (error) throw error;
  },

  // ---- team / invites ----
  async listTeam() {
    const { officeId } = await currentOffice();
    const { data, error } = await supabase.from('office_members').select('user_id, role, joined_at').eq('office_id', officeId);
    if (error) throw error;
    return data;
  },
  async createInvite(email, role) {
    const { officeId, role: myRole } = await currentOffice();
    if (myRole !== 'owner') throw new Error('רק בעל המשרד יכול להזמין משתמשים');
    const { data, error } = await supabase.from('office_invites')
      .insert({ office_id: officeId, email, role }).select('token').single();
    if (error) throw error;
    return `${location.origin}${location.pathname}?invite=${data.token}`;
  },
  async redeemInvite(token) {
    const { data: invite, error: findErr } = await supabase.from('office_invites').select('*').eq('token', token).maybeSingle();
    if (findErr) throw findErr;
    if (!invite) throw new Error('קישור ההזמנה לא תקין או שפג תוקפו');
    const { error: joinErr } = await supabase.from('office_members')
      .insert({ office_id: invite.office_id, user_id: (await supabase.auth.getUser()).data.user.id, role: invite.role });
    if (joinErr) throw joinErr;
    await supabase.from('office_invites').update({ redeemed_at: new Date().toISOString() }).eq('token', token);
    clearOfficeCache();
  },

  // ---- AI (server-side proxy — see supabase/functions/ai-proxy) ----
  async callAI(payload) {
    const { data, error } = await supabase.functions.invoke('ai-proxy', { body: payload });
    if (error) throw error;
    return data;
  },
  async getAIUsageThisMonth() {
    const { officeId } = await currentOffice();
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const { count, error } = await supabase
      .from('ai_usage').select('id', { count: 'exact', head: true })
      .eq('office_id', officeId).gte('created_at', monthStart.toISOString());
    if (error) throw error;
    return count || 0;
  },

  // ---- db (whole-object blob per OFFICE, see supabase-schema-phase1.sql) ----
  async loadDB() {
    const { officeId } = await currentOffice();
    const { data, error } = await supabase.from('app_data').select('data').eq('office_id', officeId).maybeSingle();
    if (error) throw error;
    return data ? data.data : null;
  },

  async saveDB(dbObj) {
    const { officeId } = await currentOffice();
    const { error } = await supabase.from('app_data').upsert({ office_id: officeId, data: dbObj }, { onConflict: 'office_id' });
    if (error) throw error;
    return true;
  },

  // ---- files (Supabase Storage, private bucket, path-scoped to the OFFICE) ----
  async saveFile({ buffer, filename }) {
    const { officeId } = await currentOffice();
    const path = `${officeId}/documents/${toSafeKey(filename)}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, bytesToBlob(buffer), { upsert: true });
    if (error) throw error;
    return path;
  },

  async openFile(filePath, displayName) {
    // The signed URL's response carries its own Content-Disposition (using the raw,
    // base64-safe-encoded storage key), which browsers honor over the <a download>
    // attribute — passing `download` here is what actually controls the filename the
    // user sees saved to disk.
    const { data, error } = await supabase.storage.from(BUCKET)
      .createSignedUrl(filePath, 60, { download: displayName || filePath.split('/').pop() });
    if (error) throw error;
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  pickFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.style.display = 'none';
      const cleanup = () => { if (input.parentNode) input.parentNode.removeChild(input); };
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) { cleanup(); resolve(null); return; }
        const reader = new FileReader();
        reader.onload = () => {
          const bytes = Array.from(new Uint8Array(reader.result));
          cleanup();
          resolve({ buffer: bytes, filename: file.name, filePath: file.name });
        };
        reader.readAsArrayBuffer(file);
      };
      document.body.appendChild(input);
      input.click();
    });
  },

  async pickDirectory() {
    alert('בגרסת הענן אין תיקיות מחשב לבחירה. עבור למסך "תבניות" בתפריט הצד כדי לייבא קבצים לחשבון שלך.');
    return null;
  },

  async readTemplate(templateName) {
    try {
      const { officeId } = await currentOffice();
      const path = `${officeId}/templates/${toSafeKey('תבניות')}/${toSafeKey(templateName)}`;
      const { data, error } = await supabase.storage.from(BUCKET).download(path);
      if (error) throw error;
      return { buffer: await blobToByteArray(data) };
    } catch (e) {
      return { error: `תבנית "${templateName}" לא נמצאה. ייבא אותה במסך "תבניות" (לתוך התיקייה "תבניות").` };
    }
  },

  async listLibraryFolders() {
    try {
      const { officeId } = await currentOffice();
      const { data, error } = await supabase.storage.from(BUCKET).list(`${officeId}/templates`);
      if (error) throw error;
      return (data || []).filter(f => f.id === null).map(f => fromSafeKey(f.name));
    } catch (e) { return { error: e.message }; }
  },

  async listFolderDocs({ folderName }) {
    try {
      const { officeId } = await currentOffice();
      const { data, error } = await supabase.storage.from(BUCKET).list(`${officeId}/templates/${toSafeKey(folderName)}`);
      if (error) throw error;
      return (data || []).filter(f => f.id !== null && /\.(docx|pdf)$/i.test(fromSafeKey(f.name))).map(f => fromSafeKey(f.name));
    } catch (e) { return { error: e.message }; }
  },

  async readLibraryDoc({ folderName, fileName }) {
    try {
      const { officeId } = await currentOffice();
      const path = `${officeId}/templates/${toSafeKey(folderName)}/${toSafeKey(fileName)}`;
      const { data, error } = await supabase.storage.from(BUCKET).download(path);
      if (error) throw error;
      const ext = (fileName.split('.').pop() || '').toLowerCase();
      if (ext === 'docx') {
        const ab = await data.arrayBuffer();
        const result = await window.mammoth.extractRawText({ arrayBuffer: ab });
        return { text: result.value, fileName };
      }
      return { error: 'קריאת PDF אינה נתמכת עדיין — השתמש בקובץ docx.' };
    } catch (e) { return { error: e.message }; }
  },

  // ---- helpers used only by the "template manager" screen ----
  async tmListTree() {
    const { officeId } = await currentOffice();
    const { data: folders, error } = await supabase.storage.from(BUCKET).list(`${officeId}/templates`);
    if (error) throw error;
    const result = [];
    for (const f of (folders || []).filter(x => x.id === null)) {
      const { data: files } = await supabase.storage.from(BUCKET).list(`${officeId}/templates/${f.name}`);
      result.push({ name: fromSafeKey(f.name), files: (files || []).filter(x => x.id !== null).map(x => fromSafeKey(x.name)) });
    }
    return result;
  },

  async tmEnsureFolder() {
    // Supabase Storage has no explicit "create empty folder" — folders exist implicitly once
    // a file is uploaded under that prefix, so this is a no-op; tmImportFile creates it for real.
  },

  async tmImportFile(folderName, filename, buffer) {
    const { officeId } = await currentOffice();
    const path = `${officeId}/templates/${toSafeKey(folderName)}/${toSafeKey(filename)}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, bytesToBlob(buffer), { upsert: true });
    if (error) throw error;
  },

  async tmDeleteFile(folderName, filename) {
    const { officeId } = await currentOffice();
    const path = `${officeId}/templates/${toSafeKey(folderName)}/${toSafeKey(filename)}`;
    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) throw error;
  },
};
