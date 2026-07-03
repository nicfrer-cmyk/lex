// Capacitor (Android/mobile) implementation of the Platform abstraction.
// Unlike platform.electron.js, this file IS bundled by build.mjs (esbuild) because it needs
// real imports resolved: @capacitor/filesystem, @capacitor/share, buffer, docxtemplater.
// Everything is stored in the app's private internal storage (Directory.Data) — nothing
// touches shared/public storage, per the "internal storage" choice for v1.
import { Buffer } from 'buffer';
import Docxtemplater from 'docxtemplater';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

window.Buffer = Buffer;
window.process = window.process || { browser: true, env: {}, version: '' };

// docx and pizzip are loaded separately as plain <script> tags (their own prebuilt UMD
// bundles, vendor/docx.umd.js and vendor/pizzip.min.js) — they set window.docx / window.PizZip
// directly. docxtemplater has no such prebuilt browser bundle, so it's bundled here instead.
window.__req = function (name) {
  if (name === 'docx') return window.docx;
  if (name === 'pizzip') return window.PizZip;
  if (name === 'docxtemplater') return Docxtemplater;
  throw new Error('Unknown module for mobile build: ' + name);
};

const DB_PATH = 'LexTrack/data.json';
const DOCS_DIR = 'LexTrack/Documents';
const TEMPLATES_DIR = 'LexTrack/Templates';

async function ensureDir(path) {
  try { await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true }); }
  catch (e) { /* already exists */ }
}

function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

window.Platform = {
  isMobile: true,

  async loadDB() {
    try {
      const res = await Filesystem.readFile({ path: DB_PATH, directory: Directory.Data, encoding: Encoding.UTF8 });
      return JSON.parse(res.data);
    } catch (e) { return null; }
  },

  async saveDB(data) {
    await ensureDir('LexTrack');
    await Filesystem.writeFile({ path: DB_PATH, directory: Directory.Data, data: JSON.stringify(data, null, 2), encoding: Encoding.UTF8 });
    return true;
  },

  async saveFile({ buffer, filename }) {
    await ensureDir(DOCS_DIR);
    const path = `${DOCS_DIR}/${filename}`;
    await Filesystem.writeFile({ path, directory: Directory.Data, data: bytesToBase64(buffer) });
    return path;
  },

  async openFile(filePath) {
    const { uri } = await Filesystem.getUri({ path: filePath, directory: Directory.Data });
    await Share.share({ url: uri, dialogTitle: 'פתח / שתף מסמך' });
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
    alert('בנייד אין גישה לתיקיות של המחשב. עבור למסך "תבניות" בתפריט הצד כדי לייבא קבצים לאחסון הפנימי של האפליקציה.');
    return null;
  },

  async readTemplate(templateName) {
    try {
      const path = `${TEMPLATES_DIR}/תבניות/${templateName}`;
      const res = await Filesystem.readFile({ path, directory: Directory.Data });
      return { buffer: Array.from(base64ToBytes(res.data)) };
    } catch (e) {
      return { error: `תבנית "${templateName}" לא נמצאה. ייבא אותה במסך "תבניות" (לתוך התיקייה "תבניות").` };
    }
  },

  async listLibraryFolders() {
    try {
      await ensureDir(TEMPLATES_DIR);
      const res = await Filesystem.readdir({ path: TEMPLATES_DIR, directory: Directory.Data });
      return res.files.filter(f => f.type === 'directory').map(f => f.name);
    } catch (e) { return { error: e.message }; }
  },

  async listFolderDocs({ folderName }) {
    try {
      const res = await Filesystem.readdir({ path: `${TEMPLATES_DIR}/${folderName}`, directory: Directory.Data });
      return res.files.filter(f => f.type === 'file' && /\.(docx|pdf)$/i.test(f.name)).map(f => f.name);
    } catch (e) { return { error: e.message }; }
  },

  async readLibraryDoc({ folderName, fileName }) {
    try {
      const path = `${TEMPLATES_DIR}/${folderName}/${fileName}`;
      const res = await Filesystem.readFile({ path, directory: Directory.Data });
      const ext = (fileName.split('.').pop() || '').toLowerCase();
      if (ext === 'docx') {
        const bytes = base64ToBytes(res.data);
        const result = await window.mammoth.extractRawText({ arrayBuffer: bytes.buffer });
        return { text: result.value, fileName };
      }
      return { error: 'קריאת PDF אינה נתמכת עדיין בגרסת הנייד — השתמש בקובץ docx.' };
    } catch (e) { return { error: e.message }; }
  },

  // ---- helpers used only by the mobile-only "template manager" screen ----
  async tmListTree() {
    await ensureDir(TEMPLATES_DIR);
    const res = await Filesystem.readdir({ path: TEMPLATES_DIR, directory: Directory.Data });
    const folders = [];
    for (const f of res.files.filter(x => x.type === 'directory')) {
      const inner = await Filesystem.readdir({ path: `${TEMPLATES_DIR}/${f.name}`, directory: Directory.Data });
      folders.push({ name: f.name, files: inner.files.filter(x => x.type === 'file').map(x => x.name) });
    }
    return folders;
  },

  async tmEnsureFolder(name) {
    await ensureDir(`${TEMPLATES_DIR}/${name}`);
  },

  async tmImportFile(folderName, filename, buffer) {
    await ensureDir(`${TEMPLATES_DIR}/${folderName}`);
    await Filesystem.writeFile({ path: `${TEMPLATES_DIR}/${folderName}/${filename}`, directory: Directory.Data, data: bytesToBase64(buffer) });
  },

  async tmDeleteFile(folderName, filename) {
    await Filesystem.deleteFile({ path: `${TEMPLATES_DIR}/${folderName}/${filename}`, directory: Directory.Data });
  },
};
