// מרכז שיחות — צד לקוח.
//
// קובץ נפרד ולא הרחבה של app.js (שכבר מעל 300KB), נטען כ-<script> רגיל
// אחרי ai-center.js ו-automations.js. לכן יש לו גישה לכל הגלובלים שלהם
// ומשתמש בהם במקום לשכפל: db, escapeHtml, notify, customConfirm,
// openModal/closeModal, currentRole, openClientDetail, openCaseDetail —
// ומ-ai-center.js: aiSb, aiInvoke, aiUpdateChecked, aiJsAttr, aiOfficeId,
// aiFmtDate, aiRelTime; מ-automations.js: Stat.
//
// ## מה המשתמש רואה, ומה הוא לא צריך לדעת
// המפרט מפורש: משתמש ה-CRM לא אמור לדעת שקיימים Asterisk, Whisper, SIP
// או WebSockets. לכן אין כאן אף מונח כזה בממשק. מה שכן מוצג: מי התקשר,
// מה נאמר, מה ה-AI עשה, מה נוצר, ומה דורש טיפול. המונחים הטכניים חיים
// במסך "מצב מערכת" בלבד, ושם הם נחוצים — אדם שמנסה להבין למה אין שיחות
// צריך לדעת מה בדיוק לא מחובר.
//
// ## מה הקובץ הזה לא עושה
// הוא **לא כותב** לטבלאות השיחה. אין להן policy של insert/update מהדפדפן
// בכלל. כל יצירה ועדכון עוברים דרך Edge Function שמאמתת חתימה או JWT.
// מה שכן נכתב מכאן: הגדרות, סוכנים והרשאות כלים — דרך aiUpdateChecked,
// שמאמת שהשורה באמת נכתבה (RLS מסנן שורות ולא זורק שגיאה; עדכון שנחסם
// חוזר כ"הצלחה" עם אפס שורות, ובלי הבדיקה המסך היה משקר).

'use strict';

// ===== מצב =====
let ccTab = 'dashboard';
let ccRealtimeChannel = null;
let ccTimerInterval = null;
let ccStatusCache = null;
let ccCurrentCallId = null;
let ccSim = { callId: null, log: [], busy: false, providerMode: null, agentName: '' };
let ccHistory = { page: 0, pageSize: 25, total: 0, filters: {} };

const CC_PAGE = 25;

// ---- מילונים ----

const CC_STATUS_HE = {
  ringing: 'מצלצל', answering: 'עונה', active: 'בשיחה', on_hold: 'בהמתנה',
  transferring: 'בהעברה', completed: 'הסתיימה', failed: 'נכשלה', missed: 'לא נענתה',
};
const CC_STATUS_ICON = {
  ringing: '📞', answering: '🎧', active: '🔴', on_hold: '⏸',
  transferring: '↗', completed: '✓', failed: '✗', missed: '⚠',
};
const CC_URGENCY_HE = { low: 'נמוכה', normal: 'רגילה', high: 'גבוהה', critical: 'קריטית' };
const CC_SENTIMENT_HE = {
  positive: 'חיובי', neutral: 'ניטרלי', negative: 'שלילי', distressed: 'במצוקה',
};
const CC_OUTCOME_HE = {
  appointment_scheduled: 'נקבעה פגישה',
  callback_requested: 'נרשמה בקשת חזרה',
  task_created: 'נוצרה משימה',
  lead_created: 'נפתחה פנייה',
  information_only: 'מסירת מידע',
  partial_failure: 'טיפול חלקי',
  missed: 'לא נענתה',
};

/** ציר הזמן נקרא ע"י עורך דין, לא ע"י מפתח. כל אירוע מתורגם למשפט. */
const CC_EVENT_HE = {
  CALL_RECEIVED: 'שיחה התקבלה',
  CALL_ANSWERED: 'הסוכן ענה',
  CLIENT_LOOKUP: 'בוצע איתור לקוח',
  CLIENT_FOUND: 'לקוח נמצא',
  LEAD_LOOKUP: 'בוצע איתור פנייה קודמת',
  LEAD_CREATED: 'נפתחה פנייה',
  TASK_CREATED: 'נוצרה משימה',
  NOTE_CREATED: 'נרשמה הערה',
  CALENDAR_CHECK: 'נבדק יומן',
  APPOINTMENT_CREATED: 'נקבעה פגישה',
  MESSAGE_SENT: 'נשלחה הודעה',
  TRANSFER_REQUESTED: 'התבקשה העברה לנציג',
  TRANSFER_COMPLETED: 'ההעברה הושלמה',
  CALL_ENDED: 'שיחה הסתיימה',
  CALL_STATUS_CHANGED: 'שינוי מצב שיחה',
  CALLER_UTTERANCE: 'המתקשר דיבר',
  AGENT_REPLY: 'הסוכן השיב',
  URGENCY_DETECTED: 'זוהתה דחיפות',
  TOOL_EXECUTED: 'בוצעה פעולה',
  TOOL_FAILED: 'פעולה נכשלה',
  TOOL_BLOCKED: 'פעולה נחסמה',
  FOLLOWUP_TASK_CREATED: 'נוצרה משימת המשך',
  AGENT_DISABLED: 'המזכירה הדיגיטלית מושבתת',
};

const CC_TOOL_HE = {
  lookup_client: 'זיהוי לקוח',
  lookup_lead: 'איתור פנייה קודמת',
  create_lead: 'פתיחת פנייה',
  create_task: 'יצירת משימה',
  create_note: 'רישום הערה',
  check_calendar: 'בדיקת יומן',
  create_appointment: 'קביעת פגישה',
  send_message: 'שליחת הודעה',
  request_human_callback: 'בקשת חזרה מנציג',
  transfer_call: 'העברה לנציג',
};

const CC_TABS = [
  { id: 'dashboard', label: 'סקירה',     icon: '▦' },
  { id: 'calls',     label: 'היסטוריית שיחות', icon: '≡' },
  { id: 'agents',    label: 'סוכנים',    icon: '◈' },
  { id: 'simulator', label: 'מצב בדיקה', icon: '▶' },
  { id: 'system',    label: 'מצב מערכת', icon: '⚙' },
  { id: 'settings',  label: 'הגדרות',    icon: '☎' },
];

// ============================================================
// ניווט ושלד
// ============================================================

function renderCallCenter() {
  const tabsEl = document.getElementById('cc-tabs');
  const host = document.getElementById('cc-body');
  if (!tabsEl || !host) return;

  tabsEl.innerHTML = CC_TABS.map(t =>
    `<button class="tab${t.id === ccTab ? ' active' : ''}" onclick="ccNav('${t.id}')">` +
    `<span aria-hidden="true">${t.icon}</span> ${escapeHtml(t.label)}` +
    `<span class="ai-tab-count" id="cc-count-${t.id}"></span></button>`).join('');

  host.innerHTML = '<div class="empty">טוען…</div>';

  const fn = {
    dashboard: ccRenderDashboard, calls: ccRenderHistory, agents: ccRenderAgents,
    simulator: ccRenderSimulator, system: ccRenderSystem, settings: ccRenderSettings,
  }[ccTab];

  Promise.resolve().then(() => fn(host))
    // שגיאות Supabase נזרקות כאובייקט רגיל ולא כ-Error, ולכן e.message
    // עלול להיות undefined — הנפילה ל-String(e) מונעת מסך ריק בלי הסבר.
    .catch(e => { host.innerHTML = ccError((e && e.message) || String(e), e); });

  ccSubscribeRealtime();
  ccRefreshBadge();
}

function ccNav(tab) {
  ccTab = tab;
  // ה-nav-item של מרכז השיחות הוא האחרון בסיידבר (ראה ההערה ב-app.html).
  if (currentPanel !== 'call-center') {
    const item = document.getElementById('nav-call-center-item');
    nav('call-center', item);
    return;
  }
  renderCallCenter();
}

/**
 * נקרא מ-nav() ביציאה מהמסך.
 *
 * עוצר את הטיימר בלבד — setInterval של שנייה שממשיך לרוץ על פאנל מוסתר
 * הוא בזבוז נטו. ⚠ המנוי ל-Realtime **נשאר**: שיחה נכנסת היא הדבר שהכי
 * חשוב לראות דווקא כשנמצאים במסך אחר, וניתוק המנוי היה מקפיא את הסמן
 * בסיידבר בדיוק אז. הרינדור עצמו כבר מוגן ב-currentPanel.
 */
function ccOnLeave() {
  ccStopTimers();
}

/**
 * מופעל מ-refreshSidebar() ב-app.js — כלומר כבר בעליית המערכת, ולא רק
 * אחרי שנכנסים למרכז השיחות. זה מה שהופך את הסמן "☎ 2 שיחות פעילות"
 * לנראה מכל מסך.
 *
 * הכל מוגן בדגל: refreshSidebar נקרא אחרי **כל** שמירה, ושאילתת ספירה
 * בכל שמירה הייתה עומס מיותר. אחרי המנוי הראשון, Realtime הוא שמעדכן.
 */
let ccBadgeInitialized = false;
function ccOnSidebarRefresh() {
  if (ccBadgeInitialized) return;
  if (!window.supabaseClient) return;
  ccBadgeInitialized = true;
  ccSubscribeRealtime();
  ccRefreshBadge();
}

