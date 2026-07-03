// Electron (desktop) implementation of the Platform abstraction.
// Loaded as a plain <script> before app.js — nodeIntegration is enabled in main.js's
// BrowserWindow, so plain require() works here exactly as it always has.
const { ipcRenderer } = require('electron');

window.__req = function (name) { return require(name); };

window.Platform = {
  isMobile: false,

  loadDB: () => ipcRenderer.invoke('load-db'),
  saveDB: (data) => ipcRenderer.invoke('save-db', data),
  saveFile: (args) => ipcRenderer.invoke('save-file', args),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  pickFile: () => ipcRenderer.invoke('pick-file'),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  readTemplate: (templateName) => ipcRenderer.invoke('read-template', templateName),
  listLibraryFolders: (libraryPath) => ipcRenderer.invoke('list-library-folders', libraryPath),
  listFolderDocs: (args) => ipcRenderer.invoke('list-folder-docs', args),
  readLibraryDoc: (args) => ipcRenderer.invoke('read-library-doc', args),
};
