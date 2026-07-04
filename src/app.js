
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        AlignmentType, BorderStyle, WidthType, LineRuleType, UnderlineType, LevelFormat } = __req('docx');

// ===== OFFICE INFO =====
const OFFICE = {
  name: 'ירין אשואל',
  license: '99198',
  address: 'הכנסת 11/4, חולון',
  phone: '053-678-5147',
  email: 'nicfrer@gmail.com',
  title: 'משרד עורכי דין ירין אשואל'
};

let db = {cases:[], clients:[], tasks:[], events:[], docs:[], payments:[], settings:{}};
let currentCaseId = null;
let selectedFile = null;
let currentLegalDocType = null;
let casesView = localStorage.getItem('lextrack-view') || 'table';
let currentClientId = null;
// Set by openClientQuickAdd() when "+ לקוח" is clicked from inside the case form —
// lets saveClient()/closeModal() know to return to (and reselect the new client in)
// the case modal instead of the normal clients-grid flow, whether the user saves or
// cancels out of the client modal.
let quickAddClientForCase = false;

// ===== DB =====
async function loadDB() {
  const data = await Platform.loadDB();
  if (data) {
    db = data;
    if (!db.payments) db.payments = [];
    if (!db.timeEntries) db.timeEntries = [];
    if (!db.settings) db.settings = {};
    if (!db.counters) db.counters = { nextClientNumber: 1, caseCounters: {} };
    if (!db.counters.caseCounters) db.counters.caseCounters = {};
    let dirty = false;
    // Migrate legacy C-XXX → plain numbers
    db.clients.forEach(c => {
      if (c.clientNumber && /^C-\d+$/.test(c.clientNumber)) {
        c.clientNumber = String(parseInt(c.clientNumber.replace('C-',''))||'');
        dirty = true;
      }
    });
    // Ensure nextClientNumber is ahead of all existing numbers
    const maxCN = db.clients.map(c=>parseInt(c.clientNumber)||0).reduce((m,n)=>Math.max(m,n),0);
    if (db.counters.nextClientNumber <= maxCN) { db.counters.nextClientNumber = maxCN + 1; dirty = true; }
    // Ensure per-client case counters are ahead of existing sub-numbers
    db.cases.forEach(c => {
      if (c.client && c.caseSubNumber) {
        const parts = c.caseSubNumber.split('/');
        if (parts.length === 2) {
          const cn = parseInt(parts[1])||0;
          if (!db.counters.caseCounters[c.client]) db.counters.caseCounters[c.client] = 1;
          if (db.counters.caseCounters[c.client] <= cn) { db.counters.caseCounters[c.client] = cn + 1; dirty = true; }
        }
      }
    });
    if (dirty) await Platform.saveDB(db);
  }
  refreshAll();
}

async function saveDB() {
  await Platform.saveDB(db);
  document.getElementById('save-status').textContent = 'נשמר ✓';
  setTimeout(()=>document.getElementById('save-status').textContent='', 2000);
  refreshSidebar();
}

function uid() { return Date.now().toString(36)+Math.random().toString(36).substr(2,5); }
function getNextClientNumber() {
  if (!db.counters) db.counters = { nextClientNumber: 1, caseCounters: {} };
  return String(db.counters.nextClientNumber++);
}
function getNextCaseSubNumber(clientId) {
  const cl = db.clients.find(x => x.id === clientId);
  if (!cl || !cl.clientNumber) return '';
  if (!db.counters) db.counters = { nextClientNumber: 1, caseCounters: {} };
  if (!db.counters.caseCounters) db.counters.caseCounters = {};
  if (!db.counters.caseCounters[clientId]) db.counters.caseCounters[clientId] = 1;
  return cl.clientNumber + '/' + db.counters.caseCounters[clientId]++;
}

function refreshAll() {
  refreshSidebar();
  renderDashboard();
}

function refreshSidebar() {
  const urgent = db.cases.filter(c=>c.status==='urgent').length;
  const b = document.getElementById('urgent-badge');
  b.style.display = urgent ? 'inline' : 'none';
  b.textContent = urgent;
  const openTasks = db.tasks.filter(t=>!t.done).length;
  const tb = document.getElementById('tasks-badge');
  tb.style.display = openTasks > 0 ? 'inline' : 'none';
  tb.textContent = openTasks;
  document.getElementById('data-count').textContent = `${db.cases.length} תיקים · ${db.clients.length} לקוחות`;
}

// ===== NAV =====
let currentPanel = 'dashboard';
function nav(id, el) {
  if (id === 'finance' && currentRole === 'secretary') { id = 'dashboard'; el = null; }
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('panel-'+id).classList.add('active');
  if(el) el.classList.add('active');
  // Keep the mobile bottom-nav's active state in sync regardless of whether nav()
  // was triggered from the sidebar/drawer or from the bottom nav itself.
  document.querySelectorAll('.bottom-nav-item').forEach(n=>n.classList.remove('active'));
  const bn = document.getElementById('bottomnav-'+id);
  if (bn) bn.classList.add('active');
  if (typeof closeMobileDrawer === 'function') closeMobileDrawer();
  currentPanel = id;
  if(id==='dashboard') renderDashboard();
  if(id==='cases') renderCases();
  if(id==='clients') renderClients();
  if(id==='tasks') renderTasks();
  if(id==='calendar') renderCalendar();
  if(id==='finance') renderFinance();
  if(id==='docs') renderDocs();
  if(id==='templates' && typeof tmRender==='function') tmRender();
}

// ===== MOBILE DRAWER (sidebar-as-drawer on small screens) =====
function openMobileDrawer() {
  document.getElementById('sidebar').classList.add('drawer-open');
  document.getElementById('drawer-backdrop').classList.add('open');
}
function closeMobileDrawer() {
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('drawer-backdrop');
  if (sb) sb.classList.remove('drawer-open');
  if (bd) bd.classList.remove('open');
}

// ===== MODAL =====
function openModal(id) {
  populateSelects();
  document.getElementById(id).classList.add('open');
  if(id==='modal-case') {
    const eid=document.getElementById('case-edit-id').value;
    if(!eid) {
      document.getElementById('case-modal-title').textContent='תיק חדש';
      ['case-name','case-amount','case-number','case-notes','case-court','case-court-number',
       'case-debtor-name','case-debtor-id','case-debtor-address','case-debtor-phone','case-debtor-email',
       'case-debt-desc','case-fee-pct','case-fee-fixed','case-retainer','case-fee-notes'].forEach(f=>{
        const el=document.getElementById(f);if(el)el.value='';
      });
      document.getElementById('case-fee-pct').value='15';
      document.getElementById('case-stage').selectedIndex=0;
      document.getElementById('case-status').selectedIndex=0;
      // These selects don't get rebuilt like case-client does — without resetting
      // them explicitly, a new case silently inherits fee type/VAT/debtor type/
      // expenses-on from whichever case was last edited in this session.
      document.getElementById('case-debtor-type').selectedIndex=0;
      document.getElementById('case-fee-type').selectedIndex=0;
      document.getElementById('case-fee-vat').selectedIndex=0;
      document.getElementById('case-expenses-type').selectedIndex=0;
      updateFeeFields();
    }
  }
  if(id==='modal-client' && !document.getElementById('client-edit-id').value) {
    document.getElementById('client-modal-title').textContent='לקוח חדש';
    ['client-name','client-phone','client-email','client-address','client-idnum','client-contact','client-contact-phone','client-notes'].forEach(f=>document.getElementById(f).value='');
  }
  if(id==='modal-task'){['task-text','task-due','task-notes'].forEach(f=>document.getElementById(f).value='');document.getElementById('task-priority').value='normal';document.getElementById('task-case').value='';}
  if(id==='modal-event'){['event-title','event-date','event-time','event-location','event-notes'].forEach(f=>document.getElementById(f).value='');document.getElementById('event-type').selectedIndex=0;document.getElementById('event-case').value='';}
  if(id==='modal-doc'){['doc-name','doc-notes'].forEach(f=>document.getElementById(f).value='');selectedFile=null;document.getElementById('file-info').style.display='none';document.getElementById('doc-case').value='';}
  if(id==='modal-payment'){['pay-amount','pay-note'].forEach(f=>document.getElementById(f).value='');document.getElementById('pay-date').value=localDateISO(new Date());document.getElementById('pay-case').value='';document.getElementById('pay-type').value='debt';document.getElementById('pay-method').selectedIndex=0;}
}

// Opens the "new client" modal on top of an in-progress case form, without losing
// whatever the user already typed into the case (a plain closeModal('modal-case')
// here would clear case-edit-id and make the case modal reopen in "new case" mode,
// wiping every field). See quickAddClientForCase and saveClient()/closeModal().
function openClientQuickAdd() {
  quickAddClientForCase = true;
  document.getElementById('modal-case').classList.remove('open');
  openModal('modal-client');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  if(id==='modal-case') document.getElementById('case-edit-id').value='';
  if(id==='modal-client') {
    document.getElementById('client-edit-id').value='';
    // Covers both cancelling out of the quick-add (X button / backdrop click) and
    // the post-save path in saveClient() — either way the case form must reappear.
    if(quickAddClientForCase) {
      quickAddClientForCase=false;
      document.getElementById('modal-case').classList.add('open');
    }
  }
  if(id==='modal-payment') { document.getElementById('pay-edit-id').value=''; document.getElementById('pay-modal-title').textContent='רישום תשלום'; }
}

// Routed through closeModal(), not a bare classList.remove('open') — otherwise
// dismissing a modal by clicking its backdrop skips the per-modal cleanup above
// (stale case/client edit-id sticking around for the next "new" open, or the
// quick-add-from-case flow never returning to the case form).
document.querySelectorAll('.modal-overlay').forEach(m=>m.addEventListener('click',function(e){if(e.target===this)closeModal(this.id);}));

// Delegated so it works for every task-cb rendered anywhere (dashboard, tasks
// screen, case detail) without a listener per element. A div with role="checkbox"
// only gets a11y semantics from the role/aria attributes (see taskCbHtml) — the
// browser doesn't wire up Enter/Space activation for it the way a real
// <input type=checkbox> gets for free, so this does it by hand.
document.addEventListener('keydown', function(e){
  if((e.key===' '||e.key==='Enter') && e.target.matches && e.target.matches('.task-cb[role="checkbox"]')){
    e.preventDefault();
    e.target.click();
  }
});

