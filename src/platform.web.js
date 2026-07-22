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
// this app holds client debt/legal data, so signing in requires a password every time
// by default, instead of silently restoring whatever session was last active on this
// device. "זכור אותי" (below) is the opt-in escape hatch for a user's own device —
// persistence stays off unless they explicitly ask for it, rather than flipping the
// default for everyone. detectSessionInUrl (default true, unaffected by this) still
// lets the password-reset email link log the user in for that one recovery flow.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
window.supabaseClient = supabase; // used by auth.js for sign in/up/out + session state

// "Remember me" — manual, opt-in persistence layered on top of persistSession:false.
// Storing a refresh token in localStorage is exactly what Supabase's own
// persistSession:true does by default for every app that doesn't turn it off; this
// isn't a new category of risk, just applied only when the user actually asks for it
// on this specific device rather than unconditionally for everyone.
const REMEMBER_KEY = 'lextrack-remembered-session';
function storeRememberedSession(session) {
  if (session && session.refresh_token) {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token }));
  }
}
function clearRememberedSession() {
  localStorage.removeItem(REMEMBER_KEY);
}

// docx and pizzip are loaded separately as plain <script> tags (prebuilt UMD bundles,
// vendor/docx.umd.js and vendor/pizzip.min.js).
window.__req = function (name) {
  if (name === 'docx') return window.docx;
  if (name === 'pizzip') return window.PizZip;
  if (name === 'docxtemplater') return Docxtemplater;
  throw new Error('Unknown module: ' + name);
};

// Public VAPID key (safe to ship client-side — it's the whole point of a PUBLIC key)
// for Web Push subscriptions. Must match the private half held server-side as the
// VAPID_KEYS secret (see supabase/functions/send-push-notification) — if these ever
// get out of sync, PushManager.subscribe() still succeeds but every send fails.
const VAPID_PUBLIC_KEY = 'BEpMd3uKvKAmf46uz8pgYLLch5lN07HCgPA9aYFVqDcLGVginwex6nTmMBMde1T3X9Av8chSrPptQ8tE6BunvLA';
function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// supabase.functions.invoke()'s error for a non-2xx response is a generic
// "Edge Function returned a non-2xx status code" wrapper — the actual {error:"..."}
// body every function in this project returns is reachable via error.context (the
// raw Response), but nothing was ever unwrapping it, so every real server-side
// error message (e.g. "the payment provider isn't configured yet") got replaced
// with that meaningless generic string by the time it reached notify()/customAlert().
async function unwrapFunctionError(error) {
  try {
    if (error?.context?.json) {
      const body = await error.context.json();
      if (body?.error) return new Error(body.error);
    }
  } catch (e) { /* fall through to the original error if the body isn't JSON */ }
  return error;
}

const BUCKET = 'documents';
// The one plan LexTrack sells: ₪97/month, up to this much storage per office (see
// MONTHLY_PRICE_ILS / PLAN_NAME in supabase/functions/create-payment-page — keep in
// sync if this ever changes). Also stored in subscriptions.storage_limit_gb
// (fix12.sql) for future per-office overrides; this constant is what's actually
// enforced today.
const PLAN_STORAGE_LIMIT_GB = 20;

// Resolved once per session and cached — a user belongs to exactly one office (see
// schema comments on why v1 doesn't support multi-office membership/switching).
let _officeCache = null; // { officeId, role }

