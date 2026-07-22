// Mobile-only screen: internal storage has no "browse to an existing Windows folder" concept,
// so template/reference .docx files are imported once here into the app's private storage.
// Uses only the Platform façade (tmListTree/tmEnsureFolder/tmImportFile), never Filesystem directly,
// so this file stays plain/unbundled like app.js.

async function tmRender() {
  const wrap = document.getElementById('tm-tree');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty">טוען...</div>';
  try {
    const folders = await Platform.tmListTree();
    if (!folders.length) { wrap.innerHTML = '<div class="empty">עדיין לא יובאו קבצים</div>'; return; }
    wrap.innerHTML = folders.map(f => `
      <div class="legal-section">
        <div class="legal-section-title">${escapeHtml(f.name)}</div>
        ${f.files.length ? f.files.map(name => `
          <div class="doc-item" onclick="tmOpenFile('${f.name.replace(/'/g,"\\'")}','${name.replace(/'/g,"\\'")}')">
            <div class="doc-icon doc">${(name.split('.').pop()||'').slice(0,3).toUpperCase()}</div>
            <div style="flex:1">${escapeHtml(name)}</div>
            <button class="btn btn-sm" onclick="event.stopPropagation();tmOpenFile('${f.name.replace(/'/g,"\\'")}','${name.replace(/'/g,"\\'")}')">👁 פתח</button>
            <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();tmDeleteFile('${f.name.replace(/'/g,"\\'")}','${name.replace(/'/g,"\\'")}')">מחק</button>
          </div>`).join('') : '<div class="empty">תיקייה ריקה</div>'}
      </div>`).join('');
  } catch (e) {
    wrap.innerHTML = '<div class="empty">שגיאה בטעינה: ' + e.message + '</div>';
  }
}

// Reuses the app's existing read-only doc viewer (previewRawFile/renderPreviewBody in
// app.js — same one the e-filing tab uses for files with no db.docs row) instead of
// building a second preview UI just for templates.
async function tmOpenFile(folderName, filename) {
  try {
    const filePath = await Platform.tmFilePath(folderName, filename);
    previewRawFile(filePath, getExt(filename), filename);
  } catch (e) {
    notify('שגיאה בפתיחה: ' + e.message);
  }
}

async function tmDeleteFile(folderName, filename) {
  if (!confirm(`למחוק את "${filename}"?`)) return;
  try { await Platform.tmDeleteFile(folderName, filename); notify('נמחק ✓'); tmRender(); }
  catch (e) { notify('שגיאה במחיקה: ' + e.message); }
}

async function tmImportFiles() {
  let folder = document.getElementById('tm-target-folder').value;
  if (folder === '__new__') {
    folder = prompt('שם התיקייה החדשה:');
    if (!folder) return;
    await Platform.tmEnsureFolder(folder);
  }
  const result = await Platform.pickFile();
  if (!result) return;
  try {
    await Platform.tmImportFile(folder, result.filename, result.buffer);
    notify(`"${result.filename}" יובא לתיקייה "${folder}" ✓`);
    tmRender();
  } catch (e) {
    notify('שגיאת ייבוא: ' + e.message);
  }
}
