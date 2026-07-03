const { app, BrowserWindow } = require('electron');

// Phase 2: LexTrack's UI/data now live on the web (Netlify + Supabase) — see
// C:\Users\nicfr\.claude\plans\misty-stargazing-puppy.md. Electron is now just a thin
// native window around the live site; all the local-file IPC handlers from Phase 1
// (save-file/load-db/etc.) are gone because the web app talks to Supabase directly.
const APP_URL = 'https://zesty-marigold-0edcb2.netlify.app/';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1000,
    minHeight: 650,
    title: 'LexTrack – ירין אשואל, עו"ד',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    },
    show: false
  });

  mainWindow.loadURL(APP_URL);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