// ===== CLIENT-SIDE ERROR LOGGING (see client_errors table / fix8.sql) =====
// A lightweight, zero-new-account alternative to a third-party error monitoring
// service — logs to the same Supabase project this app already runs on, so there's
// nothing new to sign up for. Deduped by message text and capped per session so a
// tight error loop can't flood the table.
const _loggedErrorKeys = new Set();
let _clientErrorCount = 0;
function logClientErrorOnce(message, stack) {
  if (_clientErrorCount >= 20) return;
  const key = String(message).slice(0, 200);
  if (_loggedErrorKeys.has(key)) return;
  _loggedErrorKeys.add(key);
  _clientErrorCount++;
  if (typeof Platform !== 'undefined' && Platform.logClientError) {
    Platform.logClientError({ message, stack, url: location.href }).catch(()=>{});
  }
}
window.addEventListener('error', (e) => {
  logClientErrorOnce(e.message, e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  logClientErrorOnce(reason && reason.message ? reason.message : String(reason), reason && reason.stack);
});

function populateSelects() {
  const co='<option value="">בחר לקוח...</option>'+db.clients.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  const cas='<option value="">ללא תיק</option>'+db.cases.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  const casReq='<option value="">בחר תיק...</option>'+db.cases.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  document.getElementById('case-client').innerHTML=co;
  document.getElementById('task-case').innerHTML=cas;
  document.getElementById('event-case').innerHTML=cas;
  document.getElementById('doc-case').innerHTML=cas;
  document.getElementById('pay-case').innerHTML=casReq;
  const tlc=document.getElementById('tl-case');
  if(tlc) tlc.innerHTML=cas;
  // tasks filter
  const tf=document.getElementById('tasks-filter');
  if(tf) tf.innerHTML='<option value="">כל התיקים</option>'+db.cases.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
}

function switchFormTab(el,id) {
  el.closest('.tabs').querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  ['ctab-basic','ctab-debtor','ctab-fee'].forEach(t=>{const e=document.getElementById(t);if(e)e.style.display='none';});
  document.getElementById(id).style.display='block';
}

function updateFeeFields() {
  const t=document.getElementById('case-fee-type').value;
  document.getElementById('fee-pct-group').style.display=(t==='percent'||t==='both')?'block':'none';
  document.getElementById('fee-fixed-group').style.display=(t==='fixed'||t==='both'||t==='hourly')?'block':'none';
}

// ===== CASES =====
function saveCase() {
  const name=document.getElementById('case-name').value.trim();
  if(!name){notify('נא להזין שם תיק');return;}
  const debtorName=document.getElementById('case-debtor-name').value.trim();
  if(!debtorName){
    notify('נא להזין שם חייב (שדה חובה)');
    const debtorTab=document.querySelector(`[onclick="switchFormTab(this,'ctab-debtor')"]`);
    if(debtorTab) switchFormTab(debtorTab,'ctab-debtor');
    return;
  }
  const eid=document.getElementById('case-edit-id').value;
  const old = eid ? db.cases.find(c=>c.id===eid) : {};
  const obj={
    id:eid||uid(), name,
    client:document.getElementById('case-client').value,
    amount:parseFloat(document.getElementById('case-amount').value)||0,
    stage:document.getElementById('case-stage').value,
    status:document.getElementById('case-status').value,
    number:document.getElementById('case-number').value.trim(),
    notes:document.getElementById('case-notes').value.trim(),
    court:document.getElementById('case-court').value.trim(),
    courtNumber:document.getElementById('case-court-number').value.trim(),
    debtorName:document.getElementById('case-debtor-name').value.trim(),
    debtorId:document.getElementById('case-debtor-id').value.trim(),
    debtorAddress:document.getElementById('case-debtor-address').value.trim(),
    debtorPhone:document.getElementById('case-debtor-phone').value.trim(),
    debtorEmail:document.getElementById('case-debtor-email').value.trim(),
    debtorType:document.getElementById('case-debtor-type').value,
    debtDesc:document.getElementById('case-debt-desc').value.trim(),
    feeType:document.getElementById('case-fee-type').value,
    feePct:parseFloat(document.getElementById('case-fee-pct').value)||15,
    feeFixed:parseFloat(document.getElementById('case-fee-fixed').value)||0,
    feeVat:document.getElementById('case-fee-vat').value,
    expensesType:document.getElementById('case-expenses-type').value,
    retainer:parseFloat(document.getElementById('case-retainer').value)||0,
    feeNotes:document.getElementById('case-fee-notes').value.trim(),
    opened:eid?(old.opened||new Date().toLocaleDateString('he-IL')):new Date().toLocaleDateString('he-IL'),
    diary:eid?(old.diary||[]):[],
    legalDocs:eid?(old.legalDocs||{}):{},
    collected:eid?(old.collected||0):0,
    caseSubNumber:eid?(old.caseSubNumber||''):''
  };
  // Generate a sub-number on first save, and also if a client gets attached later
  // via edit to a case that started with none — otherwise it silently never gets
  // one at all.
  if(obj.client && !obj.caseSubNumber) obj.caseSubNumber = getNextCaseSubNumber(obj.client);

  if(eid){const i=db.cases.findIndex(c=>c.id===eid);if(i>=0)db.cases[i]=obj;}
  else db.cases.unshift(obj);
  saveDB(); closeModal('modal-case'); notify(eid?'התיק עודכן':'תיק נוצר! ✓');
  if(currentPanel==='cases') renderCases();
  else if(currentPanel==='case-detail') openCaseDetail(obj.id);
  else if(currentPanel==='client-detail') openClientDetail(currentClientId);
  else renderDashboard();
}

function daysSinceHE(dateStr){
  if(!dateStr) return null;
  const p=dateStr.split('.');
  const d=p.length===3?new Date(+p[2],+p[1]-1,+p[0]):new Date(dateStr);
  if(isNaN(d)) return null;
  return Math.floor((Date.now()-d)/86400000);
}
function heToISO(dateStr){
  if(!dateStr) return '';
  const p=dateStr.split('.');
  if(p.length!==3) return dateStr;
  return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
}
// YYYY-MM-DD using LOCAL date parts. Same issue as localMonthKey below: plain
// `d.toISOString().split('T')[0]` converts to UTC first, so it returns YESTERDAY's
// date for the ~2-3 hours after local midnight in Israel — wrong "today" for
// default form dates, overdue-task checks, and upcoming-event filters.
function localDateISO(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
// YYYY-MM using LOCAL date parts — d.toISOString() converts to UTC first, which in
// Israel (UTC+2/+3) shifts local midnight of the 1st into the previous UTC day,
// silently bucketing everything into the wrong month for finance reporting.
function localMonthKey(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

// Single source of truth for expected fee, covering all 4 fee types + VAT — this
// used to be duplicated inline in 4+ places, and the 'both' case (percent + fixed)
// was wrong everywhere except the AI's getFinancialReport tool (it silently dropped
// the percent portion). Hourly wasn't computed anywhere despite being a selectable
// fee type — it's now (hours logged in timeEntries) × feeFixed-as-hourly-rate.
function calcExpectedFee(c){
  const vatMult = c.feeVat==='yes' ? 1+((officeVatRate||18)/100) : 1;
  let base = 0;
  if (c.feeType==='percent') base = (c.amount||0)*((c.feePct||15)/100);
  else if (c.feeType==='fixed') base = c.feeFixed||0;
  else if (c.feeType==='both') base = (c.feeFixed||0) + (c.amount||0)*((c.feePct||0)/100);
  else if (c.feeType==='hourly') {
    const totalSecs = (db.timeEntries||[]).filter(t=>t.caseId===c.id).reduce((s,t)=>s+(t.duration||0),0);
    base = (totalSecs/3600) * (c.feeFixed||0);
  }
  return base * vatMult;
}
// How much of the expected fee has actually been earned so far. Preserves the
// existing (correct) business rule: a percent-of-collection fee is earned
// PROPORTIONALLY as debt payments come in; a fixed fee is only earned once the debt
// is fully collected (all-or-nothing); hourly is earned as time gets logged,
// independent of collection. 'both' combines the proportional percent piece with
// the all-or-nothing fixed piece. Now also applies VAT, and requires a real
// positive debt amount for the "fully collected" fixed-fee check — previously
// `0 >= 0` made an unset debt amount look fully collected with zero payments.
function calcCollectedFee(c){
  if (c.feeType==='hourly') return calcExpectedFee(c);
  const vatMult = c.feeVat==='yes' ? 1+((officeVatRate||18)/100) : 1;
  const cPay=db.payments.filter(p=>p.caseId===c.id&&p.type==='debt').reduce((s,p)=>s+(p.amount||0),0);
  const debtAmount=c.amount||0;
  const fixedEarned=(debtAmount>0 && cPay>=debtAmount)?(c.feeFixed||0):0;
  let base=0;
  if (c.feeType==='percent') base=cPay*((c.feePct||15)/100);
  else if (c.feeType==='fixed') base=fixedEarned;
  else if (c.feeType==='both') base=fixedEarned+cPay*((c.feePct||0)/100);
  return base*vatMult;
}

function toggleCasesView(){
  casesView=casesView==='table'?'board':'table';
  localStorage.setItem('lextrack-view',casesView);
  renderCases(document.getElementById('cases-search').value);
}

function renderCases(filter=''){
  const statusF=document.getElementById('cases-filter-status').value;
  const stageF=document.getElementById('cases-filter-stage').value;
  let cases=db.cases;
  if(filter) cases=cases.filter(c=>
    c.name.includes(filter)||(c.number||'').includes(filter)||
    (c.caseSubNumber||'').includes(filter)||
    (db.clients.find(x=>x.id===c.client)||{name:''}).name.includes(filter)||
    (c.debtorName||'').includes(filter)||(c.debtorId||'').includes(filter)
  );
  if(statusF) cases=cases.filter(c=>c.status===statusF);
  if(stageF) cases=cases.filter(c=>c.stage===stageF);

  const toggleBtn=document.getElementById('cases-view-toggle');
  if(toggleBtn) toggleBtn.textContent=casesView==='board'?'☰ טבלה':'⊞ לוח';

  const tableWrap=document.getElementById('cases-table-wrap');
  const boardWrap=document.getElementById('cases-board-wrap');
  if(casesView==='board'){
    tableWrap.style.display='none';
    boardWrap.style.display='';
    renderCasesBoard(cases);
  } else {
    tableWrap.style.display='';
    boardWrap.style.display='none';
    renderCasesTable(cases);
  }
}

function renderCasesTable(cases){
  const tbody=document.getElementById('cases-tbody');
  const empty=document.getElementById('cases-empty');
  if(!cases.length){tbody.innerHTML='';empty.style.display='block';return;}
  empty.style.display='none';
  const smap={active:'פעיל',urgent:'דחוף',pending:'ממתין',closed:'סגור'};
  const feeLabel=(c)=>{
    if(c.feeType==='percent') return `${c.feePct||15}%`;
    if(c.feeType==='fixed') return `₪${(c.feeFixed||0).toLocaleString()}`;
    if(c.feeType==='both') return `${c.feePct||15}% + ₪${(c.feeFixed||0).toLocaleString()}`;
    return 'שעתי';
  };
  tbody.innerHTML=cases.map(c=>{
    const cl=db.clients.find(x=>x.id===c.client);
    const hasAtf=c.legalDocs&&c.legalDocs.atf;
    const hasPoa=c.legalDocs&&c.legalDocs.poa;
    return `<tr onclick="openCaseDetail('${c.id}')">
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <b style="color:var(--navy)">${c.name}</b>
          ${c.caseSubNumber?`<span style="font-size:10px;color:var(--accent2);background:var(--accent-dim);border-radius:4px;padding:1px 5px;font-weight:700;flex-shrink:0">${c.caseSubNumber}</span>`:''}
        </div>
        <span style="font-size:11px;color:var(--text3)">${c.number||''} ${c.courtNumber?'| '+c.courtNumber:''}</span>
      </td>
      <td>
        <div style="color:var(--text2);font-size:12px">${cl?cl.name:'—'}</div>
        ${c.debtorName?`<div style="font-size:11px;color:var(--text3)">חייב: ${c.debtorName}</div>`:''}
      </td>
      <td style="color:var(--accent2);font-weight:600">${c.amount?'₪'+c.amount.toLocaleString():'—'}</td>
      <td style="color:var(--text2);font-size:12px">${c.stage}</td>
      <td style="color:var(--text3);font-size:12px">${c.opened||''}</td>
      <td style="font-size:12px;color:var(--warning)">${feeLabel(c)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:4px">
          <span class="badge badge-${c.status}">${smap[c.status]||c.status}</span>
          ${hasAtf?'<span title="יש הסכם שכ״ט" style="font-size:10px;color:var(--success)">✓שכ"ט</span>':''}
          ${hasPoa?'<span title="יש ייפוי כוח" style="font-size:10px;color:var(--success)">✓י"כ</span>':''}
        </div>
      </td>
      <td><button class="btn btn-sm" onclick="event.stopPropagation();openCaseDetail('${c.id}')">פתח</button></td>
    </tr>`;
  }).join('');
}

function renderCasesBoard(cases){
  const stages=['איסוף מסמכים','התראה ראשונה','גישור','כתב תביעה','דיון','הוצאה לפועל','סגור'];
  const smap={active:'פעיל',urgent:'דחוף',pending:'ממתין',closed:'סגור'};
  const board=document.getElementById('cases-board');
  board.innerHTML=stages.map(stage=>{
    const cols=cases.filter(c=>c.stage===stage);
    const cards=cols.map(c=>{
      const days=daysSinceHE(c.opened);
      return `<div class="kanban-card" onclick="openCaseDetail('${c.id}')">
        <div class="kanban-card-name">
          ${c.caseSubNumber?`<span style="font-size:10px;color:var(--accent2);font-weight:700;opacity:0.85;margin-left:5px">${c.caseSubNumber}</span>`:''}${c.name}
        </div>
        ${c.debtorName?`<div class="kanban-card-sub">${c.debtorName}</div>`:''}
        <div class="kanban-card-amount">${c.amount?'₪'+c.amount.toLocaleString():'—'}</div>
        <div class="kanban-card-foot">
          <span class="badge badge-${c.status}" style="font-size:10px;padding:2px 7px">${smap[c.status]||c.status}</span>
          <span class="kanban-days">${days!==null?days+' ימים':''}</span>
        </div>
      </div>`;
    }).join('');
    return `<div class="kanban-col">
      <div class="kanban-col-hd">
        <span class="kanban-col-title">${stage}</span>
        <span class="kanban-count">${cols.length}</span>
      </div>
      <div class="kanban-body">${cards||`<div style="font-size:12px;color:var(--text3);padding:8px 4px">אין תיקים</div>`}</div>
    </div>`;
  }).join('');
}

function openCaseDetail(id) {
  currentCaseId=id;
  const c=db.cases.find(x=>x.id===id);
  if(!c) return;
  const cl=db.clients.find(x=>x.id===c.client);
  const caseTasks=db.tasks.filter(t=>t.caseId===id);
  const caseDocs=db.docs.filter(d=>d.caseId===id);
  const caseEvents=db.events.filter(e=>e.caseId===id);
  const casePayments=db.payments.filter(p=>p.caseId===id);
  const caseTime=(db.timeEntries||[]).filter(t=>t.caseId===id);
  const caseTimeSecs=caseTime.reduce((s,t)=>s+(t.duration||0),0);
  const smap={active:'פעיל',urgent:'דחוף',pending:'ממתין',closed:'סגור'};
  const stages=['איסוף מסמכים','התראה ראשונה','גישור','כתב תביעה','דיון','הוצאה לפועל','סגור'];
  const stageIdx=stages.indexOf(c.stage);
  const pct=Math.round(((stageIdx+1)/stages.length)*100);
  const totalCollected=casePayments.filter(p=>p.type==='debt').reduce((s,p)=>s+p.amount,0);
  const expectedFee=Math.round(calcExpectedFee(c));
  const atfStatus=c.legalDocs?.atf ? 'signed' : (c.legalDocs?.atfDraft ? 'draft' : 'none');
  const poaStatus=c.legalDocs?.poa ? 'signed' : (c.legalDocs?.poaDraft ? 'draft' : 'none');
  const statusLabels={none:'לא נוצר',draft:'טיוטה',signed:'נחתם'};

  document.getElementById('case-detail-body').innerHTML=`
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px">
      <div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <h2 style="font-size:20px;font-weight:700;color:var(--navy)">${c.name}</h2>
          ${c.caseSubNumber?`<span style="font-size:13px;color:var(--accent2);background:var(--accent-dim);border:1px solid rgba(37,99,235,0.3);border-radius:6px;padding:2px 9px;font-weight:700">${c.caseSubNumber}</span>`:''}
        </div>
        <div style="font-size:12px;color:var(--text3);margin-top:4px">
          ${c.number?'#'+c.number+' · ':''}נפתח ${c.opened||''}
          ${c.courtNumber?' · ביהמ"ש: '+c.courtNumber:''}
          ${c.court?' | '+c.court:''}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
        <span class="badge badge-${c.status}" style="font-size:13px;padding:4px 12px">${smap[c.status]}</span>
        <div style="display:flex;align-items:center;gap:8px">
          ${caseTimeSecs>0?`<span style="font-size:12px;color:var(--text3)">⏱ ${Math.floor(caseTimeSecs/3600)}:${String(Math.floor((caseTimeSecs%3600)/60)).padStart(2,'0')} שעות</span>`:''}
          <button id="case-timer-btn" class="btn btn-sm ${timerRunning&&timerCaseId===id?'btn-danger':timerRunning?'':'btn-success'}" onclick="toggleCaseTimer('${id}')">${timerRunning&&timerCaseId===id?'⏹ עצור · '+formatDuration(timerSeconds):timerRunning?'▶ טיימר פועל לתיק אחר':'▶ הפעל טיימר'}</button>
        </div>
      </div>
    </div>

    <!-- Stats row -->
    <div class="stats-grid" style="margin-bottom:16px">
      <div class="stat"><div class="stat-label">סכום חוב</div><div class="stat-value" style="color:var(--accent2);font-size:20px">${c.amount?'₪'+c.amount.toLocaleString():'—'}</div></div>
      <div class="stat"><div class="stat-label">גבוי בפועל</div><div class="stat-value" style="color:var(--success);font-size:20px">₪${totalCollected.toLocaleString()}</div></div>
      <div class="stat"><div class="stat-label">שכ"ט צפוי</div><div class="stat-value" style="color:var(--warning);font-size:18px">₪${expectedFee.toLocaleString()}</div></div>
      <div class="stat"><div class="stat-label">שלב</div><div style="font-size:14px;font-weight:600;color:var(--navy);margin-top:4px">${c.stage}</div>
        <div class="stage-bar">${stages.map((s,i)=>`<div class="stage-step ${i<stageIdx?'done':i===stageIdx?'current':''}"></div>`).join('')}</div>
      </div>
    </div>

    <!-- Debtor + Client info -->
    <div class="two-col" style="margin-bottom:0">
      ${c.debtorName?`<div class="debtor-card">
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px">פרטי חייב</div>
        <div style="font-weight:600;color:var(--navy);margin-bottom:4px">${c.debtorName} ${c.debtorId?'('+c.debtorId+')':''}</div>
        ${c.debtorAddress?`<div style="font-size:12px;color:var(--text2)">📍 ${c.debtorAddress}</div>`:''}
        ${c.debtorPhone?`<div style="font-size:12px;color:var(--text2)">📞 ${c.debtorPhone}</div>`:''}
        ${c.debtorEmail?`<div style="font-size:12px;color:var(--text2)">✉ ${c.debtorEmail}</div>`:''}
        ${c.debtDesc?`<div style="font-size:11px;color:var(--text3);margin-top:6px">${c.debtDesc}</div>`:''}
      </div>`:'<div></div>'}
      ${cl?`<div class="debtor-card" style="border-right-color:var(--success)">
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px">פרטי לקוח</div>
        <div style="font-weight:600;color:var(--navy);margin-bottom:4px">${cl.name}</div>
        ${cl.phone?`<div style="font-size:12px;color:var(--text2)">📞 ${cl.phone}</div>`:''}
        ${cl.email?`<div style="font-size:12px;color:var(--text2)">✉ ${cl.email}</div>`:''}
        ${cl.address?`<div style="font-size:12px;color:var(--text2)">📍 ${cl.address}</div>`:''}
      </div>`:'<div></div>'}
    </div>

    ${(c.feeVat==='yes'||c.expensesType||c.retainer||c.feeNotes)?`<div class="card" style="padding:12px 14px">
      <div class="card-title" style="margin-bottom:8px">פרטי שכר טרחה נוספים</div>
      <div style="display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--text2)">
        ${c.feeVat==='yes'?`<span>מע"מ: כולל (+${officeVatRate}%)</span>`:''}
        ${c.expensesType?`<span>הוצאות: ${c.expensesType==='client'?'על חשבון הלקוח':c.expensesType==='office'?'על חשבון המשרד':'לא רלוונטי'}</span>`:''}
        ${c.retainer?`<span>מקדמה/ריטיינר: ₪${c.retainer.toLocaleString()}</span>`:''}
      </div>
      ${c.feeNotes?`<div style="font-size:12px;color:var(--text3);margin-top:8px">${c.feeNotes}</div>`:''}
    </div>`:''}

    <!-- Legal Documents Section -->
    <div class="card" style="border-color:rgba(37,99,235,0.3);padding:10px 14px">
      <div style="font-size:11px;font-weight:600;color:var(--accent2);margin-bottom:8px;letter-spacing:0.05em">מסמכים משפטיים</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:13px;min-width:110px">הסכם שכ"ט</span>
        <span class="doc-status-badge doc-status-${atfStatus}" style="padding:2px 8px;font-size:11px">${atfStatus==='none'?'⚪':atfStatus==='draft'?'🟡':'🟢'} ${statusLabels[atfStatus]}</span>
        <button class="btn btn-sm btn-primary" style="padding:2px 10px;font-size:12px" onclick="generateLegalDoc('attorney-fee')">צור</button>
        ${atfStatus!=='none'?`<button class="btn btn-sm" style="padding:2px 10px;font-size:12px" onclick="markDocSigned('atf')">חתום</button>`:''}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:13px;min-width:110px">ייפוי כוח</span>
        <span class="doc-status-badge doc-status-${poaStatus}" style="padding:2px 8px;font-size:11px">${poaStatus==='none'?'⚪':poaStatus==='draft'?'🟡':'🟢'} ${statusLabels[poaStatus]}</span>
        <button class="btn btn-sm btn-primary" style="padding:2px 10px;font-size:12px" onclick="generateLegalDoc('poa')">צור</button>
        ${poaStatus!=='none'?`<button class="btn btn-sm" style="padding:2px 10px;font-size:12px" onclick="markDocSigned('poa')">חתום</button>`:''}
      </div>
    </div>

    ${c.notes?`<div class="card"><div class="card-title">הערות</div><div style="font-size:13px;color:var(--text2);line-height:1.7">${c.notes}</div></div>`:''}

    <!-- Tabs -->
    <div class="card">
      <div class="tabs">
        <div class="tab active" onclick="switchTab(this,'ct-tasks')">משימות (${caseTasks.length})</div>
        <div class="tab" onclick="switchTab(this,'ct-events')">דיונים (${caseEvents.length})</div>
        <div class="tab" onclick="switchTab(this,'ct-docs')">מסמכים (${caseDocs.length})</div>
        <div class="tab" onclick="switchTab(this,'ct-payments')">תשלומים (${casePayments.length})</div>
        <div class="tab" onclick="switchTab(this,'ct-diary')">יומן טיפול</div>
        <div class="tab" onclick="switchTab(this,'ct-time')">שעות (${caseTime.length})</div>
      </div>

      <!-- Tasks -->
      <div id="ct-tasks">
        <button class="btn btn-sm" style="margin-bottom:10px" onclick="addTaskForCase('${id}')">+ משימה</button>
        ${caseTasks.length?caseTasks.map(t=>`<div class="task-item">
          ${taskCbHtml(t,true)}
          <div class="prio-dot prio-${t.priority||'normal'}"></div>
          <div style="flex:1"><div class="task-text ${t.done?'done':''}">${t.text}</div>${t.notes?`<div style="font-size:11px;color:var(--text3)">${t.notes}</div>`:''}</div>
          <div class="task-meta ${t.priority==='urgent'&&!t.done?'urgent':''}">${t.due||''}</div>
          <button class="btn btn-sm" style="color:var(--danger);border:none;padding:2px 6px;font-size:12px" onclick="delTask('${t.id}',true)">✕</button>
        </div>`).join(''):'<div class="empty" style="padding:16px">אין משימות</div>'}
      </div>

      <!-- Events -->
      <div id="ct-events" style="display:none">
        <button class="btn btn-sm" style="margin-bottom:10px" onclick="addEventForCase('${id}')">+ דיון</button>
        ${caseEvents.length?caseEvents.sort((a,b)=>a.date>b.date?1:-1).map(e=>`<div class="task-item">
          <div style="width:40px;height:40px;border-radius:8px;background:var(--accent-dim);display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0">
            <div style="font-size:13px;font-weight:700;color:var(--accent2)">${(e.date||'').split('-')[2]||''}</div>
            <div style="font-size:9px;color:var(--text3)">${monthHE((e.date||'').split('-')[1])}</div>
          </div>
          <div style="flex:1"><div style="font-weight:500;color:var(--navy)">${e.title}</div><div style="font-size:11px;color:var(--text3)">${e.type||''} ${e.location?'| '+e.location:''} ${e.time?'| '+e.time:''}</div>${e.notes?`<div style="font-size:11px;color:var(--text3)">${e.notes}</div>`:''}</div>
          <button class="btn btn-sm" style="color:var(--danger);border:none;padding:2px 6px" onclick="delEvent('${e.id}',true)">✕</button>
        </div>`).join(''):'<div class="empty" style="padding:16px">אין דיונים</div>'}
      </div>

      <!-- Docs -->
      <div id="ct-docs" style="display:none">
        <button class="btn btn-sm" style="margin-bottom:10px" onclick="addDocForCase('${id}')">+ מסמך</button>
        ${caseDocs.length?caseDocs.map(d=>`<div class="doc-item">
          <div class="doc-icon ${d.ext}">${d.ext.toUpperCase()}</div>
          <div style="flex:1"><div style="font-size:13px;font-weight:500;color:var(--navy)">${d.name}</div><div style="font-size:11px;color:var(--text3)">${d.date||''} ${d.notes?'· '+d.notes:''}</div></div>
          ${d.filePath?`<button class="btn btn-sm" onclick="openFile('${d.filePath.replace(/\\/g,'/')}','${(d.origName||d.name||'').replace(/\\/g,'')}')">פתח</button>`:''}
          <button class="btn btn-sm" style="color:var(--danger);border:none;padding:2px 6px" onclick="delDoc('${d.id}',true)">✕</button>
        </div>`).join(''):'<div class="empty" style="padding:16px">אין מסמכים</div>'}
      </div>

      <!-- Payments -->
      <div id="ct-payments" style="display:none">
        <button class="btn btn-sm" style="margin-bottom:10px" onclick="addPaymentForCase('${id}')">+ תשלום</button>
        ${casePayments.length?casePayments.map(p=>`<div class="fin-row">
          <div><div style="font-weight:500;color:var(--navy)">₪${p.amount.toLocaleString()}</div><div style="font-size:11px;color:var(--text3)">${p.type==='debt'?'גבייה':p.type==='retainer'?'מקדמה':'הוצאה'} | ${p.method||''}</div></div>
          <div style="display:flex;align-items:center;gap:6px">
            <div style="text-align:left"><div style="font-size:12px;color:var(--text2)">${p.date||''}</div><div style="font-size:11px;color:var(--text3)">${p.note||''}</div></div>
            <button class="btn btn-sm" onclick="editPayment('${p.id}')">✏</button>
            <button class="btn btn-sm" style="color:var(--danger);border:none;padding:2px 6px" onclick="delPayment('${p.id}')">✕</button>
          </div>
        </div>`).join(''):'<div class="empty" style="padding:16px">אין תשלומים</div>'}
        ${casePayments.length?`<div class="fin-row" style="margin-top:8px"><b style="color:var(--text2)">סה"כ גבוי</b><b style="color:var(--success)">₪${casePayments.filter(p=>p.type==='debt').reduce((s,p)=>s+p.amount,0).toLocaleString()}</b></div>`:''}
      </div>

      <!-- Diary -->
      <div id="ct-diary" style="display:none">
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <textarea class="form-input" id="diary-input" placeholder="רשום פעולה, שיחה, הערה, התפתחות..." style="flex:1;min-height:60px"></textarea>
          <button class="btn btn-primary btn-sm" onclick="addDiary('${id}')">הוסף</button>
        </div>
        ${(c.diary||[]).slice().reverse().map(e=>`<div style="background:var(--bg3);border-radius:var(--radius);padding:12px;margin-bottom:8px;border-right:2px solid var(--border2)">
          <div style="font-size:11px;color:var(--text3);margin-bottom:4px">${e.date}</div>
          <div style="font-size:13px;color:var(--text2);line-height:1.6">${e.text}</div>
        </div>`).join('') || '<div class="empty" style="padding:16px">אין רישומים</div>'}
      </div>

      <!-- Time Entries -->
      <div id="ct-time" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div style="font-size:13px;color:var(--accent2);font-weight:600">⏱ סה"כ: ${Math.floor(caseTimeSecs/3600)}:${String(Math.floor((caseTimeSecs%3600)/60)).padStart(2,'0')} שעות</div>
          <button class="btn btn-sm btn-primary" onclick="openManualTime('${id}')">+ הוסף ידנית</button>
        </div>
        ${caseTime.length?caseTime.map(t=>`<div class="fin-row">
          <div>
            <div style="font-weight:500;color:var(--navy)">${t.description||'—'}</div>
            <div style="font-size:11px;color:var(--text3)">${formatDuration(t.duration)} | ${t.date||''}</div>
          </div>
          <button class="btn btn-sm" style="color:var(--danger);border:none;padding:2px 6px" onclick="delTimeEntry('${t.id}')">✕</button>
        </div>`).join(''):'<div class="empty" style="padding:12px 0">אין רשומות שעות</div>'}
      </div>
    </div>
  `;
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('panel-case-detail').classList.add('active');
  document.querySelectorAll('.nav-item')[1].classList.add('active');
  currentPanel='case-detail';
}

function markDocSigned(type) {
  const c=db.cases.find(x=>x.id===currentCaseId);
  if(!c) return;
  if(!c.legalDocs) c.legalDocs={};
  c.legalDocs[type]=true;
  c.legalDocs[type+'SignedDate']=new Date().toLocaleDateString('he-IL');
  saveDB();
  openCaseDetail(currentCaseId);
  notify(type==='atf'?'הסכם שכ"ט סומן כחתום ✓':'ייפוי כוח סומן כחתום ✓');
}

function monthHE(m){const a=['','ינו','פבר','מרץ','אפר','מאי','יוני','יולי','אוג','ספט','אוק','נוב','דצמ'];return a[+m]||'';}

function addDiary(caseId) {
  const text=document.getElementById('diary-input').value.trim();
  if(!text) return;
  const c=db.cases.find(x=>x.id===caseId);
  if(!c.diary) c.diary=[];
  c.diary.push({text, date:new Date().toLocaleString('he-IL')});
  saveDB(); openCaseDetail(caseId);
}

function deleteCase() {
  if(!confirm('למחוק תיק זה? הפעולה בלתי הפיכה.')) return;
  const id=currentCaseId;
  db.cases=db.cases.filter(c=>c.id!==id);
  db.tasks=db.tasks.filter(t=>t.caseId!==id);
  db.events=db.events.filter(e=>e.caseId!==id);
  db.docs=db.docs.filter(d=>d.caseId!==id);
  db.payments=db.payments.filter(p=>p.caseId!==id);
  db.timeEntries=(db.timeEntries||[]).filter(t=>t.caseId!==id);
  saveDB(); nav('cases',document.querySelectorAll('.nav-item')[1]); notify('תיק נמחק');
}

function editCase() {
  const c=db.cases.find(x=>x.id===currentCaseId);
  if(!c) return;
  populateSelects();
  document.getElementById('modal-case').classList.add('open');
  document.getElementById('case-modal-title').textContent='עריכת תיק';
  document.getElementById('case-edit-id').value=c.id;
  document.getElementById('case-name').value=c.name;
  document.getElementById('case-client').value=c.client||'';
  document.getElementById('case-amount').value=c.amount||'';
  document.getElementById('case-stage').value=c.stage;
  document.getElementById('case-status').value=c.status;
  document.getElementById('case-number').value=c.number||'';
  document.getElementById('case-notes').value=c.notes||'';
  document.getElementById('case-court').value=c.court||'';
  document.getElementById('case-court-number').value=c.courtNumber||'';
  document.getElementById('case-debtor-name').value=c.debtorName||'';
  document.getElementById('case-debtor-id').value=c.debtorId||'';
  document.getElementById('case-debtor-address').value=c.debtorAddress||'';
  document.getElementById('case-debtor-phone').value=c.debtorPhone||'';
  document.getElementById('case-debtor-email').value=c.debtorEmail||'';
  document.getElementById('case-debtor-type').value=c.debtorType||'יחיד';
  document.getElementById('case-debt-desc').value=c.debtDesc||'';
  document.getElementById('case-fee-type').value=c.feeType||'percent';
  document.getElementById('case-fee-pct').value=c.feePct||15;
  document.getElementById('case-fee-fixed').value=c.feeFixed||'';
  document.getElementById('case-fee-vat').value=c.feeVat||'yes';
  document.getElementById('case-expenses-type').value=c.expensesType||'client';
  document.getElementById('case-retainer').value=c.retainer||'';
  document.getElementById('case-fee-notes').value=c.feeNotes||'';
  updateFeeFields();
}

function addTaskForCase(id){openModal('modal-task');document.getElementById('task-case').value=id;}
function addDocForCase(id){openModal('modal-doc');document.getElementById('doc-case').value=id;}
function addEventForCase(id){openModal('modal-event');document.getElementById('event-case').value=id;}
function addPaymentForCase(id){openModal('modal-payment');document.getElementById('pay-case').value=id;}

// ===== LEGAL DOC GENERATOR =====
function generateLegalDoc(type) {
  const c = db.cases.find(x=>x.id===currentCaseId);
  if(!c) { notify('פתח תיק קודם'); return; }
  currentLegalDocType = type;
  const cl = db.clients.find(x=>x.id===c.client)||{};

  if(type==='attorney-fee') {
    document.getElementById('legal-gen-title').textContent = 'הסכם שכ"ט – ' + c.name;
    document.getElementById('legal-gen-body').innerHTML = `
      <div class="form-row">
        <div class="form-group"><label class="form-label">שם הלקוח</label><input class="form-input" id="lg-client-name" value="${cl.name||''}"></div>
        <div class="form-group"><label class="form-label">ת.ז / ח.פ</label><input class="form-input" id="lg-client-id" value="${cl.idNum||''}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">נושא התיק</label><input class="form-input" id="lg-matter" value="${c.name||''}"></div>
        <div class="form-group"><label class="form-label">אחוז גבייה (%)</label><input class="form-input" type="number" id="lg-fee-pct" value="${c.feePct||15}"></div>
      </div>
    `;
    openModal('modal-legal-gen');
  } else if(type==='poa') {
    document.getElementById('legal-gen-title').textContent = 'ייפוי כוח – ' + c.name;
    document.getElementById('legal-gen-body').innerHTML = `
      <div class="form-row">
        <div class="form-group"><label class="form-label">שם הממנה</label><input class="form-input" id="poa-grantor-name" value="${cl.name||''}"></div>
        <div class="form-group"><label class="form-label">ת.ז / ח.פ</label><input class="form-input" id="poa-grantor-id" value="${cl.idNum||''}"></div>
      </div>
      <div class="form-group"><label class="form-label">נושא</label>
        <input class="form-input" id="poa-matter" value="${c.debtorName?'גביית חוב מ'+c.debtorName:c.name||''}">
      </div>
    `;
    openModal('modal-legal-gen');
  }
}

async function downloadLegalDoc() {
  const c = db.cases.find(x=>x.id===currentCaseId);
  if(!c) return;
  if(currentLegalDocType==='attorney-fee') {
    const fields = {
      clientName: document.getElementById('lg-client-name').value,
      clientId:   document.getElementById('lg-client-id').value,
      matter:     document.getElementById('lg-matter').value,
      feePct:     document.getElementById('lg-fee-pct').value,
    };
    if (!fields.clientName.trim() && !confirm('שם הלקוח ריק במסמך. ליצור בכל זאת?')) return;
    await buildWithTemplate('atf', fields, c);
  } else if(currentLegalDocType==='poa') {
    const fields = {
      grantorName: document.getElementById('poa-grantor-name').value,
      grantorId:   document.getElementById('poa-grantor-id').value,
      matter:      document.getElementById('poa-matter').value,
    };
    if (!fields.grantorName.trim() && !confirm('שם מייפה הכוח ריק במסמך. ליצור בכל זאת?')) return;
    await buildWithTemplate('poa', fields, c);
  }
}

function formatDateHE(iso) {
  if(!iso) return new Date().toLocaleDateString('he-IL');
  const [y,m,d]=iso.split('-');
  return `${d}.${m}.${y}`;
}

async function fillLegalTemplate(type, data, caseObj) {
  const PizZip = __req('pizzip');
  const Docxtemplater = __req('docxtemplater');
  const isAtf = type === 'atf';
  const templateName = isAtf ? 'טמפלט_הסכם_שכר_טרחה.docx' : 'טמפלט_ייפוי_כוח.docx';
  const res = await Platform.readTemplate(templateName);
  if (res.error) throw new Error(res.error);
  const templateBuf = Buffer.from(res.buffer);

  const now = new Date();
  const DAY_NAMES = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  const MON_NAMES = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const dayName = DAY_NAMES[now.getDay()];
  const monthName = MON_NAMES[now.getMonth()];
  const day = now.getDate();
  const year = now.getFullYear();

  const placeholders = isAtf ? {
    'תאריך': `יום ${dayName} ${day} ${monthName} ${year}`,
    'מספר_תיק': caseObj.caseSubNumber || caseObj.number || '',
    'שם_לקוח': data.clientName || '',
    'תז_לקוח': data.clientId || '',
    'נושא_התיק': data.matter || '',
    'אחוז_גביה': String(data.feePct || '15'),
  } : {
    'שם_מרשה': data.grantorName || '',
    'תז_מרשה': data.grantorId || '',
    'נושא': data.matter || '',
    'תאריך': `יום ${day} לחודש ${monthName}, ${year}`,
  };

  const zip = new PizZip(templateBuf);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, delimiters: { start: '{{', end: '}}' } });
  doc.render(placeholders);
  const outBuf = doc.getZip().generate({ type: 'nodebuffer' });

  const dateStr = now.toLocaleDateString('he-IL');
  const prefix = isAtf ? 'הסכם שכ"ט' : 'ייפוי כח';
  const label = caseObj.caseSubNumber || caseObj.name || '';
  const filename = `${prefix} – ${label} – ${dateStr}.docx`.replace(/[\\/:*?"<>|]/g, '_');
  const filePath = await Platform.saveFile({ buffer: Array.from(outBuf), filename });

  if (!caseObj.legalDocs) caseObj.legalDocs = {};
  if (isAtf) {
    caseObj.legalDocs.atfDraft = true;
    caseObj.legalDocs.atfPath = filePath;
    caseObj.legalDocs.atfDate = dateStr;
  } else {
    caseObj.legalDocs.poaDraft = true;
    caseObj.legalDocs.poaPath = filePath;
    caseObj.legalDocs.poaDate = dateStr;
  }
  saveDB();
  return { filePath, filename };
}

async function buildWithTemplate(type, data, caseObj) {
  notify('מכין מסמך...');
  try {
    const { filePath, filename } = await fillLegalTemplate(type, data, caseObj);
    closeModal('modal-legal-gen');
    notify('המסמך נשמר! פותח...');
    await Platform.openFile(filePath, filename);
    if (currentPanel === 'case-detail') openCaseDetail(currentCaseId);
  } catch(e) {
    notify('שגיאה: ' + e.message);
    console.error(e);
  }
}

// ===== CLIENTS =====
function saveClient() {
  const name=document.getElementById('client-name').value.trim();
  if(!name){notify('נא להזין שם');return;}
  const eid=document.getElementById('client-edit-id').value;
  const existingClient=eid?db.clients.find(c=>c.id===eid):null;
  const colors=[['rgba(37,99,235,0.15)','var(--accent2)'],['rgba(22,163,74,0.15)','var(--success)'],['rgba(217,119,6,0.15)','var(--warning)'],['rgba(220,38,38,0.15)','var(--danger)']];
  const [bg,tc]=colors[(eid?db.clients.findIndex(c=>c.id===eid):db.clients.length)%4];
  const obj={
    id:eid||uid(),
    clientNumber: eid ? (existingClient ? existingClient.clientNumber || '' : '') : getNextClientNumber(),
    name,
    type:document.getElementById('client-type').value,
    phone:document.getElementById('client-phone').value.trim(),
    email:document.getElementById('client-email').value.trim(),
    address:document.getElementById('client-address').value.trim(),
    idNum:document.getElementById('client-idnum').value.trim(),
    contact:document.getElementById('client-contact').value.trim(),
    contactPhone:document.getElementById('client-contact-phone').value.trim(),
    notes:document.getElementById('client-notes').value.trim(),
    color:bg, textColor:tc,
    initials:name.split(' ').map(w=>w[0]).join('').substr(0,2).toUpperCase()
  };
  if(eid){const i=db.clients.findIndex(c=>c.id===eid);if(i>=0)db.clients[i]=obj;}
  else db.clients.push(obj);
  saveDB();
  const wasQuickAdd=quickAddClientForCase;
  closeModal('modal-client'); notify(eid?'לקוח עודכן':'לקוח נוסף! ✓');
  if(wasQuickAdd){
    // closeModal('modal-client') already reopened modal-case — just refresh its
    // client dropdown and land on the client we came here to create.
    populateSelects();
    document.getElementById('case-client').value=obj.id;
  } else if(currentPanel==='client-detail') openClientDetail(obj.id);
  else renderClients();
}

function renderClients(filter='') {
  const grid=document.getElementById('clients-grid');
  const empty=document.getElementById('clients-empty');
  let clients = filter ? db.clients.filter(c=>
    c.name.includes(filter)||(c.idNum||'').includes(filter)||
    (c.clientNumber||'').includes(filter)||(c.phone||'').includes(filter)
  ) : db.clients;
  if(!clients.length){grid.innerHTML='';empty.style.display='block';return;}
  empty.style.display='none';
  grid.innerHTML=clients.map(c=>`<div class="client-card" onclick="openClientDetail('${c.id}')">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <div class="client-avatar" style="background:${c.color};color:${c.textColor};margin-bottom:0">${c.initials}</div>
      <div style="flex:1;min-width:0">
        ${c.clientNumber?`<div style="font-size:10px;color:var(--accent2);font-weight:700;letter-spacing:0.04em">מספר לקוח: ${c.clientNumber}</div>`:''}
        <div style="font-weight:600;color:var(--navy);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.name}</div>
        <div style="font-size:11px;color:var(--text3)">${c.type}${c.idNum?' · '+c.idNum:''}</div>
      </div>
    </div>
    ${c.phone?`<div style="font-size:12px;color:var(--text2);margin-bottom:2px">📞 ${c.phone}</div>`:''}
    ${c.email?`<div style="font-size:12px;color:var(--text2);margin-bottom:2px">✉ ${c.email}</div>`:''}
    ${c.address?`<div style="font-size:11px;color:var(--text3);margin-bottom:4px">📍 ${c.address}</div>`:''}
    ${c.contact?`<div style="font-size:11px;color:var(--text3)">איש קשר: ${c.contact} ${c.contactPhone?'| '+c.contactPhone:''}</div>`:''}
    ${c.notes?`<div style="font-size:11px;color:var(--text3);margin-top:4px;padding-top:4px;border-top:1px solid var(--border)">${c.notes}</div>`:''}
    <div style="display:flex;align-items:center;margin-top:10px;gap:6px">
      <span class="badge badge-active">${db.cases.filter(x=>x.client===c.id&&x.status!=='closed').length} תיקים פעילים</span>
      <button class="btn btn-sm" style="margin-right:auto;font-size:11px" onclick="event.stopPropagation();editClient('${c.id}')">עריכה</button>
      <button class="btn btn-sm btn-danger" style="font-size:11px;padding:3px 8px" onclick="event.stopPropagation();deleteClient('${c.id}')">מחק</button>
    </div>
  </div>`).join('')+`<div class="client-card" style="border:1px dashed var(--border2);display:flex;align-items:center;justify-content:center;min-height:150px;color:var(--text3);cursor:pointer" onclick="openModal('modal-client')"><div style="text-align:center"><div style="font-size:28px">+</div><div style="font-size:13px">לקוח חדש</div></div></div>`;
}

function editClient(id) {
  const c=db.clients.find(x=>x.id===id);
  if(!c) return;
  document.getElementById('client-edit-id').value=c.id;
  document.getElementById('client-modal-title').textContent='עריכת לקוח';
  document.getElementById('client-name').value=c.name;
  document.getElementById('client-type').value=c.type;
  document.getElementById('client-phone').value=c.phone||'';
  document.getElementById('client-email').value=c.email||'';
  document.getElementById('client-address').value=c.address||'';
  document.getElementById('client-idnum').value=c.idNum||'';
  document.getElementById('client-contact').value=c.contact||'';
  document.getElementById('client-contact-phone').value=c.contactPhone||'';
  document.getElementById('client-notes').value=c.notes||'';
  document.getElementById('modal-client').classList.add('open');
}

function deleteClient(id){
  if(!confirm('למחוק לקוח זה?'))return;
  const linked=db.cases.filter(c=>c.client===id);
  if(linked.length){notify('לא ניתן למחוק — ללקוח '+linked.length+' תיקים');return;}
  db.clients=db.clients.filter(c=>c.id!==id);
  saveDB();
  if(currentPanel==='client-detail') nav('clients',document.querySelectorAll('.nav-item')[2]);
  else renderClients();
  notify('לקוח נמחק');
}

function addCaseForClient(id) {
  openModal('modal-case');
  document.getElementById('case-client').value=id;
}

function openClientDetail(id) {
  currentClientId=id;
  const cl=db.clients.find(x=>x.id===id);
  if(!cl) return;
  const clientCases=db.cases.filter(c=>c.client===id);
  const activeCases=clientCases.filter(c=>c.status!=='closed');
  const caseIds=clientCases.map(c=>c.id);
  const allPayments=db.payments.filter(p=>caseIds.includes(p.caseId)).slice().sort((a,b)=>(a.date||'')<(b.date||'')?1:-1);
  const allEvents=db.events.filter(e=>caseIds.includes(e.caseId)).slice().sort((a,b)=>a.date<b.date?1:-1);
  const totalDebt=activeCases.reduce((s,c)=>s+(c.amount||0),0);
  const totalCollected=allPayments.filter(p=>p.type==='debt').reduce((s,p)=>s+p.amount,0);
  const smap={active:'פעיל',urgent:'דחוף',pending:'ממתין',closed:'סגור'};

  document.getElementById('client-detail-body').innerHTML=`
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
      <div class="client-avatar" style="background:${cl.color||'rgba(37,99,235,0.15)'};color:${cl.textColor||'var(--accent2)'};width:56px;height:56px;font-size:18px;margin-bottom:0">
        ${cl.initials||cl.name.substring(0,2).toUpperCase()}
      </div>
      <div>
        <h2 style="font-size:20px;font-weight:700;color:var(--navy);margin-bottom:3px">${cl.name}</h2>
        <div style="font-size:12px;color:var(--text3)">
          ${cl.clientNumber?`<span style="color:var(--accent2);font-weight:700">מספר לקוח: ${cl.clientNumber}</span> · `:''}${cl.type}${cl.idNum?' · ת.ז/ח.פ: '+cl.idNum:''}
        </div>
      </div>
    </div>

    <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
      <div class="stat"><div class="stat-label">תיקים פעילים</div><div class="stat-value">${activeCases.length}</div><div class="stat-sub">${clientCases.length} סה"כ</div></div>
      <div class="stat"><div class="stat-label">חוב בטיפול</div><div class="stat-value" style="color:var(--accent2);font-size:20px">₪${totalDebt.toLocaleString()}</div></div>
      <div class="stat"><div class="stat-label">גבוי סה"כ</div><div class="stat-value" style="color:var(--success);font-size:20px">₪${totalCollected.toLocaleString()}</div></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-title">פרטי קשר</div>
      <div class="two-col">
        <div>
          ${cl.phone?`<div style="font-size:13px;color:var(--text2);margin-bottom:6px">📞 ${cl.phone}</div>`:''}
          ${cl.email?`<div style="font-size:13px;color:var(--text2);margin-bottom:6px">✉ ${cl.email}</div>`:''}
          ${cl.address?`<div style="font-size:13px;color:var(--text2);margin-bottom:6px">📍 ${cl.address}</div>`:''}
        </div>
        <div>
          ${cl.contact?`<div style="font-size:13px;color:var(--text2);margin-bottom:6px">איש קשר: ${cl.contact}</div>`:''}
          ${cl.contactPhone?`<div style="font-size:13px;color:var(--text2);margin-bottom:6px">📞 ${cl.contactPhone}</div>`:''}
        </div>
      </div>
      ${cl.notes?`<div style="font-size:13px;color:var(--text2);margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">${cl.notes}</div>`:''}
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-title">תיקים (${clientCases.length})</div>
      ${clientCases.length?`<table class="data-table"><thead><tr><th>שם תיק</th><th>סכום חוב</th><th>שלב</th><th>סטטוס</th></tr></thead><tbody>
        ${clientCases.map(c=>`<tr onclick="openCaseDetail('${c.id}')">
          <td>
            <div style="display:flex;align-items:center;gap:6px">
              ${c.caseSubNumber?`<span style="font-size:10px;color:var(--accent2);font-weight:700;flex-shrink:0">${c.caseSubNumber}</span>`:''}
              <b style="color:var(--navy)">${c.name}</b>
            </div>
            ${c.number?`<span style="font-size:11px;color:var(--text3)">#${c.number}</span>`:''}
          </td>
          <td style="color:var(--accent2);font-weight:600">${c.amount?'₪'+c.amount.toLocaleString():'—'}</td>
          <td style="font-size:12px;color:var(--text2)">${c.stage}</td>
          <td><span class="badge badge-${c.status}">${smap[c.status]||c.status}</span></td>
        </tr>`).join('')}
      </tbody></table>`:'<div class="empty" style="padding:16px">אין תיקים ללקוח זה</div>'}
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-title">תשלומים (${allPayments.length})</div>
      ${allPayments.length?allPayments.map(p=>{
        const pc=db.cases.find(c=>c.id===p.caseId);
        return `<div class="fin-row">
          <div>
            <div style="font-weight:500;color:var(--navy)">₪${p.amount.toLocaleString()}</div>
            <div style="font-size:11px;color:var(--text3)">${p.type==='debt'?'גבייה':p.type==='retainer'?'מקדמה':'הוצאה'} | ${p.method||''}</div>
            ${pc?`<div style="font-size:11px;color:var(--accent2)">${pc.name}</div>`:''}
          </div>
          <div style="text-align:left">
            <div style="font-size:12px;color:var(--text2)">${p.date||''}</div>
            ${p.note?`<div style="font-size:11px;color:var(--text3)">${p.note}</div>`:''}
          </div>
        </div>`;
      }).join('')+'<div class="fin-row" style="margin-top:8px"><b style="color:var(--text2)">סה"כ גבוי</b><b style="color:var(--success)">₪'+totalCollected.toLocaleString()+'</b></div>':'<div class="empty" style="padding:16px">אין תשלומים</div>'}
    </div>

    <div class="card">
      <div class="card-title">דיונים ואירועים (${allEvents.length})</div>
      ${allEvents.length?allEvents.map(e=>{
        const ec=db.cases.find(c=>c.id===e.caseId);
        return `<div class="task-item">
          <div style="width:38px;height:38px;border-radius:8px;background:var(--accent-dim);display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0">
            <div style="font-size:13px;font-weight:700;color:var(--accent2)">${(e.date||'').split('-')[2]||''}</div>
            <div style="font-size:9px;color:var(--text3)">${monthHE((e.date||'').split('-')[1])}</div>
          </div>
          <div style="flex:1">
            <div style="font-weight:500;color:var(--navy)">${e.title}</div>
            <div style="font-size:11px;color:var(--text3)">${e.type||''} ${e.location?'| '+e.location:''} ${e.time?'| '+e.time:''}</div>
            ${ec?`<div style="font-size:11px;color:var(--accent2);cursor:pointer" onclick="openCaseDetail('${ec.id}')">${ec.name}</div>`:''}
          </div>
        </div>`;
      }).join(''):'<div class="empty" style="padding:16px">אין אירועים</div>'}
    </div>
  `;
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('panel-client-detail').classList.add('active');
  document.querySelectorAll('.nav-item')[2].classList.add('active');
  currentPanel='client-detail';
}

// ===== TASKS =====
function saveTask(){
  const text=document.getElementById('task-text').value.trim();
  if(!text){notify('נא להזין תיאור');return;}
  db.tasks.unshift({id:uid(),text,due:document.getElementById('task-due').value,caseId:document.getElementById('task-case').value,priority:document.getElementById('task-priority').value,notes:document.getElementById('task-notes').value.trim(),done:false});
  saveDB();closeModal('modal-task');notify('משימה נוספה! ✓');renderTasks();
}

function toggleTask(id,inDetail=false){
  const t=db.tasks.find(x=>x.id===id);
  if(t){t.done=!t.done;saveDB();}
  if(inDetail) openCaseDetail(currentCaseId);
  else renderTasks();
  if(currentPanel==='dashboard') renderDashboard();
}

// Every "task-cb" checkbox is a styled <div>, not a real <input type=checkbox> (the
// custom checkmark/coloring is easier this way) — role/aria-checked/tabindex make it
// identify as a checkbox to a screen reader, and the delegated keydown listener
// below (added once, near the other document-level listeners) gives it Enter/Space
// keyboard activation, since a plain div with onclick otherwise only responds to a
// mouse/touch click.
function taskCbHtml(t, inDetail){
  return `<div class="task-cb ${t.done?'done':''}" role="checkbox" aria-checked="${!!t.done}" tabindex="0" onclick="toggleTask('${t.id}'${inDetail?',true':''})">${t.done?'✓':''}</div>`;
}

function renderTasks(){
  const filterCase=document.getElementById('tasks-filter')?document.getElementById('tasks-filter').value:'';
  let allTasks=filterCase?db.tasks.filter(t=>t.caseId===filterCase):db.tasks;
  const open=allTasks.filter(t=>!t.done).sort((a,b)=>{
    const prio={urgent:0,normal:1,low:2};
    if(prio[a.priority]!==prio[b.priority]) return prio[a.priority]-prio[b.priority];
    return (a.due||'9999')>(b.due||'9999')?1:-1;
  });
  const done=allTasks.filter(t=>t.done).slice(0,20);
  const today=localDateISO(new Date());
  document.getElementById('tasks-open-count').textContent=`(${open.length})`;
  const row=t=>{
    const c=t.caseId?db.cases.find(x=>x.id===t.caseId):null;
    const ov=t.due&&t.due<today&&!t.done;
    return `<div class="task-item">
      ${taskCbHtml(t)}
      <div class="prio-dot prio-${t.priority||'normal'}"></div>
      <div style="flex:1">
        <div class="task-text ${t.done?'done':''}">${t.text}</div>
        ${c?`<div style="font-size:11px;color:var(--text3)">${c.name}</div>`:''}
        ${t.notes&&!t.done?`<div style="font-size:11px;color:var(--text3)">${t.notes}</div>`:''}
      </div>
      ${t.due?`<div class="task-meta ${(ov||t.priority==='urgent')&&!t.done?'urgent':''}">${t.due}</div>`:''}
      <button class="btn btn-sm" style="color:var(--danger);border:none;padding:2px 6px;font-size:12px" onclick="delTask('${t.id}')">✕</button>
    </div>`;
  };
  document.getElementById('tasks-open').innerHTML=open.length?open.map(row).join(''):'<div class="empty" style="padding:16px">ריק ✓</div>';
  document.getElementById('tasks-done').innerHTML=done.length?done.map(row).join(''):'<div class="empty" style="padding:16px">ריק</div>';
}

function delTask(id,inDetail=false){db.tasks=db.tasks.filter(t=>t.id!==id);saveDB();if(inDetail)openCaseDetail(currentCaseId);else renderTasks();}

// ===== CALENDAR =====
let calDate=new Date();
const HE_MONTHS=['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

function renderCalendar(){
  const y=calDate.getFullYear(),m=calDate.getMonth();
  document.getElementById('cal-title').textContent=`יומן – ${HE_MONTHS[m]} ${y}`;
  const first=new Date(y,m,1).getDay(),days=new Date(y,m+1,0).getDate();
  const today=new Date();
  const evtDays=new Set(db.events.filter(e=>{if(!e.date)return false;const p=e.date.split('-');return +p[0]===y&&+p[1]-1===m;}).map(e=>+e.date.split('-')[2]));
  let h=['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳'].map(d=>`<div class="cal-day-name">${d}</div>`).join('');
  for(let i=0;i<first;i++) h+=`<div class="cal-cell"></div>`;
  for(let d=1;d<=days;d++){
    const isT=d===today.getDate()&&m===today.getMonth()&&y===today.getFullYear();
    const dd=String(d).padStart(2,'0'), mm=String(m+1).padStart(2,'0');
    h+=`<div class="cal-cell ${isT?'today':''} ${evtDays.has(d)?'has-event':''}" onclick="calDayClick('${y}-${mm}-${dd}')">${d}</div>`;
  }
  document.getElementById('cal-grid').innerHTML=h;

  const yStr=String(y),mStr=String(m+1).padStart(2,'0');
  const monthEvts=db.events.filter(e=>(e.date||'').startsWith(yStr+'-'+mStr)).sort((a,b)=>a.date>b.date?1:-1);
  document.getElementById('events-month').innerHTML=monthEvts.length?monthEvts.map(eventRow).join(''):'<div class="empty" style="padding:12px">אין אירועים החודש</div>';

  const now=localDateISO(new Date());
  const up=db.events.filter(e=>e.date>=now).sort((a,b)=>a.date>b.date?1:-1).slice(0,5);
  document.getElementById('events-list').innerHTML=up.length?up.map(eventRow).join(''):'<div class="empty">אין אירועים קרובים</div>';
}

function eventRow(e) {
  const c=e.caseId?db.cases.find(x=>x.id===e.caseId):null;
  return `<div class="task-item">
    <div style="width:38px;height:38px;border-radius:8px;background:var(--accent-dim);display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0">
      <div style="font-size:13px;font-weight:700;color:var(--accent2)">${(e.date||'').split('-')[2]||''}</div>
      <div style="font-size:9px;color:var(--text3)">${monthHE((e.date||'').split('-')[1])}</div>
    </div>
    <div style="flex:1">
      <div style="font-weight:500;color:var(--navy)">${e.title}</div>
      <div style="font-size:11px;color:var(--text3)">${e.type||''} ${e.location?'| '+e.location:''} ${e.time?'| '+e.time:''}</div>
      ${c?`<div style="font-size:11px;color:var(--accent2);cursor:pointer" onclick="openCaseDetail('${c.id}')">${c.name}</div>`:''}
    </div>
    <button class="btn btn-sm" style="color:var(--danger);border:none;padding:2px 6px" onclick="delEvent('${e.id}')">✕</button>
  </div>`;
}

function calDayClick(dateStr) {
  openModal('modal-event');
  document.getElementById('event-date').value=dateStr;
}

function calMove(d){
  // Don't use calDate.setMonth() directly — it preserves the current day-of-month,
  // so e.g. moving back a month from the 31st lands on a nonexistent day and JS
  // silently rolls forward into the following month instead. Pin to the 1st first.
  calDate=new Date(calDate.getFullYear(),calDate.getMonth()+d,1);
  renderCalendar();
}
function calToday(){calDate=new Date();renderCalendar();}

function saveEvent(){
  const title=document.getElementById('event-title').value.trim();
  const date=document.getElementById('event-date').value;
  if(!title||!date){notify('נא למלא כותרת ותאריך');return;}
  db.events.push({id:uid(),title,date,time:document.getElementById('event-time').value,location:document.getElementById('event-location').value.trim(),type:document.getElementById('event-type').value,caseId:document.getElementById('event-case').value,notes:document.getElementById('event-notes').value.trim()});
  saveDB();closeModal('modal-event');notify('אירוע נוסף! ✓');renderCalendar();
}

function delEvent(id,inDetail=false){db.events=db.events.filter(e=>e.id!==id);saveDB();if(inDetail)openCaseDetail(currentCaseId);else renderCalendar();}

// ===== FINANCE =====
function savePayment(){
  const amount=parseFloat(document.getElementById('pay-amount').value);
  if(!amount||amount<=0){notify('נא להזין סכום');return;}
  const eid=document.getElementById('pay-edit-id').value;
  const caseId=document.getElementById('pay-case').value;
  const payData={caseId,amount,date:document.getElementById('pay-date').value,method:document.getElementById('pay-method').value,type:document.getElementById('pay-type').value,note:document.getElementById('pay-note').value.trim()};
  if(eid) {
    const i=db.payments.findIndex(p=>p.id===eid);
    if(i>=0) {
      const old=db.payments[i];
      if(old.caseId&&old.type==='debt'){const oc=db.cases.find(x=>x.id===old.caseId);if(oc)oc.collected=Math.max(0,(oc.collected||0)-old.amount);}
      db.payments[i]={...db.payments[i],...payData};
    }
  } else {
    db.payments.push({id:uid(),...payData});
  }
  if(caseId&&payData.type==='debt'){const c=db.cases.find(x=>x.id===caseId);if(c)c.collected=(c.collected||0)+amount;}
  saveDB();closeModal('modal-payment');notify(eid?'תשלום עודכן! ✓':'תשלום נרשם! ✓');
  if(currentPanel==='case-detail') openCaseDetail(currentCaseId); else renderFinance();
}

function editPayment(id){
  const p=db.payments.find(x=>x.id===id);if(!p)return;
  populateSelects();
  document.getElementById('pay-edit-id').value=p.id;
  document.getElementById('pay-modal-title').textContent='עריכת תשלום';
  document.getElementById('pay-case').value=p.caseId||'';
  document.getElementById('pay-amount').value=p.amount;
  document.getElementById('pay-date').value=p.date||'';
  document.getElementById('pay-method').value=p.method||'העברה בנקאית';
  document.getElementById('pay-type').value=p.type||'debt';
  document.getElementById('pay-note').value=p.note||'';
  document.getElementById('modal-payment').classList.add('open');
}

function delPayment(id){
  const p=db.payments.find(x=>x.id===id);
  if(p&&p.caseId&&p.type==='debt'){const c=db.cases.find(x=>x.id===p.caseId);if(c)c.collected=Math.max(0,(c.collected||0)-p.amount);}
  db.payments=db.payments.filter(x=>x.id!==id);
  saveDB();notify('תשלום נמחק');
  if(currentPanel==='case-detail') openCaseDetail(currentCaseId); else renderFinance();
}

function renderFinance(){
  const totalDebt=db.cases.filter(c=>c.status!=='closed').reduce((s,c)=>s+(c.amount||0),0);
  const totalCollected=db.payments.filter(p=>p.type==='debt').reduce((s,p)=>s+p.amount,0);
  const expectedFees=db.cases.filter(c=>c.status!=='closed').reduce((s,c)=>s+calcExpectedFee(c),0);
  const collectedFees=db.cases.reduce((s,c)=>s+calcCollectedFee(c),0);
  document.getElementById('fin-total-debt').textContent='₪'+totalDebt.toLocaleString();
  document.getElementById('fin-total-collected').textContent='₪'+totalCollected.toLocaleString();
  document.getElementById('fin-expected-fee').textContent='₪'+expectedFees.toLocaleString();
  document.getElementById('fin-collected-fee').textContent='₪'+collectedFees.toLocaleString();

  // ── Monthly chart (last 6 months) ──
  const heM=['ינו','פבר','מרץ','אפר','מאי','יונ','יול','אוג','ספט','אוק','נוב','דצמ'];
  const now=new Date();
  const months=[];
  for(let i=5;i>=0;i--){
    const d=new Date(now.getFullYear(),now.getMonth()-i,1);
    months.push({key:localMonthKey(d),label:heM[d.getMonth()]});
  }
  const monthData=months.map(({key,label})=>{
    const collected=db.payments.filter(p=>p.type==='debt'&&(p.date||'').startsWith(key)).reduce((s,p)=>s+p.amount,0);
    const monthEnd=key+'-31';
    const debtByMonth=db.cases.filter(c=>heToISO(c.opened||'')<=monthEnd).reduce((s,c)=>s+(c.amount||0),0);
    const collectedToDate=db.payments.filter(p=>p.type==='debt'&&(p.date||'')<=monthEnd).reduce((s,p)=>s+p.amount,0);
    const outstanding=Math.max(0,debtByMonth-collectedToDate);
    return {key,label,collected,outstanding};
  });
  const maxVal=Math.max(...monthData.map(d=>Math.max(d.collected,d.outstanding)),1);
  const BAR_H=100;
  document.getElementById('fin-chart').innerHTML=`
    <div style="display:flex;align-items:flex-end;gap:8px;height:${BAR_H}px;border-bottom:1px solid var(--border);margin-bottom:0">
      ${monthData.map(d=>{
        const ch=Math.max(2,Math.round((d.collected/maxVal)*BAR_H));
        const oh=Math.max(2,Math.round((d.outstanding/maxVal)*BAR_H));
        return `<div style="flex:1;display:flex;align-items:flex-end;gap:2px;height:100%">
          <div class="has-tooltip" data-tip="גבוי: ₪${d.collected.toLocaleString()}" style="flex:1;height:${ch}px;background:var(--success);border-radius:3px 3px 0 0;opacity:0.85;position:relative;cursor:default"></div>
          <div class="has-tooltip" data-tip="יתרת חוב: ₪${d.outstanding.toLocaleString()}" style="flex:1;height:${oh}px;background:rgba(220,38,38,0.45);border-radius:3px 3px 0 0;position:relative;cursor:default"></div>
        </div>`;
      }).join('')}
    </div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      ${monthData.map(d=>`<div style="flex:1;text-align:center;font-size:10px;color:var(--text3);padding-top:5px">${d.label}</div>`).join('')}
    </div>
    <div style="display:flex;gap:16px;font-size:11px;color:var(--text3)">
      <span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:2px;background:var(--success);display:inline-block"></span>גבוי</span>
      <span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:2px;background:rgba(220,38,38,0.45);display:inline-block"></span>יתרת חוב</span>
    </div>`;

  // ── Cases financial list ──
  document.getElementById('fin-cases-list').innerHTML=db.cases.filter(c=>c.status!=='closed').map(c=>{
    const cPay=db.payments.filter(p=>p.caseId===c.id&&p.type==='debt').reduce((s,p)=>s+p.amount,0);
    const pct=c.amount?Math.round(cPay/c.amount*100):0;
    return `<div class="fin-row" onclick="openCaseDetail('${c.id}')" style="cursor:pointer">
      <div><div style="font-weight:500;color:var(--navy);font-size:13px">${c.name}</div>
        <div style="font-size:11px;color:var(--text3)">חוב: ₪${(c.amount||0).toLocaleString()} | שכ"ט: ${c.feeType==='percent'?(c.feePct||15)+'%':'₪'+(c.feeFixed||0).toLocaleString()}</div>
        <div class="progress-wrap" style="margin-top:4px;width:120px"><div class="progress-fill" style="width:${Math.min(pct,100)}%"></div></div>
      </div>
      <div style="text-align:left">
        <div style="color:var(--success);font-weight:600">₪${cPay.toLocaleString()}</div>
        <div style="font-size:11px;color:var(--text3)">${pct}% גבוי</div>
      </div>
    </div>`;
  }).join('')||'<div class="empty">אין תיקים פעילים</div>';

  // ── Recent payments ──
  document.getElementById('fin-payments-list').innerHTML=db.payments.slice(-10).reverse().map(p=>{
    const c=p.caseId?db.cases.find(x=>x.id===p.caseId):null;
    const typeMap={debt:'גבייה',retainer:'מקדמה',expense:'הוצאה'};
    return `<div class="fin-row">
      <div><div style="font-weight:600;color:${p.type==='expense'?'var(--danger)':'var(--success)'}">₪${p.amount.toLocaleString()}</div>
        <div style="font-size:11px;color:var(--text3)">${typeMap[p.type]||p.type} | ${p.method||''}</div>
        ${c?`<div style="font-size:11px;color:var(--text3)">${c.name}</div>`:''}
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <div style="text-align:left"><div style="font-size:12px;color:var(--text2)">${p.date||''}</div><div style="font-size:11px;color:var(--text3)">${p.note||''}</div></div>
        <button class="btn btn-sm" onclick="editPayment('${p.id}')">✏</button>
        <button class="btn btn-sm" style="color:var(--danger);border:none;padding:2px 6px" onclick="delPayment('${p.id}')">✕</button>
      </div>
    </div>`;
  }).join('')||'<div class="empty">אין תשלומים</div>';

  // ── Fee report per case ──
  const feeRows=db.cases.map(c=>{
    const cPay=db.payments.filter(p=>p.caseId===c.id&&p.type==='debt').reduce((s,p)=>s+p.amount,0);
    const expFee=Math.round(calcExpectedFee(c));
    const actFee=Math.round(calcCollectedFee(c));
    const delta=actFee-expFee;
    const smap={active:'פעיל',urgent:'דחוף',pending:'ממתין',closed:'סגור'};
    return `<div class="fin-row" onclick="openCaseDetail('${c.id}')" style="cursor:pointer">
      <div style="flex:2;min-width:0">
        <div style="font-weight:500;color:var(--navy);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.name}</div>
        <div style="font-size:11px;color:var(--text3)">${smap[c.status]||c.status} | ${c.feeType==='percent'?(c.feePct||15)+'% מגבייה':'₪'+(c.feeFixed||0).toLocaleString()+' קבוע'}</div>
      </div>
      <div style="flex:1;text-align:left">
        <div style="font-size:10px;color:var(--text3)">שכ"ט צפוי</div>
        <div style="color:var(--warning);font-weight:600;font-size:13px">₪${expFee.toLocaleString()}</div>
      </div>
      <div style="flex:1;text-align:left">
        <div style="font-size:10px;color:var(--text3)">שכ"ט גבוי</div>
        <div style="color:var(--success);font-weight:600;font-size:13px">₪${actFee.toLocaleString()}</div>
      </div>
      <div style="flex:1;text-align:left">
        <div style="font-size:10px;color:var(--text3)">הפרש</div>
        <div style="color:${delta>=0?'var(--success)':'var(--danger)'};font-weight:600;font-size:13px">${delta>=0?'+':''}₪${delta.toLocaleString()}</div>
      </div>
    </div>`;
  });
  document.getElementById('fin-fee-report').innerHTML=feeRows.join('')||'<div class="empty">אין תיקים</div>';
}

function exportFinanceSummary(){
  const totalDebt=db.cases.filter(c=>c.status!=='closed').reduce((s,c)=>s+(c.amount||0),0);
  const totalCollected=db.payments.filter(p=>p.type==='debt').reduce((s,p)=>s+p.amount,0);
  const totalRetainer=db.payments.filter(p=>p.type==='retainer').reduce((s,p)=>s+p.amount,0);
  const totalExpenses=db.payments.filter(p=>p.type==='expense').reduce((s,p)=>s+p.amount,0);
  const heML=['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const now=new Date();
  let txt=`דוח כספי – ${now.toLocaleDateString('he-IL')}\n${'='.repeat(40)}\n\n`;
  txt+=`סיכום כללי:\n`;
  txt+=`  סה"כ חוב בטיפול:  ₪${totalDebt.toLocaleString()}\n`;
  txt+=`  סה"כ גבוי:         ₪${totalCollected.toLocaleString()}\n`;
  txt+=`  מקדמות:            ₪${totalRetainer.toLocaleString()}\n`;
  txt+=`  הוצאות:            ₪${totalExpenses.toLocaleString()}\n\n`;
  txt+=`גבייה חודשית (6 חודשים אחרונים):\n`;
  for(let i=5;i>=0;i--){
    const d=new Date(now.getFullYear(),now.getMonth()-i,1);
    const key=localMonthKey(d);
    const mc=db.payments.filter(p=>p.type==='debt'&&(p.date||'').startsWith(key)).reduce((s,p)=>s+p.amount,0);
    txt+=`  ${heML[d.getMonth()]} ${d.getFullYear()}: ₪${mc.toLocaleString()}\n`;
  }
  txt+=`\nדוח שכר טרחה לפי תיק:\n${'─'.repeat(40)}\n`;
  db.cases.forEach(c=>{
    const cPay=db.payments.filter(p=>p.caseId===c.id&&p.type==='debt').reduce((s,p)=>s+p.amount,0);
    const expFee=Math.round(calcExpectedFee(c));
    const actFee=Math.round(calcCollectedFee(c));
    const smap={active:'פעיל',urgent:'דחוף',pending:'ממתין',closed:'סגור'};
    txt+=`\n  ${c.name} [${smap[c.status]||c.status}]\n`;
    txt+=`    חוב: ₪${(c.amount||0).toLocaleString()} | גבוי: ₪${cPay.toLocaleString()}\n`;
    txt+=`    שכ"ט צפוי: ₪${expFee.toLocaleString()} | שכ"ט גבוי: ₪${actFee.toLocaleString()}\n`;
  });
  const ta=document.createElement('textarea');
  ta.value=txt;
  ta.style.position='fixed';ta.style.opacity='0';
  document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy');notify('הדוח הועתק ✓');}catch(e){notify('שגיאה בהעתקה');}
  document.body.removeChild(ta);
}

// ===== DOCS =====
async function pickFile(){
  const result=await Platform.pickFile();
  if(!result) return;
  selectedFile=result;
  document.getElementById('file-info').style.display='block';
  document.getElementById('file-info').textContent='✓ '+result.filename;
  if(!document.getElementById('doc-name').value) document.getElementById('doc-name').value=result.filename.replace(/\.[^.]+$/,'');
}

function getExt(name){const e=(name||'').split('.').pop().toLowerCase();if(e==='pdf')return 'pdf';if(['doc','docx'].includes(e))return 'doc';if(['xls','xlsx','csv'].includes(e))return 'xls';return 'img';}

async function saveDoc(){
  const name=document.getElementById('doc-name').value.trim();
  if(!name){notify('נא להזין שם מסמך');return;}
  let filePath=null;
  if(selectedFile) filePath=await Platform.saveFile({buffer:selectedFile.buffer,filename:selectedFile.filename});
  db.docs.unshift({id:uid(),name,cat:document.getElementById('doc-cat').value,caseId:document.getElementById('doc-case').value,notes:document.getElementById('doc-notes').value.trim(),date:new Date().toLocaleDateString('he-IL'),ext:selectedFile?getExt(selectedFile.filename):'doc',filePath,origName:selectedFile?selectedFile.filename:null});
  saveDB();closeModal('modal-doc');notify('מסמך נשמר! ✓');renderDocs();selectedFile=null;
}

async function openFile(p,displayName){await Platform.openFile(p,displayName);}

function renderDocs(filter=''){
  const list=document.getElementById('docs-list');
  const empty=document.getElementById('docs-empty');
  let docs=filter?db.docs.filter(d=>d.name.includes(filter)||(d.cat||'').includes(filter)||(d.notes||'').includes(filter)):db.docs;
  if(!docs.length){list.innerHTML='';empty.style.display='block';return;}
  empty.style.display='none';
  const cats=[...new Set(docs.map(d=>d.cat))];
  list.innerHTML=cats.map(cat=>`<div class="card">
    <div class="card-title">${cat}</div>
    ${docs.filter(d=>d.cat===cat).map(d=>`<div class="doc-item">
      <div class="doc-icon ${d.ext}">${d.ext.toUpperCase()}</div>
      <div style="flex:1"><div style="font-size:13px;font-weight:500;color:var(--navy)">${d.name}</div><div style="font-size:11px;color:var(--text3)">${d.date||''} ${d.notes?'· '+d.notes:''}</div></div>
      ${d.filePath?`<button class="btn btn-sm" onclick="openFile('${d.filePath.replace(/\\/g,'/')}','${(d.origName||d.name||'').replace(/\\/g,'')}')">פתח</button>`:''}
      <button class="btn btn-sm" style="color:var(--danger);border:none;padding:2px 6px" onclick="delDoc('${d.id}')">✕</button>
    </div>`).join('')}
  </div>`).join('');
}
function delDoc(id,inDetail=false){db.docs=db.docs.filter(d=>d.id!==id);saveDB();if(inDetail)openCaseDetail(currentCaseId);else renderDocs();}

// ===== DASHBOARD =====
function renderDashboard(){
  const active=db.cases.filter(c=>c.status!=='closed').length;
  const urgent=db.cases.filter(c=>c.status==='urgent').length;
  const debt=db.cases.filter(c=>c.status!=='closed').reduce((s,c)=>s+(c.amount||0),0);
  const thisMonth=localMonthKey(new Date());
  const collected=db.payments.filter(p=>p.type==='debt'&&(p.date||'').startsWith(thisMonth)).reduce((s,p)=>s+p.amount,0);
  const openT=db.tasks.filter(t=>!t.done).length;
  const today=localDateISO(new Date());
  const overdue=db.tasks.filter(t=>!t.done&&t.due&&t.due<today).length;

  const _now=new Date();const _curM=String(_now.getMonth()+1).padStart(2,'0');const _curY=String(_now.getFullYear());
  const monthHours=(db.timeEntries||[]).filter(t=>{const p=(t.date||'').split('.');return p.length===3&&p[1]===_curM&&p[2]===_curY;}).reduce((s,t)=>s+(t.duration||0),0);
  const mh=Math.floor(monthHours/3600),mm2=Math.floor((monthHours%3600)/60);
  document.getElementById('s-active').textContent=active;
  document.getElementById('s-urgent-txt').textContent=urgent?`${urgent} דחופים`:'';
  document.getElementById('s-hours').textContent=`${mh}:${String(mm2).padStart(2,'0')}`;
  document.getElementById('s-hours-txt').textContent=`${db.timeEntries?db.timeEntries.length:0} רשומות`;
  document.getElementById('s-debt').textContent='₪'+debt.toLocaleString();
  document.getElementById('s-collected').textContent='₪'+collected.toLocaleString();
  document.getElementById('s-tasks').textContent=openT;
  document.getElementById('s-overdue-txt').textContent=overdue?`${overdue} באיחור`:'';

  const stages=['איסוף מסמכים','התראה ראשונה','גישור','כתב תביעה','דיון','הוצאה לפועל','סגור'];
  const stageCounts=stages.reduce((o,s)=>{o[s]=db.cases.filter(c=>c.stage===s).length;return o;},{});
  document.getElementById('d-stages').innerHTML=stages.map(s=>`<div class="fin-row">
    <div style="font-size:13px;color:var(--text2)">${s}</div>
    <div style="display:flex;align-items:center;gap:8px">
      <div style="width:80px;height:4px;background:var(--bg4);border-radius:2px">
        <div style="width:${stageCounts[s]?Math.min(100,stageCounts[s]/Math.max(1,db.cases.length)*100*3):0}%;height:4px;background:var(--accent);border-radius:2px"></div>
      </div>
      <span style="font-size:13px;font-weight:600;color:var(--navy);min-width:16px">${stageCounts[s]}</span>
    </div>
  </div>`).join('');

  const urgentTasks=db.tasks.filter(t=>!t.done&&(t.priority==='urgent'||(t.due&&t.due<=today))).slice(0,5);
  document.getElementById('d-tasks').innerHTML=urgentTasks.length?urgentTasks.map(t=>`<div class="task-item">
    ${taskCbHtml(t)}
    <div class="prio-dot prio-${t.priority||'normal'}"></div>
    <div class="task-text" style="flex:1;font-size:13px">${t.text}</div>
    <div class="task-meta ${t.due&&t.due<today?'urgent':''}">${t.due||''}</div>
  </div>`).join(''):'<div class="empty">אין משימות דחופות ✓</div>';

  const smap={active:'פעיל',urgent:'דחוף',pending:'ממתין',closed:'סגור'};
  document.getElementById('d-cases').innerHTML=db.cases.slice(0,5).map(c=>`<div class="task-item" style="cursor:pointer" onclick="openCaseDetail('${c.id}')">
    <div style="flex:1"><div style="font-weight:500;color:var(--navy);font-size:13px">${c.name}</div>
      <div style="font-size:11px;color:var(--text3)">${c.debtorName||''} ${c.amount?'| ₪'+c.amount.toLocaleString():''}</div>
    </div>
    <span class="badge badge-${c.status}">${smap[c.status]}</span>
  </div>`).join('')||'<div class="empty">אין תיקים</div>';

  const upEvts=db.events.filter(e=>e.date>=today).sort((a,b)=>a.date>b.date?1:-1).slice(0,3);
  document.getElementById('d-events').innerHTML=upEvts.length?upEvts.map(eventRow).join(''):'<div class="empty">אין אירועים קרובים</div>';
}

// ===== TABS =====
function switchTab(el,id){
  el.closest('.card').querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  ['ct-tasks','ct-docs','ct-events','ct-diary','ct-payments','ct-time'].forEach(t=>{const e=document.getElementById(t);if(e)e.style.display='none';});
  const t=document.getElementById(id);if(t)t.style.display='block';
}

// ===== NOTIFY =====
function notify(msg){const n=document.getElementById('notif');n.textContent=msg;n.style.display='block';clearTimeout(n._t);n._t=setTimeout(()=>n.style.display='none',2800);}

// ===== TIME TRACKING =====
let timerRunning=false, timerSeconds=0, timerInterval=null, pendingTimerSecs=0, timerCaseId=null;

function formatDuration(s){
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function updateTimerDisplay(){
  const btn=document.getElementById('case-timer-btn');
  if(btn){
    if(timerRunning && timerCaseId===currentCaseId){
      btn.textContent='⏹ עצור · '+formatDuration(timerSeconds);
      btn.className='btn btn-danger btn-sm';
    } else if(timerRunning){
      btn.textContent='▶ טיימר פועל לתיק אחר';
      btn.className='btn btn-sm';
    } else {
      btn.textContent='▶ הפעל טיימר';
      btn.className='btn btn-success btn-sm';
    }
  }
}

// Timer only exists inside a case's detail screen (#case-timer-btn) — there is no
// app-wide floating clock anymore, per the product decision to keep it scoped to
// the case you're actually working on.
function toggleCaseTimer(caseId){
  if(!timerRunning){
    timerCaseId=caseId;
    timerRunning=true;
    timerInterval=setInterval(()=>{timerSeconds++;updateTimerDisplay();},1000);
    updateTimerDisplay();
  } else if(timerCaseId===caseId){
    clearInterval(timerInterval);timerInterval=null;
    timerRunning=false;
    pendingTimerSecs=timerSeconds;
    timerSeconds=0;
    timerCaseId=null;
    updateTimerDisplay();
    populateSelects();
    document.getElementById('tl-desc').value='';
    document.getElementById('tl-case').value=caseId;
    document.getElementById('tl-duration-label').textContent='זמן שנרשם: '+formatDuration(pendingTimerSecs);
    document.getElementById('modal-timelog').classList.add('open');
  } else {
    notify('טיימר פועל עבור תיק אחר. עצור אותו קודם.');
  }
}

function saveTimeEntry(){
  if(!db.timeEntries) db.timeEntries=[];
  db.timeEntries.unshift({id:uid(),caseId:document.getElementById('tl-case').value,duration:pendingTimerSecs,description:document.getElementById('tl-desc').value.trim(),date:new Date().toLocaleDateString('he-IL')});
  pendingTimerSecs=0;
  timerCaseId=null;
  saveDB();
  document.getElementById('modal-timelog').classList.remove('open');
  notify('שעות נשמרו ✓');
  if(currentPanel==='case-detail') openCaseDetail(currentCaseId);
  if(currentPanel==='dashboard') renderDashboard();
}

function discardTimeEntry(){
  pendingTimerSecs=0;
  timerCaseId=null;
  document.getElementById('modal-timelog').classList.remove('open');
  notify('שעות בוטלו');
}

function openManualTime(caseId){
  document.getElementById('mt-case-id').value=caseId;
  document.getElementById('mt-hours').value='';
  document.getElementById('mt-minutes').value='';
  document.getElementById('mt-date').value=localDateISO(new Date());
  document.getElementById('mt-desc').value='';
  document.getElementById('modal-manual-time').classList.add('open');
}

function closeManualTime(){
  document.getElementById('modal-manual-time').classList.remove('open');
}

function saveManualTime(){
  const caseId=document.getElementById('mt-case-id').value;
  const h=parseInt(document.getElementById('mt-hours').value)||0;
  const m=parseInt(document.getElementById('mt-minutes').value)||0;
  const duration=h*3600+m*60;
  if(!duration){notify('יש להזין שעות או דקות');return;}
  const desc=document.getElementById('mt-desc').value.trim();
  const dateVal=document.getElementById('mt-date').value;
  const dateFormatted=dateVal?new Date(dateVal).toLocaleDateString('he-IL'):new Date().toLocaleDateString('he-IL');
  if(!db.timeEntries) db.timeEntries=[];
  db.timeEntries.unshift({id:uid(),caseId,duration,description:desc,date:dateFormatted});
  saveDB();
  closeManualTime();
  notify('שעות נשמרו ✓');
  if(currentPanel==='case-detail') openCaseDetail(currentCaseId);
  if(currentPanel==='dashboard') renderDashboard();
}

function delTimeEntry(id){
  db.timeEntries=(db.timeEntries||[]).filter(t=>t.id!==id);
  saveDB();
  if(currentPanel==='case-detail') openCaseDetail(currentCaseId);
  notify('נמחק');
}

// ===== SETTINGS =====
async function openSettingsModal() {
  updateSessionCost();
  document.getElementById('modal-settings').classList.add('open');
  try {
    const office = await Platform.getOfficeInfo();
    document.getElementById('settings-office-name').value = office.name || '';
    document.getElementById('settings-vat-rate').value = office.vat_rate ?? 18;
    const role = await Platform.getRole();
    const isOwner = role === 'owner';
    document.getElementById('settings-office-name').disabled = !isOwner;
    document.getElementById('settings-vat-rate').disabled = !isOwner;
    document.getElementById('settings-team-section').style.display = isOwner ? '' : 'none';
    document.getElementById('settings-errors-section').style.display = isOwner ? '' : 'none';
    document.getElementById('settings-subscription-section').style.display = isOwner ? '' : 'none';
    if (isOwner) { renderTeamSection(); renderErrorsSection(); renderSubscriptionSection(); }
  } catch (e) { /* office info is best-effort in this modal */ }
  try {
    const me = await Platform.getUser();
    document.getElementById('settings-user-email').value = me?.email || '';
  } catch (e) { /* best-effort */ }
}
// Reuses the same "send recovery email" call the logged-out "שכחת סיסמה?" link uses
// (Platform.resetPasswordForEmail), but for a user who's already signed in and whose
// email we already know — no need to route them through the auth-gate's email field,
// which isn't even visible/reachable while #app-root is showing.
async function settingsChangePassword() {
  const email = document.getElementById('settings-user-email').value;
  if (!email) { notify('שגיאה: לא נמצא אימייל למשתמש הנוכחי'); return; }
  try {
    await Platform.resetPasswordForEmail(email);
    alert('נשלח אימייל עם קישור לאיפוס סיסמה. בדוק/י את תיבת הדואר.');
  } catch (e) { notify('שגיאה: ' + e.message); }
}
function saveSettings() {
  const officeName = document.getElementById('settings-office-name');
  if (officeName && !officeName.disabled) {
    const vatRate = parseFloat(document.getElementById('settings-vat-rate').value) || 18;
    Platform.updateOfficeInfo({ name: officeName.value.trim(), vatRate }).catch(e => notify('שגיאה בשמירת פרטי משרד: ' + e.message));
  }
  closeModal('modal-settings'); notify('הגדרות נשמרו ✓');
}

// See supabase-schema-phase1-fix9.sql / supabase/functions/create-payment-page —
// the payment provider isn't fully wired up yet, so a failed upgradeSubscription()
// call is expected right now, not a bug; the catch below reports that plainly
// instead of leaving the button looking broken with no feedback.
async function renderSubscriptionSection() {
  const el = document.getElementById('settings-subscription-status');
  if (!el) return;
  el.textContent = 'טוען...';
  try {
    const sub = await Platform.getSubscriptionStatus();
    const statusLabel = { trial:'תקופת ניסיון', active:'פעיל', past_due:'תשלום מאחר', canceled:'בוטל' };
    const trialTxt = sub?.status === 'trial' && sub.trial_ends_at
      ? ` (מסתיימת ${new Date(sub.trial_ends_at).toLocaleDateString('he-IL')})` : '';
    el.textContent = 'סטטוס: ' + (statusLabel[sub?.status] || sub?.status || '—') + trialTxt;
  } catch (e) { el.textContent = 'לא ניתן לטעון את סטטוס המנוי'; }
}
async function upgradeSubscription() {
  try {
    const { url } = await Platform.createPaymentPage();
    if (url) window.open(url, '_blank');
  } catch (e) { notify('שגיאה: ' + e.message); }
}

async function renderErrorsSection() {
  const wrap = document.getElementById('settings-errors-list');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty">טוען...</div>';
  try {
    const errors = await Platform.listClientErrors();
    wrap.innerHTML = errors.length
      ? errors.map(e => `<div style="padding:4px 0;border-bottom:1px solid var(--border)"><div>${e.message}</div><div style="opacity:0.7">${new Date(e.created_at).toLocaleString('he-IL')}</div></div>`).join('')
      : '<div class="empty">אין שגיאות רשומות — נראה שהכל תקין 🙂</div>';
  } catch (e) { wrap.innerHTML = '<div class="empty">שגיאה בטעינת היומן</div>'; }
}

// ===== TEAM / INVITES =====
async function renderTeamSection() {
  const wrap = document.getElementById('settings-team-list');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty">טוען...</div>';
  try {
    const team = await Platform.listTeam();
    const me = await Platform.getUser();
    const roleLabel = { owner:'בעלים', lawyer:'עו"ד', secretary:'מזכירה' };
    // m.email is null for rows created before the office_members.email column existed
    // (fix7.sql) — falls back to a truncated user_id rather than showing "undefined".
    wrap.innerHTML = team.map(m => `<div class="fin-row"><span>${m.user_id === me.id ? 'את/ה' : (m.email || m.user_id.slice(0,8))}</span><span class="badge badge-active">${roleLabel[m.role]||m.role}</span></div>`).join('') || '<div class="empty">אין חברי צוות נוספים</div>';
  } catch (e) { wrap.innerHTML = '<div class="empty">שגיאה בטעינת הצוות</div>'; }
}
async function createTeamInvite() {
  // Lowercased because office_invites.email is later matched against auth.users.email
  // by exact SQL equality (see office_members_insert_via_invite policy) — if the owner
  // types "Name@Example.COM" here but the invitee's account ends up as
  // "name@example.com", the match silently fails and redemption breaks for a reason
  // that has nothing to do with security.
  const email = (document.getElementById('invite-email').value || '').trim().toLowerCase();
  const role = document.getElementById('invite-role').value;
  if (!email) { notify('נא להזין אימייל'); return; }
  try {
    const { token, link } = await Platform.createInvite(email, role);
    const linkEl = document.getElementById('invite-link-result');
    linkEl.style.display = 'block';
    linkEl.textContent = link;
    // Best-effort automatic email (see send-invite-email / Platform.sendInviteEmail)
    // — not deployed/configured yet in this project, so this is expected to fail
    // for now. Either way the link above still works via copy-paste, which is why
    // the invite itself was already created successfully regardless of this result.
    try {
      await Platform.sendInviteEmail(token);
      notify('הזמנה נשלחה באימייל! (הקישור זמין למעלה גם להעתקה ידנית)');
    } catch (e) {
      notify('קישור הזמנה נוצר — העתק ושלח אותו למוזמן (שליחה אוטומטית באימייל עדיין לא מוגדרת)');
    }
  } catch (e) { notify('שגיאה: ' + e.message); }
}
// ===== AI AGENT =====
const AGENT_SYSTEM_PROMPT = `אתה עוזר משפטי חכם ומנוסה בתוכנת LexTrack של עו״ד ירין אשואל לניהול תיקי גבייה. יש לך גישה מלאה לקרוא את כל הנתונים: תיקים, לקוחות, תשלומים, יומני טיפול, מסמכים ואירועים. אתה יכול: ליצור תיקים ולקוחות, להפיק הסכמי שכר טרחה וייפויי כוח, לרשום משימות/תשלומים/אירועים, לסכם תיקים לפי יומן הטיפול, לנתח את כל התיקים (מה דחוף, מה תקוע, מה הוזנח), לתת המלצות לפעולה, ולהפיק דוחות כספיים. יש לך גישה לספריית מסמכים משפטיים (בקשות והסכמים) המכילה דוגמאות אמיתיות לפי סוג מסמך – כשמתבקש לנסח מסמך, קרא דוגמאות רלוונטיות מהספרייה, שלב אותן עם נתוני התיק והידע המשפטי שלך, וצור טיוטה מקצועית. כשמבקשים סיכום או דוח – הצג כטקסט ברור, ואם מבקשים 'מסמך' או 'קובץ' – הפק מסמך Word. תמיד אשר פעולות יצירה מיד, ובקש אישור לפני מחיקה או עריכה. דבר עברית מקצועית, תמציתית ומדויקת. כשאתה מנתח תיק – התבסס על העובדות מהיומן ומהנתונים, אל תמציא.`;

const AGENT_TOOLS = [
  { name:'createCase', description:'צור תיק גבייה חדש במערכת',
    input_schema:{ type:'object', required:['name'], properties:{
      name:{type:'string',description:'שם התיק (לדוגמה: כהן נ׳ לוי)'},
      clientName:{type:'string',description:'שם הלקוח המזמין – יחפש לפי שם קיים'},
      debtorName:{type:'string',description:'שם החייב'},
      debtorId:{type:'string',description:'ת.ז / ח.פ של החייב'},
      debtorAddress:{type:'string',description:'כתובת החייב'},
      debtDesc:{type:'string',description:'תיאור החוב / מקורו'},
      amount:{type:'number',description:'סכום חוב בשקלים'},
      feeType:{type:'string',enum:['percent','fixed','both','hourly'],description:'סוג שכ"ט'},
      feePct:{type:'number',description:'אחוז שכ"ט (כאשר feeType=percent)'},
      stage:{type:'string',enum:['איסוף מסמכים','התראה ראשונה','גישור','כתב תביעה','דיון','הוצאה לפועל','סגור'],description:'שלב טיפול'}
    }}
  },
  { name:'createClient', description:'צור לקוח חדש במערכת',
    input_schema:{ type:'object', required:['name'], properties:{
      name:{type:'string',description:'שם הלקוח'},
      type:{type:'string',description:'יחיד / חברה / עוסק מורשה'},
      idNum:{type:'string',description:'ת.ז / ח.פ'},
      phone:{type:'string',description:'טלפון'},
      email:{type:'string',description:'אימייל'},
      address:{type:'string',description:'כתובת'}
    }}
  },
  { name:'generateATF', description:'צור הסכם שכר טרחה (Word) לתיק קיים',
    input_schema:{ type:'object', required:['caseId'], properties:{ caseId:{type:'string',description:'מזהה התיק (id)'} }}
  },
  { name:'generatePOA', description:'צור ייפוי כוח (Word) לתיק קיים',
    input_schema:{ type:'object', required:['caseId'], properties:{ caseId:{type:'string',description:'מזהה התיק (id)'} }}
  },
  { name:'addTask', description:'הוסף משימה (כללית או לתיק מסוים)',
    input_schema:{ type:'object', required:['text'], properties:{
      caseId:{type:'string',description:'מזהה תיק – אופציונלי'},
      text:{type:'string',description:'תיאור המשימה'},
      due:{type:'string',description:'תאריך יעד YYYY-MM-DD'},
      priority:{type:'string',enum:['urgent','normal','low'],description:'עדיפות'}
    }}
  },
  { name:'addPayment', description:'רשום תשלום לתיק',
    input_schema:{ type:'object', required:['caseId','amount'], properties:{
      caseId:{type:'string',description:'מזהה תיק'},
      amount:{type:'number',description:'סכום בשקלים'},
      type:{type:'string',enum:['debt','retainer','expense'],description:'סוג תשלום'},
      method:{type:'string',description:'אמצעי תשלום'},
      note:{type:'string',description:'הערה'}
    }}
  },
  { name:'addEvent', description:'הוסף דיון או אירוע ליומן (לתיק מסוים)',
    input_schema:{ type:'object', required:['caseId','title','date'], properties:{
      caseId:{type:'string',description:'מזהה תיק'},
      title:{type:'string',description:'כותרת האירוע'},
      date:{type:'string',description:'תאריך YYYY-MM-DD'},
      time:{type:'string',description:'שעה HH:MM'},
      type:{type:'string',description:'סוג: דיון / קדם משפט / הוצאה לפועל / פגישת לקוח'},
      location:{type:'string',description:'מיקום'}
    }}
  },
  { name:'addDiaryEntry', description:'הוסף רישום ליומן הטיפול של תיק',
    input_schema:{ type:'object', required:['caseId','text'], properties:{
      caseId:{type:'string',description:'מזהה תיק'},
      text:{type:'string',description:'תוכן הרישום'}
    }}
  },
  { name:'searchCases', description:'חפש תיקים לפי שם / לקוח / חייב',
    input_schema:{ type:'object', required:['query'], properties:{ query:{type:'string',description:'מחרוזת חיפוש'} }}
  },
  { name:'listCases', description:'קבל רשימת כל התיקים עם מזהים',
    input_schema:{ type:'object', properties:{} }
  },
  { name:'getCaseDetails', description:'קבל פרטים מלאים של תיק: כל השדות, לקוח, חייב, משימות, אירועים, תשלומים, מסמכים ויומן טיפול מלא',
    input_schema:{ type:'object', properties:{
      caseId:{type:'string',description:'מזהה התיק'},
      caseName:{type:'string',description:'שם חלקי לחיפוש'}
    }}
  },
  { name:'getClientDetails', description:'קבל פרטי לקוח מלאים: מידע בסיסי, כל תיקיו, סכומי חוב/גבייה, תשלומים ואירועים',
    input_schema:{ type:'object', properties:{
      clientName:{type:'string',description:'שם הלקוח'},
      clientNumber:{type:'string',description:'מספר לקוח (מספר רץ)'}
    }}
  },
  { name:'listAllCases', description:'סיכום כל התיקים: שם, חייב, סכום, שלב, סטטוס, ימים מפתיחה, ימים מעדכון אחרון',
    input_schema:{ type:'object', properties:{} }
  },
  { name:'summarizeCase', description:'קרא את יומן הטיפול וכל נתוני התיק להכנת סיכום מקצועי כרונולוגי',
    input_schema:{ type:'object', required:['caseId'], properties:{
      caseId:{type:'string',description:'מזהה התיק'}
    }}
  },
  { name:'analyzeCaseload', description:'נתח את כל התיקים: מה דחוף, מה תקוע (14+ ימים), מה הוזנח (30+ ימים), דיונים ב-7 ימים הקרובים',
    input_schema:{ type:'object', properties:{} }
  },
  { name:'getRecommendations', description:'המלצות לפעולות הבאות לפי שלב ומצב התיק/ים',
    input_schema:{ type:'object', properties:{
      caseId:{type:'string',description:'מזהה תיק ספציפי – השמט לכל התיקים הפעילים'}
    }}
  },
  { name:'getFinancialReport', description:'דוח כספי: חוב, גבוי, שכ"ט צפוי, פירוט לפי לקוח ותשלומים',
    input_schema:{ type:'object', properties:{
      period:{type:'string',description:'חודש YYYY-MM לתקופה ספציפית, או all לכל הזמנים'}
    }}
  },
  { name:'searchEverything', description:'חיפוש רוחבי: תיקים, לקוחות, יומן טיפול, מסמכים, משימות',
    input_schema:{ type:'object', required:['query'], properties:{
      query:{type:'string',description:'מחרוזת חיפוש'}
    }}
  },
  { name:'generateReport', description:'צור מסמך Word עם דוח או סיכום ופתח אותו',
    input_schema:{ type:'object', required:['title','content'], properties:{
      title:{type:'string',description:'כותרת הדוח'},
      content:{type:'string',description:'תוכן הדוח (שורות חדשות מותרות)'}
    }}
  },
  { name:'listLibraryFolders', description:'קבל רשימת תיקיות בספריית המסמכים (בקשות, הסכמים, ייפויי כוח, כתבי תביעה, התראות וכו\')',
    input_schema:{ type:'object', properties:{} }
  },
  { name:'listDocumentsInFolder', description:'קבל רשימת קבצי docx/pdf בתיקיית ספרייה מסוימת',
    input_schema:{ type:'object', required:['folderName'], properties:{
      folderName:{type:'string',description:'שם התיקייה'}
    }}
  },
  { name:'readLibraryDocument', description:'קרא את תוכן מסמך מהספרייה (docx או pdf) לצורך עיון ולמידה',
    input_schema:{ type:'object', required:['folderName','fileName'], properties:{
      folderName:{type:'string',description:'שם תיקיית הספרייה'},
      fileName:{type:'string',description:'שם הקובץ'}
    }}
  },
  { name:'draftDocument', description:'נסח מסמך משפטי חדש: קרא דוגמאות מהספרייה + נתוני התיק + הוראות → צור טיוטה Word ושמור לתיק',
    input_schema:{ type:'object', required:['documentType','instructions'], properties:{
      caseId:{type:'string',description:'מזהה תיק לקבלת נתונים (אופציונלי)'},
      documentType:{type:'string',description:'סוג המסמך: בקשה / הסכם / ייפוי כוח / כתב תביעה / התראה'},
      instructions:{type:'string',description:'הוראות ספציפיות לניסוח המסמך'}
    }},
    cache_control:{ type:'ephemeral' }
  }
];

let agentMessages = [];
let agentOpen = false;

// Model routing: Haiku for simple ops, Sonnet for drafting/analysis. Internal only —
// Phase 1 removed the manual Haiku/Sonnet picker from Settings (developer-facing UX).
function chooseModel(text) {
  const draftPat = /נסח|טיוט|בקש|תביע|עתיר|ניתוח|מסמך|ייפוי|הסכם שכ|draft|analyz/i;
  return draftPat.test(text) ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
}

function chooseMaxTokens(model, text) {
  const draftPat = /נסח|טיוט|בקש|תביע|עתיר|מסמך Word|draft/i;
  if (draftPat.test(text)) return 4000;
  return model.includes('sonnet') ? 1500 : 800;
}

// Trim to last N messages, ensuring we start on a user turn (not orphaned tool_result)
function trimMessages(messages, max) {
  max = max || 8;
  if (messages.length <= max) return messages;
  let slice = messages.slice(-max);
  while (slice.length > 0) {
    const first = slice[0];
    if (first.role === 'user' && Array.isArray(first.content) && first.content.every(b => b.type === 'tool_result')) {
      slice = slice.slice(1); // orphaned tool_result without preceding tool_use
    } else break;
  }
  return slice;
}

// AI_MONTHLY_QUOTA must match MONTHLY_QUOTA in supabase/functions/ai-proxy/index.ts —
// this is display-only (the real enforcement happens server-side in the proxy).
const AI_MONTHLY_QUOTA = 200;

async function updateSessionCost() {
  let remaining = '—';
  try {
    const used = await Platform.getAIUsageThisMonth();
    remaining = `${Math.max(0, AI_MONTHLY_QUOTA - used)}/${AI_MONTHLY_QUOTA}`;
  } catch (e) { /* leave as — if the count fails to load */ }
  const label = 'פעולות AI שנותרו החודש: ' + remaining;
  const el1 = document.getElementById('agent-session-cost');
  if (el1) el1.textContent = label;
  const el2 = document.getElementById('settings-session-cost-modal');
  if (el2) el2.textContent = remaining;
}

function agentAddCostLabel(cost, model) {
  const msgs = document.getElementById('agent-msgs');
  const el = document.createElement('div');
  el.className = 'agent-cost-label';
  const modelLabel = model && model.includes('haiku') ? '💨 מהיר' : '🧠 מעמיק';
  el.textContent = modelLabel;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
}

function toggleAgent() {
  agentOpen = !agentOpen;
  const panel = document.getElementById('agent-panel');
  if (agentOpen) { panel.classList.add('open'); setTimeout(()=>document.getElementById('agent-input').focus(),100); updateSessionCost(); }
  else panel.classList.remove('open');
}

function clearAgentChat() {
  agentMessages = [];
  document.getElementById('agent-msgs').innerHTML = '<div class="agent-welcome">שיחה נוקתה. כיצד אוכל לעזור?</div>';
}

function agentKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentSend(); }
}

function agentGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 90) + 'px';
}

