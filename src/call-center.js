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

  // ---- מכונת המצבים ומדידה ----
  LISTENING_STARTED: 'מקשיבה למתקשר',
  USER_SPEECH_STARTED: 'המתקשר התחיל לדבר',
  USER_SPEECH_ENDED: 'המתקשר סיים לדבר',
  STT_STARTED: 'תמלול התחיל',
  STT_COMPLETED: 'תמלול הושלם',
  LLM_STARTED: 'הסוכנת מנסחת תשובה',
  LLM_FIRST_TOKEN: 'התשובה החלה להתקבל',
  TOOL_STARTED: 'פעולה במערכת החלה',
  TOOL_COMPLETED: 'פעולה במערכת הושלמה',
  TTS_STARTED: 'הקראה התחילה',
  TTS_FIRST_AUDIO: 'הקול החל להישמע',
  TTS_COMPLETED: 'הקראה הושלמה',
  BARGE_IN: 'המתקשר קטע את הסוכנת',
  SILENCE_TIMEOUT: 'שתיקה ממושכת',
  AUDIO_LOST: 'ערוץ האודיו נקטע',
  IDENTITY_PHONE_MATCH: 'המספר תואם ללקוח (זהות לא אומתה)',
  POST_CALL_COMPLETED: 'הסיכום המלא הופק',
  POST_CALL_FAILED: 'הפקת הסיכום נכשלה',
  STATE_LISTENING: 'מצב: מקשיבה',
  STATE_THINKING: 'מצב: מנסחת',
  STATE_SPEAKING: 'מצב: מדברת',
  STATE_WAITING_FOR_TOOL: 'מצב: מבצעת פעולה',
  STATE_COMPLETING: 'מצב: מסכמת',
  STATE_ENDED: 'מצב: הסתיימה',
  STATE_FAILED: 'מצב: נכשלה',
};

/**
 * אירועים "רועשים" שאינם מוצגים כברירת מחדל.
 *
 * ⚠ ציר הזמן נקרא ע"י עורך דין. שיחה בת חמישה תורות מייצרת כשלושים
 * אירועי מכונת מצבים, ובתוכם נבלעות שלוש השורות שבאמת חשובות ("נוצרה
 * משימה", "נקבעה פגישה"). ההסתרה היא ברירת מחדל, לא מחיקה — כפתור
 * מציג את הכול למי שמאבחן.
 */
const CC_VERBOSE_EVENTS = new Set([
  'LISTENING_STARTED', 'USER_SPEECH_STARTED', 'USER_SPEECH_ENDED',
  'STT_STARTED', 'STT_COMPLETED', 'LLM_STARTED', 'LLM_FIRST_TOKEN',
  'TTS_STARTED', 'TTS_FIRST_AUDIO', 'TTS_COMPLETED', 'CALLER_UTTERANCE',
  'AGENT_REPLY', 'TOOL_STARTED',
  'STATE_LISTENING', 'STATE_THINKING', 'STATE_SPEAKING',
  'STATE_WAITING_FOR_TOOL', 'STATE_COMPLETING', 'STATE_ENDED', 'STATE_FAILED',
]);
let ccShowVerbose = false;

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
  { id: 'dashboard',   label: 'סקירה',            icon: '▦' },
  { id: 'callbacks',   label: 'ממתינים לחזרה',    icon: '↩' },
  { id: 'calls',       label: 'היסטוריית שיחות',  icon: '≡' },
  { id: 'performance', label: 'ביצועים',          icon: '◷' },
  { id: 'agents',      label: 'סוכנים',           icon: '◈' },
  { id: 'simulator',   label: 'מצב בדיקה',        icon: '▶' },
  { id: 'system',      label: 'מצב מערכת',        icon: '⚙' },
  { id: 'settings',    label: 'הגדרות',           icon: '☎' },
];

/** סטטוסים של בקשת חזרה. Callback הוא תכונת ליבה — אין העברה חיה. */
const CC_CALLBACK_STATUS_HE = {
  waiting: 'ממתין', contacted: 'נוצר קשר', no_answer: 'לא ענה',
  reschedule: 'נדחה למועד אחר', completed: 'הושלם', cancelled: 'בוטל',
};
const CC_CALLBACK_STATUS_CLS = {
  waiting: 'pending', contacted: 'active', no_answer: 'urgent',
  reschedule: 'pending', completed: 'active', cancelled: 'closed',
};

/** מה הסוכנת עושה עכשיו — מכונת המצבים. */
const CC_VOICE_STATE_HE = {
  ringing: 'מצלצל', answering: 'עונה לשיחה', listening: 'מקשיבה',
  transcribing: 'מתמללת', thinking: 'מנסחת תשובה', speaking: 'מדברת',
  waiting_for_tool: 'מבצעת פעולה במערכת', on_hold: 'בהמתנה',
  completing: 'מסכמת', ended: 'הסתיימה', failed: 'נכשלה',
};

const CC_IDENTITY_HE = {
  unidentified: 'לא מזוהה',
  phone_match: 'התאמת מספר',
  verified: 'זהות אומתה',
  rejected: 'צד שכנגד',
};

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
    dashboard: ccRenderDashboard, callbacks: ccRenderCallbacks,
    calls: ccRenderHistory, performance: ccRenderPerformance,
    agents: ccRenderAgents, simulator: ccRenderSimulator,
    system: ccRenderSystem, settings: ccRenderSettings,
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
    ${s.live_calls_enabled
      ? `<div class="alert alert-success" style="margin-bottom:14px">
          <strong>🟢 המערכת מקבלת שיחות אמיתיות.</strong></div>`
      : `<div class="alert alert-info" style="margin-bottom:14px">
          <strong>שיחות אמיתיות אינן מופעלות.</strong>
          <div style="margin-top:4px">אפשר לבדוק את המערכת במלואה דרך
            <button class="btn btn-sm" onclick="ccNav('simulator')">מצב בדיקה</button>
            <button class="btn btn-sm" onclick="ccNav('system')">בדיקת מוכנות</button></div>
        </div>`}

    <div class="stats-grid stats-grid-6">
      ${Stat('שיחות היום', s.calls_today ?? 0, '')}
      ${Stat('שיחות פעילות', s.calls_active ?? 0, s.calls_active ? 'עכשיו' : '', Number(s.calls_active) > 0)}
      ${Stat('לידים חדשים', s.leads_today ?? 0, 'נוצרו היום')}
      ${Stat('פגישות שנקבעו', s.appointments_today ?? 0, `${s.appointments_week ?? 0} השבוע`)}
      ${Stat('ממתינים לחזרה', s.callbacks_waiting ?? 0, 'בקשות פתוחות', Number(s.callbacks_waiting) > 0)}
      ${Stat('דורש טיפול', s.requires_attention ?? 0, '14 ימים אחרונים', Number(s.requires_attention) > 0)}
    </div>

    ${Number(s.callbacks_waiting) > 0 ? `<div style="margin-top:12px">
      <button class="btn btn-primary" onclick="ccNav('callbacks')">
        ↩ ${s.callbacks_waiting} ממתינים לחזרה — פתח רשימה</button></div>` : ''}

    ${Number(s.dead_letters) > 0 ? `<div class="alert alert-danger" style="margin-top:12px">
      <strong>🔴 ${s.dead_letters} פעולות לא סונכרנו.</strong>
      <div style="margin-top:4px">פעולות שנוצרו בשיחה ולא נרשמו במערכת.
        <button class="btn btn-sm" onclick="ccNav('system')">הצג</button></div>
    </div>` : ''}

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

