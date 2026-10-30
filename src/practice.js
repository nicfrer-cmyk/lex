// ===== PRACTICE MANAGEMENT (litigation, contracts, deadlines, billing) =====
//
// The modules that turn LexTrack from a collection tool into a whole-office system.
// A plain script loaded after app.js (see build.mjs), like ai-center.js: it uses
// app.js's globals (db, saveDB, notify, escapeHtml, jsArg, uid, OFFICE, ...) at call
// time, and app.js reaches it only through `typeof practiceX === 'function'` guards, so
// either file keeps working if the other is missing.
//
// All data stays in the office's own blob, in collections the three-way merge already
// understands (events, tasks, timeEntries, cases) plus `billingStatements`.

// ---------- small helpers ----------
function prDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return y && m && d ? `${Number(d)}.${Number(m)}.${y}` : String(iso);
}
function prISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function prParseISO(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}
// Time entries are stamped with toLocaleDateString('he-IL') ("5.7.2026"); events/tasks
// use ISO. Billing needs real dates from both.
function prParseHE(s) {
  const m = String(s || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
}
function prDaysBetween(a, b) { return Math.round((b - a) / 86400000); }
function prMoney(n) { return '₪' + Math.round(Number(n) || 0).toLocaleString('he-IL'); }
function prModal(id, title, bodyHtml, footerHtml, wide) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = id;
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="modal${wide ? ' modal-wide' : ''}">
    <div class="modal-header"><div class="modal-title">${escapeHtml(title)}</div>
      <button class="modal-close" onclick="document.getElementById('${id}').classList.remove('open')">×</button></div>
    <div>${bodyHtml}</div>
    <div class="modal-footer">${footerHtml || ''}<button class="btn" onclick="document.getElementById('${id}').classList.remove('open')">סגור</button></div>
  </div>`;
  el.classList.add('open');
  return el;
}
function prCloseModal(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); }

// ============================================================
// 1. DEADLINES — מחשבון מועדים
// ============================================================
// Common civil-procedure periods. The calculator only proposes a date: it shows how it
// was computed and what to verify, and nothing goes into the calendar until the lawyer
// confirms. Periods follow the Civil Procedure Regulations 2018 as commonly applied —
// always check the current text and any specific court order.
const DEADLINE_RULES = [
  { id: 'defense', label: 'הגשת כתב הגנה', days: 60, from: 'מיום המצאת כתב התביעה' },
  { id: 'appeal', label: 'הגשת ערעור על פסק דין', days: 60, from: 'מיום מתן פסק הדין או המצאתו' },
  { id: 'leave', label: 'בקשת רשות ערעור על החלטה', days: 30, from: 'מיום מתן ההחלטה או המצאתה' },
  { id: 'custom', label: 'מועד לפי החלטה / אחר', days: null, from: 'מיום מתן ההחלטה' },
];
const PR_SUMMER_RECESS = { from: [7, 16], to: [8, 31] }; // 16.7–31.8

// Pure: used by the modal and by the tests.
function computeDeadline(fromISO, days) {
  const start = prParseISO(fromISO);
  if (!start || !(days > 0)) return null;
  const raw = new Date(start); raw.setDate(raw.getDate() + Number(days));
  const warnings = [];
  let due = new Date(raw);
  // Courts don't sit on Friday/Saturday: a period ending then runs to the next working day.
  let moved = 0;
  while (due.getDay() === 5 || due.getDay() === 6) { due.setDate(due.getDate() + 1); moved++; }
  if (moved) warnings.push(`היום האחרון חל ב${raw.getDay() === 5 ? 'יום שישי' : 'שבת'} — הועבר ליום העבודה הבא.`);
  // Summer recess overlap (the most common reason a computed date is wrong).
  for (let y = start.getFullYear(); y <= due.getFullYear(); y++) {
    const rFrom = new Date(y, PR_SUMMER_RECESS.from[0] - 1, PR_SUMMER_RECESS.from[1]);
    const rTo = new Date(y, PR_SUMMER_RECESS.to[0] - 1, PR_SUMMER_RECESS.to[1]);
    if (start <= rTo && due >= rFrom) {
      warnings.push(`התקופה חופפת לפגרת הקיץ (16.7–31.8.${y}). ייתכן שימי הפגרה אינם נמנים במניין המועד — יש לבדוק.`);
    }
  }
  warnings.push('יש לבדוק חגים וימי שבתון שבהם בתי המשפט סגורים, ואת נוסח התקנות וההחלטה הרלוונטית.');
  return { due: prISO(due), raw: prISO(raw), warnings };
}

function openDeadlineCalculator(caseId) {
  const cases = (db.cases || []).filter(c => c.status !== 'closed');
  const body = `
    <div class="alert alert-warning" style="margin-bottom:12px">המחשבון מציע מועד ומציג את אופן החישוב. האחריות לאמת את המועד היא של עורך/ת הדין.</div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">סוג המועד</label>
        <select class="form-input" id="dl-rule" onchange="dlRecalc()">${DEADLINE_RULES.map(r => `<option value="${r.id}">${escapeHtml(r.label)}${r.days ? ` (${r.days} ימים)` : ''}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">תיק</label>
        <select class="form-input" id="dl-case"><option value="">ללא תיק</option>${cases.map(c => `<option value="${escapeHtml(c.id)}" ${c.id === caseId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label" id="dl-from-label">מתאריך</label><input class="form-input" id="dl-from" type="date" value="${prISO(new Date())}" oninput="dlRecalc()"></div>
      <div class="form-group"><label class="form-label">מספר ימים</label><input class="form-input" id="dl-days" type="number" min="1" oninput="dlRecalc()"></div>
    </div>
    <div class="form-group"><label class="form-label">כותרת ביומן</label><input class="form-input" id="dl-title"></div>
    <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:6px 0"><input type="checkbox" id="dl-reminder" checked> צור גם משימת תזכורת 7 ימים לפני המועד</label>
    <div id="dl-result" style="margin-top:10px"></div>`;
  prModal('modal-deadline', '⏳ מחשבון מועדים', body,
    `<button class="btn btn-primary" id="dl-add-btn" onclick="dlAddToCalendar()">אישרתי את המועד — הוסף ליומן</button>`);
  dlRecalc();
}

function dlRecalc() {
  const rule = DEADLINE_RULES.find(r => r.id === document.getElementById('dl-rule').value) || DEADLINE_RULES[0];
  const daysEl = document.getElementById('dl-days');
  if (document.activeElement !== daysEl && rule.days) daysEl.value = rule.days;
  document.getElementById('dl-from-label').textContent = rule.from.replace(/^מיום/, 'תאריך') ;
  const titleEl = document.getElementById('dl-title');
  if (!titleEl.dataset.touched) titleEl.value = rule.label;
  titleEl.oninput = () => { titleEl.dataset.touched = '1'; };
  const res = computeDeadline(document.getElementById('dl-from').value, Number(daysEl.value));
  const out = document.getElementById('dl-result');
  const btn = document.getElementById('dl-add-btn');
  if (!res) { out.innerHTML = '<div class="empty">הזן/י תאריך ומספר ימים.</div>'; btn.disabled = true; return; }
  btn.disabled = false;
  out.innerHTML = `<div class="card" style="padding:12px 14px">
      <div style="font-size:13px;color:var(--text3)">${escapeHtml(rule.from)} ${escapeHtml(prDate(document.getElementById('dl-from').value))} + ${Number(daysEl.value)} ימים</div>
      <div style="font-size:22px;font-weight:700;color:var(--navy);margin:6px 0">${escapeHtml(prDate(res.due))}</div>
      ${res.raw !== res.due ? `<div style="font-size:12px;color:var(--text3)">חישוב גולמי: ${escapeHtml(prDate(res.raw))}</div>` : ''}
      <ul style="margin:8px 0 0;padding-inline-start:18px;font-size:12px;color:var(--warning)">${res.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
    </div>`;
  out.dataset.due = res.due;
}

function dlAddToCalendar() {
  const due = document.getElementById('dl-result').dataset.due;
  if (!due) return;
  const rule = DEADLINE_RULES.find(r => r.id === document.getElementById('dl-rule').value) || DEADLINE_RULES[0];
  const caseId = document.getElementById('dl-case').value;
  const from = document.getElementById('dl-from').value;
  const days = Number(document.getElementById('dl-days').value);
  const title = document.getElementById('dl-title').value.trim() || rule.label;
  if (!db.events) db.events = [];
  db.events.push({
    id: uid(), title, date: due, time: '', location: '', type: 'מועד אחרון', caseId,
    notes: `${rule.from} ${prDate(from)} + ${days} ימים. חושב במחשבון המועדים ואושר ע"י עורך/ת הדין.`,
    deadline: { rule: rule.id, from, days, confirmedAt: new Date().toISOString() },
  });
  if (document.getElementById('dl-reminder').checked) {
    const remind = prParseISO(due); remind.setDate(remind.getDate() - 7);
    if (!db.tasks) db.tasks = [];
    db.tasks.push({ id: uid(), text: `תזכורת: ${title} — המועד ב-${prDate(due)}`, due: prISO(remind), priority: 'urgent', caseId, done: false });
  }
  const c = caseId ? db.cases.find(x => x.id === caseId) : null;
  if (c) { if (!c.diary) c.diary = []; c.diary.push({ text: `נקבע מועד: ${title} — ${prDate(due)}`, date: new Date().toLocaleString('he-IL') }); }
  saveDB().catch(() => {});
  prCloseModal('modal-deadline');
  notify(`המועד נוסף ליומן: ${prDate(due)} ✓`);
  if (currentPanel === 'calendar' && typeof renderCalendar === 'function') renderCalendar();
  if (currentPanel === 'case-detail' && c) reopenCaseDetailKeepingTab(c.id);
  if (currentPanel === 'dashboard') renderDashboard();
}

// ============================================================
// 2. CASE SECTIONS — agreement details and parties (in the case page)
// ============================================================
function practiceCaseSection(c) {
  if (!c) return '';
  if (c.caseType === 'contract') return prContractSection(c);
  if (c.caseType === 'litigation') return prPartiesSection(c);
  return '';
}

function prContractSection(c) {
  const k = c.contract || {};
  const end = prParseISO(k.endDate);
  const daysLeft = end ? prDaysBetween(new Date(new Date().toDateString()), end) : null;
  const badge = daysLeft === null ? '' : daysLeft < 0
    ? `<span class="badge badge-closed">פג תוקף</span>`
    : daysLeft <= 60 ? `<span class="badge badge-urgent">מסתיים בעוד ${daysLeft} ימים</span>`
      : `<span class="badge badge-active">בתוקף</span>`;
  const id = escapeHtml(c.id);
  return `<div class="card" style="padding:14px 16px;margin-bottom:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div style="font-weight:700;color:var(--navy)">📑 פרטי ההסכם ${badge}</div>
      <button class="btn btn-sm btn-primary" onclick="prSaveContract(${jsArg(c.id)})">שמור</button>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">תאריך חתימה</label><input class="form-input" type="date" id="k-signed-${id}" value="${escapeHtml(k.signedDate || '')}"></div>
      <div class="form-group"><label class="form-label">תחילת תוקף</label><input class="form-input" type="date" id="k-start-${id}" value="${escapeHtml(k.startDate || '')}"></div>
      <div class="form-group"><label class="form-label">סיום תוקף</label><input class="form-input" type="date" id="k-end-${id}" value="${escapeHtml(k.endDate || '')}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">ימי הודעה מוקדמת לאי-חידוש</label><input class="form-input" type="number" min="0" id="k-notice-${id}" value="${escapeHtml(k.noticeDays ?? '')}"></div>
      <div class="form-group"><label class="form-label">חידוש</label><select class="form-input" id="k-renew-${id}">
        <option value="none" ${k.renewal === 'auto' ? '' : 'selected'}>ללא חידוש אוטומטי</option>
        <option value="auto" ${k.renewal === 'auto' ? 'selected' : ''}>מתחדש אוטומטית</option></select></div>
    </div>
    <div style="font-size:12px;color:var(--text3)">בשמירה נוצרים ביומן אירועי "סיום תוקף" ו"מועד אחרון להודעה" — כדי שהסכם לא יתחדש או יפקע בלי שמישהו שם לב.</div>
  </div>`;
}

function prSaveContract(caseId) {
  const c = db.cases.find(x => x.id === caseId);
  if (!c) return;
  const v = (p) => document.getElementById(`${p}-${caseId}`).value;
  const k = {
    signedDate: v('k-signed'), startDate: v('k-start'), endDate: v('k-end'),
    noticeDays: v('k-notice') === '' ? null : Math.max(0, Number(v('k-notice'))),
    renewal: v('k-renew'),
  };
  if (k.startDate && k.endDate && k.endDate < k.startDate) { notify('תאריך הסיום מוקדם מתאריך התחילה'); return; }
  c.contract = k;
  // One managed event per kind per case, updated in place (never duplicated).
  const upsert = (kind, date, title) => {
    const existing = (db.events || []).find(e => e.caseId === caseId && e.contractEvent === kind);
    if (!date) { if (existing) db.events = db.events.filter(e => e !== existing); return; }
    if (existing) Object.assign(existing, { date, title });
    else db.events.push({ id: uid(), title, date, time: '', location: '', type: 'מועד אחרון', caseId, notes: 'נוצר אוטומטית מפרטי ההסכם', contractEvent: kind });
  };
  if (!db.events) db.events = [];
  upsert('end', k.endDate, `סיום תוקף ההסכם — ${c.name}`);
  let noticeISO = '';
  if (k.endDate && k.noticeDays) { const d = prParseISO(k.endDate); d.setDate(d.getDate() - k.noticeDays); noticeISO = prISO(d); }
  upsert('notice', noticeISO, `מועד אחרון להודעה על ${k.renewal === 'auto' ? 'אי-חידוש' : 'סיום'} — ${c.name}`);
  saveDB().catch(() => {});
  notify('פרטי ההסכם נשמרו ✓');
  reopenCaseDetailKeepingTab(caseId);
}

const PARTY_ROLES = ['תובע', 'נתבע', 'צד ג\'', 'מבקש', 'משיב', 'מערער', 'משיב בערעור'];
function prPartiesSection(c) {
  const parties = c.parties || [];
  return `<div class="card" style="padding:14px 16px;margin-bottom:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-weight:700;color:var(--navy)">⚖ צדדים להליך</div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-sm" onclick="openDeadlineCalculator(${jsArg(c.id)})">⏳ חשב מועד</button>
        <button class="btn btn-sm" onclick="prAddParty(${jsArg(c.id)})">+ צד</button>
      </div>
    </div>
    ${parties.length ? `<table class="data-table"><thead><tr><th>תפקיד</th><th>שם</th><th>ת"ז / ח"פ</th><th>ב"כ</th><th></th></tr></thead><tbody>${parties.map(p => `
      <tr><td>${escapeHtml(p.role)}</td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.idNum || '')}</td><td>${escapeHtml(p.counsel || '')}</td>
      <td><button class="btn btn-sm" style="color:var(--danger)" onclick="prRemoveParty(${jsArg(c.id)},${jsArg(p.id)})">✕</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty" style="padding:8px">לא נוספו צדדים. הלקוח והצד שכנגד מפרטי התיק מוצגים למטה.</div>'}
  </div>`;
}
function prAddParty(caseId) {
  const body = `<div class="form-row">
      <div class="form-group"><label class="form-label">תפקיד</label><select class="form-input" id="pp-role">${PARTY_ROLES.map(r => `<option>${escapeHtml(r)}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">שם *</label><input class="form-input" id="pp-name"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">ת"ז / ח"פ</label><input class="form-input" id="pp-id"></div>
      <div class="form-group"><label class="form-label">בא/ת כוח</label><input class="form-input" id="pp-counsel"></div>
    </div>`;
  prModal('modal-party', 'הוספת צד להליך', body, `<button class="btn btn-primary" onclick="prSaveParty(${jsArg(caseId)})">הוסף</button>`);
}
function prSaveParty(caseId) {
  const c = db.cases.find(x => x.id === caseId);
  const name = document.getElementById('pp-name').value.trim();
  if (!c || !name) { notify('נא להזין שם'); return; }
  if (!c.parties) c.parties = [];
  c.parties.push({ id: uid(), role: document.getElementById('pp-role').value, name,
    idNum: document.getElementById('pp-id').value.trim(), counsel: document.getElementById('pp-counsel').value.trim() });
  saveDB().catch(() => {});
  prCloseModal('modal-party');
  reopenCaseDetailKeepingTab(caseId);
}
async function prRemoveParty(caseId, partyId) {
  const c = db.cases.find(x => x.id === caseId);
  if (!c || !await customConfirm('להסיר את הצד מההליך?', { danger: true, okText: 'הסר' })) return;
  c.parties = (c.parties || []).filter(p => p.id !== partyId);
  saveDB().catch(() => {});
  reopenCaseDetailKeepingTab(caseId);
}

// Case form: show the contract-specific hint for contract cases.
function practiceCaseTypeUI(type) {
  const hint = document.getElementById('case-type-hint');
  if (!hint) return;
  hint.textContent = type === 'contract'
    ? 'אחרי השמירה, ניתן להזין בכרטיס התיק את תאריכי ההסכם — והמערכת תוסיף תזכורות לסיום ולחידוש.'
    : type === 'litigation'
      ? 'אחרי השמירה, ניתן להוסיף בכרטיס התיק את כל הצדדים להליך ולחשב מועדים להגשה.'
      : '';
}

// ============================================================
// 3. TIME & BILLING — חיוב ושעות
// ============================================================
function prBillingRate(c) {
  if (c && c.feeType === 'hourly' && Number(c.feeFixed) > 0) return Number(c.feeFixed);
  return Number((db.settings || {}).defaultHourlyRate) || 0;
}
function prUnbilledByCase() {
  const out = new Map();
  for (const t of db.timeEntries || []) {
    if (t.billedStatementId || !t.caseId || !(t.duration > 0)) continue;
    if (!out.has(t.caseId)) out.set(t.caseId, []);
    out.get(t.caseId).push(t);
  }
  return out;
}
// Pure: lines/totals of a statement for one case's unbilled entries (tested).
function buildStatementLines(entries, rate, vatPct, applyVat) {
  const lines = entries.map(t => {
    const hours = Math.round(((t.duration || 0) / 3600) * 100) / 100;
    return { entryId: t.id, date: t.date || '', description: t.description || 'טיפול בתיק', hours, rate, amount: Math.round(hours * rate * 100) / 100 };
  });
  const subtotal = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const vat = applyVat ? Math.round(subtotal * (vatPct / 100) * 100) / 100 : 0;
  return { lines, subtotal, vat, total: Math.round((subtotal + vat) * 100) / 100 };
}

function renderBilling() {
  const wrap = document.getElementById('billing-body');
  if (!wrap) return;
  const unbilled = prUnbilledByCase();
  const statements = (db.billingStatements || []).slice().sort((a, b) => (b.number || 0) - (a.number || 0));
  let unbilledHours = 0, unbilledValue = 0;
  const rows = [];
  for (const [caseId, entries] of unbilled) {
    const c = db.cases.find(x => x.id === caseId);
    if (!c) continue;
    const secs = entries.reduce((s, t) => s + (t.duration || 0), 0);
    const rate = prBillingRate(c);
    const value = (secs / 3600) * rate;
    unbilledHours += secs / 3600; unbilledValue += value;
    const client = db.clients.find(x => x.id === c.client);
    rows.push({ c, client, secs, rate, value, count: entries.length });
  }
  rows.sort((a, b) => b.value - a.value);
  const open = statements.filter(s => s.status === 'sent');
  const openTotal = open.reduce((s, x) => s + (x.total || 0), 0);
  const rateSetting = Number((db.settings || {}).defaultHourlyRate) || '';

  wrap.innerHTML = `
    <div class="stats-grid" style="margin-bottom:16px">
      <div class="stat"><div class="stat-label">שעות שטרם חויבו</div><div class="stat-value">${unbilledHours.toFixed(1)}</div></div>
      <div class="stat"><div class="stat-label">שווי שטרם חויב</div><div class="stat-value" style="color:var(--accent2);font-size:20px">${prMoney(unbilledValue)}</div></div>
      <div class="stat"><div class="stat-label">דרישות פתוחות</div><div class="stat-value" style="color:var(--warning);font-size:20px">${prMoney(openTotal)}</div><div class="stat-sub">${open.length} דרישות</div></div>
    </div>
    <div class="card" style="padding:12px 16px;margin-bottom:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span style="font-size:13px">תעריף שעתי ברירת מחדל (לתיקים שאינם בשכר שעתי):</span>
      <input class="form-input" style="max-width:120px" type="number" min="0" id="billing-default-rate" value="${escapeHtml(rateSetting)}">
      <button class="btn btn-sm" onclick="prSaveDefaultRate()">שמור</button>
    </div>
    <div class="card" style="padding:0;margin-bottom:16px">
      <div style="padding:12px 16px;font-weight:700;color:var(--navy)">שעות לחיוב לפי תיק</div>
      ${rows.length ? `<table class="data-table"><thead><tr><th>תיק</th><th>לקוח</th><th>רישומים</th><th>שעות</th><th>תעריף</th><th>סכום</th><th></th></tr></thead><tbody>${rows.map(r => `
        <tr><td>${escapeHtml(r.c.name)}</td><td>${escapeHtml(r.client ? r.client.name : '—')}</td><td>${r.count}</td>
        <td>${(r.secs / 3600).toFixed(2)}</td><td>${r.rate ? prMoney(r.rate) : '<span style="color:var(--danger)">לא הוגדר</span>'}</td><td>${prMoney(r.value)}</td>
        <td><button class="btn btn-sm btn-primary" ${r.rate ? '' : 'disabled title="יש להגדיר תעריף"'} onclick="prCreateStatement(${jsArg(r.c.id)})">הפק דרישת תשלום</button></td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">אין שעות שטרם חויבו. רישום שעות נעשה מהטיימר או מ"הוסף שעות" בכרטיס התיק.</div>'}
    </div>
    <div class="card" style="padding:0">
      <div style="padding:12px 16px;font-weight:700;color:var(--navy)">דרישות תשלום</div>
      ${statements.length ? `<table class="data-table"><thead><tr><th>מס'</th><th>תאריך</th><th>לקוח</th><th>תיק</th><th>סה"כ</th><th>סטטוס</th><th></th></tr></thead><tbody>${statements.map(s => {
        const c = db.cases.find(x => x.id === s.caseId); const cl = db.clients.find(x => x.id === s.clientId);
        const st = { draft: 'טיוטה', sent: 'נשלחה', paid: 'שולמה', cancelled: 'בוטלה' }[s.status] || s.status;
        return `<tr><td>${Number(s.number)}</td><td>${escapeHtml(prDate(s.date))}</td><td>${escapeHtml(cl ? cl.name : '—')}</td><td>${escapeHtml(c ? c.name : '—')}</td>
          <td>${prMoney(s.total)}</td><td>${escapeHtml(st)}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm" onclick="prPrintStatement(${jsArg(s.id)})">🖨 הדפס</button>
            ${s.status === 'draft' ? `<button class="btn btn-sm" onclick="prSetStatementStatus(${jsArg(s.id)},'sent')">סמן כנשלחה</button>` : ''}
            ${s.status === 'sent' ? `<button class="btn btn-sm btn-success" onclick="prSetStatementStatus(${jsArg(s.id)},'paid')">סמן כשולמה</button>` : ''}
            ${s.status === 'draft' || s.status === 'sent' ? `<button class="btn btn-sm" style="color:var(--danger)" onclick="prCancelStatement(${jsArg(s.id)})">בטל</button>` : ''}
          </td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty">עדיין לא הופקו דרישות תשלום.</div>'}
      <div style="padding:10px 16px;font-size:11px;color:var(--text3)">דרישת תשלום אינה חשבונית מס. חשבונית מס/קבלה מופקת במערכת הנהלת החשבונות של המשרד.</div>
    </div>`;
}

function prSaveDefaultRate() {
  const v = Number(document.getElementById('billing-default-rate').value);
  if (!db.settings) db.settings = {};
  db.settings.defaultHourlyRate = v > 0 ? v : 0;
  saveDB().catch(() => {});
  notify('התעריף נשמר ✓');
  renderBilling();
}

async function prCreateStatement(caseId) {
  const c = db.cases.find(x => x.id === caseId);
  const entries = prUnbilledByCase().get(caseId) || [];
  if (!c || !entries.length) return;
  const rate = prBillingRate(c);
  const calc = buildStatementLines(entries, rate, officeVatRate ?? 18, c.feeVat === 'yes');
  if (!await customConfirm(`להפיק דרישת תשלום עבור "${c.name}": ${calc.lines.length} רישומים, ${prMoney(calc.total)}${calc.vat ? ' כולל מע"מ' : ''}?`, { okText: 'הפק', title: 'דרישת תשלום' })) return;
  if (!db.counters) db.counters = { nextClientNumber: 1, caseCounters: {} };
  // Sequential office-wide number. counters merge by max (db-merge.js), so two
  // sessions can't hand out the same number to different statements.
  const number = Math.max(Number(db.counters.nextBillingNumber) || 1,
    ...(db.billingStatements || []).map(s => (Number(s.number) || 0) + 1));
  db.counters.nextBillingNumber = number + 1;
  const st = { id: uid(), number, date: prISO(new Date()), caseId, clientId: c.client || '', status: 'draft',
    rate, vatPct: calc.vat ? (officeVatRate ?? 18) : 0, ...calc };
  if (!db.billingStatements) db.billingStatements = [];
  db.billingStatements.push(st);
  const ids = new Set(entries.map(t => t.id));
  for (const t of db.timeEntries) if (ids.has(t.id)) t.billedStatementId = st.id;
  saveDB().catch(() => {});
  notify(`דרישת תשלום מס' ${number} הופקה ✓`);
  renderBilling();
  prPrintStatement(st.id);
}

function prSetStatementStatus(id, status) {
  const s = (db.billingStatements || []).find(x => x.id === id);
  if (!s) return;
  s.status = status;
  if (status === 'paid') {
    s.paidAt = new Date().toISOString();
    // Recorded in the office's payments so the finance screen shows the income.
    if (!db.payments) db.payments = [];
    db.payments.unshift({ id: uid(), caseId: s.caseId, amount: s.total, date: prISO(new Date()), type: 'fee', note: `תשלום דרישה מס' ${s.number}`, billingStatementId: s.id });
  }
  saveDB().catch(() => {});
  renderBilling();
}

async function prCancelStatement(id) {
  const s = (db.billingStatements || []).find(x => x.id === id);
  if (!s || !await customConfirm(`לבטל את דרישת התשלום מס' ${s.number}? השעות יחזרו לרשימת השעות לחיוב.`, { danger: true, okText: 'בטל דרישה' })) return;
  s.status = 'cancelled';
  for (const t of db.timeEntries || []) if (t.billedStatementId === id) delete t.billedStatementId;
  saveDB().catch(() => {});
  renderBilling();
}

// Printable statement in the office document standard (David, RTL, title 16 underlined),
// opened in its own window for the browser's print / save-as-PDF.
function prPrintStatement(id) {
  const s = (db.billingStatements || []).find(x => x.id === id);
  if (!s) return;
  const c = db.cases.find(x => x.id === s.caseId) || {};
  const cl = db.clients.find(x => x.id === s.clientId) || {};
  const e = escapeHtml;
  const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>דרישת תשלום ${Number(s.number)}</title>
  <style>@page{margin:2.5cm}body{font-family:David,'David Libre',serif;font-size:12pt;line-height:1.15;direction:rtl;color:#000}
  .head{text-align:center;border-bottom:1px solid #333;padding-bottom:6pt;margin-bottom:12pt}.head b{font-size:14pt}
  h1{font-size:16pt;text-align:center;text-decoration:underline;margin:14pt 0}
  table{width:100%;border-collapse:collapse;margin-top:10pt}th,td{padding:4pt 6pt;text-align:right;vertical-align:top}
  thead th{border-bottom:1px solid #000}tfoot td{border-top:1px solid #000;font-weight:bold}.meta td{padding:1pt 0}
  .note{font-size:10pt;color:#444;margin-top:16pt}</style></head><body>
  <div class="head"><b>${e(OFFICE.title || OFFICE.name || '')}</b><br>${e(officeContactLine())}</div>
  <h1>דרישת תשלום מס' ${Number(s.number)}</h1>
  <table class="meta"><tr><td>תאריך: ${e(prDate(s.date))}</td></tr><tr><td>לכבוד: ${e(cl.name || '')}${cl.idNum ? ` (${e(cl.idNum)})` : ''}</td></tr>
  <tr><td>בעניין: ${e(c.name || '')}${c.caseSubNumber ? ` — תיק ${e(c.caseSubNumber)}` : ''}</td></tr></table>
  <table><thead><tr><th>תאריך</th><th>תיאור</th><th>שעות</th><th>תעריף</th><th>סכום</th></tr></thead><tbody>
  ${(s.lines || []).map(l => `<tr><td>${e(l.date)}</td><td>${e(l.description)}</td><td>${Number(l.hours).toFixed(2)}</td><td>${prMoney(l.rate)}</td><td>${prMoney(l.amount)}</td></tr>`).join('')}
  </tbody><tfoot>
  <tr><td colspan="4">סכום לפני מע"מ</td><td>${prMoney(s.subtotal)}</td></tr>
  ${s.vat ? `<tr><td colspan="4">מע"מ (${Number(s.vatPct)}%)</td><td>${prMoney(s.vat)}</td></tr>` : ''}
  <tr><td colspan="4">סה"כ לתשלום</td><td>${prMoney(s.total)}</td></tr></tfoot></table>
  <div class="note">מסמך זה הינו דרישת תשלום ואינו חשבונית מס. חשבונית מס תונפק עם קבלת התשלום.</div>
  <p style="margin-top:28pt">${e(OFFICE.name ? OFFICE.name + ', עו"ד' : '')}</p>
  <script>window.onload=function(){setTimeout(function(){window.print()},200)}<\/script></body></html>`;
  const w = window.open('', '_blank');
  if (!w) { notify('הדפדפן חסם חלון קופץ — יש לאפשר חלונות קופצים לאתר כדי להדפיס.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}

// ============================================================
// 4. DASHBOARD — "השבוע במשרד"
// ============================================================
// Pure: what needs attention, computed from the db (tested).
function practiceAgenda(dbv, today) {
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const inDays = (iso) => { const d = prParseISO(iso); return d ? prDaysBetween(t0, d) : null; };
  const caseName = (id) => ((dbv.cases || []).find(c => c.id === id) || {}).name || '';
  const deadlines = (dbv.events || [])
    .filter(e => e.type === 'מועד אחרון' || e.deadline || e.contractEvent)
    .map(e => ({ id: e.id, title: e.title, date: e.date, caseId: e.caseId, caseName: caseName(e.caseId), days: inDays(e.date) }))
    .filter(e => e.days !== null && e.days >= -7 && e.days <= 14)
    .sort((a, b) => a.days - b.days);
  const hearings = (dbv.events || [])
    .filter(e => !(e.type === 'מועד אחרון' || e.deadline || e.contractEvent))
    .map(e => ({ id: e.id, title: e.title, date: e.date, time: e.time, type: e.type, caseName: caseName(e.caseId), days: inDays(e.date) }))
    .filter(e => e.days !== null && e.days >= 0 && e.days <= 7)
    .sort((a, b) => a.days - b.days || String(a.time || '').localeCompare(String(b.time || '')));
  const overdueTasks = (dbv.tasks || []).filter(t => !t.done && t.due && inDays(t.due) !== null && inDays(t.due) < 0).length;
  const contracts = (dbv.cases || [])
    .filter(c => c.caseType === 'contract' && c.status !== 'closed' && c.contract && c.contract.endDate)
    .map(c => ({ id: c.id, name: c.name, endDate: c.contract.endDate, days: inDays(c.contract.endDate) }))
    .filter(c => c.days !== null && c.days <= 60)
    .sort((a, b) => a.days - b.days);
  const unbilledSecs = (dbv.timeEntries || []).filter(t => !t.billedStatementId && t.caseId).reduce((s, t) => s + (t.duration || 0), 0);
  return { deadlines, hearings, overdueTasks, contracts, unbilledHours: Math.round(unbilledSecs / 360) / 10 };
}

function practiceDashboard() {
  const content = document.querySelector('#panel-dashboard .content');
  if (!content) return;
  let box = document.getElementById('practice-agenda');
  if (!box) {
    box = document.createElement('div');
    box.id = 'practice-agenda';
    const stats = content.querySelector('.stats-grid');
    if (stats && stats.nextSibling) content.insertBefore(box, stats.nextSibling); else content.appendChild(box);
  }
  const a = practiceAgenda(db, new Date());
  const when = (d) => d < 0 ? `<span style="color:var(--danger);font-weight:700">עבר לפני ${-d} ימים</span>` : d === 0 ? '<strong>היום</strong>' : d === 1 ? 'מחר' : `בעוד ${d} ימים`;
  const item = (title, sub, right, onclick) => `<div class="doc-item" style="cursor:${onclick ? 'pointer' : 'default'}" ${onclick ? `onclick="${onclick}"` : ''}>
      <div style="flex:1"><div style="font-weight:600">${title}</div>${sub ? `<div style="font-size:12px;color:var(--text3)">${sub}</div>` : ''}</div>
      <div style="font-size:12px;white-space:nowrap">${right}</div></div>`;
  const openCase = (id) => id ? `openCaseDetail(${jsArg(id)})` : '';
  box.innerHTML = `<div class="card" style="padding:14px 16px;margin-bottom:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
      <div style="font-weight:700;color:var(--navy);font-size:15px">📌 השבוע במשרד</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm" onclick="openDeadlineCalculator()">⏳ מחשבון מועדים</button>
        <button class="btn btn-sm" onclick="nav('billing',document.getElementById('nav-billing-item'))">🧾 חיוב ושעות${a.unbilledHours ? ` (${a.unbilledHours} ש')` : ''}</button>
      </div>
    </div>
    <div class="two-col" style="margin-bottom:0">
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--accent2);margin-bottom:6px">מועדים אחרונים (14 יום)</div>
        ${a.deadlines.length ? a.deadlines.map(d => item(escapeHtml(d.title), escapeHtml([prDate(d.date), d.caseName].filter(Boolean).join(' · ')), when(d.days), openCase(d.caseId))).join('') : '<div class="empty" style="padding:8px">אין מועדים קרובים</div>'}
        ${a.contracts.length ? `<div style="font-size:12px;font-weight:700;color:var(--accent2);margin:10px 0 6px">הסכמים שמסתיימים (60 יום)</div>
          ${a.contracts.map(c => item(escapeHtml(c.name), escapeHtml('סיום תוקף ' + prDate(c.endDate)), when(c.days), openCase(c.id))).join('')}` : ''}
      </div>
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--accent2);margin-bottom:6px">דיונים ופגישות (7 ימים)</div>
        ${a.hearings.length ? a.hearings.map(h => item(escapeHtml(h.title), escapeHtml([h.type, h.caseName].filter(Boolean).join(' · ')), `${when(h.days)}${h.time ? ' ' + escapeHtml(h.time) : ''}`, '')).join('') : '<div class="empty" style="padding:8px">אין דיונים השבוע</div>'}
        ${a.overdueTasks ? `<div class="alert alert-danger" style="margin-top:10px;cursor:pointer" onclick="nav('tasks',document.querySelectorAll('.nav-item')[3])">⚠ ${a.overdueTasks} משימות שחלף מועדן</div>` : ''}
      </div>
    </div>
  </div>`;
}

// ============================================================
// 5. DOCUMENT VERSIONS
// ============================================================
function practiceShowVersions(docId) {
  const d = (db.docs || []).find(x => x.id === docId);
  if (!d) return;
  const versions = (d.versions || []).slice().reverse();
  const body = versions.length ? `<table class="data-table"><thead><tr><th>גרסה</th><th>קובץ</th><th>תאריך</th><th></th></tr></thead><tbody>
    <tr><td><strong>נוכחית</strong></td><td>${escapeHtml(d.origName || d.name)}</td><td>${escapeHtml(d.date || '')}</td><td></td></tr>
    ${versions.map((v, i) => `<tr><td>${versions.length - i}</td><td>${escapeHtml(v.origName || '')}</td><td>${escapeHtml(v.date || '')}</td>
      <td><button class="btn btn-sm" onclick="Platform.openFile(${jsArg(v.filePath)},${jsArg(v.origName || d.name)})">פתח</button></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">אין גרסאות קודמות למסמך זה.</div>';
  prModal('modal-doc-versions', `📚 גרסאות — ${d.name || ''}`, body, '', true);
}