function agentAddBubble(role, text) {
  const msgs = document.getElementById('agent-msgs');
  const div = document.createElement('div');
  div.className = 'agent-msg ' + role;
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function agentAddStatus(text) {
  const msgs = document.getElementById('agent-msgs');
  const div = document.createElement('div');
  div.className = 'agent-msg status';
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function agentToolLabel(n) {
  return ({createCase:'פותח תיק',createClient:'יוצר לקוח',generateATF:'יוצר הסכם שכ"ט',generatePOA:'יוצר ייפוי כוח',addTask:'מוסיף משימה',addPayment:'רושם תשלום',addEvent:'מוסיף אירוע',addDiaryEntry:'מוסיף ליומן',searchCases:'מחפש תיקים',listCases:'טוען תיקים',getCaseDetails:'קורא פרטי תיק',getClientDetails:'קורא פרטי לקוח',listAllCases:'מסכם תיקים',summarizeCase:'מכין סיכום תיק',analyzeCaseload:'מנתח עומס תיקים',getRecommendations:'מכין המלצות',getFinancialReport:'מכין דוח כספי',searchEverything:'מחפש בכל הנתונים',generateReport:'מפיק מסמך Word',listLibraryFolders:'סורק ספריית מסמכים',listDocumentsInFolder:'מחפש מסמכי עיון',readLibraryDocument:'קורא מסמך עיון',draftDocument:'מנסח מסמך משפטי'})[n]||n;
}

async function agentSend() {
  const input = document.getElementById('agent-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = ''; input.style.height = 'auto';
  agentAddBubble('user', text);
  agentMessages.push({ role:'user', content:text });
  const statusEl = agentAddStatus('חושב...');
  const model = chooseModel(text);
  const maxTokens = chooseMaxTokens(model, text);
  try {
    await agentRunLoop(trimMessages([...agentMessages]), statusEl, 0, { model, maxTokens, _turnCost: 0 });
  } catch(e) {
    statusEl.remove();
    agentAddBubble('assistant', 'שגיאה: ' + (e.message||String(e)));
    console.error('Agent error:', e);
  }
}

async function agentRunLoop(messages, statusEl, depth, opts) {
  opts = opts || { model:'claude-haiku-4-5-20251001', maxTokens:800, _turnCost:0 };
  if (depth > 8) { statusEl.remove(); agentAddBubble('assistant','הגעתי למגבלת ביצוע.'); return; }
  const data = await agentCallAPI(messages, opts);
  opts._turnCost = (opts._turnCost || 0) + (data._cost || 0);
  const blocks = data.content || [];
  if (data.stop_reason === 'tool_use') {
    const toolBlocks = blocks.filter(b => b.type === 'tool_use');
    messages.push({ role:'assistant', content:blocks });
    const results = [];
    for (const block of toolBlocks) {
      if (statusEl) statusEl.textContent = '🔧 ' + agentToolLabel(block.name) + '...';
      const res = await agentExecTool(block.name, block.input);
      results.push({ type:'tool_result', tool_use_id:block.id, content:res });
    }
    messages.push({ role:'user', content:results });
    agentMessages = [...messages];
    await agentRunLoop(messages, statusEl, depth + 1, opts);
  } else {
    const text = blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
    messages.push({ role:'assistant', content:blocks });
    agentMessages = [...messages];
    if (statusEl) statusEl.remove();
    if (text) agentAddBubble('assistant', text);
    agentAddCostLabel(opts._turnCost || 0, opts.model);
    updateSessionCost();
  }
}

async function agentCallAPI(messages, opts) {
  opts = opts || {};
  const model = opts.model || 'claude-haiku-4-5-20251001';
  const maxTokens = opts.maxTokens || 800;
  // Prompt caching is a pure cost/latency optimization with no functional
  // trade-off a user could meaningfully choose about, so it's always on — this
  // used to be a Settings toggle exposing raw API terms ("prompt caching",
  // "system prompt") to a lawyer end-user for no real benefit. Removed.
  const systemBlock = [{ type:'text', text:AGENT_SYSTEM_PROMPT, cache_control:{ type:'ephemeral' } }];

  // Server-side proxy (supabase/functions/ai-proxy) holds the real Anthropic key,
  // enforces the office's monthly quota, and logs usage — the client never sees
  // cost or the API key anymore (Phase 1).
  const data = await Platform.callAI({ model, max_tokens:maxTokens, system:systemBlock, tools:AGENT_TOOLS, messages, useCaching:true });
  if (data.error) throw new Error(data.error);
  data._model = model;
  return data;
}

async function agentExecTool(name, input) {
  try {
    switch(name) {
      case 'createCase': {
        let clientId = '';
        if (input.clientName) {
          const q = (input.clientName||'').trim();
          const cl = db.clients.find(c=>c.name.includes(q)||q.includes(c.name));
          if (cl) clientId = cl.id;
        }
        const obj = {
          id:uid(), name:input.name, client:clientId,
          amount:input.amount||0, stage:input.stage||'איסוף מסמכים', status:'active',
          number:'', notes:'', court:'', courtNumber:'',
          debtorName:input.debtorName||'', debtorId:input.debtorId||'',
          debtorAddress:input.debtorAddress||'', debtorPhone:'', debtorEmail:'', debtorType:'יחיד',
          debtDesc:input.debtDesc||'',
          feeType:input.feeType||'percent', feePct:input.feePct||15, feeFixed:0,
          feeVat:'yes', expensesType:'client', retainer:0, feeNotes:'',
          opened:new Date().toLocaleDateString('he-IL'),
          diary:[], legalDocs:{}, collected:0, caseSubNumber:''
        };
        if (clientId) obj.caseSubNumber = getNextCaseSubNumber(clientId);
        db.cases.unshift(obj); saveDB(); refreshAll();
        return `✅ תיק "${obj.name}" נוצר בהצלחה (מזהה: ${obj.id})`;
      }
      case 'createClient': {
        const colors=[['rgba(37,99,235,0.15)','var(--accent2)'],['rgba(22,163,74,0.15)','var(--success)'],['rgba(217,119,6,0.15)','var(--warning)'],['rgba(220,38,38,0.15)','var(--danger)']];
        const [bg,tc]=colors[db.clients.length%4];
        const obj = {
          id:uid(), clientNumber:getNextClientNumber(),
          name:input.name, type:input.type||'יחיד',
          idNum:input.idNum||'', phone:input.phone||'', email:input.email||'',
          address:input.address||'', contact:'', contactPhone:'', notes:'',
          color:bg, textColor:tc,
          initials:(input.name||'').split(' ').map(w=>w[0]).join('').substr(0,2).toUpperCase()
        };
        db.clients.push(obj); saveDB();
        return `✅ לקוח "${obj.name}" (${obj.clientNumber}) נוצר בהצלחה (מזהה: ${obj.id})`;
      }
      case 'generateATF': {
        const c = db.cases.find(x=>x.id===input.caseId);
        if (!c) return 'שגיאה: תיק לא נמצא. השתמש ב-listCases כדי למצוא מזהה.';
        const cl = db.clients.find(x=>x.id===c.client)||{};
        const { filePath: fpAtf, filename: fnAtf } = await fillLegalTemplate('atf', {
          clientName:cl.name||'', clientId:cl.idNum||'',
          matter:c.name||'', feePct:c.feePct||15
        }, c);
        notify('הסכם שכ"ט נפתח!');
        await Platform.openFile(fpAtf, fnAtf);
        return `✅ הסכם שכ"ט לתיק "${c.name}" נוצר ונשמר`;
      }
      case 'generatePOA': {
        const c = db.cases.find(x=>x.id===input.caseId);
        if (!c) return 'שגיאה: תיק לא נמצא.';
        const cl = db.clients.find(x=>x.id===c.client)||{};
        const { filePath: fpPoa, filename: fnPoa } = await fillLegalTemplate('poa', {
          grantorName:cl.name||'', grantorId:cl.idNum||'',
          matter:`גבייה מ${c.debtorName||'החייב'} בסך ₪${(c.amount||0).toLocaleString()}${c.debtDesc?' – '+c.debtDesc:''}`
        }, c);
        notify('ייפוי כוח נפתח!');
        await Platform.openFile(fpPoa, fnPoa);
        return `✅ ייפוי כוח לתיק "${c.name}" נוצר ונשמר`;
      }
      case 'addTask': {
        const task = { id:uid(), text:input.text, due:input.due||'', caseId:input.caseId||'', priority:input.priority||'normal', notes:'', done:false };
        db.tasks.unshift(task); saveDB(); refreshSidebar();
        return `✅ משימה "${input.text}" נוספה`;
      }
      case 'addPayment': {
        const c = db.cases.find(x=>x.id===input.caseId);
        if (!c) return 'שגיאה: תיק לא נמצא.';
        // Coerce to a number — the model is expected to send one, but if it sends a
        // numeric string (e.g. "5000"), `c.collected += pay.amount` would silently do
        // string concatenation instead of addition, corrupting every later finance total.
        const payAmount = parseFloat(input.amount) || 0;
        const pay = { id:uid(), caseId:input.caseId, amount:payAmount, date:localDateISO(new Date()), method:input.method||'העברה בנקאית', type:input.type||'debt', note:input.note||'' };
        db.payments.push(pay);
        if (pay.type==='debt') c.collected=(c.collected||0)+pay.amount;
        saveDB();
        return `✅ תשלום ₪${pay.amount.toLocaleString()} נרשם לתיק "${c.name}"`;
      }
      case 'addEvent': {
        const c = db.cases.find(x=>x.id===input.caseId);
        if (!c) return 'שגיאה: תיק לא נמצא.';
        db.events.push({ id:uid(), title:input.title, date:input.date, time:input.time||'', location:input.location||'', type:input.type||'דיון', caseId:input.caseId, notes:'' });
        saveDB();
        return `✅ אירוע "${input.title}" (${input.date}) נוסף לתיק "${c.name}"`;
      }
      case 'addDiaryEntry': {
        const c = db.cases.find(x=>x.id===input.caseId);
        if (!c) return 'שגיאה: תיק לא נמצא.';
        if (!c.diary) c.diary=[];
        c.diary.push({ text:input.text, date:new Date().toLocaleString('he-IL') });
        saveDB();
        return `✅ רישום ביומן נוסף לתיק "${c.name}"`;
      }
      case 'searchCases': {
        const q = (input.query||'').trim();
        const res = db.cases.filter(c=>
          c.name.includes(q)||(c.debtorName||'').includes(q)||
          (db.clients.find(x=>x.id===c.client)||{name:''}).name.includes(q)
        );
        if (!res.length) return `לא נמצאו תיקים עבור "${q}"`;
        return res.map(c=>`[${c.id}] ${c.name} | חייב: ${c.debtorName||'—'} | ₪${(c.amount||0).toLocaleString()} | ${c.stage} | ${c.status}`).join('\n');
      }
      case 'listCases': {
        if (!db.cases.length) return 'אין תיקים במערכת';
        return db.cases.slice(0,30).map(c=>`[${c.id}] ${c.name} | חייב: ${c.debtorName||'—'} | ₪${(c.amount||0).toLocaleString()} | ${c.stage}`).join('\n');
      }
      case 'getCaseDetails': {
        let gc=input.caseId?db.cases.find(x=>x.id===input.caseId):null;
        if (!gc&&input.caseName){const q=(input.caseName||'').trim();gc=db.cases.find(x=>x.name.includes(q)||q.includes(x.name));}
        if (!gc) return 'תיק לא נמצא. השתמש ב-searchCases כדי למצוא מזהה.';
        const gcl=db.clients.find(x=>x.id===gc.client)||{};
        const gct=db.tasks.filter(t=>t.caseId===gc.id);
        const gce=db.events.filter(e=>e.caseId===gc.id);
        const gcp=db.payments.filter(p=>p.caseId===gc.id);
        const gcd=db.docs.filter(d=>d.caseId===gc.id);
        const gcte=(db.timeEntries||[]).filter(t=>t.caseId===gc.id);
        const gcMins=Math.round(gcte.reduce((s,t)=>s+(t.duration||0),0)/60);
        return [
          `=== תיק: ${gc.name} ===`,
          `מזהה: ${gc.id} | מספר: ${gc.number||'—'} | משנה: ${gc.caseSubNumber||'—'}`,
          `סטטוס: ${gc.status} | שלב: ${gc.stage} | נפתח: ${gc.opened||'—'}`,
          '',`--- לקוח ---`,
          `שם: ${gcl.name||'—'} (${gcl.clientNumber||''}) | ת.ז/ח.פ: ${gcl.idNum||'—'} | טל: ${gcl.phone||'—'}`,
          `כתובת: ${gcl.address||'—'}`,
          '',`--- חייב ---`,
          `שם: ${gc.debtorName||'—'} | ת.ז/ח.פ: ${gc.debtorId||'—'} | כתובת: ${gc.debtorAddress||'—'}`,
          `תיאור חוב: ${gc.debtDesc||'—'}`,
          '',`--- כספים ---`,
          `סכום תביעה: ₪${(gc.amount||0).toLocaleString()} | גבוי: ₪${(gc.collected||0).toLocaleString()} | יתרה: ₪${((gc.amount||0)-(gc.collected||0)).toLocaleString()}`,
          `שכ"ט: ${gc.feeType==='percent'?gc.feePct+'%':gc.feeType==='fixed'?'₪'+(gc.feeFixed||0).toLocaleString():gc.feeType}`,
          '',`--- תשלומים (${gcp.length}) ---`,
          ...gcp.map(p=>`${p.date} | ${p.type} | ₪${p.amount.toLocaleString()} | ${p.method||''}${p.note?' | '+p.note:''}`),
          '',`--- משימות (${gct.length}) ---`,
          ...gct.map(t=>`[${t.done?'V':' '}] ${t.text} | עדיפות: ${t.priority||'normal'} | יעד: ${t.due||'—'}`),
          '',`--- אירועים (${gce.length}) ---`,
          ...gce.map(e=>`${e.date} ${e.time||''} | ${e.type||'דיון'}: ${e.title} | ${e.location||''}`),
          '',`--- מסמכים (${gcd.length}) ---`,
          ...gcd.map(d=>`${d.name} (.${d.ext}) | ${d.cat||''} | ${d.date||''}`),
          '',`--- שעות עבודה ---`,`סה"כ: ${gcMins} דקות`,
          '',`--- יומן טיפול (${(gc.diary||[]).length} רשומות) ---`,
          ...(gc.diary||[]).map(d=>`[${d.date}] ${d.text}`),
          '',`--- מסמכים משפטיים ---`,
          `הסכם שכ"ט: ${gc.legalDocs&&gc.legalDocs.atfDraft?'קיים ('+gc.legalDocs.atfDate+')':'לא נוצר'}`,
          `ייפוי כוח: ${gc.legalDocs&&gc.legalDocs.poaDraft?'קיים ('+gc.legalDocs.poaDate+')':'לא נוצר'}`,
          '',`--- הערות ---`,gc.notes||'—',
        ].join('\n');
      }
      case 'getClientDetails': {
        let gcl2;
        if (input.clientName){const q=(input.clientName||'').trim();gcl2=db.clients.find(c=>c.name.includes(q)||q.includes(c.name));}
        if (!gcl2&&input.clientNumber) gcl2=db.clients.find(c=>c.clientNumber===input.clientNumber);
        if (!gcl2) return 'לקוח לא נמצא.';
        const gcc=db.cases.filter(c=>c.client===gcl2.id);
        const gctd=gcc.reduce((s,c)=>s+(c.amount||0),0);
        const gctc=gcc.reduce((s,c)=>s+(c.collected||0),0);
        const gcp2=db.payments.filter(p=>gcc.some(c=>c.id===p.caseId));
        const todayGCL=localDateISO(new Date());
        const gcev=db.events.filter(e=>gcc.some(c=>c.id===e.caseId)&&e.date>=todayGCL).sort((a,b)=>a.date>b.date?1:-1);
        return [
          `=== לקוח: ${gcl2.name} (${gcl2.clientNumber}) ===`,
          `סוג: ${gcl2.type||'—'} | ת.ז/ח.פ: ${gcl2.idNum||'—'} | טל: ${gcl2.phone||'—'} | אימייל: ${gcl2.email||'—'}`,
          `כתובת: ${gcl2.address||'—'} | איש קשר: ${gcl2.contact||'—'} טל: ${gcl2.contactPhone||'—'}`,
          '',`--- סיכום כספי ---`,
          `סה"כ חוב: ₪${gctd.toLocaleString()} | גבוי: ₪${gctc.toLocaleString()} | יתרה: ₪${(gctd-gctc).toLocaleString()}`,
          '',`--- תיקים (${gcc.length}) ---`,
          ...gcc.map(c=>`[${c.id}] ${c.name} | ${c.stage} | ${c.status} | ₪${(c.amount||0).toLocaleString()} | גבוי ₪${(c.collected||0).toLocaleString()}`),
          '',`--- תשלומים אחרונים ---`,
          ...gcp2.slice(-10).reverse().map(p=>{const c2=db.cases.find(x=>x.id===p.caseId)||{};return `${p.date} | ${c2.name||'—'} | ${p.type} | ₪${p.amount.toLocaleString()} | ${p.method||''}`;}),
          '',`--- אירועים קרובים ---`,
          ...gcev.slice(0,5).map(e=>{const c2=db.cases.find(x=>x.id===e.caseId)||{};return `${e.date} | ${c2.name||'—'} | ${e.title}`;}),
          '',`--- הערות ---`,gcl2.notes||'—',
        ].join('\n');
      }
      case 'listAllCases': {
        if (!db.cases.length) return 'אין תיקים במערכת';
        const lines2=['=== כל התיקים ===',''];
        db.cases.forEach(c=>{
          const cl2=db.clients.find(x=>x.id===c.client)||{};
          const ld=c.diary&&c.diary.length?c.diary[c.diary.length-1].date:null;
          const dO=daysSinceHE(c.opened); const dL=ld?daysSinceHE(ld):null;
          lines2.push(`[${c.id}] ${c.name}`);
          lines2.push(`  לקוח: ${cl2.name||'—'} | חייב: ${c.debtorName||'—'}`);
          lines2.push(`  ₪${(c.amount||0).toLocaleString()} | גבוי: ₪${(c.collected||0).toLocaleString()} | שלב: ${c.stage} | ${c.status}`);
          lines2.push(`  ימים מפתיחה: ${dO!==null?dO:'—'} | ימים מעדכון יומן: ${dL!==null?dL:'—'}`);
          lines2.push('');
        });
        return lines2.join('\n');
      }
      case 'summarizeCase': {
        const sc=db.cases.find(x=>x.id===input.caseId);
        if (!sc) return 'תיק לא נמצא.';
        return await agentExecTool('getCaseDetails',{caseId:input.caseId});
      }
      case 'analyzeCaseload': {
        const todayAC=localDateISO(new Date());
        const next7=new Date(); next7.setDate(next7.getDate()+7);
        const next7s=localDateISO(next7);
        const acActive=db.cases.filter(c=>c.status!=='closed');
        const acUrgent=db.cases.filter(c=>c.status==='urgent');
        const acStuck=acActive.filter(c=>{const ld=c.diary&&c.diary.length?c.diary[c.diary.length-1].date:c.opened;const d=daysSinceHE(ld);return d!==null&&d>=14;});
        const acNegl=acActive.filter(c=>{const ld=c.diary&&c.diary.length?c.diary[c.diary.length-1].date:c.opened;const d=daysSinceHE(ld);return d!==null&&d>=30;});
        const acEvts=db.events.filter(e=>e.date>=todayAC&&e.date<=next7s).sort((a,b)=>a.date>b.date?1:-1);
        const acOver=db.tasks.filter(t=>!t.done&&t.due&&t.due<todayAC);
        return [
          '=== ניתוח עומס תיקים ===','',
          `סה"כ תיקים: ${db.cases.length} (פעילים: ${acActive.length}, סגורים: ${db.cases.length-acActive.length})`,
          '',`--- 🔴 דחופים (${acUrgent.length}) ---`,
          ...acUrgent.map(c=>`[${c.id}] ${c.name} | ${c.stage} | ₪${(c.amount||0).toLocaleString()}`),
          acUrgent.length===0?'אין':'',
          '',`--- 🟡 תקועים – ללא עדכון 14+ ימים (${acStuck.length}) ---`,
          ...acStuck.map(c=>{const ld=c.diary&&c.diary.length?c.diary[c.diary.length-1].date:c.opened;return `[${c.id}] ${c.name} | ${c.stage} | עדכון: ${ld||'—'}`;}),
          acStuck.length===0?'אין':'',
          '',`--- 🔴 מוזנחים – ללא עדכון 30+ ימים (${acNegl.length}) ---`,
          ...acNegl.map(c=>{const ld=c.diary&&c.diary.length?c.diary[c.diary.length-1].date:c.opened;return `[${c.id}] ${c.name} | ${c.stage} | עדכון: ${ld||'—'}`;}),
          acNegl.length===0?'אין':'',
          '',`--- 📅 דיונים ב-7 ימים הקרובים (${acEvts.length}) ---`,
          ...acEvts.map(e=>{const c=db.cases.find(x=>x.id===e.caseId)||{};return `${e.date} ${e.time||''} | ${e.title} | תיק: ${c.name||'—'}`;}),
          acEvts.length===0?'אין אירועים קרובים':'',
          '',`--- ⏰ משימות באיחור (${acOver.length}) ---`,
          ...acOver.slice(0,10).map(t=>{const cn=t.caseId?(db.cases.find(x=>x.id===t.caseId)||{}).name||'':'';return `${t.text} | יעד: ${t.due}${cn?' | תיק: '+cn:''}`;}),
          acOver.length===0?'אין משימות באיחור':'',
        ].join('\n');
      }
      case 'getRecommendations': {
        const stRec={'איסוף מסמכים':'לאסוף מסמכי חוב ולשלוח מכתב התראה ראשון','התראה ראשונה':'לבדוק אם חלפו 14-30 יום ולשקול פנייה משפטית או גישור','גישור':'לתאם ישיבת גישור; אם נכשל – לעבור לכתב תביעה','כתב תביעה':'להגיש כתב תביעה לבית המשפט המוסמך','דיון':'להתכונן לדיון ולוודא כל המסמכים מוכנים','הוצאה לפועל':'לעקוב אחר הליכי הוצל"פ ולדרוש עיקולים','סגור':'תיק סגור'};
        const todayRec=localDateISO(new Date());
        let recList;
        if (input.caseId&&input.caseId!=='all'){const rc=db.cases.find(x=>x.id===input.caseId);if(!rc) return 'תיק לא נמצא.';recList=[rc];}
        else recList=db.cases.filter(c=>c.status!=='closed').slice(0,20);
        const rlines=['=== המלצות לפעולה ===',''];
        recList.forEach(c=>{
          const ld=c.diary&&c.diary.length?c.diary[c.diary.length-1].date:c.opened;
          const d=daysSinceHE(ld)||0;
          const ot=db.tasks.filter(t=>t.caseId===c.id&&!t.done).length;
          const ne=db.events.filter(e=>e.caseId===c.id&&e.date>=todayRec).length;
          rlines.push(`📁 ${c.name} [${c.id}]`);
          rlines.push(`   שלב: ${c.stage} | עדכון: לפני ${d} ימים`);
          rlines.push(`   המלצה: ${stRec[c.stage]||'לבדוק מצב התיק'}`);
          if (d>=30) rlines.push(`   ⚠️ לא עודכן 30+ ימים – דחוף טיפול`);
          else if (d>=14) rlines.push(`   ⚠️ לא עודכן 14+ ימים`);
          if (ot>0) rlines.push(`   📋 ${ot} משימות פתוחות`);
          if (ne>0) rlines.push(`   📅 ${ne} אירועים קרובים`);
          if (!c.legalDocs||!c.legalDocs.atfDraft) rlines.push(`   📄 הסכם שכ"ט טרם נוצר`);
          if (!c.legalDocs||!c.legalDocs.poaDraft) rlines.push(`   📄 ייפוי כוח טרם נוצר`);
          rlines.push('');
        });
        return rlines.join('\n');
      }
      case 'getFinancialReport': {
        const frPeriod=input.period||'all';
        const frPay=frPeriod==='all'?db.payments:db.payments.filter(p=>(p.date||'').startsWith(frPeriod));
        const frLabel=frPeriod==='all'?'כל הזמנים':frPeriod;
        const frActive=db.cases.filter(c=>c.status!=='closed');
        const frDebt=frActive.reduce((s,c)=>s+(c.amount||0),0);
        const frColl=db.cases.reduce((s,c)=>s+(c.collected||0),0);
        const frDP=frPay.filter(p=>p.type==='debt'), frRP=frPay.filter(p=>p.type==='retainer'), frEP=frPay.filter(p=>p.type==='expense');
        const frSum=arr=>arr.reduce((s,p)=>s+(p.amount||0),0);
        const frFee=frActive.reduce((s,c)=>s+calcExpectedFee(c),0);
        const frCB=db.clients.map(cl=>{const cc=db.cases.filter(c=>c.client===cl.id);const d=cc.reduce((s,c)=>s+(c.amount||0),0);const co=cc.reduce((s,c)=>s+(c.collected||0),0);const cp=frPay.filter(p=>cc.some(c=>c.id===p.caseId));return {name:cl.name,debt:d,collected:co,cases:cc.length};}).filter(x=>x.debt>0).sort((a,b)=>b.debt-a.debt);
        return [
          `=== דוח כספי – ${frLabel} ===`,'',
          `--- סיכום ---`,
          `סה"כ חוב בתיקים פעילים: ₪${frDebt.toLocaleString()}`,
          `סה"כ גבוי (כל הזמנים): ₪${frColl.toLocaleString()}`,
          `יתרה לגבייה: ₪${(frDebt-frColl).toLocaleString()}`,
          `שכ"ט צפוי (תיקים פעילים): ₪${Math.round(frFee).toLocaleString()}`,
          '',`--- תשלומים בתקופה (${frPay.length}) ---`,
          `גביית חוב: ₪${frSum(frDP).toLocaleString()} (${frDP.length} תשלומים)`,
          `קדם לתשלום: ₪${frSum(frRP).toLocaleString()} (${frRP.length} תשלומים)`,
          `הוצאות: ₪${frSum(frEP).toLocaleString()} (${frEP.length} תשלומים)`,
          '',`--- פירוט לפי לקוח ---`,
          ...frCB.map(cl=>`${cl.name} | חוב: ₪${cl.debt.toLocaleString()} | גבוי: ₪${cl.collected.toLocaleString()} | יתרה: ₪${(cl.debt-cl.collected).toLocaleString()} | ${cl.cases} תיקים`),
          '',`--- תשלומים אחרונים ---`,
          ...frPay.slice(-15).reverse().map(p=>{const c=db.cases.find(x=>x.id===p.caseId)||{};return `${p.date} | ${c.name||'—'} | ${p.type} | ₪${p.amount.toLocaleString()} | ${p.method||''}`;}),
        ].join('\n');
      }
      case 'searchEverything': {
        const seQ=(input.query||'').trim().toLowerCase();
        if (!seQ) return 'חיפוש ריק';
        const seR=[];
        db.cases.forEach(c=>{
          if(c.name.toLowerCase().includes(seQ)||(c.debtorName||'').toLowerCase().includes(seQ)||(c.debtorId||'').includes(seQ)||(c.debtDesc||'').toLowerCase().includes(seQ)||(c.notes||'').toLowerCase().includes(seQ))
            seR.push(`[תיק] [${c.id}] ${c.name} | חייב: ${c.debtorName||'—'} | ${c.stage}`);
          (c.diary||[]).forEach(d=>{if(d.text.toLowerCase().includes(seQ)) seR.push(`[יומן "${c.name}"] ${d.date}: ${d.text.substring(0,100)}`);});
        });
        db.clients.forEach(cl=>{
          if(cl.name.toLowerCase().includes(seQ)||(cl.idNum||'').includes(seQ)||(cl.phone||'').includes(seQ)||(cl.email||'').toLowerCase().includes(seQ)||(cl.address||'').toLowerCase().includes(seQ))
            seR.push(`[לקוח] [${cl.id}] ${cl.name} (${cl.clientNumber||''}) | ${cl.phone||''}`);
        });
        db.docs.forEach(d=>{
          const c=db.cases.find(x=>x.id===d.caseId)||{};
          if((d.name||'').toLowerCase().includes(seQ)||(d.notes||'').toLowerCase().includes(seQ))
            seR.push(`[מסמך] ${d.name} | תיק: ${c.name||'—'} | ${d.date||''}`);
        });
        db.tasks.forEach(t=>{
          if((t.text||'').toLowerCase().includes(seQ)){const cn=t.caseId?(db.cases.find(x=>x.id===t.caseId)||{}).name||'':'';seR.push(`[משימה] ${t.text}${cn?' | תיק: '+cn:''} | ${t.done?'בוצע':'פתוח'}`);}
        });
        if (!seR.length) return `לא נמצאו תוצאות עבור "${input.query}"`;
        return `נמצאו ${seR.length} תוצאות עבור "${input.query}":\n\n`+seR.join('\n');
      }
      case 'listLibraryFolders': {
        const llRes = await Platform.listLibraryFolders();
        if (llRes && llRes.error) return `שגיאה: ${llRes.error}`;
        if (!Array.isArray(llRes) || !llRes.length) return 'הספרייה ריקה. ייבא קבצים במסך "תבניות".';
        return 'תיקיות בספרייה:\n' + llRes.join('\n');
      }
      case 'listDocumentsInFolder': {
        const ldfRes = await Platform.listFolderDocs({ folderName: input.folderName });
        if (ldfRes && ldfRes.error) return `שגיאה: ${ldfRes.error}`;
        if (!Array.isArray(ldfRes) || !ldfRes.length) return `אין מסמכים בתיקייה "${input.folderName}"`;
        return `מסמכים בתיקייה "${input.folderName}":\n` + ldfRes.join('\n');
      }
      case 'readLibraryDocument': {
        const rldRes = await Platform.readLibraryDoc({ folderName: input.folderName, fileName: input.fileName });
        if (rldRes && rldRes.error) return `שגיאה בקריאת "${input.fileName}": ${rldRes.error}`;
        return `=== תוכן "${input.fileName}" ===\n` + (rldRes.text||'').substring(0, 8000);
      }
      case 'draftDocument': {
        const ddType = input.documentType || '';

        // Route ATF and POA to template-based generation
        if (ddType === 'הסכם שכ"ט' || ddType === 'הסכם שכר טרחה') {
          const ddCaseForTpl = input.caseId ? db.cases.find(x => x.id === input.caseId) : null;
          if (!ddCaseForTpl) return 'שגיאה: נדרש תיק לייצור הסכם שכ"ט';
          const ddClientForTpl = db.clients.find(x => x.id === ddCaseForTpl.client) || {};
          const { filePath: tplPath, filename: tplFilename } = await fillLegalTemplate('atf', {
            clientName: ddClientForTpl.name || '',
            clientId: ddClientForTpl.idNum || '',
            matter: ddCaseForTpl.name || '',
            feePct: ddCaseForTpl.feePct || '15',
          }, ddCaseForTpl);
          notify('הסכם שכ"ט נשמר! פותח...');
          await Platform.openFile(tplPath, tplFilename);
          return `✅ הסכם שכ"ט נשמר ונפתח`;
        }
        if (ddType === 'ייפוי כוח' || ddType === 'ייפוי כח') {
          const ddCaseForTpl = input.caseId ? db.cases.find(x => x.id === input.caseId) : null;
          if (!ddCaseForTpl) return 'שגיאה: נדרש תיק לייצור ייפוי כוח';
          const ddClientForTpl = db.clients.find(x => x.id === ddCaseForTpl.client) || {};
          const { filePath: tplPath, filename: tplFilename } = await fillLegalTemplate('poa', {
            grantorName: ddClientForTpl.name || '',
            grantorId: ddClientForTpl.idNum || '',
            matter: ddCaseForTpl.name || '',
          }, ddCaseForTpl);
          notify('ייפוי כוח נשמר! פותח...');
          await Platform.openFile(tplPath, tplFilename);
          return `✅ ייפוי כוח נשמר ונפתח`;
        }

        // Map document type to library folder
        const ddFolderMap = {'בקשה':'בקשות','בקשות':'בקשות','הסכם':'הסכמים','הסכמים':'הסכמים','ייפוי כוח':'ייפויי כוח','ייפויי כוח':'ייפויי כוח','כתב תביעה':'כתבי תביעה','כתבי תביעה':'כתבי תביעה','התראה':'התראות','התראות':'התראות'};
        let ddFolder = ddFolderMap[ddType];
        if (!ddFolder) {
          const ddKey = Object.keys(ddFolderMap).find(k => ddType.includes(k));
          ddFolder = ddKey ? ddFolderMap[ddKey] : ddType;
        }

        // Read reference docs from library
        const ddRefs = [];
        let ddNoLibNote = '';
        const ddDocsRes = await Platform.listFolderDocs({ folderName: ddFolder });
        if (!Array.isArray(ddDocsRes) || !ddDocsRes.length) {
          ddNoLibNote = '\n[לא נמצאו דוגמאות בספרייה – נוסח מידע משפטי בלבד]';
        } else {
          const ddKws = (input.instructions + ' ' + ddType).split(/[\s,]+/).filter(w => w.length > 2);
          const ddScored = ddDocsRes.map(f => ({ f, score: ddKws.filter(k => f.includes(k)).length })).sort((a,b) => b.score-a.score).slice(0,3);
          for (const { f } of ddScored) {
            const rr = await Platform.readLibraryDoc({ folderName: ddFolder, fileName: f });
            if (!rr || rr.error) continue;
            ddRefs.push({ name: f, text: (rr.text||'').substring(0,5000) });
          }
          if (!ddRefs.length) ddNoLibNote = '\n[לא ניתן לקרוא קבצים מהספרייה – נוסח מידע משפטי בלבד]';
        }

        // Get case data
        let ddCaseCtx = '';
        const ddCaseObj = input.caseId ? db.cases.find(x => x.id === input.caseId) : null;
        if (ddCaseObj) {
          ddCaseCtx = '\n\n=== נתוני התיק ===\n' + (await agentExecTool('getCaseDetails', { caseId: input.caseId }));
        }

        // Party roles (court vs enforcement)
        const ddIsHp = ddType.includes('הוצאה לפועל') || ddType.includes('ל"פ');
        const ddPlaintiffLabel = ddIsHp ? 'הזוכה' : 'התובע';
        const ddDefendantLabel = ddIsHp ? 'החייב' : 'הנתבע';
        const ddClientName = ddCaseObj && ddCaseObj.client ? (db.clients.find(x=>x.id===ddCaseObj.client)||{}).name||'' : '';
        const ddDebtorName = ddCaseObj ? (ddCaseObj.debtorName||'') : '';
        const ddCaseNum = ddCaseObj ? (ddCaseObj.caseSubNumber||ddCaseObj.number||'') : '';

        // Build prompt with structured output markers
        const ddRefBlock = ddRefs.length ? '## מסמכי עיון:\n' + ddRefs.map(r => `### ${r.name}\n${r.text}`).join('\n\n---\n\n') + '\n\n' : '';
        const ddPartyBlock = ddCaseObj ? `צדדים: ${ddPlaintiffLabel}=${ddClientName}, ${ddDefendantLabel}=${ddDebtorName}, תיק: ${ddCaseNum}\n` : '';
        const ddPrompt = `${ddRefBlock}${ddCaseCtx?ddCaseCtx+'\n\n':''}${ddPartyBlock}
## הוראות: ${ddType} – ${input.instructions}

## פורמט פלט חובה (אין להוסיף טקסט מחוץ לסמנים):
##TITLE## [כותרת המסמך]
##OPEN## [פסקת פתיחה: "בית המשפט הנכבד מתבקש בזאת..."]
##ARGUES## ואילו נימוקי הבקשה:
##ARG## [טיעון ראשון]
##ARG## [טיעון שני]
##CLOSE## מן הדין ומן הצדק להיעתר לבקשה.
##SIGN## ${OFFICE.name}, עו"ד

לציטוטים: ##QUOTE## טקסט ##ENDQUOTE##`;

        // Inner Claude call to draft
        const ddData = await Platform.callAI({ model:'claude-sonnet-4-6', max_tokens:4000, system:'אתה עורך דין מומחה בישראל. נסח מסמכים משפטיים בעברית בלבד. עקוב בדיוק אחר פורמט הסמנים שהוגדר.', messages:[{role:'user',content:ddPrompt}] });
        if (ddData.error) return `שגיאת API בניסוח: ${ddData.error}`;
        const ddText = (ddData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
        if (!ddText) return 'לא התקבל תוכן מהסוכן';

        // Build Type-3 docx
        const MARGIN = 1418, HL = 32, TL = 36;
        const FNT = { name: 'David', cs: 'David' };
        const LANG = { value: 'he-IL', eastAsia: 'he-IL', bidi: 'he-IL' };

        function ddRun(text, opts={}) {
          const o = { text:String(text||''), bold:!!opts.bold, size:opts.size||HL, font:FNT, language:LANG, color:opts.color||'000000' };
          if (opts.underline) o.underline = { type: UnderlineType.SINGLE };
          return new TextRun(o);
        }
        function ddPara(children, opts={}) {
          const al = opts.center ? AlignmentType.CENTER : opts.right ? AlignmentType.RIGHT : AlignmentType.JUSTIFIED;
          const p = { bidirectional:true, alignment:al, spacing:{line:276,lineRule:LineRuleType.AUTO,after:opts.after!==undefined?opts.after:240,before:opts.before||0} };
          if (opts.numbering) p.numbering = opts.numbering;
          if (opts.indent) p.indent = opts.indent;
          if (opts.border) p.border = opts.border;
          p.children = Array.isArray(children) ? children : [ddRun(children, opts)];
          return new Paragraph(p);
        }

        const ddDate = new Date().toLocaleDateString('he-IL');
        const ddChildren = [
          ddPara([ddRun(OFFICE.title,{bold:true,size:TL})],{center:true,after:60,line:240,border:{bottom:{style:BorderStyle.SINGLE,size:4,color:'3333AA'}}}),
          ddPara([ddRun(`רח' ${OFFICE.address} | טל': ${OFFICE.phone} | ${OFFICE.email} | רישיון: ${OFFICE.license}`,{size:20,color:'555555'})],{center:true,after:240,line:240}),
        ];
        if (ddCaseObj) {
          ddChildren.push(ddPara([ddRun(`${ddPlaintiffLabel}: ${ddClientName}`)],{right:true,after:0}));
          ddChildren.push(ddPara([ddRun(`${ddDefendantLabel}: ${ddDebtorName}`)],{right:true,after:0}));
          if (ddCaseNum) ddChildren.push(ddPara([ddRun(`מספר תיק: ${ddCaseNum}`)],{right:true,after:0}));
          ddChildren.push(ddPara([ddRun('',{size:HL})],{after:0}));
        }
        ddChildren.push(ddPara([ddRun(ddDate,{size:20,color:'555555'})],{right:true,after:240,line:240}));

        // Parse Claude output with structured markers
        let ddInQuote = false, ddQuoteAccum = [], ddHasClose = false;
        for (const rawLine of ddText.split('\n')) {
          const line = rawLine.trim();
          if (line.startsWith('##TITLE##')) {
            const t = line.slice(9).trim();
            ddChildren.push(ddPara([ddRun(t,{bold:true,size:TL,underline:true})],{center:true,after:60}));
            ddChildren.push(ddPara([ddRun('',{size:HL})],{after:0}));
          } else if (line.startsWith('##OPEN##')) {
            ddChildren.push(ddPara(line.slice(8).trim()));
          } else if (line.startsWith('##ARGUES##')) {
            ddChildren.push(ddPara([ddRun((line.slice(10).trim()||'ואילו נימוקי הבקשה:'),{bold:true})],{right:true,after:120}));
          } else if (line.startsWith('##ARG##')) {
            ddChildren.push(new Paragraph({bidirectional:true,alignment:AlignmentType.JUSTIFIED,spacing:{line:276,lineRule:LineRuleType.AUTO,after:240},numbering:{reference:'motion-num',level:0},children:[ddRun(line.slice(7).trim())]}));
          } else if (line.startsWith('##CLOSE##')) {
            ddHasClose = true;
            ddChildren.push(ddPara(line.slice(9).trim()||'מן הדין ומן הצדק להיעתר לבקשה.'));
          } else if (line.startsWith('##SIGN##')) {
            const t = line.slice(8).trim();
            if (t) ddChildren.push(ddPara([ddRun(t)],{right:true}));
          } else if (line.startsWith('##QUOTE##')) {
            ddInQuote = true;
            const t = line.slice(9).trim();
            ddQuoteAccum = t ? [t] : [];
          } else if (line === '##ENDQUOTE##') {
            if (ddQuoteAccum.length) ddChildren.push(ddPara([ddRun(ddQuoteAccum.join(' '))],{indent:{left:540,right:540}}));
            ddInQuote = false; ddQuoteAccum = [];
          } else if (ddInQuote) {
            if (line) ddQuoteAccum.push(line);
          } else if (!line) {
            ddChildren.push(ddPara([ddRun('',{size:HL})],{after:0}));
          } else {
            ddChildren.push(ddPara(line));
          }
        }
        if (!ddHasClose) {
          ddChildren.push(ddPara([ddRun('',{size:HL})],{after:0}));
          ddChildren.push(ddPara('מן הדין ומן הצדק להיעתר לבקשה.'));
        }

        const ddDoc = new Document({
          numbering: { config: [{ reference:'motion-num', levels:[{ level:0, format:LevelFormat.DECIMAL, text:'%1.', alignment:AlignmentType.START, style:{ paragraph:{indent:{left:714,hanging:357},bidirectional:true,spacing:{line:276,lineRule:LineRuleType.AUTO,after:240}}, run:{font:FNT,size:HL,language:LANG} } }] }] },
          sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:MARGIN,right:MARGIN,bottom:MARGIN,left:MARGIN,header:709,footer:709}},rtl:true},children:ddChildren}]
        });
        const ddBuf = await Packer.toBuffer(ddDoc);
        const ddLabel = ddCaseObj ? (ddCaseObj.caseSubNumber||ddCaseObj.name) : 'כללי';
        const ddSafeType = ddType.replace(/[\\/:*?"<>|]/g,'_');
        const ddFilename = `${ddSafeType} – ${ddLabel} – ${ddDate}.docx`.replace(/[\\/:*?"<>|]/g,'_');
        const ddFilePath = await Platform.saveFile({ buffer:Array.from(ddBuf), filename:ddFilename });
        if (ddCaseObj) {
          if (!db.docs) db.docs = [];
          db.docs.push({ id:uid(), caseId:input.caseId, name:ddFilename, ext:'docx', cat:ddType, date:ddDate, notes:'נוצר ע"י סוכן AI', filePath:ddFilePath });
          saveDB();
        }
        notify('טיוטה נשמרה! פותח...');
        await Platform.openFile(ddFilePath, ddFilename);
        const ddSub = ddCaseObj && ddCaseObj.caseSubNumber ? ` [${ddCaseObj.caseSubNumber}]` : '';
        return `✅ טיוטת "${ddType}" נשמרה ונפתחה${ddSub}${ddNoLibNote}`;
      }
      case 'generateReport': {
        const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle } = __req('docx');
        const grDate=new Date().toLocaleDateString('he-IL');
        function grP(text,opts={}){return new Paragraph({alignment:opts.center?AlignmentType.CENTER:AlignmentType.RIGHT,spacing:{after:opts.after||80,before:opts.before||0},children:[new TextRun({text:String(text||''),bold:opts.bold||false,size:opts.size||22,font:'David',color:opts.color||'000000'})]});}
        const grChildren=[
          new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:60,before:0},border:{bottom:{style:BorderStyle.SINGLE,size:4,color:'3333AA'}},children:[new TextRun({text:OFFICE.title,bold:true,size:28,font:'David'})]}),
          new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:300},children:[new TextRun({text:grDate,size:20,font:'David',color:'555555'})]}),
          grP(input.title,{center:true,bold:true,size:34,color:'1a1a6b',after:400,before:100}),
        ];
        (input.content||'').split('\n').forEach(line=>{
          const isH=line.startsWith('---')||line.startsWith('===');
          const clean=line.replace(/^[-=]{3,}/,'').trim();
          if(!clean){grChildren.push(grP('',{after:60}));return;}
          grChildren.push(grP(clean,{bold:isH,size:isH?26:22,color:isH?'1a1a6b':'000000',after:isH?140:60,before:isH?180:0}));
        });
        const grDoc=new Document({sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:1134,right:1134,bottom:1134,left:1134}},rtl:true},children:grChildren}]});
        const grBuf=await Packer.toBuffer(grDoc);
        const grTitle=(input.title||'דוח').replace(/[\\/:*?"<>|]/g,'_');
        const grFilename=`${grTitle} – ${grDate}.docx`.replace(/[\\/:*?"<>|]/g,'_');
        const grPath=await Platform.saveFile({buffer:Array.from(grBuf),filename:grFilename});
        notify('הדוח נשמר! פותח...');
        await Platform.openFile(grPath, grFilename);
        return `✅ המסמך "${grFilename}" נשמר ונפתח`;
      }
      default: return 'שגיאה: כלי לא מוכר – ' + name;
    }
  } catch(e) { return 'שגיאה בביצוע: ' + e.message; }
}