/**
 * "מה קורה עכשיו" בשפה של אדם, לא בשם הסטטוס.
 *
 * ⚠ voice_state קודם ל-status. status אומר "בשיחה" גם כשהסוכנת ממתינה
 * לתשובת כלי — וההבחנה הזו היא בדיוק מה שמסביר למה השיחה נשמעת תקועה.
 */
function ccLiveStateText(call) {
  const agentName = 'מזכירת המשרד';
  const vs = call.voice_state;
  if (vs && CC_VOICE_STATE_HE[vs] && !['ringing', 'ended', 'failed'].includes(vs)) {
    const who = call.client_id ? ' · לקוח קיים' : (call.lead_id ? ' · פנייה חדשה' : '');
    return `${agentName} ${CC_VOICE_STATE_HE[vs]}${who}`;
  }
  if (call.status === 'ringing') return 'השיחה מצלצלת';
  if (call.status === 'answering') return `${agentName} עונה לשיחה`;
  if (call.status === 'on_hold') return 'המתקשר בהמתנה';
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
// ממתינים לחזרה
// ============================================================
//
// ⚠ זו אינה רשימת משימות נוספת. החלטת המוצר היא שאין העברה חיה לעורך
// הדין, ולכן **כל** בקשה לדבר איתו הופכת לבקשת חזרה — וזה הופך את
// המסך הזה לליבת המוצר ולא למקרה קצה. אם משהו כאן נופל בין הכיסאות,
// לקוח שהמזכירה הבטיחה לו שיחזרו אליו לא יקבל אותה.
//
// המקור הוא db.tasks (המשימות חיות ב-blob, ראה docs). אין טבלה מקבילה:
// שתי רשימות משימות היו מפצלות את תשומת הלב של עורך הדין, וזה בדיוק
// מה שגורם לרשימה אחת מהן להיזנח.

/** בקשות חזרה פתוחות, ממוינות לפי דחיפות ואז ותק. */
function ccOpenCallbacks() {
  const OPEN = ['waiting', 'no_answer', 'reschedule'];
  const rank = { critical: 0, high: 1, normal: 2, low: 3 };
  return (db.tasks || [])
    .filter(t => t.callback && OPEN.includes(String(t.callback.status || 'waiting')))
    .sort((a, b) => {
      const ra = rank[a.callback.urgency] ?? 2, rb = rank[b.callback.urgency] ?? 2;
      if (ra !== rb) return ra - rb;
      return String(a.callback.createdAt || '').localeCompare(String(b.callback.createdAt || ''));
    });
}

function ccClosedCallbacks(limit) {
  const CLOSED = ['contacted', 'completed', 'cancelled'];
  return (db.tasks || [])
    .filter(t => t.callback && CLOSED.includes(String(t.callback.status)))
    .sort((a, b) => String(b.callback.completedAt || b.callback.createdAt || '')
      .localeCompare(String(a.callback.completedAt || a.callback.createdAt || '')))
    .slice(0, limit || 20);
}

/** "לפני 3 שעות" — זמן ההמתנה הוא המספר שקובע כאן. */
function ccWaitingFor(iso) {
  if (!iso) return '—';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins} דק׳`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} שע׳${mins % 60 ? ` ${mins % 60} דק׳` : ''}`;
  return `${Math.floor(hours / 24)} ימים`;
}

/** ⚠ המתנה ארוכה מסומנת. בקשת חזרה דחופה שממתינה יום היא כישלון שירות. */
function ccWaitingClass(cb) {
  const hours = (Date.now() - Date.parse(cb.createdAt || 0)) / 3600000;
  if (!isFinite(hours)) return '';
  const urgent = cb.urgency === 'high' || cb.urgency === 'critical';
  if (urgent && hours > 4) return 'ai-attention';
  if (hours > 24) return 'ai-attention';
  return '';
}

function ccRenderCallbacks(host) {
  const open = ccOpenCallbacks();
  const closed = ccClosedCallbacks();

  host.innerHTML = `
    <div class="alert alert-info" style="margin-bottom:14px">
      <strong>המזכירה הדיגיטלית אינה מעבירה שיחות.</strong>
      <div style="margin-top:4px">כשמתקשר מבקש לדבר עם עורך הדין, היא לוקחת את פרטי
      הפנייה ופותחת בקשת חזרה. הרשימה הזו היא מה שנשאר לעשות.</div>
    </div>

    <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
      ${Stat('ממתינים', open.length, '', open.length > 0)}
      ${Stat('דחופים', open.filter(t => ['high', 'critical'].includes(t.callback.urgency)).length, '')}
      ${Stat('טופלו לאחרונה', closed.length, '')}
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-title">ממתינים לחזרה (${open.length})</div>
      ${open.length ? ccCallbackTable(open, true) :
        '<div class="empty">אין בקשות חזרה פתוחות.</div>'}
    </div>

    ${closed.length ? `<div class="card">
      <div class="card-title">טופלו</div>
      ${ccCallbackTable(closed, false)}
    </div>` : ''}`;
}