function ccError(msg, err) {
  const code = err && (err.code || (err.cause && err.cause.code));
  const missingTable = code === '42P01' ||
    /relation .* does not exist|could not find the table/i.test(msg || '');
  if (missingTable) {
    return `<div class="alert alert-warning">
      <strong>מרכז השיחות טרם הותקן.</strong>
      <div style="margin-top:6px">טבלאות המערכת לא נמצאו במסד הנתונים. יש להריץ את המיגרציות:</div>
      <pre class="ai-payload" style="margin-top:8px">supabase db push</pre>
      <div class="cc-muted">ההוראות המלאות: <code>docs/AI_CALL_CENTER.md</code></div>
      <div style="margin-top:8px"><button class="btn btn-sm" onclick="renderCallCenter()">↻ בדוק שוב</button></div>
    </div>`;
  }
  if (code === '42501' || /permission denied|row-level security/i.test(msg || '')) {
    return `<div class="alert alert-warning"><strong>אין לך הרשאה לפעולה זו.</strong>
      <div class="cc-muted" style="margin-top:6px">הגדרות המזכירה הדיגיטלית זמינות לבעל המשרד בלבד.</div></div>`;
  }
  return `<div class="alert alert-danger"><strong>שגיאה:</strong> ${escapeHtml(msg)}
    <div style="margin-top:8px"><button class="btn btn-sm" onclick="renderCallCenter()">↻ נסה שוב</button></div></div>`;
}

// ============================================================
// רכיבים
// ============================================================

function UrgencyBadge(u) {
  const k = CC_URGENCY_HE[u] ? u : 'normal';
  const icon = { low: '○', normal: '◔', high: '▲', critical: '●' }[k];
  return `<span class="cc-urg cc-urg-${k}">${icon} דחיפות ${CC_URGENCY_HE[k]}</span>`;
}

/** סטטוס תמיד עם טקסט ואייקון, לא בצבע בלבד — נגישות. */
function CallStatusBadge(s) {
  const cls = ['completed'].includes(s) ? 'active'
    : ['failed', 'missed'].includes(s) ? 'urgent'
    : ['ringing', 'answering', 'active', 'on_hold', 'transferring'].includes(s) ? 'pending' : 'closed';
  return `<span class="badge badge-${cls}">${CC_STATUS_ICON[s] || '•'} ${CC_STATUS_HE[s] || escapeHtml(s || '')}</span>`;
}

/** מספר טלפון — תמיד LTR בתוך משפט עברי, אחרת הספרות מתהפכות בתצוגה. */
function Phone(p) {
  return p ? `<span class="cc-num">${escapeHtml(p)}</span>` : '—';
}

function ccDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function ccCallerLabel(call) {
  if (call.client_id) {
    const c = (db.clients || []).find(x => x.id === call.client_id);
    if (c) return c.name;
  }
  if (call.lead_id) {
    const l = (db.leads || []).find(x => x.id === call.lead_id);
    if (l && l.name) return l.name;
  }
  return call.caller_phone || 'מתקשר לא מזוהה';
}

function ccEmpty(title, sub, cta) {
  return `<div class="empty-main"><div class="empty-main-icon">☎</div>
    <div class="empty-main-title">${escapeHtml(title)}</div>
    <div class="empty-main-sub">${escapeHtml(sub || '')}</div>${cta || ''}</div>`;
}

const CC_ACTIVE_STATUSES = ['ringing', 'answering', 'active', 'on_hold', 'transferring'];

// ============================================================
// סקירה
// ============================================================

async function ccRenderDashboard(host) {
  const officeId = await aiOfficeId();
  const [statsRes, activeRes, recentRes] = await Promise.all([
    aiSb().rpc('call_center_stats', { p_office_id: officeId }),
    aiSb().from('call_sessions').select('*')
      .in('status', CC_ACTIVE_STATUSES).order('started_at', { ascending: false }),
    aiSb().from('call_sessions').select('*')
      .order('started_at', { ascending: false }).limit(8),
  ]);
  if (statsRes.error) throw statsRes.error;
  if (activeRes.error) throw activeRes.error;

  const s = statsRes.data || {};
  const active = activeRes.data || [];
  const recent = recentRes.data || [];

  const gwState = s.gateway_state || 'never_connected';
  const gwLabel = {
    online: '🟢 מחובר', degraded: '🟡 לא יציב',
    offline: '🔴 מנותק', never_connected: '🟡 טרם חובר',
  }[gwState] || gwState;

  host.innerHTML = `
    ${gwState !== 'online' ? `<div class="alert alert-info" style="margin-bottom:14px">
      <strong>שרת הטלפוניה ${gwState === 'never_connected' ? 'טרם חובר' : 'אינו מחובר'}.</strong>
      <div style="margin-top:4px">שיחות טלפון אמיתיות עדיין אינן מתקבלות. אפשר לבדוק את המערכת
      במלואה דרך <button class="btn btn-sm" onclick="ccNav('simulator')">מצב בדיקה</button></div>
    </div>` : ''}

    <div class="stats-grid stats-grid-6">
      ${Stat('שיחות היום', s.calls_today ?? 0, '')}
      ${Stat('שיחות פעילות', s.calls_active ?? 0, s.calls_active ? 'עכשיו' : '', Number(s.calls_active) > 0)}
      ${Stat('לידים חדשים', s.leads_today ?? 0, 'נוצרו היום')}
      ${Stat('פגישות שנקבעו', s.appointments_today ?? 0, `${s.appointments_week ?? 0} השבוע`)}
      ${Stat('משימות שנוצרו', s.tasks_today ?? 0, 'היום')}
      ${Stat('דורש טיפול', s.requires_attention ?? 0, '14 ימים אחרונים', Number(s.requires_attention) > 0)}
    </div>

    <div class="ai-section-title" style="margin-top:20px">שיחות פעילות עכשיו</div>
    <div id="cc-active-wrap">${ccActiveCallsHtml(active)}</div>

    <div class="ai-section-title" style="margin-top:22px">שיחות אחרונות</div>
    <div class="card">
      ${recent.length ? ccCallsTable(recent, { compact: true }) :
        '<div class="empty">טרם התקבלו שיחות.</div>'}
      ${recent.length ? `<div style="margin-top:10px;text-align:center">
        <button class="btn btn-sm" onclick="ccNav('calls')">כל השיחות ←</button></div>` : ''}
    </div>

    <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <span class="cc-muted">מצב שרת הטלפוניה: ${gwLabel}</span>
      <button class="btn btn-sm" onclick="ccNav('system')">מצב מערכת ←</button>
    </div>`;

  ccStartTimers();
}

function ccActiveCallsHtml(active) {
  if (!active.length) {
    return `<div class="card"><div class="empty">אין שיחות פעילות כרגע.</div></div>`;
  }
  return `<div class="cc-live-grid">${active.map(ccLiveCard).join('')}</div>`;
}

function ccLiveCard(call) {
  const name = ccCallerLabel(call);
  const state = ccLiveStateText(call);
  return `<div class="cc-live cc-u-${escapeHtml(call.urgency || 'normal')}">
    <div class="cc-live-head">
      <div style="min-width:0">
        <div class="cc-live-name"><span class="cc-dot" aria-hidden="true"></span>${escapeHtml(name)}</div>
        <div class="cc-live-phone">${escapeHtml(call.caller_phone || '')}</div>
      </div>
      <div class="cc-live-timer" data-cc-timer="${escapeHtml(call.started_at)}">00:00</div>
    </div>
    <div class="cc-live-meta">
      ${CallStatusBadge(call.status)}
      ${call.category ? `<span class="badge badge-pending">${escapeHtml(call.category)}</span>` : ''}
      ${UrgencyBadge(call.urgency)}
      ${call.is_simulation ? '<span class="badge badge-closed">בדיקה</span>' : ''}
    </div>
    <div class="cc-live-state">${escapeHtml(state)}</div>
    <div class="cc-live-actions">
      <button class="btn btn-sm btn-primary" onclick="ccOpenCall(${aiJsAttr(call.id)})">פתח שיחה</button>
      ${call.client_id ? `<button class="btn btn-sm" onclick="ccOpenClient(${aiJsAttr(call.client_id)})">פתח לקוח</button>` : ''}
      <button class="btn btn-sm" onclick="ccQuickTask(${aiJsAttr(call.id)})">צור משימה</button>
      <button class="btn btn-sm btn-warning" onclick="ccRequestTransfer(${aiJsAttr(call.id)})">בקש העברה לנציג</button>
    </div>
  </div>`;
}

/** "מה קורה עכשיו" בשפה של אדם, לא בשם הסטטוס. */
function ccLiveStateText(call) {
  const agentName = 'מזכירת המשרד';
  if (call.status === 'ringing') return 'השיחה מצלצלת';
  if (call.status === 'answering') return `${agentName} עונה לשיחה`;
  if (call.status === 'on_hold') return 'המתקשר בהמתנה';
  if (call.status === 'transferring') return 'השיחה מועברת לנציג';
  if (call.client_id) return `${agentName} מטפלת בפניית לקוח קיים`;
  if (call.lead_id) return `${agentName} אוספת פרטים לפנייה חדשה`;
  return `${agentName} אוספת פרטים`;
}

// ---- טיימר לשיחות פעילות ----

function ccStartTimers() {
  ccStopTimers();
  const tick = () => {
    const els = document.querySelectorAll('[data-cc-timer]');
    if (!els.length) return;
    const now = Date.now();
    els.forEach(el => {
      const start = Date.parse(el.getAttribute('data-cc-timer'));
      if (!isFinite(start)) return;
      el.textContent = ccDuration((now - start) / 1000);
    });
  };
  tick();
  ccTimerInterval = setInterval(tick, 1000);
}

function ccStopTimers() {
  if (ccTimerInterval) { clearInterval(ccTimerInterval); ccTimerInterval = null; }
}

// ============================================================
// היסטוריית שיחות
// ============================================================