async function agentUploadFile() {
  const result = await Platform.pickFile();
  if (!result) return;
  const { buffer, filename } = result;
  const ext = (filename.split('.').pop()||'').toLowerCase();
  agentAddBubble('user', '📎 ' + filename);
  if (buffer.length > 10 * 1024 * 1024) { agentAddBubble('assistant','⚠️ הקובץ גדול מדי (מקסימום 10MB)'); return; }
  const statusEl = agentAddStatus('מנתח מסמך...');
  try {
    let userContent;
    const extractPrompt = 'חלץ מהמסמך את כל הפרטים הרלוונטיים לתיק גבייה: שם לקוח, שם חייב, מספרי זהות/ח.פ, סכומים חוב, כתובות, תיאור החוב/עסקה. השב בעברית בפורמט ברור עם כותרות. אם הפרטים חסרים – ציין זאת.';
    if (['jpg','jpeg','png','gif','webp'].includes(ext)) {
      const mt = ext==='jpg'||ext==='jpeg'?'image/jpeg':ext==='png'?'image/png':ext==='gif'?'image/gif':'image/webp';
      const b64 = Buffer.from(buffer).toString('base64');
      userContent = [{ type:'image', source:{ type:'base64', media_type:mt, data:b64 } }, { type:'text', text:extractPrompt }];
    } else if (ext === 'pdf') {
      const b64 = Buffer.from(buffer).toString('base64');
      userContent = [{ type:'document', source:{ type:'base64', media_type:'application/pdf', data:b64 } }, { type:'text', text:extractPrompt }];
    } else {
      statusEl.remove();
      agentAddBubble('assistant', `⚠️ פורמט .${ext} אינו נתמך לחילוץ אוטומטי. תומך: PDF, JPG, PNG, GIF, WEBP.`);
      return;
    }
    const data = await Platform.callAI({ model:'claude-sonnet-4-6', max_tokens:2048, messages:[{ role:'user', content:userContent }] });
    if (data.error) throw new Error(data.error);
    const extracted = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
    statusEl.remove();
    const reply = `📄 חולץ מ"${filename}":\n\n${extracted}\n\n──────────\nהאם ליצור תיק עם הנתונים האלה? אם כן – כתב "כן, צור תיק" ואוסיף את הפרטים אוטומטית.`;
    agentAddBubble('assistant', reply);
    agentMessages.push({ role:'user', content:`[המשתמש העלה מסמך: ${filename}]` });
    agentMessages.push({ role:'assistant', content:`מצאתי את הנתונים הבאים במסמך:\n${extracted}\n\nהאם ליצור תיק?` });
  } catch(e) {
    statusEl.remove();
    agentAddBubble('assistant', 'שגיאה בניתוח המסמך: ' + e.message);
  }
}