// Sums file sizes under an office's storage folder. Supabase Storage's list() isn't
// recursive, so this walks the two known shapes by hand: documents/ (flat) and
// templates/<folder>/ (one level of subfolders) — mirrors tmListTree()'s traversal.
// Supabase Storage's list() caps at 1000 entries per call with no indication a
// truncated page was truncated — a plain single call silently undercounts (and, for
// officeStorageUsageBytes, lets an office quietly blow past its 20GB cap) once a
// folder holds more than 1000 objects. Loops with offset until a page comes back
// shorter than the page size, which is the actual "no more results" signal.
async function listAllStorageEntries(path) {
  const pageSize = 1000;
  let offset = 0;
  let all = [];
  while (true) {
    const { data } = await supabase.storage.from(BUCKET).list(path, { limit: pageSize, offset });
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}
async function officeStorageUsageBytes(officeId) {
  let total = 0;
  const docs = await listAllStorageEntries(`${officeId}/documents`);
  docs.forEach(f => { if (f.id !== null) total += (f.metadata?.size || 0); });
  const folders = await listAllStorageEntries(`${officeId}/templates`);
  for (const folder of folders.filter(f => f.id === null)) {
    const files = await listAllStorageEntries(`${officeId}/templates/${folder.name}`);
    files.forEach(f => { if (f.id !== null) total += (f.metadata?.size || 0); });
  }
  return total;
}
async function enforceStorageQuota(officeId, incomingBytes) {
  const used = await officeStorageUsageBytes(officeId);
  const limitBytes = PLAN_STORAGE_LIMIT_GB * 1024 * 1024 * 1024;
  if (used + incomingBytes > limitBytes) {
    throw new Error(`חריגה ממכסת האחסון (${PLAN_STORAGE_LIMIT_GB}GB). מחק/י מסמכים ישנים או שדרג/י את המנוי.`);
  }
}

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

// Every upload went through here with no `contentType` — Storage then had no real
// MIME type to serve the object with, so a signed URL opened for in-app preview
// (previewDoc()'s <iframe>/<img>) had nothing telling the browser "this is a PDF/
// image, render it" and fell back to treating it as an opaque download instead, even
// though the URL had no `download` disposition set. Filename extension alone doesn't
// fix this — browsers key off the actual Content-Type header.
function mimeTypeFor(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const map = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  };
  return map[ext] || 'application/octet-stream';
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

// Was hardcoded `false` and never read anywhere — a leftover placeholder from before
// this app settled on Capacitor's "remote URL" mode (see capacitor.config.json), where
// the Android app is just this same site loaded in a WebView, so there never ended up
// being a separate native platform.js to set it from. Computed for real now because
// app.js needs it to hide desktop-only affordances (e.g. the ms-word:ofe "open in Word,
// linked to the site" button — that custom protocol has no handler on Android/iOS, so
// showing it there is a dead button, not a working one) instead of showing them broken.
//
// iPadOS Safari has requested the desktop site by default since iPadOS 13, so its
// userAgent just says "Macintosh" like a real Mac — the standard workaround is pairing
// that with navigator.maxTouchPoints (real Macs report 0; trackpads aren't touchscreens
// and don't set this). Using maxTouchPoints alone, without requiring the Mac-like UA
// too, was wrong: it also matched any touchscreen Windows/Linux laptop or monitor,
// which silently hid this button on real desktops with Word actually installed.
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

window.Platform = {
  isMobile: IS_MOBILE,

  // ---- auth ----
  // profile ({ fullName, officeName, phone, address }) comes from the full signup
  // form (see auth.js's authFullSignUp()) — Google sign-in has no equivalent, so
  // this is always called with it populated for the email/password path only.
  async signUp(email, password, profile = {}) {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { full_name: profile.fullName || '', phone: profile.phone || '', address: profile.address || '' } },
    });
    if (error) throw error;
    const hasInvite = new URLSearchParams(location.search).has('invite');
    if (data.user && !hasInvite && profile.officeName) {
      // We already have the real office name right here — create the office now
      // instead of waiting for showApp()'s generic ensureSoloOffice() fallback
      // (which only knows to default to "המשרד שלי", for the Google-sign-in case
      // where no such form was ever filled in). Calling ensureSoloOffice() again
      // from showApp() right after this is harmless — it no-ops once a membership
      // already exists.
      await this.ensureSoloOffice(profile.officeName);
    }
  },
  async signIn(email, password, remember) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (remember) storeRememberedSession(data.session);
    else clearRememberedSession();
    clearOfficeCache();
  },
  // Called once at page load, before anything else touches auth state. If a previous
  // sign-in opted into "זכור אותי" on this device, this restores that session instead
  // of leaving the user at the login screen; a rejected/expired refresh token just
  // clears the stale entry and falls through to a normal login prompt.
  async tryRestoreRememberedSession() {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) return false;
    try {
      const { access_token, refresh_token } = JSON.parse(raw);
      const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
      if (error || !data.session) throw error || new Error('no session');
      storeRememberedSession(data.session); // setSession may have rotated the refresh token
      return true;
    } catch (e) {
      clearRememberedSession();
      return false;
    }
  },
  async signInWithGoogle() {
    // location.href (not just origin+pathname) so a `?invite=token` in the current
    // URL survives the round-trip to Google and back — showApp() still needs it
    // afterward to redeem the invite instead of bootstrapping a stray solo office.
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.href },
    });
    if (error) throw error;
  },
  // Ensures the signed-in user belongs to SOME office, creating a new solo one
  // (owned by them) if not — called from showApp() on every first-time-this-session
  // login that didn't arrive via an invite link, regardless of auth method. A no-op
  // for a returning user who already has a membership (one extra select, no writes).
  async ensureSoloOffice(officeName) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: existing, error: existingErr } = await supabase
      .from('office_members').select('office_id').eq('user_id', user.id).maybeSingle();
    if (existingErr) throw existingErr;
    if (existing) return;
    // Generate the office's id client-side and insert with return=minimal (no
    // automatic select-back) — right after creating the office, the user isn't a
    // member of it YET (that's the next statement), so a follow-up .insert().select()
    // would normally fail the offices_select_member RLS policy and Postgres reports
    // it as "new row violates row-level security policy" even though the insert
    // itself succeeded. Knowing the id upfront sidesteps the read entirely.
    const officeId = crypto.randomUUID();
    const { error: officeErr } = await supabase
      .from('offices').insert({ id: officeId, name: officeName || 'המשרד שלי' });
    if (officeErr) throw officeErr;
    const { error: memberErr } = await supabase
      .from('office_members').insert({ office_id: officeId, user_id: user.id, role: 'owner', email: user.email });
    if (memberErr) throw memberErr;
    clearOfficeCache();
  },
  async signOut() {
    await supabase.auth.signOut();
    clearRememberedSession();
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
  // "Open in Word, linked to the site" — builds the ms-word:ofe URL Word's own
  // desktop client understands, pointed at the `webdav` Edge Function (see its
  // header comment for the full design). The docId is enough for that function to
  // resolve the actual Storage path itself — nothing here needs the raw path.
  async getWordEditUrl(docId, filename) {
    const { officeId } = await currentOffice();
    const safe = (filename || 'document.docx').replace(/[\\/:*?"<>|]/g, '_');
    const webdavUrl = `${SUPABASE_URL}/functions/v1/webdav/${officeId}/${docId}/${encodeURIComponent(safe)}`;
    return 'ms-word:ofe|u|' + webdavUrl;
  },

  // Generates the credential Word's Basic-Auth prompt needs (see fix17.sql / the
  // webdav function) — only the token's hash is sent/stored; the raw token is
  // returned once here for the UI to show and never touches the server again.
  async saveWebdavCredential(tokenHash) {
    const { officeId } = await currentOffice();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('לא מחובר');
    const email = (user.email || '').toLowerCase();
    const { error } = await supabase.from('webdav_credentials')
      .upsert({ user_id: user.id, office_id: officeId, email, token_hash: tokenHash }, { onConflict: 'user_id' });
    if (error) throw error;
    return email;
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
    const { data, error } = await supabase.from('office_members').select('user_id, email, role, joined_at').eq('office_id', officeId);
    if (error) throw error;
    return data;
  },
  async createInvite(email, role) {
    const { officeId, role: myRole } = await currentOffice();
    if (myRole !== 'owner') throw new Error('רק בעל המשרד יכול להזמין משתמשים');
    const { data, error } = await supabase.from('office_invites')
      .insert({ office_id: officeId, email, role }).select('token').single();
    if (error) throw error;
    return { token: data.token, link: `${location.origin}${location.pathname}?invite=${data.token}` };
  },
  // Best-effort — see supabase/functions/send-invite-email: needs the service_role
  // key AND real SMTP configured to actually work. Callers should treat a thrown
  // error here as "fall back to the copy-paste link", not a hard failure.
  async sendInviteEmail(inviteToken) {
    const { error } = await supabase.functions.invoke('send-invite-email', { body: { inviteToken } });
    if (error) throw await unwrapFunctionError(error);
  },
  async redeemInvite(token) {
    const { data: invite, error: findErr } = await supabase.from('office_invites').select('*').eq('token', token).maybeSingle();
    if (findErr) throw findErr;
    if (!invite) throw new Error('קישור ההזמנה לא תקין או שפג תוקפו');
    const me = (await supabase.auth.getUser()).data.user;
    const { error: joinErr } = await supabase.from('office_members')
      .insert({ office_id: invite.office_id, user_id: me.id, role: invite.role, email: me.email });
    if (joinErr) throw joinErr;
    await supabase.from('office_invites').update({ redeemed_at: new Date().toISOString() }).eq('token', token);
    clearOfficeCache();
  },

  // ---- subscription / billing (see supabase-schema-phase1-fix9.sql) ----
  async getSubscriptionStatus() {
    const { officeId } = await currentOffice();
    const { data, error } = await supabase.from('subscriptions')
      .select('status, plan, trial_ends_at').eq('office_id', officeId).maybeSingle();
    if (error) throw error;
    return data;
  },
  // Calls supabase/functions/create-payment-page, which isn't deployed/configured
  // yet (needs GROW_USER_ID/GROW_PAGE_CODE secrets) — this will throw a normal,
  // catchable error until that's done, not crash the app.
  async createPaymentPage() {
    const { data, error } = await supabase.functions.invoke('create-payment-page', { body: {} });
    if (error) throw await unwrapFunctionError(error);
    return data;
  },

  // ---- account deletion (see supabase/functions/delete-account) ----
  // Irreversible — permanently deletes the office, all its data/documents, and the
  // owner's own login. See that function for exactly what gets removed.
  async deleteAccount() {
    const { data, error } = await supabase.functions.invoke('delete-account', { body: {} });
    if (error) throw await unwrapFunctionError(error);
    return data;
  },

  // ---- push notifications (hearing/task/stuck-case reminders) ----
  isPushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window;
  },
  async getPushSubscriptionStatus() {
    if (!this.isPushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const reg = await navigator.serviceWorker.getRegistration();
    const existing = reg && await reg.pushManager.getSubscription();
    return existing ? 'subscribed' : 'unsubscribed';
  },
  async subscribeToPush() {
    if (!this.isPushSupported()) throw new Error('הדפדפן הזה לא תומך בהתראות פוש');
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('לא ניתנה הרשאה להתראות');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    const { officeId } = await currentOffice();
    const { data: { user } } = await supabase.auth.getUser();
    const json = sub.toJSON();
    const { error } = await supabase.from('push_subscriptions').upsert({
      user_id: user.id,
      office_id: officeId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth_key: json.keys.auth,
    }, { onConflict: 'endpoint' });
    if (error) throw error;
  },
  async unsubscribeFromPush() {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
  },

  // ---- AI (server-side proxy — see supabase/functions/ai-proxy) ----
  async callAI(payload) {
    const { data, error } = await supabase.functions.invoke('ai-proxy', { body: payload });
    if (error) throw await unwrapFunctionError(error);
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
    await enforceStorageQuota(officeId, buffer.length);
    // Keyed by filename alone before this, with upsert:true — two DIFFERENT documents
    // from different cases/clients that happen to share a common name (very plausible
    // in a law firm: "תביעה.docx", "כתב הגנה.docx") would silently overwrite each
    // other's bytes in Storage, even though db.docs kept separate metadata rows for
    // each — opening the first would return the second's content. A random prefix
    // guarantees no two uploads ever collide; the real filename is preserved
    // separately (origName in db.docs) and still shown to the user via openFile()'s
    // displayName param, so this is invisible to anyone except at the storage layer.
    const path = `${officeId}/documents/${crypto.randomUUID()}-${toSafeKey(filename)}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, bytesToBlob(buffer), { upsert: true, contentType: mimeTypeFor(filename) });
    if (error) throw error;
    return path;
  },
  async getStorageUsage() {
    const { officeId } = await currentOffice();
    const usedBytes = await officeStorageUsageBytes(officeId);
    return { usedBytes, limitGb: PLAN_STORAGE_LIMIT_GB };
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

  // For email/WhatsApp share links, which may sit unopened in an inbox/chat for a
  // while — a week-long expiry so the link the recipient actually clicks still works.
  async getShareUrl(filePath, displayName) {
    const { data, error } = await supabase.storage.from(BUCKET)
      .createSignedUrl(filePath, 60 * 60 * 24 * 7, { download: displayName || filePath.split('/').pop() });
    if (error) throw error;
    return data.signedUrl;
  },

  async downloadFileBytes(filePath) {
    const { data, error } = await supabase.storage.from(BUCKET).download(filePath);
    if (error) throw error;
    return { buffer: await blobToByteArray(data) };
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

  // Same shape as pickFile() but resolves an array (possibly empty if cancelled),
  // one {buffer,filename} per selected file, in the order the OS file picker
  // returned them (FileList preserves selection order).
  pickFiles() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.style.display = 'none';
      const cleanup = () => { if (input.parentNode) input.parentNode.removeChild(input); };
      input.onchange = async () => {
        const files = Array.from(input.files || []);
        cleanup();
        if (!files.length) { resolve([]); return; }
        const results = await Promise.all(files.map(file => new Promise((res) => {
          const reader = new FileReader();
          reader.onload = () => res({ buffer: Array.from(new Uint8Array(reader.result)), filename: file.name, filePath: file.name });
          reader.readAsArrayBuffer(file);
        })));
        resolve(results);
      };
      document.body.appendChild(input);
      input.click();
    });
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
    await enforceStorageQuota(officeId, buffer.length);
    const path = `${officeId}/templates/${toSafeKey(folderName)}/${toSafeKey(filename)}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, bytesToBlob(buffer), { upsert: true, contentType: mimeTypeFor(filename) });
    if (error) throw error;
  },

  async tmDeleteFile(folderName, filename) {
    const { officeId } = await currentOffice();
    const path = `${officeId}/templates/${toSafeKey(folderName)}/${toSafeKey(filename)}`;
    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) throw error;
  },

  // Bucket-relative key for a template file — same derivation as tmDeleteFile/
  // tmImportFile — so the template-manager screen can hand it to the same
  // downloadFileBytes()-backed preview the rest of the app already uses, without
  // reaching past the Platform façade into officeId/toSafeKey internals itself.
  async tmFilePath(folderName, filename) {
    const { officeId } = await currentOffice();
    return `${officeId}/templates/${toSafeKey(folderName)}/${toSafeKey(filename)}`;
  },

  // Raw bytes for any file under templates/<folderName>/ — unlike readLibraryDoc()
  // (which mammoth-extracts .docx to text for AI context), this is used where the
  // caller needs the actual bytes: a .spec.json's text, or a .docx template buffer
  // to feed into Docxtemplater for the "הכן בקשה" merge/validation flow.
  async tmReadFileBytes(folderName, filename) {
    const { officeId } = await currentOffice();
    const path = `${officeId}/templates/${toSafeKey(folderName)}/${toSafeKey(filename)}`;
    const { data, error } = await supabase.storage.from(BUCKET).download(path);
    if (error) throw error;
    return { buffer: await blobToByteArray(data) };
  },

  // ---- client-side error logging (see client_errors table / fix8.sql) ----
  async logClientError({ message, stack, url }) {
    // Never let logging an error throw another one — if we don't have a resolved
    // office yet (e.g. the error happened before login finished), there's nothing
    // useful to attach it to, so just skip rather than force officeId to be
    // nullable and widen the insert policy.
    try {
      if (!_officeCache) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from('client_errors').insert({
        office_id: _officeCache.officeId,
        user_id: user.id,
        message: String(message == null ? 'Unknown error' : message).slice(0, 2000),
        stack: stack ? String(stack).slice(0, 4000) : null,
        url: url || null,
        user_agent: navigator.userAgent,
      });
    } catch (e) { /* logging must never itself throw */ }
  },
  async listClientErrors() {
    const { officeId, role } = await currentOffice();
    if (role !== 'owner') throw new Error('רק בעל המשרד יכול לצפות ביומן השגיאות');
    const { data, error } = await supabase.from('client_errors')
      .select('message, url, created_at').eq('office_id', officeId)
      .order('created_at', { ascending: false }).limit(20);
    if (error) throw error;
    return data;
  },
};
