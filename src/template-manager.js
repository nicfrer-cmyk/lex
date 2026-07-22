// Mobile-only screen: internal storage has no "browse to an existing Windows folder" concept,
// so template/reference .docx files are imported once here into the app's private storage.
// Uses only the Platform façade (tmListTree/tmEnsureFolder/tmImportFile), never Filesystem directly,
// so this file stays plain/unbundled like app.js.

// One row for a template-library file: the shared doc-item markup, plus (for the
// "תבניות" folder only) a spec-status badge — reused for both the paired-docx case
// and the "spec.json exists but its docx doesn't" orphan case, so both surface the
// same way instead of one being invisible in the list.
function tmFileRow(folderName, name, specBadge) {
  const fEsc = folderName.replace(/'/g, "\\'");
  const nEsc = name.replace(/'/g, "\\'");
  return `<div class="doc-item" onclick="tmOpenFile('${fEsc}','${nEsc}')">
    <div class="doc-icon doc">${(name.split('.').pop() || '').slice(0, 3).toUpperCase()}</div>
    <div style="flex:1">
      <div>${escapeHtml(name)}</div>
      ${specBadge || ''}
    </div>
    <button class="btn btn-sm" onclick="event.stopPropagation();tmOpenFile('${fEsc}','${nEsc}')">👁 פתח</button>
    <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();tmDeleteFile('${fEsc}','${nEsc}')">מחק</button>
  </div>`;
}

function tmSpecBadge(entry) {
  if (!entry) return '';
  if (entry.specError) {
    return `<div style="font-size:11px;color:var(--danger);margin-top:2px">⚠ ${escapeHtml(entry.specError)}</div>`;
  }
  if (!entry.docxOk) {
    return `<div style="font-size:11px;color:var(--danger);margin-top:2px">⚠ חסרים ב-docx placeholders עבור: ${escapeHtml(entry.missingInDocx.join(', '))}</div>`;
  }
  const fields = entry.spec.aiFields.map(f => f.placeholder).join(', ');
  const extra = entry.extraInDocx.length ? ` · (לא בשימוש ב-docx: ${escapeHtml(entry.extraInDocx.join(', '))})` : '';
  return `<div style="font-size:11px;color:var(--success);margin-top:2px">✓ "${escapeHtml(entry.spec.displayName)}" · מודל: ${escapeHtml(entry.spec.model || '—')} · שדות AI: ${escapeHtml(fields || '—')}${extra}</div>`;
}

async function tmRender() {
  const wrap = document.getElementById('tm-tree');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty">טוען...</div>';
  try {
    const folders = await Platform.tmListTree();
    if (!folders.length) { wrap.innerHTML = '<div class="empty">עדיין לא יובאו קבצים</div>'; return; }

    // "הכן בקשה" spec/docx pairing only applies inside the "תבניות" folder — everywhere
    // else (בקשות/הסכמים/וכו') is plain reference-document storage, unchanged.
    let specByDocx = null, orphanSpecs = null;
    if (folders.some(f => f.name === 'תבניות')) {
      const specs = await loadRequestSpecs();
      specByDocx = new Map(specs.filter(s => s.docxFile).map(s => [s.docxFile, s]));
      orphanSpecs = specs.filter(s => s.specFile && !s.docxOk && s.specError && s.specError.startsWith('חסר קובץ תבנית'));
    }

    wrap.innerHTML = folders.map(f => {
      const isLib = f.name === 'תבניות';
      const rows = [];
      for (const name of f.files) {
        if (isLib && /\.spec\.json$/i.test(name)) continue; // folded into its docx row below
        const badge = isLib && /\.docx$/i.test(name) ? tmSpecBadge(specByDocx.get(name)) : '';
        rows.push(tmFileRow(f.name, name, badge));
      }
      if (isLib && orphanSpecs) {
        for (const s of orphanSpecs) rows.push(tmFileRow(f.name, s.specFile, tmSpecBadge(s)));
      }
      return `<div class="legal-section">
        <div class="legal-section-title">${escapeHtml(f.name)}</div>
        ${rows.length ? rows.join('') : '<div class="empty">תיקייה ריקה</div>'}
      </div>`;
    }).join('');
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
    let msg = `"${result.filename}" יובא לתיקייה "${folder}" ✓`;
    // "הכן בקשה" pairing only applies in the "תבניות" folder — check right away for a
    // docx/spec.json mismatch instead of leaving it to be discovered silently later.
    if (folder === 'תבניות' && /\.(docx|spec\.json)$/i.test(result.filename)) {
      const baseName = result.filename.replace(/\.spec\.json$/i, '').replace(/\.docx$/i, '');
      const specs = await loadRequestSpecs();
      const entry = specs.find(s => s.baseName === baseName);
      if (entry && entry.specError) msg += ` — שים לב: ${entry.specError}`;
    }
    notify(msg);
    tmRender();
  } catch (e) {
    notify('שגיאת ייבוא: ' + e.message);
  }
}