// ===== INIT =====
// Called by auth.js once a Supabase session is confirmed (fresh login or restored session) —
// everything here needs Platform.loadDB() to succeed, which needs a signed-in user.
let currentRole = null; // 'owner' | 'lawyer' | 'secretary' — set in bootApp(), used for UI-level gating
let officeVatRate = 18; // updated in bootApp() from the office's actual configured rate
async function bootApp() {
  const tmNav = document.getElementById('nav-templates-item');
  if (tmNav) tmNav.style.display = '';
  loadDB();
  try {
    const office = await Platform.getOfficeInfo();
    officeVatRate = office.vat_rate ?? 18;
    const vatOption = document.getElementById('case-fee-vat-yes-option');
    if (vatOption) vatOption.textContent = `כן (+${officeVatRate}%)`;
  } catch (e) { /* keep the 18% default if this fails to load */ }
  try {
    currentRole = await Platform.getRole();
    // UI-level only (see supabase-schema-phase1.sql plan notes): a secretary's
    // finance nav entry is hidden, not database-blocked — RLS can't enforce this
    // under the current single-JSON-blob-per-office data model.
    if (currentRole === 'secretary') {
      document.querySelectorAll('.nav-item').forEach(n => {
        if (n.getAttribute('onclick') === "nav('finance',this)") n.style.display = 'none';
      });
    }
  } catch (e) { /* role lookup failing shouldn't block the rest of the app */ }
}