async function ccRenderHistory(host) {
  const f = ccHistory.filters;
  const from = ccHistory.page * ccHistory.pageSize;

  let q = aiSb().from('call_sessions').select('*', { count: 'exact' });
  if (f.from) q = q.gte('started_at', f.from + 'T00:00:00');
  if (f.to) q = q.lte('started_at', f.to + 'T23:59:59');
  if (f.urgency) q = q.eq('urgency', f.urgency);
  if (f.category) q = q.eq('category', f.category);
  if (f.outcome) q = q.eq('outcome', f.outcome);
  if (f.agent) q = q.eq('agent_id', f.agent);
  if (f.client) q = q.eq('client_id', f.client);
  // ilike על מספר: המשתמש מקליד "1234567" ולא "+972501234567".
  if (f.search) q = q.ilike('caller_phone', '%' + f.search.replace(/[%_]/g, '') + '%');
  if (!f.includeSimulations) q = q.eq('is_simulation', false);

  const { data, count, error } = await q
    .order('started_at', { ascending: false })
    .range(from, from + ccHistory.pageSize - 1);
  if (error) throw error;

  ccHistory.total = count || 0;
  const { data: agents } = await aiSb().from('voice_agents').select('id,name');
  const categories = [...new Set((data || []).map(c => c.category).filter(Boolean))];

  const pages = Math.max(1, Math.ceil(ccHistory.total / ccHistory.pageSize));

  host.innerHTML = `
    <div class="cc-filters">
      <input class="form-input" type="date" id="cc-f-from" value="${escapeHtml(f.from || '')}" onchange="ccApplyFilters()" title="מתאריך">
      <input class="form-input" type="date" id="cc-f-to" value="${escapeHtml(f.to || '')}" onchange="ccApplyFilters()" title="עד תאריך">
      <input class="form-input" id="cc-f-search" placeholder="חיפוש לפי מספר…" value="${escapeHtml(f.search || '')}" onchange="ccApplyFilters()">
      <select class="form-input" id="cc-f-urgency" onchange="ccApplyFilters()">
        <option value="">כל רמות הדחיפות</option>
        ${Object.entries(CC_URGENCY_HE).map(([k, v]) =>
          `<option value="${k}"${f.urgency === k ? ' selected' : ''}>${v}</option>`).join('')}
      </select>
      <select class="form-input" id="cc-f-category" onchange="ccApplyFilters()">
        <option value="">כל התחומים</option>
        ${categories.map(c => `<option value="${escapeHtml(c)}"${f.category === c ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}
      </select>
      <select class="form-input" id="cc-f-outcome" onchange="ccApplyFilters()">
        <option value="">כל התוצאות</option>
        ${Object.entries(CC_OUTCOME_HE).map(([k, v]) =>
          `<option value="${k}"${f.outcome === k ? ' selected' : ''}>${v}</option>`).join('')}
      </select>
      <select class="form-input" id="cc-f-client" onchange="ccApplyFilters()">
        <option value="">כל הלקוחות</option>
        ${(db.clients || []).slice()
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'he'))
          .map(c => `<option value="${escapeHtml(c.id)}"${f.client === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
      </select>
      <select class="form-input" id="cc-f-agent" onchange="ccApplyFilters()">
        <option value="">כל הסוכנים</option>
        ${(agents || []).map(a => `<option value="${escapeHtml(a.id)}"${f.agent === a.id ? ' selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
      </select>
      <label class="ai-switch"><input type="checkbox" id="cc-f-sim" ${f.includeSimulations ? 'checked' : ''} onchange="ccApplyFilters()"> הצג שיחות בדיקה</label>
      <button class="btn btn-sm" onclick="ccClearFilters()">נקה</button>
    </div>

    <div class="card">
      ${(data || []).length ? ccCallsTable(data, { agents }) :
        ccEmpty('לא נמצאו שיחות', 'נסה לשנות את הסינון, או להריץ שיחת בדיקה.',
          '<button class="btn btn-primary" style="margin-top:12px" onclick="ccNav(\'simulator\')">▶ מצב בדיקה</button>')}
    </div>

    ${ccHistory.total > ccHistory.pageSize ? `<div class="cc-pager">
      <button class="btn btn-sm" ${ccHistory.page === 0 ? 'disabled' : ''} onclick="ccPage(-1)">→ הקודם</button>
      <span>עמוד ${ccHistory.page + 1} מתוך ${pages} · ${ccHistory.total} שיחות</span>
      <button class="btn btn-sm" ${ccHistory.page + 1 >= pages ? 'disabled' : ''} onclick="ccPage(1)">הבא ←</button>
    </div>` : `<div class="cc-pager"><span>${ccHistory.total} שיחות</span></div>`}`;
}

function ccCallsTable(calls, opts) {
  const compact = opts && opts.compact;
  // שם הסוכן מהשורה ולא מחרוזת קבועה: ברגע שיוגדר סוכן שני, טבלה
  // שמדפיסה תמיד "מזכירת המשרד" מייחסת שיחות לסוכן הלא נכון.
  const agentNames = new Map(((opts && opts.agents) || []).map(a => [a.id, a.name]));
  return `<table class="data-table">
    <thead><tr>
      <th>תאריך ושעה</th><th>מתקשר</th><th>מספר</th>
      ${compact ? '' : '<th>סוג</th>'}
      <th>משך</th><th>תחום</th><th>דחיפות</th><th>תוצאה</th>
      ${compact ? '' : '<th>סוכן</th>'}
      <th></th>
    </tr></thead>
    <tbody>${calls.map(c => `<tr>
      <td style="white-space:nowrap">${aiFmtDate(c.started_at)}</td>
      <td><b style="color:var(--navy)">${escapeHtml(ccCallerLabel(c))}</b>
        ${c.is_simulation ? ' <span class="badge badge-closed">בדיקה</span>' : ''}
        ${c.manual_followup_required ? ' <span class="badge badge-urgent">דורש טיפול</span>' : ''}</td>
      <td>${Phone(c.caller_phone)}</td>
      ${compact ? '' : `<td>${c.direction === 'outbound' ? 'יוצאת' : 'נכנסת'}</td>`}
      <td><span class="cc-num">${ccDuration(c.duration_seconds)}</span></td>
      <td>${escapeHtml(c.category || '—')}</td>
      <td>${UrgencyBadge(c.urgency)}</td>
      <td>${c.status === 'completed' ? escapeHtml(CC_OUTCOME_HE[c.outcome] || c.outcome || '—') : CallStatusBadge(c.status)}</td>
      ${compact ? '' : `<td class="cc-muted">${escapeHtml(agentNames.get(c.agent_id) || (c.agent_id ? 'סוכן' : '—'))}</td>`}
      <td><button class="btn btn-sm" onclick="ccOpenCall(${aiJsAttr(c.id)})">פתח</button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function ccApplyFilters() {
  const v = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  ccHistory.filters = {
    from: v('cc-f-from'), to: v('cc-f-to'), search: v('cc-f-search').trim(),
    urgency: v('cc-f-urgency'), category: v('cc-f-category'),
    outcome: v('cc-f-outcome'), agent: v('cc-f-agent'), client: v('cc-f-client'),
    includeSimulations: (document.getElementById('cc-f-sim') || {}).checked || false,
  };
  ccHistory.page = 0;
  renderCallCenter();
}

function ccClearFilters() {
  ccHistory.filters = {};
  ccHistory.page = 0;
  renderCallCenter();
}

function ccPage(delta) {
  const pages = Math.max(1, Math.ceil(ccHistory.total / ccHistory.pageSize));
  ccHistory.page = Math.min(pages - 1, Math.max(0, ccHistory.page + delta));
  renderCallCenter();
}

// ============================================================
// פרטי שיחה
// ============================================================

async function ccOpenCall(callId) {
  ccCurrentCallId = callId;
  openModal('modal-call-detail');
  document.getElementById('cc-detail-body').innerHTML = '<div class="empty">טוען…</div>';
  await ccRefreshCallDetail();
}

async function ccRefreshCallDetail() {
  const callId = ccCurrentCallId;
  if (!callId) return;
  const body = document.getElementById('cc-detail-body');
  if (!body) return;

  try {
    const [callRes, evRes, segRes, actRes] = await Promise.all([
      aiSb().from('call_sessions').select('*').eq('id', callId).maybeSingle(),
      aiSb().from('call_events').select('*').eq('call_id', callId).order('occurred_at'),
      aiSb().from('call_transcript_segments').select('*').eq('call_id', callId).order('sequence'),
      aiSb().from('call_actions').select('*').eq('call_id', callId).order('started_at'),
    ]);
    if (callRes.error) throw callRes.error;
    const call = callRes.data;
    if (!call) { body.innerHTML = '<div class="empty">השיחה לא נמצאה.</div>'; return; }

    document.getElementById('cc-detail-title').textContent =
      `שיחה · ${ccCallerLabel(call)}`;

    body.innerHTML = ccCallDetailHtml(call, evRes.data || [], segRes.data || [], actRes.data || []);
    ccStartTimers();
  } catch (e) {
    body.innerHTML = ccError((e && e.message) || String(e), e);
  }
}

function ccCallDetailHtml(call, events, segments, actions) {
  const failed = actions.filter(a => a.status === 'failed' || a.status === 'blocked');

  return `
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px">
      ${CallStatusBadge(call.status)}
      ${UrgencyBadge(call.urgency)}
      ${call.category ? `<span class="badge badge-pending">${escapeHtml(call.category)}</span>` : ''}
      ${call.sentiment ? `<span class="badge badge-closed">רגש: ${escapeHtml(CC_SENTIMENT_HE[call.sentiment] || call.sentiment)}</span>` : ''}
      ${call.is_simulation ? '<span class="badge badge-closed">שיחת בדיקה</span>' : ''}
      <span style="margin-right:auto" class="cc-muted">
        ${aiFmtDate(call.started_at)} · משך <span class="cc-num">${
          CC_ACTIVE_STATUSES.includes(call.status)
            ? `<span data-cc-timer="${escapeHtml(call.started_at)}">00:00</span>`
            : ccDuration(call.duration_seconds)}</span></span>
    </div>

    <div class="two-col" style="margin-bottom:14px">
      <div class="card">
        <div class="card-title">פרטי המתקשר</div>
        <div style="font-size:13px;line-height:2">
          <div>שם: <b>${escapeHtml(ccCallerLabel(call))}</b></div>
          <div>מספר: ${Phone(call.caller_phone)}</div>
          <div>יעד: ${Phone(call.called_phone)}</div>
          <div>כיוון: ${call.direction === 'outbound' ? 'יוצאת' : 'נכנסת'}</div>
        </div>
        <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
          ${call.client_id ? `<button class="btn btn-sm" onclick="ccOpenClient(${aiJsAttr(call.client_id)})">פתח כרטיס לקוח</button>` : ''}
          ${call.matter_id ? `<button class="btn btn-sm" onclick="ccOpenCase(${aiJsAttr(call.matter_id)})">פתח תיק</button>` : ''}
          ${call.lead_id ? `<span class="badge badge-active">נוצרה פנייה</span>` : ''}
        </div>
      </div>
      <div class="card">
        <div class="card-title">סיכום השיחה</div>
        ${call.summary
          ? `<div style="font-size:13.5px;line-height:1.75">${escapeHtml(call.summary)}</div>`
          : `<div class="cc-muted">${CC_ACTIVE_STATUSES.includes(call.status)
              ? 'הסיכום ייווצר בסיום השיחה.' : 'לא נוצר סיכום.'}</div>`}
        ${call.outcome ? `<div style="margin-top:10px"><span class="badge badge-active">
          תוצאה: ${escapeHtml(CC_OUTCOME_HE[call.outcome] || call.outcome)}</span></div>` : ''}
        ${call.manual_followup_required ? `<div class="alert alert-warning" style="margin-top:10px">
          <strong>דורש טיפול ידני.</strong>
          <div style="margin-top:3px">${escapeHtml(call.followup_reason || 'לא כל הפעולות הושלמו אוטומטית.')}</div>
        </div>` : ''}
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="card-title">ציר זמן</div>
        ${events.length ? `<div class="cc-timeline">${events.map(ccTimelineItem).join('')}</div>`
          : '<div class="cc-muted">אין אירועים.</div>'}
      </div>
      <div class="card">
        <div class="card-title">פעולות שבוצעו</div>
        ${actions.length ? actions.map(ccActionRow).join('')
          : '<div class="cc-muted">לא בוצעו פעולות במערכת.</div>'}
        ${failed.length ? `<div class="alert alert-danger" style="margin-top:10px">
          ${failed.length} פעולות לא הושלמו. הפרטים מופיעים לידן.</div>` : ''}
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-title">תמלול השיחה</div>
      ${segments.length ? ccTranscriptHtml(segments, actions)
        : '<div class="cc-muted">אין תמלול לשיחה זו.</div>'}
    </div>`;
}

function ccTimelineItem(ev) {
  const t = new Date(ev.occurred_at);
  const time = t.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = ev.payload || {};
  const cls = ['TOOL_FAILED', 'TOOL_BLOCKED'].includes(ev.event_type) ? 'cc-tl-fail'
    : ['LEAD_CREATED', 'TASK_CREATED', 'APPOINTMENT_CREATED', 'CLIENT_FOUND', 'URGENCY_DETECTED'].includes(ev.event_type) ? 'cc-tl-key'
    : 'cc-tl-ok';

  let sub = '';
  if (ev.event_type === 'CLIENT_FOUND' && p.name) sub = escapeHtml(p.name);
  else if (ev.event_type === 'URGENCY_DETECTED') {
    sub = escapeHtml([CC_URGENCY_HE[p.urgency] || p.urgency, (p.reasons || []).join('; ')]
      .filter(Boolean).join(' · '));
  } else if (p.message) sub = escapeHtml(String(p.message));
  else if (p.tool) sub = escapeHtml(CC_TOOL_HE[p.tool] || p.tool);

  return `<div class="cc-tl-item ${cls}">
    <div class="cc-tl-time">${escapeHtml(time)}</div>
    <div>
      <div class="cc-tl-text">${escapeHtml(CC_EVENT_HE[ev.event_type] || ev.event_type)}</div>
      ${sub ? `<div class="cc-tl-sub">${sub}</div>` : ''}
    </div>
  </div>`;
}

function ccActionRow(a) {
  const cls = a.status === 'success' ? 'cc-action-ok'
    : a.status === 'blocked' ? 'cc-action-blocked' : 'cc-action-fail';
  const icon = a.status === 'success' ? '✓' : a.status === 'blocked' ? '⛔' : '🔴';
  const resp = a.response_payload || {};
  const link = ccEntityLink(a);
  return `<div class="cc-action ${cls}">
    <div class="cc-action-icon" aria-hidden="true">${icon}</div>
    <div class="cc-action-body">
      <div><b>${escapeHtml(CC_TOOL_HE[a.tool_name] || a.tool_name)}</b>
        ${link ? ' · ' + link : ''}</div>
      ${a.status === 'success'
        ? `<div class="cc-muted">${escapeHtml(String(resp.message || ''))}</div>`
        : `<div class="cc-action-reason">${escapeHtml(a.error || resp.message || 'הפעולה לא הושלמה')}</div>`}
    </div>
  </div>`;
}

/** קישור ישיר לישות שנוצרה — הדבר הראשון שרוצים ללחוץ עליו. */
function ccEntityLink(a) {
  if (a.status !== 'success' || !a.entity_id) return '';
  if (a.entity_type === 'client') {
    return `<button class="btn btn-sm" onclick="ccOpenClient(${aiJsAttr(a.entity_id)})">פתח לקוח</button>`;
  }
  if (a.entity_type === 'matter') {
    return `<button class="btn btn-sm" onclick="ccOpenCase(${aiJsAttr(a.entity_id)})">פתח תיק</button>`;
  }
  if (a.entity_type === 'task') {
    const t = (db.tasks || []).find(x => x.id === a.entity_id);
    return t ? `<span class="cc-muted">${escapeHtml(t.text)}</span>` : '';
  }
  if (a.entity_type === 'event') {
    const e = (db.events || []).find(x => x.id === a.entity_id);
    return e ? `<span class="cc-muted">${escapeHtml(e.date)} ${escapeHtml(e.time || '')}</span>` : '';
  }
  if (a.entity_type === 'lead') {
    const l = (db.leads || []).find(x => x.id === a.entity_id);
    return l ? `<span class="cc-muted">${escapeHtml(l.name || '')}</span>` : '';
  }
  return '';
}

/**
 * התמלול, עם קריאות הכלים משובצות בנקודה שבה הן קרו.
 *
 * השיבוץ נעשה לפי זמן ולא לפי סדר הרשומות: קריאת כלי נרשמת בטבלה אחרת
 * מהתמלול, וסידור לפי הכנסה היה מציג "נקבעה פגישה" לפני שהמתקשר ביקש
 * אותה.
 */
function ccTranscriptHtml(segments, actions) {
  const items = segments.map(s => ({ at: Date.parse(s.created_at), kind: 'seg', s }))
    .concat(actions.map(a => ({ at: Date.parse(a.started_at), kind: 'act', a })))
    .sort((x, y) => (x.at || 0) - (y.at || 0));

  const who = { caller: 'לקוח', agent: 'מזכירת AI', human: 'נציג', system: 'מערכת' };

  return `<div class="cc-transcript">${items.map(it => {
    if (it.kind === 'act') {
      const a = it.a;
      const cls = a.status === 'success' ? 'cc-tool-ok'
        : a.status === 'pending' || a.status === 'executing' ? '' : 'cc-tool-fail';
      const icon = a.status === 'success' ? '✓' : a.status === 'blocked' ? '⛔' : '⚙';
      return `<div class="cc-tool-inline ${cls}">
        <span aria-hidden="true">${icon}</span>
        ${escapeHtml(CC_TOOL_HE[a.tool_name] || a.tool_name)}</div>`;
    }
    const s = it.s;
    return `<div class="cc-bubble cc-bubble-${escapeHtml(s.speaker)}">
      <div class="cc-bubble-who">${escapeHtml(who[s.speaker] || s.speaker)}</div>
      ${escapeHtml(s.text)}
    </div>`;
  }).join('')}</div>`;
}

// ---- פעולות ממסך השיחה ----

function ccOpenClient(clientId) {
  closeModal('modal-call-detail');
  nav('clients', document.querySelectorAll('.nav-item')[2]);
  if (typeof openClientDetail === 'function') openClientDetail(clientId);
}

function ccOpenCase(caseId) {
  closeModal('modal-call-detail');
  nav('cases', document.querySelectorAll('.nav-item')[1]);
  if (typeof openCaseDetail === 'function') openCaseDetail(caseId);
}

/**
 * "צור משימה" מכרטיס שיחה חיה.
 *
 * ⚠ המשימה נוצרת דרך saveDB() של ה-CRM — אותו נתיב שכל פעולת משתמש
 * עוברת בו — ולא דרך שער הכלים. הסיבה: זו פעולה של **אדם**, לא של
 * הסוכן. ערבוב השניים היה מציג פעולה אנושית ברשימת "מה ה-AI עשה".
 */
async function ccQuickTask(callId, opts) {
  const { data: call } = await aiSb().from('call_sessions')
    .select('caller_phone, client_id, matter_id, category, summary').eq('id', callId).maybeSingle();
  if (!call) { notify('השיחה לא נמצאה'); return; }

  const who = ccCallerLabel(call);
  // skipConfirm: הקורא כבר שאל. שני דיאלוגים רצופים על אותה כוונה הם מה
  // שגורם לאנשים ללחוץ "אישור" בלי לקרוא — ואז האישור מפסיק להיות אישור.
  if (!(opts && opts.skipConfirm)) {
    const ok = await customConfirm(
      `לפתוח משימת מעקב עבור ${who}?`,
      { title: 'משימה חדשה מהשיחה', okText: 'צור משימה' });
    if (!ok) return;
  }

  db.tasks.unshift({
    id: uid(),
    text: `מעקב אחרי שיחה — ${who}`,
    due: localDateISO(new Date()),
    caseId: call.matter_id || '',
    priority: 'urgent',
    notes: [call.summary, `מספר: ${call.caller_phone || ''}`].filter(Boolean).join('\n'),
    done: false,
    createdByCall: callId,
  });
  await saveDB();
  notify('נוצרה משימה ✓');
  renderCallCenter();
}

/**
 * בקשת העברה לנציג מתוך המסך.
 *
 * ⚠ אין כאן העברה בפועל, וזה מכוון: כל עוד לא הוגדר HUMAN_TRANSFER_NUMBER
 * אין יעד חוקי, והעברה למספר הציבורי הייתה יוצרת לולאת ניתוב. במקום זה
 * נוצרת משימת חזרה — בדיוק מה שהמפרט מורה.
 */
async function ccRequestTransfer(callId) {
  const status = await ccStatus();
  const target = status && status.settings && status.settings.human_transfer_number;

  const message = target
    ? `לבקש העברה של השיחה לנציג במספר ${target}?`
    : 'לא הוגדר מספר העברה לנציג, ולכן לא ניתן להעביר את השיחה. ' +
      'תיווצר במקום משימת "חזרה דחופה ללקוח". להמשיך?';

  const ok = await customConfirm(message, { title: 'העברה לנציג', okText: 'אישור' });
  if (!ok) return;

  try {
    const res = await aiInvoke('call-center', {
      action: 'simulate.say', call_id: callId,
      text: 'אני מבקש לדבר עם נציג אנושי.',
    });
    notify(res && res.reply ? 'הבקשה נמסרה לסוכן ✓' : 'הבקשה נשלחה');
  } catch (e) {
    // שיחה אמיתית לא ניתנת להנחיה מהדפדפן (assertSimulation בשרת חוסם).
    // במקרה כזה יוצרים משימת חזרה ישירות — התוצאה שהמשתמש ביקש, בלי
    // לשאול אותו שוב על אותה כוונה.
    await ccQuickTask(callId, { skipConfirm: true });
    return;
  }
  await ccRefreshCallDetail();
  renderCallCenter();
}

// ============================================================
// סוכנים
// ============================================================

async function ccRenderAgents(host) {
  const [{ data: agents, error }, catalog] = await Promise.all([
    aiSb().from('voice_agents').select('*').order('created_at'),
    aiInvoke('call-center', { action: 'tools.catalog' }).catch(() => ({ tools: [] })),
  ]);
  if (error) throw error;

  if (!agents || !agents.length) {
    host.innerHTML = ccEmpty('לא הוגדר סוכן קולי',
      'יש להריץ את המיגרציות כדי ליצור את מזכירת המשרד.');
    return;
  }

  const isOwner = currentRole === 'owner';
  const tools = (catalog && catalog.tools) || [];

  host.innerHTML = agents.map(a => `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-size:16px;font-weight:700;color:var(--navy)">${escapeHtml(a.name)}</div>
          <div class="cc-muted" style="margin-top:3px">${escapeHtml(a.description || '')}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="badge badge-${a.is_active ? 'active' : 'closed'}">
            ${a.is_active ? '✓ פעילה' : '⊘ מושבתת'}</span>
          ${isOwner ? `<button class="btn btn-sm" onclick="ccToggleAgent(${aiJsAttr(a.id)},${!a.is_active})">
            ${a.is_active ? 'השבת' : 'הפעל'}</button>` : ''}
        </div>
      </div>

      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-top:14px">
        ${Stat('תפקיד', a.role === 'receptionist' ? 'מזכירה' : a.role, '')}
        ${Stat('שפה', a.language === 'he-IL' ? 'עברית' : a.language, '')}
        ${Stat('מנוע שפה', a.llm_provider, a.llm_model)}
        ${Stat('הקראה / תמלול', a.voice_provider === 'mock' ? 'הדגמה' : a.voice_provider,
          a.stt_provider === 'mock' ? 'תמלול: הדגמה' : 'תמלול: ' + a.stt_provider)}
      </div>

      <div class="form-group" style="margin-top:16px">
        <label class="form-label">משפט פתיחה</label>
        <input class="form-input" id="cc-greet-${escapeHtml(a.id)}" value="${escapeHtml(a.greeting || '')}" ${isOwner ? '' : 'disabled'}>
      </div>

      <div class="form-group">
        <label class="form-label">הנחיות הסוכן (System Prompt)</label>
        <textarea class="form-input" id="cc-prompt-${escapeHtml(a.id)}" rows="12"
          style="font-family:inherit;line-height:1.7" ${isOwner ? '' : 'disabled'}>${escapeHtml(a.system_prompt || '')}</textarea>
        <div class="cc-muted" style="margin-top:5px">
          איסור מתן ייעוץ משפטי נאכף גם בקוד: הסוכן יכול להפעיל אך ורק את הכלים המאושרים למטה,
          ללא קשר למה שנכתב כאן.
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">שעות פעילות</label>
          <input class="form-input" id="cc-hours-${escapeHtml(a.id)}"
            value="${escapeHtml(ccHoursText(a.business_hours))}" ${isOwner ? '' : 'disabled'}
            placeholder="09:00-18:00">
        </div>
        <div class="form-group">
          <label class="form-label">מונחים שמעלים דחיפות</label>
          <input class="form-input" id="cc-urg-${escapeHtml(a.id)}"
            value="${escapeHtml(((a.urgency_rules || {}).keywords || {}).high ? (a.urgency_rules.keywords.high || []).join(', ') : '')}"
            ${isOwner ? '' : 'disabled'} placeholder="עיקול, פינוי, צו…">
          <div class="cc-muted" style="margin-top:4px">
            המנוע לא מסתמך על מונחים בלבד: הוא בודק גם הקשר (שאלה היפותטית אינה חירום),
            מועד קרוב, והאם המתקשר לקוח קיים.
          </div>
        </div>
      </div>

      ${isOwner ? `<div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-primary" onclick="ccSaveAgent(${aiJsAttr(a.id)})">שמור שינויים</button>
      </div>` : `<div class="alert alert-info">עריכת הסוכן זמינה לבעל המשרד בלבד.</div>`}

      <div class="ai-section-title" style="margin-top:20px">כלים מאושרים</div>
      <div class="cc-tool-grid">
        ${tools.map(t => ccToolCard(t, a.id, isOwner)).join('')}
      </div>
    </div>`).join('');
}

function ccToolCard(t, agentId, isOwner) {
  const off = !t.enabled || !t.available;
  return `<div class="cc-tool-card${off ? ' cc-tool-off' : ''}">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
      <div class="cc-tool-name">${escapeHtml(t.title || t.name)}</div>
      <span class="ai-risk ai-risk-${escapeHtml(t.risk_level || 'low')}">${escapeHtml(t.risk_level || '')}</span>
    </div>
    <div class="cc-tool-desc">${escapeHtml(t.description || '')}</div>
    <div style="margin-top:9px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">
      ${t.available
        ? `<label class="ai-switch"><input type="checkbox" ${t.enabled ? 'checked' : ''}
             ${isOwner ? '' : 'disabled'}
             onchange="ccToggleTool(${aiJsAttr(agentId)},${aiJsAttr(t.name)},this.checked)"> מופעל</label>`
        : `<span class="badge badge-pending">לא זמין</span>`}
      ${t.requires_confirmation ? '<span class="badge badge-closed">דורש אישור</span>' : ''}
      ${t.read_only ? '<span class="badge badge-active">קריאה בלבד</span>' : ''}
    </div>
    ${!t.available && t.unavailable_reason
      ? `<div class="cc-muted" style="margin-top:7px">${escapeHtml(t.unavailable_reason)}</div>` : ''}
  </div>`;
}

function ccHoursText(bh) {
  const days = (bh || {}).days || {};
  const first = Object.values(days)[0];
  if (Array.isArray(first) && Array.isArray(first[0])) return first[0].join('-');
  return '';
}

async function ccToggleAgent(agentId, next) {
  try {
    await aiUpdateChecked('voice_agents', { is_active: next },
      q => q.eq('id', agentId),
      'הפעולה לא בוצעה — שינוי סוכן מותר לבעל המשרד בלבד.');
    notify(next ? 'הסוכן הופעל ✓' : 'הסוכן הושבת');
    renderCallCenter();
  } catch (e) { notify((e && e.message) || 'הפעולה נכשלה'); }
}

async function ccSaveAgent(agentId) {
  const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const greeting = val('cc-greet-' + agentId);
  const prompt = val('cc-prompt-' + agentId);
  const hours = val('cc-hours-' + agentId);
  const kws = val('cc-urg-' + agentId).split(',').map(s => s.trim()).filter(Boolean);

  if (!prompt) { notify('לא ניתן לשמור סוכן בלי הנחיות'); return; }

  const patch = { greeting, system_prompt: prompt };

  const m = hours.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (hours && !m) { notify('שעות פעילות בפורמט 09:00-18:00'); return; }
  if (m) {
    const window = [[m[1], m[2]]];
    patch.business_hours = {
      tz: 'Asia/Jerusalem',
      days: { 0: window, 1: window, 2: window, 3: window, 4: window },
      outside_hours_behavior: 'take_message',
    };
  }

  if (kws.length) {
    const { data: cur } = await aiSb().from('voice_agents')
      .select('urgency_rules').eq('id', agentId).maybeSingle();
    const rules = (cur && cur.urgency_rules) || {};
    rules.keywords = Object.assign({}, rules.keywords, { high: kws });
    patch.urgency_rules = rules;
  }

  try {
    await aiUpdateChecked('voice_agents', patch, q => q.eq('id', agentId),
      'הפעולה לא בוצעה — עריכת סוכן מותרת לבעל המשרד בלבד.');
    notify('הסוכן נשמר ✓');
  } catch (e) { notify((e && e.message) || 'השמירה נכשלה'); }
}

async function ccToggleTool(agentId, toolName, enabled) {
  try {
    await aiUpdateChecked('agent_tools', { enabled },
      q => q.eq('agent_id', agentId).eq('tool_name', toolName),
      'הפעולה לא בוצעה — שינוי הרשאות כלים מותר לבעל המשרד בלבד.');
    notify(enabled ? 'הכלי הופעל ✓' : 'הכלי כובה');
  } catch (e) {
    notify((e && e.message) || 'הפעולה נכשלה');
    renderCallCenter();
  }
}

// ============================================================
// מצב בדיקה
// ============================================================

const CC_SIM_EXAMPLES = [
  'שלום, יש לי עיקול בחשבון ואני רוצה שעורך הדין יחזור אליי היום.',
  'היי, קוראים לי ישראל. קיבלתי היום עיקול בחשבון ואני רוצה לקבוע פגישה.',
  'שלום, רציתי לשאול אם אתם מטפלים בהסכמי ממון.',
  'קיבלתי מכתב על פינוי מהדירה ויש לי דיון מחר בבוקר.',
];

function ccRenderSimulator(host) {
  host.innerHTML = `
    <div class="alert alert-info" style="margin-bottom:14px">
      <strong>מצב בדיקה מריץ את המערכת האמיתית.</strong>
      <div style="margin-top:4px">אותו סוכן, אותם כלים ואותה כתיבה ל-CRM כמו בשיחה אמיתית —
      ולכן ליד, משימה או פגישה שייווצרו כאן <b>יופיעו במערכת</b>. השיחה מסומנת כשיחת בדיקה
      וניתן לסנן אותה מההיסטוריה.</div>
    </div>

    <div class="cc-sim">
      <div class="card">
        <div class="card-title">שיחת סימולציה</div>
        <div class="form-group">
          <label class="form-label">מספר המתקשר</label>
          <input class="form-input cc-num" id="cc-sim-phone" value="0501234567" dir="ltr">
        </div>
        <div class="form-group">
          <label class="form-label">מה המתקשר אומר</label>
          <textarea class="form-input" id="cc-sim-msg" rows="4"
            placeholder="שלום, יש לי עיקול בחשבון…">${escapeHtml(CC_SIM_EXAMPLES[0])}</textarea>
        </div>
        <button class="btn btn-primary" style="width:100%" id="cc-sim-start"
          onclick="ccSimStart()">▶ התחל שיחת סימולציה</button>

        <div class="ai-section-title" style="margin-top:16px">דוגמאות</div>
        <div class="cc-sim-examples">
          ${CC_SIM_EXAMPLES.map(x =>
            `<button class="cc-sim-example" onclick="ccSimUseExample(${aiJsAttr(x)})">${escapeHtml(x)}</button>`).join('')}
        </div>
      </div>

      <div class="cc-sim-log" id="cc-sim-log">
        ${ccSimLogHtml()}
      </div>
    </div>`;
}

function ccSimUseExample(text) {
  const el = document.getElementById('cc-sim-msg');
  if (el) { el.value = text; el.focus(); }
}

function ccSimLogHtml() {
  if (!ccSim.callId && !ccSim.log.length) {
    return `<div class="empty-main" style="padding:40px 20px">
      <div class="empty-main-icon">☎</div>
      <div class="empty-main-title">לא רצה שיחת בדיקה</div>
      <div class="empty-main-sub">הזן מספר והודעה, ולחץ "התחל שיחת סימולציה".</div>
    </div>`;
  }

  const modeBadge = ccSim.providerMode === 'live'
    ? '<span class="badge badge-active">מנוע שפה פעיל</span>'
    : '<span class="badge badge-pending">מצב הדגמה (ללא מפתח AI)</span>';

  return `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <b style="color:var(--navy)">${escapeHtml(ccSim.agentName || 'מזכירת המשרד')}</b>
      ${modeBadge}
      ${ccSim.callId ? `<button class="btn btn-sm" style="margin-right:auto"
        onclick="ccOpenCall(${aiJsAttr(ccSim.callId)})">פתח כרטיס שיחה</button>` : ''}
    </div>

    <div class="cc-transcript" style="max-height:none">
      ${ccSim.log.map(entry => {
        if (entry.type === 'caller') {
          return `<div class="cc-bubble cc-bubble-caller">
            <div class="cc-bubble-who">לקוח</div>${escapeHtml(entry.text)}</div>`;
        }
        if (entry.type === 'agent') {
          return `<div class="cc-bubble cc-bubble-agent">
            <div class="cc-bubble-who">מזכירת AI</div>${escapeHtml(entry.text)}</div>`;
        }
        if (entry.type === 'tool') {
          const cls = entry.status === 'success' ? 'cc-tool-ok'
            : entry.status === 'blocked' ? 'cc-tool-fail' : 'cc-tool-fail';
          const icon = entry.status === 'success' ? '✓' : entry.status === 'blocked' ? '⛔' : '🔴';
          return `<div class="cc-tool-inline ${cls}">
            <span aria-hidden="true">${icon}</span>
            ${escapeHtml(CC_TOOL_HE[entry.tool] || entry.tool)}
            ${entry.message ? ' — ' + escapeHtml(entry.message) : ''}</div>`;
        }
        return `<div class="cc-bubble cc-bubble-system">${escapeHtml(entry.text)}</div>`;
      }).join('')}
    </div>

    ${ccSim.callId ? `<div class="cc-sim-row">
      <input class="form-input" id="cc-sim-reply" placeholder="תשובת המתקשר…"
        onkeydown="if(event.key==='Enter')ccSimSay()">
      <button class="btn btn-primary" onclick="ccSimSay()" ${ccSim.busy ? 'disabled' : ''}>שלח</button>
      <button class="btn" onclick="ccSimEnd()" ${ccSim.busy ? 'disabled' : ''}>סיים שיחה</button>
    </div>` : ''}`;
}

function ccSimRefresh() {
  const el = document.getElementById('cc-sim-log');
  if (el) el.innerHTML = ccSimLogHtml();
}

function ccSimPushTurn(turn) {
  (turn.actions || []).forEach(a => {
    ccSim.log.push({ type: 'tool', tool: a.tool, status: a.status, message: a.message });
  });
  if (turn.reply) ccSim.log.push({ type: 'agent', text: turn.reply });
  if (turn.category || turn.urgency) {
    ccSim.log.push({
      type: 'system',
      text: `סווג: ${turn.category || '—'} · דחיפות ${CC_URGENCY_HE[turn.urgency] || turn.urgency}`,
    });
  }
  ccSim.providerMode = turn.providerMode || ccSim.providerMode;
}

async function ccSimStart() {
  const phone = (document.getElementById('cc-sim-phone') || {}).value || '';
  const msg = ((document.getElementById('cc-sim-msg') || {}).value || '').trim();
  if (!phone.trim()) { notify('נא להזין מספר מתקשר'); return; }

  const btn = document.getElementById('cc-sim-start');
  if (btn) { btn.disabled = true; btn.textContent = 'מריץ…'; }
  ccSim = { callId: null, log: [], busy: true, providerMode: null, agentName: '' };
  ccSimRefresh();

  try {
    const res = await aiInvoke('call-center', {
      action: 'simulate.start', caller_phone: phone.trim(), message: msg || undefined,
    });
    ccSim.callId = res.call_id;
    ccSim.providerMode = res.provider_mode;
    ccSim.agentName = (res.agent && res.agent.name) || 'מזכירת המשרד';
    ccSim.log.push({ type: 'agent', text: res.greeting });
    if (msg) ccSim.log.push({ type: 'caller', text: msg });
    if (res.turn) ccSimPushTurn(res.turn);
    // ה-CRM בדפדפן מחזיק עותק של ה-blob. השיחה יצרה בו ליד/משימה בשרת,
    // ובלי טעינה מחדש המשתמש היה לוחץ "פתח לקוח" ולא מוצא כלום.
    await loadDB();
  } catch (e) {
    ccSim.log.push({ type: 'system', text: 'שגיאה: ' + ((e && e.message) || String(e)) });
  } finally {
    ccSim.busy = false;
    if (btn) { btn.disabled = false; btn.textContent = '▶ התחל שיחת סימולציה'; }
    ccSimRefresh();
  }
}

async function ccSimSay() {
  const el = document.getElementById('cc-sim-reply');
  const text = el ? el.value.trim() : '';
  if (!text || !ccSim.callId || ccSim.busy) return;
  if (el) el.value = '';

  ccSim.log.push({ type: 'caller', text });
  ccSim.busy = true;
  ccSimRefresh();

  try {
    const turn = await aiInvoke('call-center', {
      action: 'simulate.say', call_id: ccSim.callId, text,
    });
    ccSimPushTurn(turn);
    await loadDB();
  } catch (e) {
    ccSim.log.push({ type: 'system', text: 'שגיאה: ' + ((e && e.message) || String(e)) });
  } finally {
    ccSim.busy = false;
    ccSimRefresh();
  }
}

async function ccSimEnd() {
  if (!ccSim.callId || ccSim.busy) return;
  ccSim.busy = true;
  ccSimRefresh();
  try {
    const res = await aiInvoke('call-center', { action: 'simulate.end', call_id: ccSim.callId });
    ccSim.log.push({ type: 'system', text: 'השיחה הסתיימה · ' + (CC_OUTCOME_HE[res.outcome] || res.outcome || '') });
    if (res.summary) ccSim.log.push({ type: 'system', text: 'סיכום: ' + res.summary });
    await loadDB();
  } catch (e) {
    ccSim.log.push({ type: 'system', text: 'שגיאה: ' + ((e && e.message) || String(e)) });
  } finally {
    ccSim.busy = false;
    ccSim.callId = null;
    ccSimRefresh();
  }
}

// ============================================================
// מצב מערכת
// ============================================================

async function ccStatus(force) {
  if (ccStatusCache && !force) return ccStatusCache;
  ccStatusCache = await aiInvoke('call-center', { action: 'status' });
  return ccStatusCache;
}

async function ccRenderSystem(host) {
  const st = await ccStatus(true);
  const c = st.components || {};

  const card = (label, comp, hint) => {
    const state = (comp && comp.state) || 'unknown';
    const map = {
      connected: ['🟢', 'מחובר', 'cc-s-online'],
      online: ['🟢', 'מחובר', 'cc-s-online'],
      live: ['🟢', 'פעיל', 'cc-s-online'],
      degraded: ['🟡', 'לא יציב', 'cc-s-degraded'],
      never_connected: ['🟡', 'טרם חובר', 'cc-s-degraded'],
      not_configured: ['🟡', 'לא מוגדר', 'cc-s-degraded'],
      mock: ['🟡', 'מצב הדגמה', 'cc-s-mock'],
      offline: ['🔴', 'מנותק', 'cc-s-offline'],
      error: ['🔴', 'שגיאה', 'cc-s-error'],
    };
    const [icon, text, cls] = map[state] || ['⚪', state, 'cc-s-idle'];
    return `<div class="cc-status">
      <div class="cc-status-label">${escapeHtml(label)}</div>
      <div class="cc-status-value ${cls}"><span aria-hidden="true">${icon}</span> ${escapeHtml(text)}</div>
      <div class="cc-status-detail">${escapeHtml((comp && comp.detail) || hint || '')}</div>
    </div>`;
  };

  const sc = st.server_config || {};

  host.innerHTML = `
    <div class="cc-status-grid">
      ${card('CRM API', c.crm_api)}
      ${card('Supabase', c.supabase)}
      ${card('שרת הטלפוניה', c.voice_gateway)}
      ${card('מרכזייה', c.asterisk)}
      ${card('קו SIP', c.sip)}
      ${card('תמלול (STT)', c.stt)}
      ${card('מנוע שפה (LLM)', c.llm)}
      ${card('הקראה (TTS)', c.tts)}
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">המספר הציבורי</div>
      <div style="font-size:22px;font-weight:700;color:var(--navy)" class="cc-num">
        ${escapeHtml(ccFormatPhone(st.phone))}</div>
      <div class="cc-muted" style="margin-top:6px">
        ${c.sip && c.sip.state === 'not_configured'
          ? 'ממתין להגדרת ספק טלפוניה. שיחות אמיתיות אינן מתקבלות עדיין.'
          : 'הקו מוגדר.'}
      </div>
      ${(st.lines || []).length ? `<table class="data-table" style="margin-top:12px">
        <thead><tr><th>מספר</th><th>תיאור</th><th>ספק</th><th>מצב ספק</th><th>מצב קו</th><th>פעיל</th></tr></thead>
        <tbody>${st.lines.map(l => `<tr>
          <td class="cc-num">${escapeHtml(l.public_number)}</td>
          <td>${escapeHtml(l.label || '—')}</td>
          <td>${escapeHtml(l.provider)}</td>
          <td>${escapeHtml(ccLineState(l.provider_status))}</td>
          <td>${escapeHtml(ccLineState(l.sip_status))}</td>
          <td>${l.is_active ? '✓' : '—'}</td>
        </tr>`).join('')}</tbody></table>` : ''}
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-title">הגדרות שרת</div>
      <div class="cc-muted" style="margin-bottom:8px">
        מוצג רק האם הערך מוגדר. שום סוד אינו נשלח לדפדפן.
      </div>
      <table class="data-table">
        <tbody>
          ${ccConfigRow('סוד חתימה לשרת הקול (VOICE_GATEWAY_SECRET)', sc.voice_gateway_secret,
            'בלעדיו שרת הקול לא יוכל להתחבר כלל')}
          ${ccConfigRow('כתובת שרת הקול (VOICE_GATEWAY_URL)', Boolean(sc.voice_gateway_url), '')}
          ${ccConfigRow('מפתח מנוע השפה (ANTHROPIC_API_KEY)', sc.anthropic_key,
            'בלעדיו המערכת עובדת במצב הדגמה')}
          ${ccConfigRow('מספר העברה לנציג', Boolean(st.settings && st.settings.human_transfer_number),
            'בלעדיו נוצרת משימת חזרה במקום העברה')}
          ${ccConfigRow('הקלטת שיחות', Boolean(st.settings && st.settings.recording_enabled),
            'כבוי כברירת מחדל, במכוון', true)}
        </tbody>
      </table>
    </div>`;
}

function ccConfigRow(label, on, hint, offIsOk) {
  const icon = on ? '🟢 מוגדר' : (offIsOk ? '⚪ כבוי' : '🟡 לא מוגדר');
  return `<tr><td>${escapeHtml(label)}</td><td style="white-space:nowrap">${icon}</td>
    <td class="cc-muted">${escapeHtml(hint || '')}</td></tr>`;
}

function ccLineState(s) {
  return {
    not_configured: 'לא מוגדר', configuring: 'בהגדרה', configured: 'מוגדר',
    error: 'שגיאה', registering: 'נרשם', registered: 'רשום', failed: 'נכשל',
  }[s] || s || '—';
}

/** 0552745790 → 055-274-5790. */
function ccFormatPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 9) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  return p || '—';
}

// ============================================================
// הגדרות
// ============================================================

async function ccRenderSettings(host) {
  const st = await ccStatus(true);
  const s = st.settings || {};
  const isOwner = currentRole === 'owner';

  host.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">טלפוניה</div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">המספר הציבורי של המשרד</label>
          <input class="form-input cc-num" id="cc-set-phone" dir="ltr"
            value="${escapeHtml(st.phone || '')}" ${isOwner ? '' : 'disabled'}>
        </div>
        <div class="form-group">
          <label class="form-label">מספר העברה לנציג אנושי</label>
          <input class="form-input cc-num" id="cc-set-transfer" dir="ltr"
            value="${escapeHtml(s.human_transfer_number || '')}" ${isOwner ? '' : 'disabled'}
            placeholder="לא מוגדר">
          <div class="cc-muted" style="margin-top:5px">
            ⚠ אין להזין כאן את המספר הציבורי. אם השיחה מופנית ממנו אל המזכירה,
            העברה חזרה אליו תיצור לולאת ניתוב. כל עוד השדה ריק — נוצרת משימת חזרה במקום העברה.
          </div>
        </div>
      </div>
      <div class="cc-muted">
        ספק טלפוניה: ${escapeHtml(((st.components || {}).sip || {}).state === 'not_configured' ? 'לא מוגדר' : 'מוגדר')}
        · חיבור SIP: ${escapeHtml(ccLineState((((st.lines || [])[0]) || {}).sip_status))}
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-title">הקלטות ושמירת נתונים</div>
      <div class="ai-toggles">
        <label class="ai-switch"><input type="checkbox" id="cc-set-recording"
          ${s.recording_enabled ? 'checked' : ''} ${isOwner ? '' : 'disabled'}>
          הקלטת שיחות</label>
        <label class="ai-switch"><input type="checkbox" id="cc-set-ai"
          ${s.ai_enabled !== false ? 'checked' : ''} ${isOwner ? '' : 'disabled'}>
          המזכירה הדיגיטלית פעילה</label>
        <label class="ai-switch"><input type="checkbox" id="cc-set-sim"
          ${s.simulation_enabled !== false ? 'checked' : ''} ${isOwner ? '' : 'disabled'}>
          מצב בדיקה זמין</label>
      </div>
      <div class="alert alert-warning" style="margin-top:10px">
        הקלטת שיחה כפופה לחוק האזנת סתר ולכללי האתיקה. ההקלטה כבויה כברירת מחדל
        ואינה מופעלת אוטומטית.
      </div>

      <div class="form-row" style="margin-top:10px">
        <div class="form-group">
          <label class="form-label">שמירת תמלולים (ימים)</label>
          <input class="form-input" type="number" min="0" id="cc-set-ret-transcript"
            value="${Number(s.transcript_retention_days) || 0}" ${isOwner ? '' : 'disabled'}>
        </div>
        <div class="form-group">
          <label class="form-label">שמירת הקלטות (ימים)</label>
          <input class="form-input" type="number" min="0" id="cc-set-ret-recording"
            value="${Number(s.recording_retention_days) || 0}" ${isOwner ? '' : 'disabled'}>
        </div>
        <div class="form-group">
          <label class="form-label">שמירת נתוני שיחה (ימים)</label>
          <input class="form-input" type="number" min="0" id="cc-set-ret-meta"
            value="${Number(s.call_metadata_retention_days) || 0}" ${isOwner ? '' : 'disabled'}>
        </div>
      </div>
      <div class="cc-muted">0 = ללא מחיקה. בשלב זה אין מחיקה אוטומטית של נתונים — ההגדרה נשמרת בלבד.</div>
    </div>

    ${isOwner ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      <button class="btn btn-primary" onclick="ccSaveSettings()">שמור הגדרות</button>
      <button class="btn btn-danger" onclick="ccToggleEmergency(${!s.emergency_stop})">
        ${s.emergency_stop ? '▶ בטל עצירת חירום' : '⛔ עצירת חירום'}</button>
    </div>` : '<div class="alert alert-info">שינוי הגדרות זמין לבעל המשרד בלבד.</div>'}

    ${s.emergency_stop ? `<div class="alert alert-danger">
      <strong>המזכירה הדיגיטלית מושבתת.</strong> שיחות נכנסות לא יטופלו אוטומטית.</div>` : ''}

    <div class="card">
      <div class="card-title">בדיקות</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" onclick="ccRunTest('test.crm','cc-test-crm')">בדוק CRM API</button>
        <button class="btn" onclick="ccRunTest('test.gateway','cc-test-gw')">בדוק שרת טלפוניה</button>
        <button class="btn" onclick="ccRunTest('test.tools','cc-test-tools')">בדוק שער הכלים</button>
        <button class="btn" onclick="ccRunTest('test.simulation','cc-test-sim')">הרץ שיחת בדיקה</button>
      </div>
      <div id="cc-test-crm" style="margin-top:10px"></div>
      <div id="cc-test-gw"></div>
      <div id="cc-test-tools"></div>
      <div id="cc-test-sim"></div>
    </div>`;
}

async function ccSaveSettings() {
  const officeId = await aiOfficeId();
  const v = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const chk = id => { const el = document.getElementById(id); return el ? el.checked : false; };

  const phone = v('cc-set-phone');
  const transfer = v('cc-set-transfer');

  // ⚠ הבדיקה נעשית גם בשרת (syncToolAvailability) — כאן היא רק כדי
  // להסביר למשתמש מיד למה, במקום שיגלה זאת כשהעברה לא תעבוד.
  if (transfer && ccSameNumber(transfer, phone)) {
    notify('מספר ההעברה זהה למספר הציבורי — הדבר עלול ליצור לולאת ניתוב');
    return;
  }

  try {
    await aiUpdateChecked('call_center_settings', {
      public_office_phone: phone || null,
      human_transfer_number: transfer || null,
      recording_enabled: chk('cc-set-recording'),
      ai_enabled: chk('cc-set-ai'),
      simulation_enabled: chk('cc-set-sim'),
      transcript_retention_days: Math.max(0, Number(v('cc-set-ret-transcript')) || 0),
      recording_retention_days: Math.max(0, Number(v('cc-set-ret-recording')) || 0),
      call_metadata_retention_days: Math.max(0, Number(v('cc-set-ret-meta')) || 0),
    }, q => q.eq('office_id', officeId),
      'ההגדרות לא נשמרו — נדרשת הרשאת בעל משרד.');

    // מסנכרן זמינות כלים (בעיקר transfer_call) מול ההגדרות החדשות.
    await aiInvoke('call-center', { action: 'settings.sync' });
    ccStatusCache = null;
    notify('ההגדרות נשמרו ✓');
    renderCallCenter();
  } catch (e) { notify((e && e.message) || 'השמירה נכשלה'); }
}

function ccSameNumber(a, b) {
  const norm = x => String(x || '').replace(/\D/g, '').replace(/^972/, '0').slice(-9);
  const na = norm(a), nb = norm(b);
  return na.length === 9 && na === nb;
}

async function ccToggleEmergency(on) {
  const ok = await customConfirm(
    on ? 'להשבית מיידית את המזכירה הדיגיטלית? שיחות נכנסות לא יטופלו אוטומטית.'
       : 'להחזיר את המזכירה הדיגיטלית לפעולה?',
    { title: on ? 'עצירת חירום' : 'ביטול עצירה', okText: 'אישור', danger: on });
  if (!ok) return;

  const officeId = await aiOfficeId();
  try {
    await aiUpdateChecked('call_center_settings', {
      emergency_stop: on,
      emergency_stop_reason: on ? 'הופעל ידנית ממסך מרכז השיחות' : null,
    }, q => q.eq('office_id', officeId),
      'הפעולה לא בוצעה — עצירת חירום מותרת לבעל המשרד בלבד.');
    ccStatusCache = null;
    notify(on ? '⛔ המזכירה הדיגיטלית הושבתה' : 'המזכירה הדיגיטלית פעילה ✓');
    renderCallCenter();
  } catch (e) { notify((e && e.message) || 'הפעולה נכשלה'); }
}

async function ccRunTest(action, targetId) {
  const el = document.getElementById(targetId);
  if (el) el.innerHTML = '<div class="cc-muted">מריץ…</div>';
  try {
    const res = await aiInvoke('call-center', { action });
    const cls = res.ok ? 'alert-success' : 'alert-warning';
    const icon = res.ok ? '🟢' : '🟡';
    let extra = '';
    if (res.actions && res.actions.length) {
      extra = '<div style="margin-top:6px">' + res.actions.map(a =>
        `<div>${a.status === 'success' ? '✓' : '🔴'} ${escapeHtml(CC_TOOL_HE[a.tool] || a.tool)} — ${escapeHtml(a.message || '')}</div>`
      ).join('') + '</div>';
    }
    if (res.summary) extra += `<div style="margin-top:6px"><b>סיכום:</b> ${escapeHtml(res.summary)}</div>`;
    if (el) {
      el.innerHTML = `<div class="alert ${cls}" style="margin-top:8px">
        ${icon} ${escapeHtml(res.detail || (res.ok ? 'תקין' : 'לא זמין'))}${extra}
        ${res.call_id ? `<div style="margin-top:6px">
          <button class="btn btn-sm" onclick="ccOpenCall(${aiJsAttr(res.call_id)})">פתח את השיחה</button></div>` : ''}
      </div>`;
    }
    if (res.call_id) await loadDB();
  } catch (e) {
    if (el) el.innerHTML = `<div class="alert alert-danger" style="margin-top:8px">
      🔴 ${escapeHtml((e && e.message) || String(e))}</div>`;
  }
}

// ============================================================
// שילוב בכרטיס הלקוח
// ============================================================

/**
 * נקרא מ-openCaseDetail/openClientDetail ב-app.js תחת
 * `typeof CallsClientSection==='function'`. מחזיר מיכל ריק ומתמלא
 * אסינכרונית — openClientDetail בונה innerHTML סינכרוני, ו-await בתוכו
 * היה מעכב את כל הכרטיס עד שהשאילתה חוזרת.
 */
function CallsClientSection(clientId) {
  const id = 'cc-client-calls-' + clientId;
  setTimeout(() => ccFillClientCalls(clientId, id), 0);
  return `<div id="${escapeHtml(id)}"></div>`;
}

async function ccFillClientCalls(clientId, hostId) {
  const host = document.getElementById(hostId);
  if (!host) return;
  try {
    const { data, error } = await aiSb().from('call_sessions')
      .select('*').eq('client_id', clientId)
      .order('started_at', { ascending: false }).limit(20);
    if (error) throw error;
    if (!data || !data.length) { host.innerHTML = ''; return; }

    host.innerHTML = `<div class="card" style="margin-bottom:16px">
      <div class="card-title">שיחות (${data.length})</div>
      <table class="data-table">
        <thead><tr><th>תאריך</th><th>משך</th><th>תחום</th><th>דחיפות</th><th>סיכום</th><th></th></tr></thead>
        <tbody>${data.map(c => `<tr>
          <td style="white-space:nowrap">${aiFmtDate(c.started_at)}</td>
          <td><span class="cc-num">${ccDuration(c.duration_seconds)}</span></td>
          <td>${escapeHtml(c.category || '—')}</td>
          <td>${UrgencyBadge(c.urgency)}</td>
          <td style="max-width:340px">${escapeHtml((c.summary || '').slice(0, 160))}${(c.summary || '').length > 160 ? '…' : ''}</td>
          <td><button class="btn btn-sm" onclick="ccOpenCall(${aiJsAttr(c.id)})">פתח</button></td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  } catch (e) {
    // הטבלאות עשויות לא להיות מותקנות. כרטיס הלקוח חייב להיפתח בכל מקרה.
    host.innerHTML = '';
  }
}

// ============================================================
// Realtime ומונים
// ============================================================

/**
 * Realtime — שיחה חדשה, קטע תמלול ופעולה מופיעים בלי רענון (סעיף PHASE 6).
 * RLS חל גם על ערוצי Realtime, ולכן אין כאן חשיפה בין משרדים.
 */
function ccSubscribeRealtime() {
  if (ccRealtimeChannel) return;
  try {
    ccRealtimeChannel = aiSb().channel('call-center')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_sessions' }, (p) => {
        ccRefreshBadge();
        if (p.eventType === 'INSERT' && p.new && !p.new.is_simulation) {
          notify('☎ שיחה נכנסת — ' + (p.new.caller_phone || ''));
        }
        // רק המסכים שמציגים שיחות מתרעננים. רענון גורף היה מוחק טופס
        // הגדרות שהמשתמש באמצע מילויו בכל שיחה נכנסת.
        if (currentPanel === 'call-center' && ['dashboard', 'calls'].includes(ccTab)) {
          renderCallCenter();
        }
        if (ccCurrentCallId && p.new && p.new.id === ccCurrentCallId) ccRefreshCallDetail();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_events' }, (p) => {
        if (ccCurrentCallId && p.new && p.new.call_id === ccCurrentCallId) ccRefreshCallDetail();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_transcript_segments' }, (p) => {
        const row = p.new || p.old;
        if (ccCurrentCallId && row && row.call_id === ccCurrentCallId) ccRefreshCallDetail();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_actions' }, (p) => {
        const row = p.new || p.old;
        if (ccCurrentCallId && row && row.call_id === ccCurrentCallId) ccRefreshCallDetail();
      })
      .subscribe();
  } catch (e) { /* Realtime לא זמין — המסך עדיין עובד עם רענון ידני */ }
}

/** סמן בסיידבר: שיחות פעילות + שיחות שדורשות טיפול. */
async function ccRefreshBadge() {
  try {
    const [{ count: active }, { count: attention }] = await Promise.all([
      aiSb().from('call_sessions').select('id', { count: 'exact', head: true })
        .in('status', CC_ACTIVE_STATUSES),
      aiSb().from('call_sessions').select('id', { count: 'exact', head: true })
        .eq('manual_followup_required', true).eq('status', 'completed'),
    ]);
    const badge = document.getElementById('cc-nav-badge');
    if (badge) {
      const n = (active || 0) + (attention || 0);
      badge.textContent = n || '';
      badge.style.display = n ? '' : 'none';
      badge.style.background = active ? 'var(--danger)' : 'var(--warning)';
    }
    const ind = document.getElementById('cc-live-indicator');
    if (ind) {
      ind.innerHTML = active
        ? `<span class="badge badge-urgent"><span class="cc-dot"></span>${active} שיחות פעילות</span>`
        : '';
    }
    const setCount = (id, n) => {
      const el = document.getElementById('cc-count-' + id);
      if (el) { el.textContent = n ? String(n) : ''; el.style.display = n ? '' : 'none'; }
    };
    setCount('dashboard', active || 0);
  } catch (e) { /* מונה שלא התעדכן אינו סיבה לשבור את המסך */ }
}
