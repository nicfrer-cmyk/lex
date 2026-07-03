// Web/cloud implementation of the Platform abstraction — replaces platform.electron.js and
// platform.capacitor.js from Phase 1. Bundled by build.mjs (esbuild) because it needs
// @supabase/supabase-js, buffer, and docxtemplater resolved.
// Same idea as before: this is the ONLY file that knows about the actual storage backend;
// app.js and template-manager.js only ever call the Platform façade.
import { Buffer } from 'buffer';
import Docxtemplater from 'docxtemplater';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

window.Buffer = Buffer;
window.process = window.process || { browser: true, env: {}, version: '' };

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.supabaseClient = supabase; // used by auth.js for sign in/up/out + session state

// docx and pizzip are loaded separately as plain <script> tags (prebuilt UMD bundles,
// vendor/docx.umd.js and vendor/pizzip.min.js) — same vendor files used in Phase 1.
window.__req = function (name) {
  if (name === 'docx') return window.docx;
  if (name === 'pizzip') return window.PizZip;
  if (name === 'docxtemplater') return Docxtemplater;
  throw new Error('Unknown module: ' + name);
};

const BUCKET = 'documents';

async function currentUserId() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('לא מחובר');
  return user.id;
}

function bytesToBlob(buffer) {
  return new Blob([buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)]);
}
async function blobToByteArray(blob) {
  const ab = await blob.arrayBuffer();
  return Array.from(new Uint8Array(ab));
}

window.Platform = {
  isMobile: false, // "mobile" in the Phase-1 sense (device-local storage) no longer applies

  // ---- auth ----
  async signUp(email, password) {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
  },
  async signIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },
  async signOut() {
    await supabase.auth.signOut();
  },
  async getUser() {
    const { data: { user } } = await supabase.auth.getUser();
    return user;
  },

  // ---- db (whole-object blob per user, see supabase-schema.sql) ----
  async loadDB() {
    const uid = await currentUserId();
    const { data, error } = await supabase.from('app_data').select('data').eq('user_id', uid).maybeSingle();
    if (error) throw error;
    return data ? data.data : null;
  },

  async saveDB(dbObj) {
    const uid = await currentUserId();
    const { error } = await supabase.from('app_data').upsert({ user_id: uid, data: dbObj });
    if (error) throw error;
    return true;
  },

  // ---- files (Supabase Storage, private bucket, path-scoped to the user) ----
  async saveFile({ buffer, filename }) {
    const uid = await currentUserId();
    const path = `${uid}/documents/${filename}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, bytesToBlob(buffer), { upsert: true });
    if (error) throw error;
    return path;
  },

  async openFile(filePath) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, 60);
    if (error) throw error;
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.download = filePath.split('/').pop();
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
      const uid = await currentUserId();
      const path = `${uid}/templates/תבניות/${templateName}`;
      const { data, error } = await supabase.storage.from(BUCKET).download(path);
      if (error) throw error;
      return { buffer: await blobToByteArray(data) };
    } catch (e) {
      return { error: `תבנית "${templateName}" לא נמצאה. ייבא אותה במסך "תבניות" (לתוך התיקייה "תבניות").` };
    }
  },

  async listLibraryFolders() {
    try {
      const uid = await currentUserId();
      const { data, error } = await supabase.storage.from(BUCKET).list(`${uid}/templates`);
      if (error) throw error;
      return (data || []).filter(f => f.id === null).map(f => f.name); // folders have id === null in Supabase Storage listings
    } catch (e) { return { error: e.message }; }
  },

  async listFolderDocs({ folderName }) {
    try {
      const uid = await currentUserId();
      const { data, error } = await supabase.storage.from(BUCKET).list(`${uid}/templates/${folderName}`);
      if (error) throw error;
      return (data || []).filter(f => f.id !== null && /\.(docx|pdf)$/i.test(f.name)).map(f => f.name);
    } catch (e) { return { error: e.message }; }
  },

  async readLibraryDoc({ folderName, fileName }) {
    try {
      const uid = await currentUserId();
      const path = `${uid}/templates/${folderName}/${fileName}`;
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
    const uid = await currentUserId();
    const { data: folders, error } = await supabase.storage.from(BUCKET).list(`${uid}/templates`);
    if (error) throw error;
    const result = [];
    for (const f of (folders || []).filter(x => x.id === null)) {
      const { data: files } = await supabase.storage.from(BUCKET).list(`${uid}/templates/${f.name}`);
      result.push({ name: f.name, files: (files || []).filter(x => x.id !== null).map(x => x.name) });
    }
    return result;
  },

  async tmEnsureFolder() {
    // Supabase Storage has no explicit "create empty folder" — folders exist implicitly once
    // a file is uploaded under that prefix, so this is a no-op; tmImportFile creates it for real.
  },

  async tmImportFile(folderName, filename, buffer) {
    const uid = await currentUserId();
    const path = `${uid}/templates/${folderName}/${filename}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, bytesToBlob(buffer), { upsert: true });
    if (error) throw error;
  },

  async tmDeleteFile(folderName, filename) {
    const uid = await currentUserId();
    const path = `${uid}/templates/${folderName}/${filename}`;
    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) throw error;
  },
};
