const { app, BrowserWindow, shell } = require('electron');

// Phase 2: LexTrack's UI/data now live on the web (Netlify + Supabase). Electron is
// just a thin native window around the live site; all the local-file IPC handlers from
// Phase 1 (save-file/load-db/etc.) are gone because the web app talks to Supabase directly.
const APP_URL = 'https://zesty-marigold-0edcb2.netlify.app/';
const APP_ORIGIN = new URL(APP_URL).origin;

// The window shows a remote site holding a law office's client data, so it may only
// navigate inside the app itself and the sign-in flow it relies on (Supabase auth and
// Google OAuth). Everything else — links in documents, share links, external sites —
// opens in the user's real browser instead of inside this privileged window.
function isInAppUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.origin === APP_ORIGIN) return true;
    if (u.protocol !== 'https:') return false;
    return /\.supabase\.co$/.test(u.hostname) || u.hostname === 'accounts.google.com';
  } catch { return false; }
}
function openExternally(raw) {
  try {
    const u = new URL(raw);
    // ms-word: is how "open in Word (linked)" hands a WebDAV document to Word.
    if (['https:', 'http:', 'mailto:', 'ms-word:', 'tel:'].includes(u.protocol)) shell.openExternal(raw);
  } catch { /* malformed URL — ignore */ }
}

// Only what the web app actually uses; camera/mic/geolocation etc. are refused.
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen']);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1000,
    minHeight: 650,
    title: 'LexTrack',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false
    },
    show: false
  });

  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (!isInAppUrl(url)) openExternally(url);
    else if (new URL(url).origin === APP_ORIGIN) return { action: 'allow' };
    return { action: 'deny' };
  });
  const guardNavigation = (event, url) => {
    if (!isInAppUrl(url)) { event.preventDefault(); openExternally(url); }
  };
  wc.on('will-navigate', guardNavigation);
  wc.on('will-redirect', guardNavigation);
  wc.session.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));

  mainWindow.loadURL(APP_URL);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