function ccCallbackTable(rows, withActions) {
  return `<table class="data-table">
    <thead><tr>
      <th>שם</th><th>טלפון</th><th>סיבת הפנייה</th><th>דחיפות</th>
      <th>ממתין</th><th>מועד מועדף</th><th>ניסיונות</th><th>סטטוס</th>
      ${withActions ? '<th></th>' : ''}
    </tr></thead>
    <tbody>${rows.map(t => {
      const cb = t.callback || {};
      const st = String(cb.status || 'waiting');
      return `<tr>
        <td><b style="color:var(--navy)">${escapeHtml(cb.callerName || '—')}</b></td>
        <td>${Phone(cb.callerPhone)}</td>
        <td style="max-width:280px">${escapeHtml(String(cb.reason || '').slice(0, 140))}</td>
        <td>${UrgencyBadge(cb.urgency)}</td>
        <td class="${ccWaitingClass(cb)}">${escapeHtml(ccWaitingFor(cb.createdAt))}</td>
        <td>${escapeHtml(cb.preferredCallbackTime || '—')}</td>
        <td>${Number(cb.attemptCount) || 0}</td>
        <td><span class="badge badge-${CC_CALLBACK_STATUS_CLS[st] || 'pending'}">
          ${escapeHtml(CC_CALLBACK_STATUS_HE[st] || st)}</span></td>
        ${withActions ? `<td style="white-space:nowrap">
          <div class="overflow-menu-wrap">
            <button class="btn btn-sm btn-success" onclick="ccCallbackSet(${aiJsAttr(t.id)},'completed')"
              title="הלקוח קיבל מענה">✓ חזרתי</button>
            <button class="btn btn-sm" onclick="ccCallbackSet(${aiJsAttr(t.id)},'no_answer')"
              title="חייגתי ולא ענו">לא ענה</button>
            <button class="btn btn-sm" onclick="ccCallbackReschedule(${aiJsAttr(t.id)})"
              title="קבע ניסיון נוסף">מועד אחר</button>
            ${t.clientId ? `<button class="btn btn-sm" onclick="ccOpenClient(${aiJsAttr(t.clientId)})">לקוח</button>` : ''}
            ${cb.sourceCallId ? `<button class="btn btn-sm" onclick="ccOpenCall(${aiJsAttr(cb.sourceCallId)})">שיחה</button>` : ''}
            <button class="btn btn-sm btn-danger" onclick="ccCallbackSet(${aiJsAttr(t.id)},'cancelled')"
              title="בוטל">⊘</button>
          </div>
        </td>` : ''}
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

/**
 * עדכון סטטוס.
 *
 * ⚠ עובר דרך שכבת הפקודות בשרת ולא דרך saveDB בדפדפן. בקשת חזרה
 * עשויה להתעדכן גם ע"י הסוכן (שיחה חוזרת מאותו מספר) וגם ע"י אדם
 * באותו רגע; שני נתיבי כתיבה לאותו שדה הם בדיוק המקום שבו "סימנתי
 * שחזרתי" נמחק בשקט.
 */
async function ccCallbackSet(taskId, status, extra) {
  try {
    await aiInvoke('call-center', Object.assign({
      action: 'callback.update', task_id: taskId, status,
    }, extra || {}));
    await loadDB();
    notify(status === 'completed' ? 'סומן כטופל ✓' : 'עודכן ✓');
    renderCallCenter();
  } catch (e) {
    notify((e && e.message) || 'העדכון נכשל');
  }
}

async function ccCallbackReschedule(taskId) {
  const when = await aiPrompt('מתי לחזור? (טקסט חופשי — למשל "מחר אחרי 16:00")', '');
  if (when === null) return;
  await ccCallbackSet(taskId, 'reschedule', { preferred_time: when });
}

// ============================================================
// ביצועים
// ============================================================
//
// ⚠ P50 ו-P95 ולא ממוצע בלבד. בשיחה קולית הזנב הוא הבעיה: ממוצע של
// 1.4 שניות נשמע מצוין גם כשאחת מכל עשרים שיחות ממתינה שש שניות —
// וזו השיחה שבה המתקשר מנתק.

const CC_LATENCY_TARGETS = { good: 1500, ok: 2500 };

function ccLatencyClass(ms) {
  const n = Number(ms) || 0;
  if (!n) return 'cc-s-idle';
  if (n <= CC_LATENCY_TARGETS.good) return 'cc-s-online';
  if (n <= CC_LATENCY_TARGETS.ok) return 'cc-s-degraded';
  return 'cc-s-offline';
}

function ccMs(v) {
  const n = Number(v);
  if (!isFinite(n) || !n) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)} שנ׳` : `${Math.round(n)} ms`;
}

async function ccRenderPerformance(host) {
  const days = ccPerfDays;
  const m = await aiInvoke('call-center', { action: 'metrics', days });

  if (!m.turns) {
    host.innerHTML = ccEmpty('אין נתוני ביצועים',
      'מדדים נאספים לכל תור שיחה. הרץ שיחת בדיקה כדי לראות אותם.',
      `<button class="btn btn-primary" style="margin-top:12px" onclick="ccNav('simulator')">▶ מצב בדיקה</button>`);
    return;
  }

  const row = (label, avg, p95, hint) => `
    <div class="cc-status">
      <div class="cc-status-label">${escapeHtml(label)}</div>
      <div class="cc-status-value ${ccLatencyClass(avg)}">${escapeHtml(ccMs(avg))}</div>
      <div class="cc-status-detail">${p95 != null ? `P95: ${escapeHtml(ccMs(p95))}` : ''}
        ${hint ? '<br>' + escapeHtml(hint) : ''}</div>
    </div>`;

  host.innerHTML = `
    <div class="cc-filters">
      <select class="form-input" onchange="ccPerfSetDays(this.value)">
        ${[1, 7, 30].map(d => `<option value="${d}"${d === days ? ' selected' : ''}>${d} ימים אחרונים</option>`).join('')}
      </select>
      <span class="cc-muted">${m.turns} תורות נמדדו</span>
    </div>

    <div class="ai-section-title">זמן תגובה כולל</div>
    <div class="cc-muted" style="margin-bottom:8px">
      מרגע שהמתקשר סיים לדבר ועד ששמע את תחילת התשובה. זה המספר שהאדם בקו מרגיש.
    </div>
    <div class="cc-status-grid">
      ${row('ממוצע', m.turn_avg_ms, null)}
      ${row('חציון (P50)', m.turn_p50_ms, null, 'מחצית מהתורות מהירים מזה')}
      ${row('P95', m.turn_p95_ms, null, 'הזנב — כאן מנתקים')}
      ${row('הפרעות', m.interruptions, null, 'מתקשר שקטע את הסוכנת')}
    </div>

    <div class="ai-section-title" style="margin-top:20px">פירוק לפי שלב</div>
    <div class="cc-status-grid">
      ${row('תמלול (STT)', m.stt_avg_ms, m.stt_p95_ms)}
      ${row('מנוע שפה — טוקן ראשון', m.llm_first_token_avg_ms, null)}
      ${row('מנוע שפה — סה"כ', m.llm_avg_ms, m.llm_p95_ms)}
      ${row('כלים', m.tool_avg_ms, m.tool_p95_ms)}
      ${row('הקראה — אודיו ראשון', m.tts_first_audio_avg_ms, null)}
      ${row('הקראה — סה"כ', m.tts_avg_ms, null)}
    </div>

    <div class="alert alert-info" style="margin-top:16px">
      <strong>יעד:</strong> זמן תגובה מתחת ל-1.5 שניות נשמע טבעי. מעל 2.5 שניות
      מתקשרים מתחילים לדבר שוב מתוך הנחה שהקו נפל.
      ${(m.tts_avg_ms == null && m.stt_avg_ms == null) ? `<div style="margin-top:6px">
        שלבי התמלול וההקראה אינם נמדדים כרגע — הם רצים בשרת הקול, שטרם חובר.</div>` : ''}
    </div>`;
}

let ccPerfDays = 7;
function ccPerfSetDays(v) { ccPerfDays = Number(v) || 7; renderCallCenter(); }

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
    const [callRes, evRes, segRes, actRes, metRes] = await Promise.all([
      aiSb().from('call_sessions').select('*').eq('id', callId).maybeSingle(),
      aiSb().from('call_events').select('*').eq('call_id', callId).order('occurred_at'),
      aiSb().from('call_transcript_segments').select('*').eq('call_id', callId).order('sequence'),
      aiSb().from('call_actions').select('*').eq('call_id', callId).order('started_at'),
      // מדדי השהיה לכל תור. .then(r=>r,()=>...) כי המיגרציה עשויה טרם
      // לרוץ — ומסך שיחה שלא נפתח בגלל טבלת מדדים חסרה הוא תקלה גרועה
      // בהרבה מהיעדר המדדים עצמם.
      aiSb().from('call_turn_metrics').select('*').eq('call_id', callId)
        .order('turn_index').then(r => r, () => ({ data: [] })),
    ]);
    if (callRes.error) throw callRes.error;
    const call = callRes.data;
    if (!call) { body.innerHTML = '<div class="empty">השיחה לא נמצאה.</div>'; return; }

    document.getElementById('cc-detail-title').textContent =
      `שיחה · ${ccCallerLabel(call)}`;

    body.innerHTML = ccCallDetailHtml(call, evRes.data || [], segRes.data || [],
      actRes.data || [], metRes.data || []);
    ccStartTimers();
  } catch (e) {
    body.innerHTML = ccError((e && e.message) || String(e), e);
  }
}

function ccCallDetailHtml(call, events, segments, actions, metrics) {
  const failed = actions.filter(a => a.status === 'failed' || a.status === 'blocked');
  metrics = metrics || [];

  return `
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px">
      ${CallStatusBadge(call.status)}
      ${UrgencyBadge(call.urgency)}
      ${call.category ? `<span class="badge badge-pending">${escapeHtml(call.category)}</span>` : ''}
      ${call.sentiment ? `<span class="badge badge-closed">רגש: ${escapeHtml(CC_SENTIMENT_HE[call.sentiment] || call.sentiment)}</span>` : ''}
      ${call.is_simulation ? '<span class="badge badge-closed">שיחת בדיקה</span>' : ''}
      ${ccIdentityBadge(call)}
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
          <div>זיהוי: ${escapeHtml(CC_IDENTITY_HE[call.identity_status] || call.identity_status || '—')}</div>
        </div>
        ${call.identity_status === 'phone_match' ? `<div class="cc-muted" style="margin-top:6px">
          ⚠ המספר תואם ללקוח אך הזהות לא אומתה. הסוכנת לא מסרה פרטי תיק.</div>` : ''}
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
        ${(() => {
          const shown = ccShowVerbose ? events : events.filter(e => !CC_VERBOSE_EVENTS.has(e.event_type));
          const hidden = events.length - shown.length;
          return (shown.length
            ? `<div class="cc-timeline">${shown.map(ccTimelineItem).join('')}</div>`
            : '<div class="cc-muted">אין אירועים.</div>') +
            (hidden > 0 || ccShowVerbose
              ? `<div style="margin-top:8px"><button class="btn btn-sm" onclick="ccToggleVerbose()">
                  ${ccShowVerbose ? 'הצג רק אירועים מרכזיים' : `הצג ${hidden} אירועים טכניים`}</button></div>`
              : '');
        })()}
      </div>
      <div class="card">
        <div class="card-title">פעולות שבוצעו</div>
        ${actions.length ? actions.map(ccActionRow).join('')
          : '<div class="cc-muted">לא בוצעו פעולות במערכת.</div>'}
        ${failed.length ? `<div class="alert alert-danger" style="margin-top:10px">
          ${failed.length} פעולות לא הושלמו. הפרטים מופיעים לידן.</div>` : ''}
      </div>
    </div>

    ${ccMetricsCard(call, metrics)}

    <div class="card" style="margin-top:14px">
      <div class="card-title">תמלול השיחה</div>
      ${segments.length ? ccTranscriptHtml(segments, actions)
        : '<div class="cc-muted">אין תמלול לשיחה זו.</div>'}
    </div>`;
}

function ccIdentityBadge(call) {
  const st = call.identity_status || 'unidentified';
  const cls = st === 'verified' ? 'active' : st === 'rejected' ? 'urgent' : 'pending';
  return `<span class="badge badge-${cls}">${escapeHtml(CC_IDENTITY_HE[st] || st)}</span>`;
}

/**
 * מדדי ההשהיה ותצורת הסוכן.
 *
 * ⚠ התצורה מוצגת מה-snapshot שנשמר על השיחה ולא מהסוכן הנוכחי. prompt
 * שהשתנה בצהריים לא משנה למפרע את מה ששיחה של הבוקר התנהלה לפיו — וזו
 * בדיוק השאלה שנשאלת כשמישהו מתלונן על משהו שהמזכירה אמרה.
 */
function ccMetricsCard(call, metrics) {
  const hasMetrics = metrics && metrics.length;
  const hasConfig = call.prompt_hash || call.llm_provider;
  if (!hasMetrics && !hasConfig) return '';

  return `<div class="two-col" style="margin-top:14px">
    ${hasMetrics ? `<div class="card">
      <div class="card-title">זמני תגובה</div>
      <div class="cc-muted" style="margin-bottom:8px">
        ממוצע ${escapeHtml(ccMs(call.avg_turn_latency_ms))} · שיא ${escapeHtml(ccMs(call.max_turn_latency_ms))}
        ${call.interruptions_count ? ` · ${call.interruptions_count} הפרעות` : ''}
      </div>
      <table class="data-table">
        <thead><tr><th>תור</th><th>תמלול</th><th>מודל</th><th>כלים</th><th>הקראה</th><th>סה"כ</th></tr></thead>
        <tbody>${metrics.map(m => `<tr>
          <td>${m.turn_index + 1}${m.interrupted ? ' ⚡' : ''}</td>
          <td>${escapeHtml(ccMs(m.stt_latency_ms))}</td>
          <td>${escapeHtml(ccMs(m.llm_total_ms))}</td>
          <td>${escapeHtml(ccMs(m.tool_latency_ms))}</td>
          <td>${escapeHtml(ccMs(m.tts_first_audio_ms))}</td>
          <td class="${ccLatencyClass(m.turn_latency_ms)}"><b>${escapeHtml(ccMs(m.turn_latency_ms))}</b></td>
        </tr>`).join('')}</tbody>
      </table>
    </div>` : '<div></div>'}

    ${hasConfig ? `<div class="card">
      <div class="card-title">תצורת הסוכן בשיחה זו</div>
      <div class="cc-muted" style="margin-bottom:8px">
        נשמר בתחילת השיחה. שינוי הגדרות מאוחר יותר אינו משנה את הרשומה הזו.
      </div>
      <table class="data-table"><tbody>
        ${ccCfgRow('מנוע שפה', call.llm_provider, call.llm_model)}
        ${ccCfgRow('תמלול', call.stt_provider, call.stt_model)}
        ${ccCfgRow('הקראה', call.tts_provider, call.tts_model)}
        ${ccCfgRow('גרסת הנחיות', call.prompt_hash, '')}
        ${ccCfgRow('גרסת הרשאות כלים', call.tools_policy_version, '')}
      </tbody></table>
      ${call.tags && call.tags.length ? `<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        ${call.tags.map(t => `<span class="badge badge-closed">${escapeHtml(t)}</span>`).join('')}
      </div>` : ''}
      ${call.post_call_status === 'pending' || call.post_call_status === 'processing'
        ? '<div class="cc-muted" style="margin-top:8px">⏳ הסיכום המלא בהכנה…</div>' : ''}
      ${call.post_call_status === 'failed'
        ? `<div class="cc-action-reason" style="margin-top:8px">עיבוד הסיכום נכשל: ${escapeHtml(call.post_call_error || '')}
           <button class="btn btn-sm" onclick="ccRetryPostCall(${aiJsAttr(call.id)})">נסה שוב</button></div>` : ''}
    </div>` : '<div></div>'}
  </div>`;
}

function ccCfgRow(label, value, sub) {
  if (!value) return '';
  return `<tr><td>${escapeHtml(label)}</td>
    <td><b>${escapeHtml(String(value))}</b>${sub ? ` <span class="cc-muted">${escapeHtml(String(sub))}</span>` : ''}</td></tr>`;
}

function ccToggleVerbose() { ccShowVerbose = !ccShowVerbose; ccRefreshCallDetail(); }

async function ccRetryPostCall(callId) {
  try {
    await aiInvoke('call-center', { action: 'call.postprocess', call_id: callId });
    notify('העיבוד הורץ מחדש ✓');
    await ccRefreshCallDetail();
  } catch (e) { notify((e && e.message) || 'הפעולה נכשלה'); }
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
  const r = st.readiness || { ready: false, blocking_reasons: [], warnings: [], checks: [] };
  const isOwner = currentRole === 'owner';

  const card = (label, comp, hint) => {
    const state = (comp && comp.state) || 'unknown';
    const map = {
      connected: ['🟢', 'מחובר', 'cc-s-online'],
      online: ['🟢', 'מחובר', 'cc-s-online'],
      live: ['🟢', 'פעיל', 'cc-s-online'],
      configured: ['🟢', 'מוגדר', 'cc-s-online'],
      registered: ['🟢', 'רשום', 'cc-s-online'],
      degraded: ['🟡', 'לא יציב', 'cc-s-degraded'],
      never_connected: ['🟡', 'טרם חובר', 'cc-s-degraded'],
      not_configured: ['🔴', 'לא מוגדר', 'cc-s-offline'],
      // ⚠ Mock מסומן אדום ולא צהוב. הוא בריא לחלוטין — ואם מחברים
      // אליו מספר אמיתי, הלקוח לא שומע דבר. זה חוסם, ולכן הוא נראה
      // כמו חוסם.
      mock: ['🔴', 'מצב הדגמה', 'cc-s-offline'],
      skeleton: ['🔴', 'שלד בלבד', 'cc-s-offline'],
      offline: ['🔴', 'מנותק', 'cc-s-offline'],
      failed: ['🔴', 'נכשל', 'cc-s-offline'],
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
  const s2 = st.settings || {};

  host.innerHTML = `
    <!-- ============ מוכנות לייצור ============ -->
    <div class="card ${r.ready ? '' : 'ai-emergency'}" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-size:18px;font-weight:700;color:${r.ready ? 'var(--success)' : 'var(--warning)'}">
            ${r.ready ? '🟢 מוכן לקבלת שיחות אמיתיות' : '🟡 עדיין לא מוכן ל-Production'}
          </div>
          <div class="cc-muted" style="margin-top:4px">
            ${r.checks.filter(x => x.severity === 'ok').length} מתוך ${r.checks.length} רכיבים תקינים
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" onclick="ccRunReadiness()">↻ בדיקת מוכנות מלאה</button>
          ${isOwner ? ccLiveCallsButton(s2, r) : ''}
        </div>
      </div>

      <div class="progress-wrap" style="margin-top:12px">
        <div class="progress-fill" style="width:${r.progress || 0}%;
          background:${r.ready ? 'var(--success)' : 'var(--warning)'}"></div>
      </div>

      ${r.blocking_reasons.length ? `<div style="margin-top:12px">
        <div style="font-size:12px;font-weight:700;color:var(--danger);margin-bottom:6px">חסמים</div>
        ${r.blocking_reasons.map(x => `<div class="cc-action cc-action-fail">
          <div class="cc-action-icon">🔴</div>
          <div class="cc-action-body">${escapeHtml(x)}</div></div>`).join('')}
      </div>` : ''}

      ${r.warnings.length ? `<div style="margin-top:12px">
        <div style="font-size:12px;font-weight:700;color:var(--warning);margin-bottom:6px">אזהרות</div>
        ${r.warnings.map(x => `<div class="cc-action cc-action-blocked">
          <div class="cc-action-icon">⚠</div>
          <div class="cc-action-body">${escapeHtml(x)}</div></div>`).join('')}
      </div>` : ''}

      ${s2.live_calls_enabled ? `<div class="alert alert-success" style="margin-top:12px">
        המערכת מקבלת שיחות אמיתיות מאז ${aiFmtDate(s2.live_calls_enabled_at)}.</div>` : ''}
      <div id="cc-readiness-result"></div>
    </div>

    <!-- ============ רכיבים ============ -->
    <div class="ai-section-title">רכיבי המערכת</div>
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

    <!-- ============ יכולות הספקים ============ -->
    ${ccProviderTable(st.providers || {})}

    <!-- ============ סנכרון ============ -->
    <div class="card" style="margin-top:16px">
      <div class="card-title">סנכרון פעולות</div>
      <div class="cc-muted" style="margin-bottom:8px">
        פעולות שנוצרו בשיחה נשמרות בשרת הקול עד שה-CRM מאשר אותן. פעולה שמיצתה את
        כל הניסיונות מופיעה כאן — היא לא נעלמת.
      </div>
      <div class="cc-status-grid">
        ${card('ממתינות לסנכרון',
          { state: (c.voice_gateway && c.voice_gateway.outbox_pending) ? 'degraded' : 'connected',
            detail: `${(c.voice_gateway && c.voice_gateway.outbox_pending) || 0} פעולות` })}
        ${card('לא סונכרנו',
          { state: st.dead_letters ? 'error' : 'connected',
            detail: `${st.dead_letters || 0} פעולות` })}
      </div>
      <div id="cc-deadletters" style="margin-top:12px"></div>
    </div>

    <!-- ============ המספר ============ -->
    <div class="card" style="margin-top:16px">
      <div class="card-title">המספר הציבורי</div>
      <div style="font-size:22px;font-weight:700;color:var(--navy)" class="cc-num">
        ${escapeHtml(ccFormatPhone(st.phone))}</div>
      <div class="cc-muted" style="margin-top:6px">
        ${escapeHtml(st.phone || '')} · ${(c.sip && c.sip.state === 'registered')
          ? 'הקו רשום אצל הספק.'
          : 'ממתין להגדרת ספק טלפוניה. שיחות אמיתיות אינן מתקבלות עדיין.'}
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

    <!-- ============ הגדרות שרת ============ -->
    <div class="card" style="margin-top:14px">
      <div class="card-title">הגדרות שרת</div>
      <div class="cc-muted" style="margin-bottom:8px">
        מוצג רק האם הערך מוגדר. שום סוד אינו נשלח לדפדפן.
      </div>
      <table class="data-table"><tbody>
        ${ccConfigRow('סוד חתימה לשרת הקול (VOICE_GATEWAY_SECRET)', sc.voice_gateway_secret,
          'בלעדיו שרת הקול לא יוכל להתחבר כלל')}
        ${ccConfigRow('כתובת שרת הקול (VOICE_GATEWAY_URL)', Boolean(sc.voice_gateway_url), '')}
        ${ccConfigRow('מפתח מנוע השפה (ANTHROPIC_API_KEY)', sc.anthropic_key,
          'בלעדיו המערכת עובדת במצב הדגמה')}
        ${ccConfigRow('ערוץ אודיו', Boolean(c.voice_gateway && c.voice_gateway.transport),
          escapeHtml((c.voice_gateway && c.voice_gateway.transport) || 'לא דווח'))}
        ${ccConfigRow('הקלטת שיחות', Boolean(s2.recording_enabled),
          'כבוי כברירת מחדל, במכוון', true)}
      </tbody></table>
    </div>`;

  ccLoadDeadLetters();
}

/**
 * מתג השיחות האמיתיות.
 *
 * ⚠ חסום כשהמערכת אינה מוכנה, ולא רק מוצג באפור: הפעלה על מערכת עם
 * TTS במצב הדגמה פירושה שהמתקשר הראשון לא ישמע דבר. השרת חוסם גם הוא
 * (live_calls.set מחזיר 409) — הכפילות מכוונת.
 */
function ccLiveCallsButton(settings, readiness) {
  if (settings.live_calls_enabled) {
    return `<button class="btn btn-danger" onclick="ccSetLiveCalls(false)">
      ⏸ הפסק קבלת שיחות אמיתיות</button>`;
  }
  if (!readiness.ready) {
    return `<button class="btn" disabled
      title="לא ניתן להפעיל כל עוד קיימים חסמים">🔒 אפשר שיחות אמיתיות</button>`;
  }
  return `<button class="btn btn-primary" onclick="ccSetLiveCalls(true)">
    ▶ אפשר שיחות אמיתיות</button>`;
}

async function ccSetLiveCalls(enabled) {
  const ok = await customConfirm(
    enabled
      ? 'להפעיל קבלת שיחות אמיתיות? מרגע זה המזכירה הדיגיטלית תענה למתקשרים.'
      : 'להפסיק קבלת שיחות אמיתיות? שיחות נכנסות לא ייענו ע"י המזכירה.',
    { title: enabled ? 'הפעלת שיחות אמיתיות' : 'הפסקת שיחות', okText: 'אישור',
      danger: !enabled });
  if (!ok) return;

  try {
    const res = await aiInvoke('call-center', { action: 'live_calls.set', enabled });
    if (res && res.ok === false) {
      notify(res.error || 'לא ניתן להפעיל');
    } else {
      notify(enabled ? '🟢 שיחות אמיתיות מופעלות' : 'שיחות אמיתיות הופסקו');
    }
  } catch (e) {
    notify((e && e.message) || 'הפעולה נכשלה');
  }
  ccStatusCache = null;
  renderCallCenter();
}

async function ccRunReadiness() {
  const el = document.getElementById('cc-readiness-result');
  if (el) el.innerHTML = '<div class="cc-muted" style="margin-top:10px">בודק…</div>';
  try {
    const r = await aiInvoke('call-center', { action: 'readiness' });
    if (el) {
      el.innerHTML = `<div style="margin-top:12px">
        <div class="ai-section-title">תוצאות הבדיקה</div>
        ${r.checks.map(x => {
          const icon = x.severity === 'ok' ? '✅' : x.severity === 'warning' ? '⚠️' : '🔴';
          const cls = x.severity === 'ok' ? 'cc-action-ok'
            : x.severity === 'warning' ? 'cc-action-blocked' : 'cc-action-fail';
          return `<div class="cc-action ${cls}">
            <div class="cc-action-icon">${icon}</div>
            <div class="cc-action-body">
              <b>${escapeHtml(x.label)}</b>
              <div class="cc-muted">${escapeHtml(x.detail)}</div>
            </div></div>`;
        }).join('')}
      </div>`;
    }
    ccStatusCache = null;
  } catch (e) {
    if (el) el.innerHTML = `<div class="alert alert-danger" style="margin-top:10px">
      ${escapeHtml((e && e.message) || String(e))}</div>`;
  }
}

/** יכולות הספקים — מה אפשרי, לא רק מה מחובר. */
function ccProviderTable(providers) {
  const keys = Object.keys(providers);
  if (!keys.length) return '';
  const yn = v => v === true ? '✓' : v === false ? '—' : '?';
  return `<div class="card" style="margin-top:16px">
    <div class="card-title">יכולות הספקים</div>
    <div class="cc-muted" style="margin-bottom:8px">
      <b>פעיל</b> פירושו שהשירות מגיב. <b>מוכן לייצור</b> פירושו שאפשר לענות איתו
      לטלפון של לקוח. אלה שני דברים שונים.
    </div>
    <table class="data-table">
      <thead><tr><th>רכיב</th><th>ספק</th><th>מצב</th><th>פעיל</th><th>מוכן לייצור</th>
        <th>עברית</th><th>זרימה</th><th>הפרעה</th><th>השהיה</th></tr></thead>
      <tbody>${keys.map(k => {
        const p = providers[k] || {};
        return `<tr>
          <td><b>${escapeHtml(k.toUpperCase())}</b></td>
          <td>${escapeHtml(p.name || '—')}</td>
          <td>${escapeHtml(p.mode === 'mock' ? 'הדגמה' : p.mode === 'skeleton' ? 'שלד' : 'אמיתי')}</td>
          <td>${p.healthy === false ? '🔴' : '🟢'}</td>
          <td>${p.production_ready ? '🟢' : '🔴'}</td>
          <td>${yn(p.supports_hebrew)}</td>
          <td>${yn(p.supports_streaming)}</td>
          <td>${yn(p.supports_barge_in)}</td>
          <td>${p.average_latency_ms ? escapeHtml(ccMs(p.average_latency_ms)) : '—'}</td>
        </tr>${p.message ? `<tr><td colspan="9" class="cc-muted"
          style="padding-top:0">${escapeHtml(p.message)}</td></tr>` : ''}`;
      }).join('')}</tbody>
    </table>
  </div>`;
}

/**
 * פעולות שלא סונכרנו.
 *
 * ⚠ המפרט אוסר לאבד פעולה בשקט. כל שורה כאן היא פנייה של לקוח שהמזכירה
 * קיבלה ושלא נרשמה במערכת — היא חייבת להיות גלויה ולהיות ניתנת לטיפול.
 */
async function ccLoadDeadLetters() {
  const host = document.getElementById('cc-deadletters');
  if (!host) return;
  try {
    const { data, error } = await aiSb().from('voice_dead_letters')
      .select('*').neq('status', 'resolved')
      .order('created_at', { ascending: false }).limit(20);
    if (error) throw error;
    if (!data || !data.length) {
      host.innerHTML = '<div class="cc-muted">כל הפעולות סונכרנו.</div>';
      return;
    }
    const isOwner = currentRole === 'owner';
    host.innerHTML = `<table class="data-table">
      <thead><tr><th>מתי</th><th>פעולה</th><th>ניסיונות</th><th>שגיאה</th><th></th></tr></thead>
      <tbody>${data.map(d => `<tr>
        <td style="white-space:nowrap">${aiFmtDate(d.created_at)}</td>
        <td><b>${escapeHtml(d.action || '—')}</b>
          ${d.error_code ? `<div class="cc-muted">${escapeHtml(d.error_code)}</div>` : ''}</td>
        <td>${d.attempt_count}</td>
        <td style="max-width:320px" class="cc-action-reason">${escapeHtml(String(d.last_error || '').slice(0, 200))}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm" onclick="ccDeadLetterDetails(${aiJsAttr(d.id)})">פרטים</button>
          ${isOwner ? `<button class="btn btn-sm btn-success"
            onclick="ccResolveDeadLetter(${aiJsAttr(d.id)})">סמן כטופל</button>` : ''}
        </td>
      </tr>`).join('')}</tbody></table>`;
  } catch (e) {
    host.innerHTML = '';
  }
}

async function ccDeadLetterDetails(id) {
  const { data } = await aiSb().from('voice_dead_letters').select('*').eq('id', id).maybeSingle();
  if (!data) return;
  await customAlert(
    `פעולה: ${data.action}\n` +
    `ניסיונות: ${data.attempt_count}\n` +
    `שגיאה: ${data.last_error || '—'}\n` +
    `מזהה שיחה: ${data.call_external_id || data.call_id || '—'}\n\n` +
    `תוכן: ${JSON.stringify(data.payload || {}, null, 1).slice(0, 800)}`,
    'פעולה שלא סונכרנה');
}

async function ccResolveDeadLetter(id) {
  const ok = await customConfirm(
    'לסמן את הפעולה כטופלה? ודא שהפנייה נרשמה במערכת באופן ידני.',
    { title: 'סימון כטופל', okText: 'סמן' });
  if (!ok) return;
  try {
    await aiInvoke('call-center', { action: 'deadletter.resolve', id });
    notify('סומן כטופל ✓');
    ccStatusCache = null;
    renderCallCenter();
  } catch (e) { notify((e && e.message) || 'הפעולה נכשלה'); }
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
  const p = st.providers || {};
  const isOwner = currentRole === 'owner';
  const ro = isOwner ? '' : 'disabled';

  host.innerHTML = `
    <!-- ============ טלפוניה ============ -->
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">טלפוניה</div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">המספר הציבורי של המשרד</label>
          <input class="form-input cc-num" id="cc-set-phone" dir="ltr"
            value="${escapeHtml(st.phone || '')}" ${ro}>
          <div class="cc-muted" style="margin-top:5px">
            נשמר בפורמט E.164 (למשל +972552745790). נרמול מתבצע אוטומטית בשמירה.
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">מספר העברה לנציג אנושי</label>
          <input class="form-input cc-num" id="cc-set-transfer" dir="ltr"
            value="${escapeHtml(s.human_transfer_number || '')}" ${ro} placeholder="לא מוגדר">
          <div class="cc-muted" style="margin-top:5px">
            ⚠ החלטת המוצר היא ש<b>אין העברה חיה</b>. הסוכנת לוקחת הודעה ופותחת בקשת
            חזרה. השדה נשאר לשימוש עתידי; אין להזין בו את המספר הציבורי — העברה
            אליו תיצור לולאת ניתוב.
          </div>
        </div>
      </div>
      <div class="cc-muted">
        ספק טלפוניה: ${escapeHtml(((st.components || {}).sip || {}).state === 'registered' ? 'רשום' : 'לא מוגדר')}
        · מרכזייה: ${escapeHtml(((st.components || {}).asterisk || {}).state || '—')}
        · ערוץ אודיו: ${escapeHtml(s.media_transport || '—')}
      </div>
    </div>

    <!-- ============ מנועי ה-AI ============ -->
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">מנועי הקול</div>
      <div class="cc-muted" style="margin-bottom:10px">
        הספקים נקבעים בשרת הקול (משתני סביבה) ומדווחים כאן. מסך זה מציג את מה
        ש<b>רץ בפועל</b>, לא את מה שהוגדר.
      </div>
      <table class="data-table">
        <thead><tr><th>רכיב</th><th>ספק</th><th>מצב</th><th>מוכן לייצור</th></tr></thead>
        <tbody>
          ${['stt', 'llm', 'tts'].map(k => {
            const pr = p[k] || {};
            const label = { stt: 'תמלול (STT)', llm: 'מנוע שפה (LLM)', tts: 'הקראה (TTS)' }[k];
            return `<tr>
              <td><b>${label}</b></td>
              <td>${escapeHtml(pr.name || 'לא דווח')}</td>
              <td>${escapeHtml(pr.mode === 'mock' ? 'הדגמה' : pr.mode === 'skeleton' ? 'שלד' : 'אמיתי')}</td>
              <td>${pr.production_ready ? '🟢 כן' : '🔴 לא'}
                ${pr.message ? `<div class="cc-muted">${escapeHtml(pr.message)}</div>` : ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    <!-- ============ התנהגות השיחה ============ -->
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">התנהגות השיחה</div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">משך שיחה מרבי (שניות)</label>
          <input class="form-input" type="number" min="60" max="3600" id="cc-set-maxdur"
            value="${Number(s.max_call_duration_seconds) || 600}" ${ro}>
        </div>
        <div class="form-group">
          <label class="form-label">זמן שתיקה עד תגובה (מילישניות)</label>
          <input class="form-input" type="number" min="2000" max="30000" step="500"
            id="cc-set-silence" value="${Number(s.silence_timeout_ms) || 8000}" ${ro}>
        </div>
        <div class="form-group">
          <label class="form-label">SLA לחזרה ללקוח (שעות)</label>
          <input class="form-input" type="number" min="0" max="168" id="cc-set-sla"
            value="${Number(s.callback_sla_hours) || 0}" ${ro}>
          <div class="cc-muted" style="margin-top:4px">
            0 = ללא התחייבות. ⚠ כל עוד הערך אפס, הסוכנת לא תבטיח זמן חזרה מדויק —
            הבטחה שלא נשמרת גרועה מהיעדר הבטחה.
          </div>
        </div>
      </div>
      <div class="ai-toggles">
        <label class="ai-switch"><input type="checkbox" id="cc-set-bargein"
          ${s.barge_in_enabled !== false ? 'checked' : ''} ${ro}>
          אפשר למתקשר לקטוע את הסוכנת (barge-in)</label>
        <label class="ai-switch"><input type="checkbox" id="cc-set-ai"
          ${s.ai_enabled !== false ? 'checked' : ''} ${ro}>
          המזכירה הדיגיטלית פעילה</label>
        <label class="ai-switch"><input type="checkbox" id="cc-set-sim"
          ${s.simulation_enabled !== false ? 'checked' : ''} ${ro}>
          מצב בדיקה זמין</label>
      </div>
    </div>

    <!-- ============ זהות ============ -->
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">זיהוי מתקשרים</div>
      <div class="form-group">
        <label class="form-label">מדיניות מסירת מידע</label>
        <select class="form-input" id="cc-set-identity" ${ro}>
          <option value="strict"${s.identity_policy === 'strict' ? ' selected' : ''}>
            קפדנית — התאמת מספר אינה מספיקה למסירת פרטי תיק (מומלץ)</option>
          <option value="phone_match_ok"${s.identity_policy === 'phone_match_ok' ? ' selected' : ''}>
            מקלה — התאמת מספר מספיקה</option>
        </select>
        <div class="cc-muted" style="margin-top:6px">
          ⚠ Caller ID אינו אימות זהות. טלפון אבוד, בן משפחה או זיוף מספר מייצרים
          אותה התאמה בדיוק. במדיניות קפדנית הסוכנת פונה ללקוח בשמו אך אינה מוסרת
          פרטי תיק.
        </div>
      </div>
    </div>

    <!-- ============ פרטיות ============ -->
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">פרטיות ושמירת נתונים</div>
      <div class="ai-toggles">
        <label class="ai-switch"><input type="checkbox" id="cc-set-recording"
          ${s.recording_enabled ? 'checked' : ''} ${ro}> הקלטת שיחות</label>
        <label class="ai-switch"><input type="checkbox" id="cc-set-transcript"
          ${s.transcript_enabled !== false ? 'checked' : ''} ${ro}> שמירת תמלול</label>
      </div>
      <div class="alert alert-warning" style="margin-top:10px">
        הקלטת שיחה כפופה לחוק האזנת סתר ולכללי האתיקה. ההקלטה כבויה כברירת מחדל
        ואינה מופעלת אוטומטית.
      </div>

      <div class="form-row" style="margin-top:10px">
        <div class="form-group">
          <label class="form-label">שמירת תמלולים (ימים)</label>
          <input class="form-input" type="number" min="0" id="cc-set-ret-transcript"
            value="${Number(s.transcript_retention_days) || 0}" ${ro}>
        </div>
        <div class="form-group">
          <label class="form-label">שמירת הקלטות (ימים)</label>
          <input class="form-input" type="number" min="0" id="cc-set-ret-recording"
            value="${Number(s.recording_retention_days) || 0}" ${ro}>
        </div>
        <div class="form-group">
          <label class="form-label">שמירת נתוני שיחה (ימים)</label>
          <input class="form-input" type="number" min="0" id="cc-set-ret-meta"
            value="${Number(s.call_metadata_retention_days) || 0}" ${ro}>
        </div>
      </div>
      <div class="cc-muted">0 = ללא מחיקה. בשלב זה <b>אין מחיקה אוטומטית</b> —
        ההגדרה נשמרת בלבד. מחיקת מידע בתיק משפטי דורשת כוונה מפורשת.</div>
    </div>

    <!-- ============ ייצור ============ -->
    <div class="card ${s.live_calls_enabled ? '' : 'ai-emergency'}" style="margin-bottom:14px">
      <div class="card-title">שיחות אמיתיות</div>
      <div style="font-size:15px;font-weight:700;color:${s.live_calls_enabled ? 'var(--success)' : 'var(--text2)'}">
        ${s.live_calls_enabled ? '🟢 מופעל' : '⚪ כבוי'}
      </div>
      <div class="cc-muted" style="margin-top:6px">
        ⚠ גם כשכל התשתית מחוברת, קבלת שיחות אמיתיות אינה נדלקת מעצמה. ההפעלה
        נעשית במסך "מצב מערכת" אחרי בדיקת מוכנות שעוברת.
      </div>
      <button class="btn" style="margin-top:10px" onclick="ccNav('system')">
        עבור למצב מערכת ←</button>
    </div>

    ${isOwner ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      <button class="btn btn-primary" onclick="ccSaveSettings()">שמור הגדרות</button>
      <button class="btn btn-danger" onclick="ccToggleEmergency(${!s.emergency_stop})">
        ${s.emergency_stop ? '▶ בטל עצירת חירום' : '⛔ עצירת חירום'}</button>
    </div>` : '<div class="alert alert-info">שינוי הגדרות זמין לבעל המשרד בלבד.</div>'}

    ${s.emergency_stop ? `<div class="alert alert-danger">
      <strong>המזכירה הדיגיטלית מושבתת.</strong> שיחות נכנסות לא יטופלו אוטומטית.</div>` : ''}

    <!-- ============ בדיקות ============ -->
    <div class="card">
      <div class="card-title">בדיקות</div>
      <div class="cc-muted" style="margin-bottom:10px">
        כל בדיקה מריצה את הנתיב האמיתי. בדיקה של ספק במצב הדגמה נכשלת בכוונה —
        "תקין" על מנוע שמחזיר שקט הוא בדיוק מה שגורם לחבר מספר אמיתי בביטחון מוטעה.
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" onclick="ccRunTest('test.crm','cc-t-crm')">CRM API</button>
        <button class="btn" onclick="ccRunTest('test.gateway','cc-t-gw')">שרת טלפוניה</button>
        <button class="btn" onclick="ccRunTest('test.tools','cc-t-tools')">שער הכלים</button>
        <button class="btn" onclick="ccRunTest('test.stt','cc-t-stt')">תמלול (STT)</button>
        <button class="btn" onclick="ccRunTest('test.llm','cc-t-llm')">מנוע שפה (LLM)</button>
        <button class="btn" onclick="ccRunTest('test.tts','cc-t-tts')">הקראה (TTS)</button>
        <button class="btn" onclick="ccRunTest('test.simulation','cc-t-sim')">שיחת בדיקה</button>
        <button class="btn btn-primary" onclick="ccRunTest('test.pipeline','cc-t-pipe')">
          ▶ צינור מלא</button>
      </div>
      <div id="cc-t-crm" style="margin-top:10px"></div>
      <div id="cc-t-gw"></div><div id="cc-t-tools"></div>
      <div id="cc-t-stt"></div><div id="cc-t-llm"></div><div id="cc-t-tts"></div>
      <div id="cc-t-sim"></div><div id="cc-t-pipe"></div>
    </div>`;
}

async function ccSaveSettings() {
  const officeId = await aiOfficeId();
  const v = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const chk = id => { const el = document.getElementById(id); return el ? el.checked : false; };
  const num = (id, def) => { const n = Number(v(id)); return isFinite(n) ? n : def; };

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
      // נרמול ל-E.164 לפני שמירה: המספר הזה משמש להשוואה מול מספרי
      // מתקשרים, וצורה לא קנונית פירושה שהשוואה תיכשל בשקט.
      public_office_phone: ccToE164(phone) || phone || null,
      human_transfer_number: ccToE164(transfer) || transfer || null,
      recording_enabled: chk('cc-set-recording'),
      transcript_enabled: chk('cc-set-transcript'),
      ai_enabled: chk('cc-set-ai'),
      simulation_enabled: chk('cc-set-sim'),
      barge_in_enabled: chk('cc-set-bargein'),
      identity_policy: v('cc-set-identity') || 'strict',
      max_call_duration_seconds: Math.max(60, num('cc-set-maxdur', 600)),
      silence_timeout_ms: Math.max(2000, num('cc-set-silence', 8000)),
      callback_sla_hours: Math.max(0, num('cc-set-sla', 0)),
      transcript_retention_days: Math.max(0, num('cc-set-ret-transcript', 0)),
      recording_retention_days: Math.max(0, num('cc-set-ret-recording', 0)),
      call_metadata_retention_days: Math.max(0, num('cc-set-ret-meta', 0)),
    }, q => q.eq('office_id', officeId),
      'ההגדרות לא נשמרו — נדרשת הרשאת בעל משרד.');

    await aiInvoke('call-center', { action: 'settings.sync' });
    ccStatusCache = null;
    notify('ההגדרות נשמרו ✓');
    renderCallCenter();
  } catch (e) { notify((e && e.message) || 'השמירה נכשלה'); }
}

/**
 * נרמול ל-E.164 בצד הלקוח.
 *
 * ⚠ מכוון להיות זהה ל-normalizePhoneNumber בשרת. הוא לא מחליף אותו —
 * השרת מנרמל שוב — אבל בלעדיו המשתמש היה רואה בשדה מה שהקליד ומגלה
 * רק אחר כך שנשמר משהו אחר.
 */
function ccToE164(raw) {
  let s = String(raw || '').replace(/[\s\-().]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s.startsWith('+972')) s = '+972' + s.slice(4).replace(/^0+/, '');
  else if (s.startsWith('972')) s = '+972' + s.slice(3).replace(/^0+/, '');
  else if (s.startsWith('0')) s = '+972' + s.slice(1);
  else if (!s.startsWith('+')) return '';
  return /^\+\d{9,15}$/.test(s) ? s : '';
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
    // ⚠ NOT_PRODUCTION_READY מוצג אדום ולא צהוב. הבדיקה "עברה" טכנית
    // והמערכת עדיין לא יכולה לענות לטלפון — צבע מרגיע כאן הוא בדיוק
    // מה שגורם לחבר מספר אמיתי בביטחון מוטעה.
    const blocking = res.code === 'NOT_PRODUCTION_READY';
    const cls = res.ok ? 'alert-success' : blocking ? 'alert-danger' : 'alert-warning';
    const icon = res.ok ? '🟢' : blocking ? '🔴' : '🟡';
    let extra = '';
    if (res.stages && res.stages.length) {
      extra += '<div style="margin-top:8px">' + res.stages.map(st =>
        `<div class="cc-action ${st.ok ? 'cc-action-ok' : 'cc-action-fail'}">
          <div class="cc-action-icon">${st.ok ? '✓' : '🔴'}</div>
          <div class="cc-action-body"><b>${escapeHtml(st.stage)}</b>
            <div class="cc-muted">${escapeHtml(st.detail)}${st.ms ? ` · ${ccMs(st.ms)}` : ''}</div>
          </div></div>`).join('') + '</div>';
    }
    if (res.provider) {
      extra += `<div class="cc-muted" style="margin-top:6px">
        ספק: ${escapeHtml(res.provider.name || '?')} · מצב: ${escapeHtml(res.provider.mode || '?')}</div>`;
    }
    if (res.reply) {
      extra += `<div style="margin-top:6px"><b>תשובה:</b> ${escapeHtml(res.reply)}</div>`;
    }
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
