// מרכז שליטה לסוכני AI — צד לקוח.
//
// קובץ נפרד ולא הרחבה של app.js (שכבר 297KB). נטען כ-<script> רגיל אחרי
// app.js, ולכן יש לו גישה ל-db, saveDB, notify, escapeHtml, uid, openModal
// וכל שאר הגלובלים — ומשתמש בהם במקום לשכפל אותם.
//
// ## ההחלטה המרכזית בקובץ הזה: החלת אישורים
//
// כל ה-CRM הוא ערך jsonb יחיד ב-app_data (ראה docs/AI_CENTER_AUDIT.md §4).
// שמירה היא read-modify-write של השורה כולה. אילו ה-worker היה כותב לשם
// במקביל למשתמש שעובד כאן — אחד היה דורס את השני בלי שאיש ישים לב.
//
// לכן הסוכנים **לא כותבים ל-CRM בכלל**. הם יוצרים שורות ב-ai_approvals,
// ו-aiApplyApproval() כאן מחיל אותן דרך אותו נתיב saveDB() בדיוק שכל
// פעולת משתמש עוברת בו. תופעת לוואי נוחה: זה גם בדיוק מה שהפרומט דורש
// משפטית — אישור אנושי לפני פעולה רגישה.
//
// פעולות **חיצוניות** (שליחת מייל/וואטסאפ) לא מבוצעות כאן אלא ב-ai-comms,
// שקורא את סטטוס האישור מהשרת לפני ששולח. הדפדפן לא יכול "להכריז" שמשהו
// אושר.

'use strict';

// ===== מצב =====
let aiTab = 'team';
let aiBusy = false;
let aiCache = { agents: null, settings: null, integrations: null };
let aiRealtimeChannel = null;
let aiCurrentRunId = null;
let aiDrainTimer = null;

const AI_RISK_HE = { none: 'ללא', low: 'נמוך', medium: 'בינוני', high: 'גבוה', critical: 'קריטי' };
const AI_RISK_ICON = { none: '○', low: '◔', medium: '◑', high: '◕', critical: '●' };
const AI_STATUS_HE = {
  pending: 'ממתין', queued: 'בתור', running: 'רץ', waiting_approval: 'ממתין לאישור',
  completed: 'הושלם', failed: 'נכשל', cancelled: 'בוטל', stopped: 'נעצר',
  dead_letter: 'נכשל סופית', approved: 'אושר', rejected: 'נדחה', applied: 'הוחל',
  expired: 'פג תוקף', returned: 'הוחזר לסוכן',
};
const AI_STATUS_ICON = {
  pending: '⏳', queued: '⏳', running: '⚙', waiting_approval: '✋',
  completed: '✓', failed: '✗', cancelled: '⊘', stopped: '⛔',
  dead_letter: '✗', approved: '✓', rejected: '✗', applied: '✓',
  expired: '⌛', returned: '↩',
};

// ===== גישה לשרת =====

function aiSb() {
  if (!window.supabaseClient) throw new Error('החיבור לשרת לא זמין');
  return window.supabaseClient;
}

/**
 * קריאה ל-Edge Function. supabase-js מצרף את ה-JWT של הסשן אוטומטית,
 * ולכן office_id ותפקיד נגזרים בשרת ולא נשלחים מכאן — מה שהופך זיוף
 * מזהה משרד מהדפדפן לבלתי אפשרי.
 */
async function aiInvoke(fn, body) {
  const { data, error } = await aiSb().functions.invoke(fn, { body });
  if (error) {
    // הודעת השגיאה האמיתית (בעברית) יושבת בגוף התשובה, לא ב-error.message —
    // אותה בעיה שכבר טופלה ב-platform.web.js unwrapFunctionError.
    let msg = error.message || 'שגיאה בשרת';
    try {
      const ctx = error.context;
      if (ctx && typeof ctx.json === 'function') {
        const j = await ctx.json();
        if (j && j.error) msg = j.error;
      }
    } catch (e) { /* נשארים עם ההודעה הגנרית */ }
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

/**
 * עדכון שמאמת שהשורה באמת נכתבה.
 *
 * ⚠ זו הפונקציה שמונעת את הבאג המסוכן ביותר בקובץ הזה. RLS מסנן שורות,
 * הוא לא זורק שגיאה: כשמדיניות ה-UPDATE חוסמת את המשתמש, PostgREST מחזיר
 * הצלחה עם אפס שורות מעודכנות ו-`error: null`. בדיקת `error` בלבד הייתה
 * מציגה "⛔ כל הסוכנים נעצרו" למי שאין לו הרשאה — בזמן שהסוכנים ממשיכים
 * לרוץ. במערכת שכל תכליתה שליטה, זו התקלה הגרועה ביותר האפשרית.
 *
 * `.select()` מכריח את PostgREST להחזיר את השורות שנכתבו בפועל; מערך ריק
 * = נחסם. מדיניות ה-SELECT רחבה יותר מזו של ה-UPDATE בכל הטבלאות כאן,
 * ולכן ההבחנה אמינה.
 */
async function aiUpdateChecked(table, patch, applyFilter, deniedMessage) {
  let q = aiSb().from(table).update(patch);
  q = applyFilter(q);
  // select() ללא ארגומנט ולא select('id'): ai_settings ממופתחת ב-office_id
  // ואין בה עמודת id כלל, כך שעמודה קשיחה הייתה מפילה דווקא את מסך
  // ההגדרות — כולל עצירת החירום.
  const { data, error } = await q.select();
  if (error) throw new Error(error.message);
  if (!data || !data.length) {
    throw new Error(deniedMessage || 'אין לך הרשאה לבצע פעולה זו.');
  }
  return data;
}

/**
 * ערך בטוח להזרקה כארגומנט JS בתוך מאפיין onclick.
 *
 * ⚠ escapeHtml **אינו** מספיק כאן, וזו טעות קלה מאוד לעשות: הוא ממיר `'`
 * ל-`&#39;`, אבל מנתח ה-HTML מפענח ישויות בערך של מאפיין **לפני** שה-JS
 * נקרא — כך ש-`&#39;` חוזר להיות גרש אמיתי בתוך קוד ה-JS. ערך כמו
 * `x'),alert(1),('` היה נשאר בר-הרצה.
 *
 * JSON.stringify מייצר literal תקין של JS (כולל המרכאות והבריחות), ורק
 * אז escapeHtml מגן על גבולות המאפיין. שילוב השניים בטוח בשני השלבים.
 * שימוש: onclick="f(${aiJsAttr(v)})"
 */
function aiJsAttr(v) {
  return escapeHtml(JSON.stringify(String(v == null ? '' : v)));
}

const AI_OWNER_ONLY = 'הפעולה לא בוצעה — נדרשת הרשאת בעל משרד.';
const AI_APPROVER_ONLY = 'הפעולה לא בוצעה — אישור פעולות מותר לבעל המשרד או לעורך דין בלבד.';

// ===== ניווט פנימי =====
// אין URL routing במערכת (nav() ב-app.js:157 רק מחליף .active על פאנלים),
// ולכן 12 ה"מסכים" של הפרומט הם טאבים בתוך פאנל אחד.

// שש לשוניות במקום 13. הצוות, התוצרים והאישורים הם מה שבעל המשרד צריך
// כל יום; כל השאר (הרצות, תור, למידה, עלויות, יומן) חי תחת "מתקדם"
// (ai-staff.js) — לא נמחק, רק יצא מהדרך.
const AI_TABS = [
  { id: 'team',           label: 'הצוות',            icon: '◈' },
  { id: 'work',           label: 'תוצרים',           icon: '▤' },
  { id: 'approvals',      label: 'אישורים',          icon: '✋' },
  { id: 'inbox',          label: 'לידים',            icon: '◨' },
  { id: 'setup',          label: 'הגדרות וחיבורים',  icon: '⚙' },
  { id: 'advanced',       label: 'מתקדם',            icon: '⋯' },
];

function renderAiCenter() {
  const host = document.getElementById('ai-center-body');
  if (!host) return;
  const tabsHtml = AI_TABS.map(t =>
    `<button class="ai-tab${t.id === aiTab ? ' active' : ''}" onclick="aiNav('${t.id}')">` +
    `<span aria-hidden="true">${t.icon}</span> ${t.label}` +
    `<span class="ai-tab-count" id="ai-count-${t.id}"></span></button>`).join('');
  document.getElementById('ai-tabs').innerHTML = tabsHtml;
  host.innerHTML = '<div class="empty">טוען...</div>';

  // הפונקציות של הצוות מוגדרות ב-ai-staff.js, שנטען אחרי קובץ זה; הן
  // נפתרות בזמן הקריאה ולא בזמן הטעינה, ולכן הסדר לא משנה.
  const fn = {
    team: (h) => aiRenderTeam(h), work: (h) => aiRenderWork(h),
    approvals: aiRenderApprovals, inbox: aiRenderInbox,
    setup: (h) => aiRenderSetup(h), advanced: (h) => aiRenderAdvanced(h),
  }[aiTab] || ((h) => aiRenderTeam(h));

  Promise.resolve()
    .then(() => fn(host))
    // שגיאות Supabase נזרקות כאובייקט רגיל ולא כ-Error, ולכן e.message עלול
    // להיות undefined — הנפילה ל-String(e) מונעת מסך ריק במקום הסבר.
    .catch(e => { host.innerHTML = aiError((e && e.message) || String(e), e); });

  aiRefreshBadges();
  aiSubscribeRealtime();
}

function aiNav(tab) {
  aiTab = tab;
  renderAiCenter();
}

function aiError(msg, err) {
  // התקלה הראשונה הצפויה ביותר היא שה-migrations טרם הורצו. Postgres מחזיר
  // על כך 42P01 ("relation does not exist") — הודעה באנגלית שלא אומרת דבר
  // למי שרק פתח את המסך. עדיף להסביר בדיוק מה חסר ואיך לתקן, מאשר להציג
  // שגיאה גולמית שנראית כמו תקלה במערכת.
  const code = err && (err.code || (err.cause && err.cause.code));
  const missingTable = code === '42P01' || /relation .* does not exist|could not find the table/i.test(msg || '');
  if (missingTable) {
    return `<div class="alert alert-warning">
      <strong>מרכז ה-AI טרם הותקן.</strong>
      <div style="margin-top:6px">טבלאות המערכת לא נמצאו במסד הנתונים. יש להריץ את המיגרציות:</div>
      <pre class="ai-payload" style="margin-top:8px">supabase db push</pre>
      <div class="ai-muted">ההוראות המלאות: <code>docs/AI_CENTER_DEPLOYMENT.md</code></div>
      <div style="margin-top:8px"><button class="btn btn-sm" onclick="renderAiCenter()">↻ בדוק שוב</button></div>
    </div>`;
  }
  // 42501 = חוסר הרשאה. כמעט תמיד: פעולה שמוגבלת לבעל המשרד.
  if (code === '42501' || /permission denied|row-level security/i.test(msg || '')) {
    return `<div class="alert alert-warning">
      <strong>אין לך הרשאה לפעולה זו.</strong>
      <div class="ai-muted" style="margin-top:6px">הגדרות, סוכנים, אוטומציות וחיבורים זמינים לבעל המשרד בלבד.</div>
    </div>`;
  }
  return `<div class="alert alert-danger"><strong>שגיאה:</strong> ${escapeHtml(msg)}
    <div style="margin-top:8px"><button class="btn btn-sm" onclick="renderAiCenter()">↻ נסה שוב</button></div></div>`;
}

function aiEmpty(title, sub, cta) {
  return `<div class="empty-main"><div class="empty-main-icon">◈</div>
    <div class="empty-main-title">${escapeHtml(title)}</div>
    <div class="empty-main-sub">${escapeHtml(sub || '')}</div>${cta || ''}</div>`;
}

// ===== רכיבים =====

function RiskBadge(risk) {
  const r = risk || 'none';
  const known = AI_RISK_HE[r] ? r : 'none';
  return `<span class="ai-risk ai-risk-${known}" title="רמת סיכון">${AI_RISK_ICON[known]} ${AI_RISK_HE[r] || escapeHtml(r)}</span>`;
}

function AgentStatusBadge(status) {
  const map = { active: ['✓', 'פעיל', 'active'], paused: ['⏸', 'מושהה', 'pending'], disabled: ['⊘', 'מושבת', 'closed'] };
  const [icon, label, cls] = map[status] || ['?', escapeHtml(status), 'pending'];
  return `<span class="badge badge-${cls}">${icon} ${label}</span>`;
}

/** סטטוס תמיד עם טקסט ואייקון ולא בצבע בלבד (סעיף 19.1 — נגישות). */
function StatusChip(status) {
  const cls = ['completed', 'applied', 'approved'].includes(status) ? 'active'
    : ['failed', 'dead_letter', 'rejected'].includes(status) ? 'urgent'
    : ['waiting_approval', 'pending', 'queued', 'running'].includes(status) ? 'pending' : 'closed';
  return `<span class="badge badge-${cls}">${AI_STATUS_ICON[status] || '•'} ${AI_STATUS_HE[status] || escapeHtml(status)}</span>`;
}

function SourceCitation(refs) {
  if (!refs || !refs.length) return '';
  const items = refs.map(r => {
    if (!r) return '';
    const doc = r.documentId ? (db.docs || []).find(d => d.id === r.documentId) : null;
    const name = doc ? doc.name : (r.document_id || r.documentId || 'מקור');
    const quote = r.quote || r.source_quote;
    return `<div class="ai-citation">
      <span class="ai-citation-doc">📄 ${escapeHtml(name)}${r.page ? ' · עמ׳ ' + escapeHtml(r.page) : ''}</span>
      ${quote ? `<div class="ai-citation-quote">"${escapeHtml(String(quote).slice(0, 300))}"</div>` : ''}
      ${doc ? `<button class="btn btn-sm" onclick="previewDoc(${aiJsAttr(doc.id)})">פתח מסמך</button>` : ''}
    </div>`;
  }).filter(Boolean).join('');
  return items ? `<div class="ai-citations"><div class="ai-citations-title">מקורות</div>${items}</div>` : '';
}

function aiFmtCost(n) {
  const v = Number(n) || 0;
  return v < 0.01 ? '<$0.01' : '$' + v.toFixed(2);
}

function aiFmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('he-IL') + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

function aiRelTime(iso) {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'עכשיו';
  if (mins < 60) return `לפני ${mins} דק׳`;
  if (mins < 1440) return `לפני ${Math.round(mins / 60)} שע׳`;
  return `לפני ${Math.round(mins / 1440)} ימים`;
}

function aiCaseName(id) {
  const c = (db.cases || []).find(x => x.id === id);
  return c ? c.name : null;
}
function aiClientName(id) {
  const c = (db.clients || []).find(x => x.id === id);
  return c ? c.name : null;
}

// ============================================================
// סקירה
// ============================================================

async function aiRenderOverview(host) {
  const sb = aiSb();
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const [runs, approvals, jobs, agents, spend] = await Promise.all([
    sb.from('ai_runs').select('id,status,created_at,estimated_cost,goal,agent_id')
      .order('created_at', { ascending: false }).limit(100),
    sb.from('ai_approvals').select('id,status,risk_level,action_label,requested_at,matter_id')
      .eq('status', 'pending').order('requested_at', { ascending: false }).limit(50),
    sb.from('ai_jobs').select('id,status').in('status', ['queued', 'running', 'dead_letter']),
    aiGetAgents(),
    sb.rpc('ai_spend_window', { p_office_id: await aiOfficeId() }),
  ]);

  const R = runs.data || [];
  const todayRuns = R.filter(r => Date.parse(r.created_at) >= today.getTime());
  const spendRow = Array.isArray(spend.data) ? spend.data[0] : spend.data;
  const activeAgents = (agents || []).filter(a => a.status === 'active').length;

  // מדדי ה-CRM עצמו — נקראים מה-blob המקומי, בלי סיבוב לשרת.
  const cases = db.cases || [], tasks = db.tasks || [], events = db.events || [];
  const todayISO = aiTodayISO();
  const overdueTasks = tasks.filter(t => !t.done && t.due && t.due < todayISO);
  const upcoming = events.filter(e => e.date >= todayISO && e.date <= aiAddDays(todayISO, 7));
  const newLeads = (db.leads || []).filter(l => !l.status || l.status === 'new');
  const unanalyzed = (db.docs || []).filter(d => d.filePath && !d.aiAnalyzedAt);
  // null = לא ניתן לקבוע (אין יומן ואין תאריך פתיחה) → **לא** נחשב תקוע.
  // הסף >= 14 זהה ל-analyzeCaseload ב-app.js, כדי ששני המסכים לא יציגו
  // שני מספרים שונים לאותו תיק.
  const stuck = cases.filter(c => {
    if (c.status === 'closed') return false;
    const idle = aiIdleDays(c);
    return idle !== null && idle >= 14;
  });

  const stat = (label, value, sub, cls) =>
    `<div class="stat"><div class="stat-label">${label}</div>
     <div class="stat-value${cls ? ' ' + cls : ''}">${value}</div>
     ${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;

  host.innerHTML = `
    ${aiCommandBarHtml()}

    <div class="stats-grid stats-grid-6" style="margin-top:16px">
      ${stat('ממתין לאישורי', (approvals.data || []).length, 'פעולות שדורשות אותך', (approvals.data || []).length ? 'ai-attention' : '')}
      ${stat('משימות פעילות', (jobs.data || []).filter(j => j.status !== 'dead_letter').length, 'בתור או רצות')}
      ${stat('הושלמו היום', todayRuns.filter(r => r.status === 'completed').length, `מתוך ${todayRuns.length} הרצות`)}
      ${stat('נכשלו', R.filter(r => r.status === 'failed').length + (jobs.data || []).filter(j => j.status === 'dead_letter').length, '30 ימים אחרונים')}
      ${stat('עלות היום', aiFmtCost(spendRow && spendRow.today_cost), 'מודלים בתשלום')}
      ${stat('עלות החודש', aiFmtCost(spendRow && spendRow.month_cost), `${activeAgents} סוכנים פעילים`)}
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">☀ סיכום הבוקר שלי</div>
      <div id="ai-morning">${aiMorningHtml(overdueTasks, upcoming, newLeads, stuck)}</div>
      <button class="btn btn-primary" style="margin-top:12px"
        onclick="aiRunAgent('office-manager','הכן את סיכום הבוקר של המשרד להיום',{})">
        ◈ הפעל את סוכן מנהל המשרד
      </button>
    </div>

    <div class="two-col" style="margin-top:16px">
      <div class="card">
        <div class="card-title">מה דורש טיפול</div>
        ${aiAttentionRow('מועדים ב-7 הימים הקרובים', upcoming.length, "nav('calendar',document.querySelectorAll('.nav-item')[4])")}
        ${aiAttentionRow('משימות באיחור', overdueTasks.length, "nav('tasks',document.querySelectorAll('.nav-item')[3])")}
        ${aiAttentionRow('לידים שלא טופלו', newLeads.length, "aiNav('inbox')")}
        ${aiAttentionRow('תיקים ללא פעילות 14 יום', stuck.length, "aiRunAgent('office-manager','אתר את התיקים ללא פעילות והצע פעולת המשך לכל אחד',{})")}
        ${aiAttentionRow('מסמכים שטרם נותחו', unanalyzed.length, "aiNav('inbox')")}
      </div>
      <div class="card">
        <div class="card-title">הרצות אחרונות</div>
        ${R.slice(0, 8).map(r => `
          <div class="ai-run-row" onclick="aiOpenRun('${r.id}')">
            <div class="ai-run-goal">${escapeHtml((r.goal || '—').slice(0, 70))}</div>
            <div class="ai-run-meta">${StatusChip(r.status)} · ${aiRelTime(r.created_at)} · ${aiFmtCost(r.estimated_cost)}</div>
          </div>`).join('') || '<div class="empty">אין הרצות עדיין</div>'}
      </div>
    </div>`;
}

function aiAttentionRow(label, count, onclick) {
  const cls = count > 0 ? 'ai-attention' : '';
  return `<div class="fin-row" style="cursor:pointer" onclick="${onclick}">
    <span>${label}</span><span class="${cls}"><strong>${count}</strong> ›</span></div>`;
}

function aiMorningHtml(overdue, upcoming, leads, stuck) {
  const top = [];
  if (overdue.length) top.push(`${overdue.length} משימות באיחור — הדחופה ביותר: "${escapeHtml(overdue[0].text)}"`);
  if (upcoming.length) top.push(`מועד קרוב: ${escapeHtml(upcoming[0].title)} ב-${aiDisplayDate(upcoming[0].date)}`);
  if (leads.length) top.push(`${leads.length} לידים ממתינים לטיפול`);
  if (stuck.length) top.push(`${stuck.length} תיקים ללא פעילות מעל שבועיים`);
  if (!top.length) return '<div class="empty">אין פריטים דחופים. יום נקי.</div>';
  return '<ol class="ai-morning-list">' + top.slice(0, 4).map(t => `<li>${t}</li>`).join('') + '</ol>';
}

// ============================================================
// תיבת פקודה (AiCommandBar)
// ============================================================

function aiCommandBarHtml(compact) {
  return `<div class="ai-cmdbar${compact ? ' compact' : ''}">
    <div class="ai-cmdbar-row">
      <input class="form-input ai-cmdbar-input" id="ai-cmd-input"
        placeholder="מה לעשות? למשל: סכם לי את תיק כהן · מצא תיקים ללא פעילות 14 ימים · הכן דוח לידים מהחודש"
        onkeydown="aiCmdKey(event)" oninput="aiCmdPreview()">
      <button class="btn btn-primary" id="ai-cmd-btn" onclick="aiCmdSubmit()">הפעל</button>
    </div>
    <div class="ai-cmd-hint" id="ai-cmd-hint"></div>
    <div class="ai-cmd-examples">
      ${['סכם לי את התיק', 'מצא את כל התיקים שאין בהם פעילות 14 ימים', 'הצג לי את כל המועדים לשבוע הבא',
         'מצא לקוחות שלא שילמו', 'הכן דוח לידים מהחודש']
        .map(x => `<button class="ai-chip" onclick="aiCmdFill(${aiJsAttr(x)})">${escapeHtml(x)}</button>`).join('')}
    </div>
  </div>`;
}

function aiCmdFill(text) {
  const el = document.getElementById('ai-cmd-input');
  if (el) { el.value = text; el.focus(); aiCmdPreview(); }
}

function aiCmdKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiCmdSubmit(); }
}

let aiPreviewTimer = null;
/**
 * "להציג למשתמש מה הסוכן מתכוון לבצע" לפני ההפעלה (סעיף 4.2).
 * ה-debounce קיים כי כל הקשה הייתה אחרת קריאת רשת.
 */
function aiCmdPreview() {
  clearTimeout(aiPreviewTimer);
  const hint = document.getElementById('ai-cmd-hint');
  const goal = (document.getElementById('ai-cmd-input') || {}).value || '';
  if (!hint) return;
  if (goal.trim().length < 4) { hint.innerHTML = ''; return; }
  aiPreviewTimer = setTimeout(async () => {
    try {
      const r = await aiInvoke('ai-gateway', { action: 'route', goal });
      if (!r || !r.agent) { hint.innerHTML = ''; return; }
      hint.innerHTML = `<span class="ai-hint-icon">◈</span> יופעל: <strong>${escapeHtml(r.agent.name)}</strong>` +
        ` — ${escapeHtml(r.agent.description || '')}` +
        (r.allowed ? '' : ' <span class="ai-attention">(אין לך הרשאה לסוכן זה)</span>');
    } catch (e) { hint.innerHTML = ''; }
  }, 450);
}

async function aiCmdSubmit() {
  const input = document.getElementById('ai-cmd-input');
  if (!input || !input.value.trim()) return;
  const goal = input.value.trim();
  const btn = document.getElementById('ai-cmd-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'שולח...'; }
  try {
    // מצרפים את התיק הפתוח כהקשר, אם יש כזה — כך "סכם לי את התיק" עובד
    // בלי לחזור על שם התיק.
    const ctx = {};
    if (typeof currentCaseId !== 'undefined' && currentCaseId) ctx.matter_id = currentCaseId;
    if (typeof currentClientId !== 'undefined' && currentClientId) ctx.client_id = currentClientId;
    await aiRunAgent(null, goal, ctx);
    input.value = '';
    const hint = document.getElementById('ai-cmd-hint');
    if (hint) hint.innerHTML = '';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'הפעל'; }
  }
}

// ============================================================
// הפעלת סוכן
// ============================================================

/**
 * הפעלת סוכן דרך ה-Gateway.
 * הדפדפן לעולם לא פונה ל-API של מודל AI ישירות (סעיף 3.2).
 */
async function aiRunAgent(agentSlug, goal, opts) {
  if (aiBusy) { notify('פעולה קודמת עדיין רצה'); return null; }
  aiBusy = true;
  try {
    const body = { action: 'run', goal: goal, trigger_type: 'manual' };
    if (agentSlug) body.agent_slug = agentSlug;
    if (opts && opts.matter_id) body.matter_id = opts.matter_id;
    if (opts && opts.client_id) body.client_id = opts.client_id;
    if (opts && opts.lead_id) body.lead_id = opts.lead_id;
    if (opts && opts.job_type) body.job_type = opts.job_type;
    if (opts && opts.payload) body.payload = opts.payload;

    const res = await aiInvoke('ai-gateway', body);

    if (!res || !res.run_id) throw new Error('לא התקבלה תשובה תקינה מהשרת');
    if (res.deduplicated) notify('בקשה זהה כבר קיימת — מוצגת התוצאה הקיימת');
    else notify('המשימה נשלחה לסוכן');
    if (res.budget_warning) notify('⚠ ' + res.budget_warning);

    aiOpenRun(res.run_id);
    aiScheduleDrain();
    return res;
  } catch (e) {
    notify('שגיאה: ' + e.message);
    return null;
  } finally {
    aiBusy = false;
  }
}

/**
 * ניקוז התור מהדפדפן.
 *
 * זהו **גיבוי, לא הפתרון**. pg_cron אינו מופעל בפרויקט (מתועד ב-
 * check-and-send-reminders/index.ts:14), ובלי מתזמן שרת המשימות היו נשארות
 * בתור. הניקוז מכאן גורם למערכת לעבוד היום — אבל רק כשהאפליקציה פתוחה,
 * ולכן מסך ההגדרות מציג "תזמון: לא פעיל" עד שמוגדר cron אמיתי.
 *
 * ה-worker דורש service_role ולכן לא נקרא מכאן ישירות; ה-Gateway מפעיל
 * אותו fire-and-forget בכל בקשה. כאן רק בודקים אם נשארו משימות תקועות
 * ומבקשים מה-Gateway סטטוס, מה שגם מרענן את המסך.
 */
function aiScheduleDrain() {
  clearTimeout(aiDrainTimer);
  let ticks = 0;
  const tick = async () => {
    ticks++;
    try {
      if (aiCurrentRunId) await aiRefreshRunModal();
      if (aiTab === 'overview' || aiTab === 'runs' || aiTab === 'approvals') aiRefreshBadges();
    } catch (e) { /* לא מפילים את הלולאה על תקלת רשת רגעית */ }
    // עד ~2 דקות של מעקב, ואז עוצרים. Realtime ממשיך לעדכן גם אחרי.
    if (ticks < 24 && aiCurrentRunId) aiDrainTimer = setTimeout(tick, 5000);
  };
  aiDrainTimer = setTimeout(tick, 2500);
}

// ============================================================
// אישורים — הלב של המערכת
// ============================================================

async function aiRenderApprovals(host) {
  const { data, error } = await aiSb().from('ai_approvals')
    .select('*').in('status', ['pending', 'approved', 'applied', 'rejected', 'failed', 'returned', 'expired'])
    .order('requested_at', { ascending: false }).limit(60);
  if (error) throw error;

  const pending = (data || []).filter(a => a.status === 'pending');
  const other = (data || []).filter(a => a.status !== 'pending');

  if (!data || !data.length) {
    host.innerHTML = aiEmpty('אין פעולות הממתינות לאישור',
      'כשסוכן יציע פעולה שדורשת אישור, היא תופיע כאן לפני שתתבצע.');
    return;
  }

  host.innerHTML = `
    <div class="alert alert-info">
      פעולות שסוכן הציע. <strong>אף אחת מהן טרם בוצעה.</strong>
      אישור מחיל את הפעולה על המערכת; דחייה מוחקת אותה.
    </div>
    ${pending.length ? `<div class="ai-section-title">ממתינות לאישור (${pending.length})</div>` : ''}
    ${pending.map(ApprovalCard).join('')}
    ${other.length ? `<div class="ai-section-title" style="margin-top:24px">טופלו לאחרונה</div>
      ${other.map(a => `<div class="ai-approval-mini">
        ${StatusChip(a.status)} <strong>${escapeHtml(a.action_label || a.action_type)}</strong>
        <span class="ai-muted">${aiRelTime(a.requested_at)}</span>
        ${a.apply_error ? `<div class="ai-muted">שגיאה: ${escapeHtml(a.apply_error)}</div>` : ''}
      </div>`).join('')}` : ''}`;
}

// Who an outbound message actually goes to. The card used to show only the message
// text, while the recipient (`payload.to`, chosen freely by the model) stayed hidden —
// so an injected instruction could route a client's data to any address and the
// approver would only see the client's name. Now recipient, channel and subject are
// always shown, with a warning when the address isn't one on file for the client.
function ApprovalRecipient(a, payload) {
  const to = payload.to || payload.phone || payload.email || '';
  if (!to && !payload.channel && !payload.subject) return '';
  const cl = a.client_id ? (db.clients || []).find(c => c.id === a.client_id) : null;
  const norm = (v) => String(v || '').toLowerCase().replace(/[\s\-()+]/g, '');
  const known = cl ? [cl.email, cl.phone].filter(Boolean).map(norm) : [];
  const mismatch = to && known.length && !known.includes(norm(to));
  const channelLabel = { email: 'דוא"ל', whatsapp: 'וואטסאפ', sms: 'SMS' }[payload.channel] || payload.channel || '';
  return `<div class="ai-payload" style="margin-top:10px">
      ${to ? `<div><strong>נמען:</strong> ${escapeHtml(to)}</div>` : ''}
      ${channelLabel ? `<div><strong>ערוץ:</strong> ${escapeHtml(channelLabel)}</div>` : ''}
      ${payload.subject ? `<div><strong>נושא:</strong> ${escapeHtml(payload.subject)}</div>` : ''}
    </div>
    ${mismatch ? `<div class="alert alert-danger" style="margin:8px 0">⚠ הנמען אינו כתובת/טלפון השמורים של הלקוח${cl && cl.name ? ' ' + escapeHtml(cl.name) : ''}. בדוק/י היטב לפני אישור.</div>` : ''}`;
}

function ApprovalCard(a) {
  const matter = aiCaseName(a.matter_id);
  const client = aiClientName(a.client_id);
  // `_content` הוא מפתח פנימי שנשמר רק עבור לולאת הלמידה (ראה aiApproveApproval).
  // הוא לא נתון של הפעולה, ואין סיבה שעורך הדין יראה אותו בתצוגת ה-payload.
  const raw = a.edited_payload || a.proposed_payload || {};
  const payload = {};
  for (const k of Object.keys(raw)) if (k !== '_content') payload[k] = raw[k];
  const isCritical = a.risk_level === 'critical';
  const content = raw._content || a.proposed_content || payload.body || payload.text || '';

  return `<div class="card ai-approval${isCritical ? ' ai-approval-critical' : ''}" id="approval-${a.id}">
    <div class="ai-approval-head">
      <div>
        <div class="ai-approval-title">${escapeHtml(a.action_label || a.action_type)}</div>
        <div class="ai-approval-sub">
          ${RiskBadge(a.risk_level)}
          ${matter ? ` · תיק: ${escapeHtml(matter)}` : ''}
          ${client ? ` · לקוח: ${escapeHtml(client)}` : ''}
          · ${aiRelTime(a.requested_at)}
        </div>
      </div>
    </div>

    ${a.reason_required ? `<div class="alert alert-warning" style="margin:10px 0">
      <strong>למה נדרש אישור:</strong> ${escapeHtml(a.reason_required)}</div>` : ''}

    ${ApprovalRecipient(a, payload)}

    ${content ? `<div class="form-group" style="margin-top:10px">
      <label class="form-label">התוכן המוצע — ניתן לערוך לפני האישור</label>
      <textarea class="form-input ai-approval-text" id="ai-app-content-${a.id}"
        rows="${Math.min(16, Math.max(4, String(content).split('\n').length + 1))}">${escapeHtml(content)}</textarea>
    </div>` : `<div class="ai-payload">${escapeHtml(JSON.stringify(payload, null, 2))}</div>`}

    ${SourceCitation(a.source_refs)}

    <div class="ai-approval-actions">
      <button class="btn btn-success" onclick="aiApproveAndApply('${a.id}')">✓ אשר ובצע</button>
      <button class="btn" onclick="aiReturnToAgent('${a.id}')">↩ החזר לסוכן עם הנחיה</button>
      <button class="btn btn-danger" onclick="aiRejectApproval('${a.id}')">✗ דחה</button>
      ${a.run_id ? `<button class="btn btn-sm" onclick="aiOpenRun('${a.run_id}')">הצג את ההרצה</button>` : ''}
    </div>
  </div>`;
}

async function aiApproveAndApply(id) {
  const card = document.getElementById('approval-' + id);
  const btns = card ? card.querySelectorAll('button') : [];
  btns.forEach(b => b.disabled = true);
  try {
    const { data: a, error } = await aiSb().from('ai_approvals').select('*').eq('id', id).single();
    if (error) throw error;
    if (a.status === 'applied') { notify('הפעולה כבר בוצעה'); return; }

    // התוכן הערוך גובר על המקורי — "עריכה ואישור" (סעיף 4.5).
    const editEl = document.getElementById('ai-app-content-' + id);
    const editedContent = editEl ? editEl.value : null;
    const payload = Object.assign({}, a.proposed_payload || {});
    const contentChanged = editedContent !== null && editedContent !== a.proposed_content;
    if (contentChanged) {
      if (payload.body !== undefined) payload.body = editedContent;
      else if (payload.text !== undefined) payload.text = editedContent;
    }

    // מה שנשמר ל-DB אינו זהה למה שמוחל.
    //
    // כשהעריכה היא של ה-**תוכן** (טיוטה, מכתב) ול-payload אין שדה body או
    // text, השינוי לא נרשם בשום מקום ב-edited_payload — כלומר לולאת הלמידה
    // לא רואה אותו. זה בדיוק הסיגנל היקר ביותר: תיקוני ניסוח של עורך הדין
    // בטיוטות משפטיות.
    //
    // המפתח מוגדר בנפרד ולא נדחף ל-payload שעובר ל-aiApplyApproval, כי
    // חלק מהמחילים מעתיקים את ה-payload כמו שהוא לרשומת CRM — שדה זר היה
    // דולף לתוך ליד או משימה.
    const editedForDb = contentChanged && payload.body === undefined && payload.text === undefined
      ? Object.assign({}, payload, { _content: editedContent })
      : payload;

    if (a.risk_level === 'critical') {
      const okc = await customConfirm(
        `זו פעולה ברמת סיכון קריטית: ${a.action_label || a.action_type}.\n\n` +
        `אישורך מבצע אותה בפועל. לאשר?`,
        { title: 'אישור פעולה רגישה', okText: 'כן, אשר ובצע', danger: true });
      if (!okc) { btns.forEach(b => b.disabled = false); return; }
    }

    // 1) שמירת האישור בשרת — **לפני** כל פעולה חיצונית (סעיף 4.5).
    //
    // התנאי `.eq('status','pending')` הוא claim אטומי: הוא גם מוודא שאיש
    // לא אישר את אותה הצעה במקביל, וגם הופך לחיצה כפולה לחסרת השפעה —
    // הניסיון השני מעדכן אפס שורות ונעצר כאן, במקום להחיל את הפעולה
    // פעמיים וליצור משימה/תיק/מסמך כפולים.
    await aiUpdateChecked('ai_approvals', {
      status: 'approved', approved_at: new Date().toISOString(),
      edited_payload: editedContent !== null ? editedForDb : (a.edited_payload || null),
    }, q => q.eq('id', id).eq('status', 'pending'), AI_APPROVER_ONLY);

    // 2) החלה.
    const result = await aiApplyApproval(Object.assign({}, a, {
      proposed_content: editedContent !== null ? editedContent : a.proposed_content,
      edited_payload: payload,
    }));

    if (result.external) {
      // פעולה חיצונית (שליחה) — מבוצעת בשרת, שקורא שוב את סטטוס האישור.
      notify(result.message || 'נשלח');
    } else {
      // ההחלה כבר קרתה; אם סימון ה-applied נכשל, מוטב ליידע מפורשות מאשר
      // להשאיר שורה שנראית כאילו לא בוצעה ותוחל שוב בלחיצה הבאה.
      try {
        await aiUpdateChecked('ai_approvals',
          { status: 'applied', applied_at: new Date().toISOString() },
          q => q.eq('id', id));
      } catch (markErr) {
        notify('הפעולה בוצעה, אך סימון האישור נכשל: ' + markErr.message);
      }
      notify(result.message || 'הפעולה בוצעה');
    }
    renderAiCenter();
  } catch (e) {
    notify('שגיאה: ' + e.message);
    try {
      // Only an approval that wasn't applied may be marked failed. Unconditionally
      // writing 'failed' hid actions that had in fact run (e.g. the error came from
      // the follow-up bookkeeping), inviting a second, duplicate application.
      await aiSb().from('ai_approvals').update({ status: 'failed', apply_error: e.message })
        .eq('id', id).in('status', ['pending', 'approved']).is('applied_at', null);
    } catch (e2) { /* ההודעה למשתמש כבר יצאה */ }
    btns.forEach(b => b.disabled = false);
  }
}

/**
 * החלת אישור על ה-CRM.
 *
 * זו הפונקציה שכותבת בפועל. היא רצה **רק** אחרי ששורת האישור עודכנה
 * ל-approved בשרת, והיא משתמשת ב-saveDB() — אותו נתיב שמירה של כל פעולת
 * משתמש — ולכן אין כאן מרוץ כתיבה מול המשתמש עצמו.
 *
 * שמות השדות נלקחו מהכותבים האמיתיים ב-app.js (saveTask:2499, saveEvent:2615,
 * saveClient:2281, saveCase:440, saveDoc:3117). שתי מלכודות:
 *   • ב-case מזהה הלקוח הוא `client`, לא `clientId`
 *   • תאריכים מעורבים: due/date של משימות ואירועים הם YYYY-MM-DD, אבל
 *     cases.opened ו-docs.date הם "5.7.2026" בפורמט he-IL
 */
async function aiApplyApproval(a) {
  const p = a.edited_payload || a.proposed_payload || {};
  const type = a.action_type;

  switch (type) {
    case 'create_task': {
      db.tasks.unshift({
        id: uid(), text: String(p.text || ''), due: p.due || '',
        caseId: p.caseId || '', priority: p.priority || 'normal',
        notes: p.notes || '', done: false,
      });
      saveDB();
      if (typeof renderTasks === 'function' && currentPanel === 'tasks') renderTasks();
      return { message: 'המשימה נוצרה' };
    }

    case 'create_event':
    case 'create_deadline': {
      if (!db.events) db.events = [];
      db.events.push({
        id: uid(), title: String(p.title || ''), date: String(p.date || ''),
        time: p.time || '', location: p.location || '',
        type: p.type || (type === 'create_deadline' ? 'מועד אחרון' : 'אחר'),
        caseId: p.caseId || '', notes: p.notes || '',
        // מועד שחולץ אוטומטית עובר מ-suggested ל-confirmed רק כאן, ברגע
        // האישור האנושי (סעיף 5.9). הסימון נשמר כתיעוד של המקור.
        aiSuggested: type === 'create_deadline' ? true : undefined,
        aiConfirmedAt: new Date().toISOString(),
      });
      saveDB();
      if (typeof renderCalendar === 'function' && currentPanel === 'calendar') renderCalendar();
      return { message: type === 'create_deadline' ? 'המועד אושר ונקבע' : 'האירוע נוצר' };
    }

    case 'add_diary_entry': {
      const c = db.cases.find(x => x.id === p.caseId);
      if (!c) throw new Error('התיק לא נמצא');
      if (!c.diary) c.diary = [];
      // אותו פורמט בדיוק כמו app.js:1037 — locale string עם שעה.
      c.diary.push({ text: String(p.text || ''), date: new Date().toLocaleString('he-IL') });
      saveDB();
      if (currentPanel === 'case-detail' && typeof reopenCaseDetailKeepingTab === 'function') {
        reopenCaseDetailKeepingTab(c.id);
      }
      return { message: 'הרישום נוסף ליומן התיק' };
    }

    case 'create_client': {
      const palette = [
        ['rgba(37,99,235,0.15)', 'var(--accent2)'],
        ['rgba(22,163,74,0.15)', 'var(--success)'],
        ['rgba(217,119,6,0.15)', 'var(--warning)'],
        ['rgba(220,38,38,0.15)', 'var(--danger)'],
      ];
      const [color, textColor] = palette[db.clients.length % 4];
      const name = String(p.name || '');
      db.clients.push({
        id: uid(), clientNumber: getNextClientNumber(), name,
        type: p.type || 'יחיד', phone: p.phone || '', email: p.email || '',
        address: p.address || '', idNum: p.idNum || '', contact: '', contactPhone: '',
        notes: p.notes || '', color, textColor,
        initials: name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase(),
      });
      saveDB();
      if (typeof renderClients === 'function' && currentPanel === 'clients') renderClients();
      return { message: 'הלקוח נוצר' };
    }

    case 'create_matter': {
      const clientId = p.client || p.clientId || '';
      if (!db.clients.find(c => c.id === clientId)) throw new Error('הלקוח לא נמצא');
      // caseType/stage come from the model's proposal — only known values are stored
      // (same rule as the in-app agent's createCase), never free text.
      const caseType = CASE_STAGES[p.caseType] ? p.caseType : 'debt';
      const stages = CASE_STAGES[caseType];
      db.cases.unshift({
        id: uid(), name: String(p.name || ''), caseType,
        client: clientId, amount: Number(p.amount) || 0,
        stage: stages.includes(p.stage) ? p.stage : stages[0],
        status: 'active', number: p.number || '', notes: p.notes || '',
        court: p.court || '', courtNumber: '',
        debtorName: p.debtorName || '', debtorId: '', debtorAddress: '',
        debtorPhone: '', debtorEmail: '', debtorType: 'יחיד', debtDesc: '',
        feeType: 'percent', feePct: 15, feeFixed: 0, feeVat: 'yes',
        expensesType: 'client', retainer: 0, feeNotes: '',
        // he-IL, בדיוק כמו saveCase (app.js:465) — לא ISO.
        opened: new Date().toLocaleDateString('he-IL'),
        diary: [{ text: 'התיק נפתח בעקבות הצעת סוכן AI', date: new Date().toLocaleString('he-IL') }],
        legalDocs: {}, collected: 0,
        caseSubNumber: getNextCaseSubNumber(clientId),
        closedAt: null, trustCloseNote: '',
      });
      saveDB();
      if (typeof renderCases === 'function' && currentPanel === 'cases') renderCases();
      return { message: 'התיק נפתח' };
    }

    case 'tag_document': {
      const d = db.docs.find(x => x.id === p.docId);
      if (!d) throw new Error('המסמך לא נמצא');
      if (p.cat) d.cat = p.cat;
      if (p.caseId) d.caseId = p.caseId;
      if (p.aiSummary) d.aiSummary = p.aiSummary;
      d.aiAnalyzedAt = new Date().toISOString();
      saveDB();
      if (typeof renderDocs === 'function' && currentPanel === 'docs') renderDocs();
      return { message: 'המסמך תויג' };
    }

    case 'create_lead': {
      if (!db.leads) db.leads = [];
      // ⚠ סדר ה-Object.assign הפוך בכוונה: `p` מגיע מהסוכן, ולכן הוא
      // מתפרש **ראשון** והשדות שאנחנו מייצרים דורסים אותו. בסדר ההפוך,
      // הצעה עם `{"id": "..."}` הייתה קובעת את המזהה — והמזהה מוזרק
      // ל-onclick בכרטיס הליד. מסמך של הצד שכנגד שמכיל prompt injection
      // (תרחיש שה-prompts עצמם מזהירים מפניו) יכול היה כך להריץ קוד אצל
      // כל מי שיפתח את התיבה.
      db.leads.unshift(Object.assign({}, p, {
        id: uid(),
        status: 'new',
        createdAt: new Date().toISOString(),
      }));
      saveDB();
      return { message: 'הליד נוצר' };
    }

    case 'update_lead_score': {
      const l = (db.leads || []).find(x => x.id === p.leadId);
      if (!l) throw new Error('הליד לא נמצא');
      l.score = Number(p.score) || 0;
      l.scoreReason = p.scoreReason || '';
      l.urgency = p.urgency || 'normal';
      l.missingInfo = p.missingInfo || [];
      l.followUpQuestions = p.followUpQuestions || [];
      l.updatedAt = new Date().toISOString();
      saveDB();
      return { message: `הליד נוקד ${l.score}/100` };
    }

    case 'draft_legal_document': {
      const path = await aiSaveDraftDocx(a, p);
      return { message: 'הטיוטה נשמרה במסמכי התיק', path: path };
    }

    // פעולות חיצוניות — לא כאן. ai-comms מבצע אותן אחרי שהוא קורא את
    // סטטוס האישור מהשרת בעצמו (סעיף 4.5).
    case 'draft_message':
    case 'draft_email':
    case 'send_message':
    case 'send_email':
    case 'send_whatsapp':
    case 'send_legal_notice':
    case 'send_letter_opposing': {
      const res = await aiInvoke('ai-comms', { action: 'send_approved', approval_id: a.id });
      if (!res.ok) throw new Error(res.error || 'השליחה נכשלה');
      return { external: true, message: `ההודעה נשלחה ל-${res.recipient}` };
    }

    case 'request_approval': {
      // בקשת אישור כללית — אין מה להחיל אוטומטית; האישור עצמו הוא ההחלטה.
      return { message: 'הבקשה אושרה ותועדה' };
    }

    default:
      throw new Error(`אין מנגנון החלה לפעולה מסוג "${type}". יש לבצע אותה ידנית.`);
  }
}

/** שומר טיוטה משפטית כמסמך Word בתיק, באותו סגנון שה-CRM כבר מייצר. */
async function aiSaveDraftDocx(a, p) {
  const { Document, Paragraph, TextRun, Packer, AlignmentType } = __req('docx');
  const text = a.proposed_content || '';
  const caseObj = db.cases.find(c => c.id === p.caseId);
  const FNT = { name: 'David', cs: 'David' };

  const para = (t, opts) => new Paragraph({
    bidirectional: true,
    alignment: (opts && opts.center) ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
    spacing: { after: 180 },
    children: [new TextRun({
      text: String(t || ''), font: FNT, size: (opts && opts.size) || 24,
      bold: !!(opts && opts.bold), color: (opts && opts.color) || '000000',
    })],
  });

  const children = [
    para('— טיוטה —', { center: true, bold: true, size: 28, color: 'B45309' }),
    para(String(p.title || 'מסמך'), { center: true, bold: true, size: 32 }),
    para(new Date().toLocaleDateString('he-IL'), { center: true, size: 20, color: '555555' }),
    para(''),
  ];
  for (const line of String(text).split('\n')) children.push(para(line));

  if (p.assumptions && p.assumptions.length) {
    children.push(para(''), para('הנחות:', { bold: true }));
    p.assumptions.forEach(x => children.push(para('• ' + x)));
  }
  if (p.missingInfo && p.missingInfo.length) {
    children.push(para(''), para('מידע חסר שיש להשלים:', { bold: true, color: 'B45309' }));
    p.missingInfo.forEach(x => children.push(para('• ' + x, { color: 'B45309' })));
  }

  const doc = new Document({
    sections: [{ properties: { page: { margin: { top: 1418, right: 1418, bottom: 1418, left: 1418 } }, rtl: true }, children }],
  });
  const buf = await Packer.toBuffer(doc);

  const dateStr = new Date().toLocaleDateString('he-IL');
  const label = caseObj ? (caseObj.caseSubNumber || caseObj.name) : 'כללי';
  const filename = `טיוטה – ${String(p.docType || 'מסמך')} – ${label} – ${dateStr}.docx`
    .replace(/[\\/:*?"<>|]/g, '_');
  const filePath = await Platform.saveFile({ buffer: Array.from(buf), filename });

  if (!db.docs) db.docs = [];
  db.docs.unshift({
    id: uid(), caseId: p.caseId || '', name: filename,
    // הדליים ש-getExt מכיר הם pdf|doc|xls|img. 'doc' ולא 'docx', אחרת
    // המחלקה .doc-icon לא קיימת ומסנן סוג הקובץ בלשונית המסמכים לא תופס.
    ext: 'doc', cat: 'טיוטות AI', date: dateStr,
    notes: 'טיוטה שהוכנה ע"י סוכן AI ואושרה', filePath: filePath, origName: filename,
  });
  saveDB();
  if (typeof renderDocs === 'function' && currentPanel === 'docs') renderDocs();
  try { await Platform.openFile(filePath, filename); } catch (e) { /* ההורדה נשמרה בכל מקרה */ }
  return filePath;
}

async function aiRejectApproval(id) {
  const reason = await aiPrompt('סיבת הדחייה (אופציונלי):', '');
  if (reason === null) return;
  try {
    await aiUpdateChecked('ai_approvals', {
      status: 'rejected', rejected_at: new Date().toISOString(), rejection_reason: reason || null,
    }, q => q.eq('id', id).eq('status', 'pending'), AI_APPROVER_ONLY);
    notify('הפעולה נדחתה');
  } catch (e) {
    notify('שגיאה: ' + e.message);
  }
  renderAiCenter();
}

/** "החזרה לסוכן עם הנחיה" (סעיף 4.5) — יוצר הרצה חדשה עם התיקון. */
async function aiReturnToAgent(id) {
  const instruction = await aiPrompt('מה לתקן? ההנחיה תישלח לסוכן להרצה חוזרת:', '');
  if (!instruction) return;

  const { data: a, error: readErr } = await aiSb()
    .from('ai_approvals').select('*').eq('id', id).maybeSingle();
  if (readErr || !a) { notify('שגיאה: ההצעה לא נמצאה'); return; }

  try {
    await aiUpdateChecked('ai_approvals',
      { status: 'returned', return_instruction: instruction },
      q => q.eq('id', id).eq('status', 'pending'), AI_APPROVER_ONLY);
  } catch (e) {
    notify('שגיאה: ' + e.message);
    return;
  }

  const { data: agent } = await aiSb().from('ai_agents').select('slug').eq('id', a.agent_id).maybeSingle();
  await aiRunAgent(agent ? agent.slug : null,
    `הצעה קודמת שלך הוחזרה לתיקון.\n\nההצעה: ${a.action_label}\n` +
    `התוכן הקודם:\n${(a.proposed_content || '').slice(0, 3000)}\n\n` +
    `הנחיית התיקון: ${instruction}`,
    { matter_id: a.matter_id, client_id: a.client_id });
}

// ============================================================
// סוכנים
// ============================================================

async function aiGetAgents(force) {
  if (aiCache.agents && !force) return aiCache.agents;
  const { data, error } = await aiSb().from('ai_agents').select('*').order('category').order('name');
  if (error) throw error;
  aiCache.agents = data || [];
  return aiCache.agents;
}

async function aiRenderAgents(host) {
  const agents = await aiGetAgents(true);
  if (!agents.length) {
    host.innerHTML = aiEmpty('לא נמצאו סוכנים',
      'יש להריץ את מיגרציית הזריעה (20260804000001_ai_center_seed.sql) כדי ליצור את הסוכנים.');
    return;
  }

  // סטטיסטיקה אמיתית לכל סוכן — לא מספרים דקורטיביים.
  const { data: runs } = await aiSb().from('ai_runs')
    .select('agent_id,status,estimated_cost,duration_ms').limit(1000);
  const stats = {};
  for (const r of runs || []) {
    const s = stats[r.agent_id] || (stats[r.agent_id] = { n: 0, ok: 0, cost: 0, ms: 0 });
    s.n++;
    if (r.status === 'completed' || r.status === 'waiting_approval') s.ok++;
    s.cost += Number(r.estimated_cost) || 0;
    s.ms += Number(r.duration_ms) || 0;
  }

  const byCat = {};
  for (const a of agents) (byCat[a.category || 'אחר'] || (byCat[a.category || 'אחר'] = [])).push(a);

  host.innerHTML = Object.entries(byCat).map(([cat, list]) => `
    <div class="ai-section-title">${escapeHtml(cat)}</div>
    <div class="ai-agent-grid">${list.map(a => AgentCard(a, stats[a.id])).join('')}</div>
  `).join('');
}

function AgentCard(a, s) {
  const st = s || { n: 0, ok: 0, cost: 0, ms: 0 };
  const rate = st.n ? Math.round(st.ok / st.n * 100) : null;
  return `<div class="card ai-agent-card">
    <div class="ai-agent-head">
      <div class="ai-agent-name">◈ ${escapeHtml(a.name)}</div>
      ${AgentStatusBadge(a.status)}
    </div>
    <div class="ai-agent-desc">${escapeHtml(a.description || '')}</div>
    <div class="ai-agent-meta">
      <span title="מודל">${escapeHtml(a.default_model.replace('claude-', '').replace(/-\d{8}$/, ''))}</span>
      <span title="רמת עצמאות">רמה ${a.autonomy_level}</span>
      <span title="מדיניות אישור">${{ always: 'אישור לכל פעולה', sensitive: 'אישור לרגישות', never: 'ללא אישור' }[a.approval_policy]}</span>
      <span title="תקרת עלות להרצה">עד $${Number(a.max_cost_per_run).toFixed(2)}</span>
    </div>
    <div class="ai-agent-stats">
      <span>${st.n} הרצות</span>
      ${rate !== null ? `<span>${rate}% הצלחה</span>` : ''}
      ${st.n ? `<span>${aiFmtCost(st.cost / st.n)} ממוצע</span>` : ''}
      ${st.n && st.ms ? `<span>${Math.round(st.ms / st.n / 1000)} שנ׳ ממוצע</span>` : ''}
    </div>
    <div class="ai-agent-actions">
      <button class="btn btn-sm btn-primary" onclick="aiAgentRunPrompt(${aiJsAttr(a.slug)},${aiJsAttr(a.name)})">הפעל</button>
      <button class="btn btn-sm" onclick="aiOpenAgentDetail('${a.id}')">פרטים וכלים</button>
      <button class="btn btn-sm ${a.status === 'active' ? 'btn-warning' : 'btn-success'}"
        onclick="aiToggleAgent(${aiJsAttr(a.id)},${aiJsAttr(a.status)})">${a.status === 'active' ? '⏸ השבת' : '▶ הפעל'}</button>
    </div>
  </div>`;
}

async function aiAgentRunPrompt(slug, name) {
  const goal = await aiPrompt(`מה לבקש מ"${name}"?`, '');
  if (!goal) return;
  const ctx = {};
  if (typeof currentCaseId !== 'undefined' && currentCaseId) ctx.matter_id = currentCaseId;
  await aiRunAgent(slug, goal, ctx);
}

async function aiToggleAgent(id, status) {
  const next = status === 'active' ? 'disabled' : 'active';
  try {
    await aiUpdateChecked('ai_agents', { status: next }, q => q.eq('id', id), AI_OWNER_ONLY);
    aiCache.agents = null;
    notify(next === 'active' ? 'הסוכן הופעל' : 'הסוכן הושבת');
  } catch (e) {
    notify('שגיאה: ' + e.message);
  }
  renderAiCenter();
}

async function aiOpenAgentDetail(id) {
  const body = document.getElementById('ai-modal-body');
  document.getElementById('ai-modal-title').textContent = 'פרטי סוכן';
  body.innerHTML = '<div class="empty">טוען...</div>';
  openModal('modal-ai-detail');
  try {
    const [{ data: a }, { data: tools }, { data: versions }] = await Promise.all([
      aiSb().from('ai_agents').select('*').eq('id', id).single(),
      aiSb().from('ai_agent_tools').select('requires_approval, ai_tools(slug,name,description,risk_level,category)').eq('agent_id', id),
      aiSb().from('ai_agent_versions').select('version_number,is_active,change_notes,created_at').eq('agent_id', id).order('version_number', { ascending: false }),
    ]);
    document.getElementById('ai-modal-title').textContent = a.name;
    body.innerHTML = `
      <div class="ai-agent-desc">${escapeHtml(a.description || '')}</div>
      <div class="ai-kv">
        <div><span>מודל</span><strong>${escapeHtml(a.default_model)}</strong></div>
        <div><span>טמפרטורה</span><strong>${a.default_temperature}</strong></div>
        <div><span>מקסימום צעדים</span><strong>${a.max_steps}</strong></div>
        <div><span>תקרת עלות להרצה</span><strong>$${Number(a.max_cost_per_run).toFixed(2)}</strong></div>
        <div><span>רמת עצמאות</span><strong>${a.autonomy_level}</strong></div>
        <div><span>מדיניות אישור</span><strong>${{ always: 'תמיד', sensitive: 'לפעולות רגישות', never: 'ללא' }[a.approval_policy]}</strong></div>
      </div>

      <div class="ai-section-title" style="margin-top:16px">כלים מורשים (${(tools || []).length})</div>
      <table class="data-table"><thead><tr>
        <th>כלי</th><th>סיכון</th><th>אישור</th></tr></thead><tbody>
        ${(tools || []).map(t => {
          const tool = t.ai_tools || {};
          return `<tr><td><strong>${escapeHtml(tool.name || '')}</strong>
            <div class="ai-muted">${escapeHtml(tool.description || '')}</div></td>
            <td>${RiskBadge(tool.risk_level)}</td>
            <td>${t.requires_approval ? '✓ נדרש' : '—'}</td></tr>`;
        }).join('')}
      </tbody></table>

      <div class="ai-section-title" style="margin-top:16px">גרסאות prompt</div>
      ${(versions || []).map(v => `<div class="fin-row">
        <span>גרסה ${v.version_number} ${v.is_active ? '<span class="badge badge-active">✓ פעילה</span>' : ''}</span>
        <span class="ai-muted">${escapeHtml(v.change_notes || '')} · ${aiFmtDate(v.created_at)}</span>
      </div>`).join('') || '<div class="empty">אין גרסאות</div>'}

      <div class="ai-section-title" style="margin-top:16px">הנחיית המערכת</div>
      <pre class="ai-prompt-view">${escapeHtml(a.system_prompt || '')}</pre>`;
  } catch (e) {
    body.innerHTML = aiError(e.message);
  }
}

// ============================================================
// הרצות
// ============================================================

async function aiRenderRuns(host) {
  const { data, error } = await aiSb().from('ai_runs')
    .select('*').order('created_at', { ascending: false }).limit(60);
  if (error) throw error;
  if (!data.length) { host.innerHTML = aiEmpty('אין הרצות', 'כל הפעלה של סוכן תתועד כאן במלואה.'); return; }

  const agents = await aiGetAgents();
  const agentName = id => (agents.find(a => a.id === id) || {}).name || '—';

  host.innerHTML = `<table class="data-table"><thead><tr>
    <th>סוכן</th><th>מטרה</th><th>סטטוס</th><th>תיק</th><th>עלות</th><th>מתי</th>
  </tr></thead><tbody>
    ${data.map(r => `<tr onclick="aiOpenRun('${r.id}')">
      <td>${escapeHtml(agentName(r.agent_id))}</td>
      <td>${escapeHtml((r.goal || '—').slice(0, 60))}
        ${r.flags && r.flags.injection_suspected ? ' <span class="ai-attention" title="זוהה תוכן חשוד">⚠</span>' : ''}</td>
      <td>${StatusChip(r.status)}</td>
      <td>${escapeHtml(aiCaseName(r.matter_id) || '—')}</td>
      <td>${aiFmtCost(r.estimated_cost)}</td>
      <td>${aiRelTime(r.created_at)}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

async function aiOpenRun(runId) {
  if (!runId) return;
  aiCurrentRunId = runId;
  document.getElementById('ai-modal-title').textContent = 'הרצת סוכן';
  document.getElementById('ai-modal-body').innerHTML = '<div class="empty">טוען...</div>';
  openModal('modal-ai-detail');
  await aiRefreshRunModal();
}

async function aiRefreshRunModal() {
  if (!aiCurrentRunId) return;
  const modal = document.getElementById('modal-ai-detail');
  if (!modal || !modal.classList.contains('open')) { aiCurrentRunId = null; return; }
  const body = document.getElementById('ai-modal-body');
  try {
    const res = await aiInvoke('ai-gateway', { action: 'status', run_id: aiCurrentRunId });
    body.innerHTML = RunTimeline(res.run, res.steps, res.approvals);
  } catch (e) {
    body.innerHTML = aiError(e.message);
  }
}

function RunTimeline(run, steps, approvals) {
  const injection = run.flags && run.flags.injection_suspected;
  return `
    ${injection ? `<div class="alert alert-danger">
      ⚠ <strong>זוהה תוכן חשוד</strong> באחד המקורות שנקראו — ייתכן ניסיון להנחות את הסוכן.
      ההוראות שבתוכן החיצוני לא בוצעו, והכלים של הסוכן נשארו מוגבלים.
      <div class="ai-muted">${escapeHtml((run.flags.injection_details || []).join(' · '))}</div>
    </div>` : ''}

    <div class="ai-kv">
      <div><span>סטטוס</span><strong>${StatusChip(run.status)}</strong></div>
      <div><span>מודל</span><strong>${escapeHtml(run.model_name || '—')}</strong></div>
      <div><span>טוקנים</span><strong>${run.input_tokens} ← / → ${run.output_tokens}</strong></div>
      <div><span>עלות</span><strong>${aiFmtCost(run.estimated_cost)}</strong></div>
      <div><span>צעדים</span><strong>${run.steps_used}</strong></div>
      <div><span>משך</span><strong>${run.duration_ms ? Math.round(run.duration_ms / 1000) + ' שנ׳' : '—'}</strong></div>
      <div><span>תיק</span><strong>${escapeHtml(aiCaseName(run.matter_id) || '—')}</strong></div>
      <div><span>לקוח</span><strong>${escapeHtml(aiClientName(run.client_id) || '—')}</strong></div>
    </div>

    <div class="ai-section-title" style="margin-top:14px">מטרה</div>
    <div class="ai-run-goal-full">${escapeHtml(run.goal || '—')}</div>

    ${run.error_message ? `<div class="alert alert-danger" style="margin-top:10px">
      <strong>שגיאה:</strong> ${escapeHtml(run.error_message)}</div>` : ''}

    ${run.output_data && run.output_data.text ? `
      <div class="ai-section-title" style="margin-top:14px">התוצאה</div>
      <div class="ai-result">${escapeHtml(run.output_data.text)}</div>` : ''}

    ${approvals && approvals.length ? `
      <div class="ai-section-title" style="margin-top:14px">פעולות שנוצרו (${approvals.length})</div>
      ${approvals.map(a => `<div class="fin-row">
        <span>${RiskBadge(a.risk_level)} ${escapeHtml(a.action_label || a.action_type)}</span>
        <span>${StatusChip(a.status)}</span></div>`).join('')}
      <button class="btn btn-sm btn-primary" style="margin-top:8px"
        onclick="closeModal('modal-ai-detail');aiNav('approvals')">עבור למסך האישורים</button>` : ''}

    <div class="ai-section-title" style="margin-top:14px">ציר הפעולה (${steps.length} צעדים)</div>
    <div class="ai-timeline">
      ${steps.map(s => `<div class="ai-step ai-step-${s.step_type}">
        <div class="ai-step-head">
          <span class="ai-step-num">${s.step_number}</span>
          <span class="ai-step-type">${{ model: 'המודל חשב', tool: 'הפעלת כלי', context: 'בניית הקשר', approval: 'אישור', error: 'שגיאה', system: 'מערכת' }[s.step_type] || s.step_type}</span>
          ${s.tool_slug ? `<code>${escapeHtml(s.tool_slug)}</code>` : ''}
          ${s.status === 'failed' ? '<span class="badge badge-urgent">✗ נכשל</span>' : ''}
          ${s.duration_ms ? `<span class="ai-muted">${s.duration_ms}ms</span>` : ''}
        </div>
        ${s.model_output ? `<div class="ai-step-body">${escapeHtml(s.model_output.slice(0, 1500))}</div>` : ''}
        ${s.tool_input ? `<details><summary>קלט הכלי</summary><pre class="ai-payload">${escapeHtml(JSON.stringify(s.tool_input, null, 2))}</pre></details>` : ''}
        ${s.tool_output ? `<details><summary>פלט הכלי</summary><pre class="ai-payload">${escapeHtml(JSON.stringify(s.tool_output, null, 2).slice(0, 4000))}</pre></details>` : ''}
        ${s.error ? `<div class="ai-step-error">${escapeHtml(s.error)}</div>` : ''}
      </div>`).join('')}
    </div>

    ${run.context_summary ? `<details style="margin-top:12px"><summary>מה בדיוק נשלח למודל</summary>
      <pre class="ai-payload">${escapeHtml(run.context_summary)}</pre></details>` : ''}

    <div class="ai-feedback">
      <span>האם התוצאה הייתה מועילה?</span>
      <button class="btn btn-sm" onclick="aiFeedback('${run.id}','up')">👍 כן</button>
      <button class="btn btn-sm" onclick="aiFeedback('${run.id}','down')">👎 לא</button>
    </div>`;
}

async function aiFeedback(runId, rating) {
  const { data: { user } } = await aiSb().auth.getUser();
  const text = rating === 'down' ? await aiPrompt('מה היה לא טוב? (עוזר לשפר)', '') : null;
  const { error } = await aiSb().from('ai_feedback').insert({
    office_id: await aiOfficeId(), run_id: runId, rating,
    feedback_text: text || null, created_by: user ? user.id : null,
  });
  notify(error ? 'שגיאה: ' + error.message : 'תודה על המשוב');
}

// ============================================================
// תור
// ============================================================

async function aiRenderJobs(host) {
  const { data, error } = await aiSb().from('ai_jobs')
    .select('*').order('created_at', { ascending: false }).limit(60);
  if (error) throw error;
  if (!data.length) { host.innerHTML = aiEmpty('התור ריק', 'משימות שנשלחו לסוכנים יופיעו כאן.'); return; }

  const agents = await aiGetAgents();
  const dead = data.filter(j => j.status === 'dead_letter');

  host.innerHTML = `
    ${dead.length ? `<div class="alert alert-danger">
      ${dead.length} משימות נכשלו סופית אחרי כל הניסיונות. ניתן להריץ מחדש כל אחת.</div>` : ''}
    <table class="data-table"><thead><tr>
      <th>סוג</th><th>סוכן</th><th>סטטוס</th><th>ניסיונות</th><th>מתי</th><th></th>
    </tr></thead><tbody>
      ${data.map(j => `<tr>
        <td>${escapeHtml(j.job_type)}<div class="ai-muted">${escapeHtml(String(j.payload && j.payload.goal || '').slice(0, 50))}</div></td>
        <td>${escapeHtml(((agents.find(a => a.id === j.agent_id)) || {}).name || '—')}</td>
        <td>${StatusChip(j.status)}${j.last_error ? `<div class="ai-muted">${escapeHtml(j.last_error.slice(0, 80))}</div>` : ''}</td>
        <td>${j.attempts}/${j.max_attempts}</td>
        <td>${aiRelTime(j.created_at)}</td>
        <td>
          ${['queued', 'running'].includes(j.status) ? `<button class="btn btn-sm btn-danger" onclick="aiCancelJob('${j.id}')">עצור</button>` : ''}
          ${j.status === 'dead_letter' ? `<button class="btn btn-sm" onclick="aiRetryJob('${j.id}')">↻ הרץ שוב</button>` : ''}
        </td>
      </tr>`).join('')}
    </tbody></table>`;
}

async function aiCancelJob(id) {
  try { await aiInvoke('ai-gateway', { action: 'cancel', job_id: id }); notify('המשימה בוטלה'); renderAiCenter(); }
  catch (e) { notify('שגיאה: ' + e.message); }
}

async function aiRetryJob(id) {
  // דרך RPC ולא UPDATE ישיר: ל-ai_jobs אין מדיניות UPDATE בכוונה, כדי
  // שחבר משרד לא יוכל לשכתב את ה-payload (וממנו את מה שייאמר לסוכן) של
  // משימה שממתינה בתור. retry_ai_job נוגעת רק בעמודות הסטטוס.
  const { data, error } = await aiSb().rpc('retry_ai_job', { p_job_id: id });
  if (error) notify('שגיאה: ' + error.message);
  else if (data === false) notify('לא ניתן להריץ מחדש — אין הרשאה או שהמשימה אינה במצב שניתן להריץ שוב');
  else notify('המשימה הוחזרה לתור');
  renderAiCenter();
}

// ============================================================
// תיבה — לידים ומסמכים שממתינים
// ============================================================

async function aiRenderInbox(host) {
  const leads = (db.leads || []).slice().sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const unanalyzed = (db.docs || []).filter(d => d.filePath && !d.aiAnalyzedAt);
  const { data: threads } = await aiSb().from('communication_threads')
    .select('*').eq('status', 'waiting_reply').order('last_message_at', { ascending: true }).limit(20);

  host.innerHTML = `
    <div class="ai-section-title">לידים (${leads.length})</div>
    ${leads.length ? leads.slice(0, 25).map(LeadCard).join('') :
      '<div class="empty">אין לידים. לידים נוצרים אוטומטית מוואטסאפ, ממייל ומשיחות שלא נענו.</div>'}

    <div class="ai-section-title" style="margin-top:20px">מסמכים שטרם נותחו (${unanalyzed.length})</div>
    ${unanalyzed.length ? unanalyzed.slice(0, 15).map(d => `<div class="fin-row">
      <span>📄 ${escapeHtml(d.name)} <span class="ai-muted">${escapeHtml(aiCaseName(d.caseId) || 'ללא תיק')}</span></span>
      <button class="btn btn-sm btn-primary" onclick="aiAnalyzeDoc(${aiJsAttr(d.id)})">נתח</button>
    </div>`).join('') : '<div class="empty">כל המסמכים נותחו</div>'}

    <div class="ai-section-title" style="margin-top:20px">ממתינים לתשובה שלנו (${(threads || []).length})</div>
    ${(threads || []).length ? (threads || []).map(t => `<div class="fin-row">
      <span>${aiChannelIcon(t.channel)} ${escapeHtml(t.participant_name || '—')}
        <span class="ai-muted">${escapeHtml(t.subject || '')}</span></span>
      <span class="ai-muted">${aiRelTime(t.last_message_at)}</span>
    </div>`).join('') : '<div class="empty">אין הודעות שממתינות לתשובה</div>'}`;
}

function LeadCard(l) {
  const score = Number(l.score);
  const scoreCls = score >= 70 ? 'ai-score-high' : score >= 40 ? 'ai-score-mid' : 'ai-score-low';
  return `<div class="card ai-lead">
    <div class="ai-approval-head">
      <div>
        <div class="ai-approval-title">${escapeHtml(l.name || '—')}
          ${l.phone ? `<span class="ai-muted">${escapeHtml(l.phone)}</span>` : ''}</div>
        <div class="ai-approval-sub">
          ${l.area ? escapeHtml(l.area) + ' · ' : ''}מקור: ${escapeHtml(l.source || '—')}
          · סטטוס: ${escapeHtml(l.status || 'new')}
          ${l.urgency ? ` · דחיפות: ${escapeHtml(l.urgency)}` : ''}
        </div>
      </div>
      ${isFinite(score) ? `<div class="ai-score ${scoreCls}" title="ציון ליד">${score}<span>/100</span></div>` : ''}
    </div>
    ${l.scoreReason ? `<div class="ai-muted" style="margin-top:6px">${escapeHtml(l.scoreReason)}</div>` : ''}
    ${l.summary ? `<div style="margin-top:6px">${escapeHtml(l.summary)}</div>` : ''}
    ${(l.missingInfo && l.missingInfo.length) ? `<div class="alert alert-warning" style="margin-top:8px">
      <strong>מידע חסר:</strong> ${escapeHtml(l.missingInfo.join(' · '))}</div>` : ''}
    ${(l.followUpQuestions && l.followUpQuestions.length) ? `<div style="margin-top:6px">
      <strong>שאלות המשך מוצעות:</strong><ul>${l.followUpQuestions.map(q => `<li>${escapeHtml(q)}</li>`).join('')}</ul></div>` : ''}
    <div class="ai-approval-actions">
      <button class="btn btn-sm btn-primary" onclick="aiRunAgent('lead-intake','סווג ודרג את הליד הזה, אתר מידע חסר והכן הודעת פתיחה מוצעת',{lead_id:${aiJsAttr(l.id)}})">◈ נתח ודרג</button>
      <button class="btn btn-sm" onclick="aiRunAgent('sales-conversion','הכן הודעת המשך לליד הזה',{lead_id:${aiJsAttr(l.id)}})">הכן הודעה</button>
      <button class="btn btn-sm" onclick="aiConvertLead(${aiJsAttr(l.id)})">המר ללקוח</button>
    </div>
  </div>`;
}

async function aiConvertLead(id) {
  const l = (db.leads || []).find(x => x.id === id);
  if (!l) return;
  const ok = await customConfirm(`להמיר את "${l.name}" ללקוח במערכת?`, { title: 'המרת ליד', okText: 'המר' });
  if (!ok) return;
  const palette = [
    ['rgba(37,99,235,0.15)', 'var(--accent2)'], ['rgba(22,163,74,0.15)', 'var(--success)'],
    ['rgba(217,119,6,0.15)', 'var(--warning)'], ['rgba(220,38,38,0.15)', 'var(--danger)'],
  ];
  const [color, textColor] = palette[db.clients.length % 4];
  const client = {
    id: uid(), clientNumber: getNextClientNumber(), name: l.name,
    type: 'יחיד', phone: l.phone || '', email: l.email || '', address: l.city || '',
    idNum: '', contact: '', contactPhone: '', notes: l.summary || '',
    color, textColor,
    initials: String(l.name || '').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase(),
  };
  db.clients.push(client);
  l.status = 'won'; l.clientId = client.id; l.updatedAt = new Date().toISOString();
  saveDB();
  notify('הליד הומר ללקוח');
  renderAiCenter();
}

async function aiAnalyzeDoc(docId) {
  const d = (db.docs || []).find(x => x.id === docId);
  if (!d) return;
  await aiRunAgent('document-analysis',
    `נתח את המסמך "${d.name}". חלץ תאריכים, סכומים, צדדים והחלטות, ואתר מועדים — עם ציטוט מקור לכל ממצא.`,
    { matter_id: d.caseId || undefined, payload: { document_id: docId } });
}

function aiChannelIcon(ch) {
  return { email: '✉', whatsapp: '💬', sms: '📱', call: '📞', web: '🌐', system: '⚙' }[ch] || '•';
}

// ============================================================
// תקשורת
// ============================================================

async function aiRenderCommunications(host) {
  const { data: threads, error } = await aiSb().from('communication_threads')
    .select('*').order('last_message_at', { ascending: false }).limit(80);
  if (error) throw error;

  if (!threads.length) {
    host.innerHTML = aiEmpty('אין תקשורת מתועדת',
      'מיילים, הודעות WhatsApp ושיחות יופיעו כאן ברגע שהאינטגרציות יחוברו.',
      `<button class="btn btn-primary" style="margin-top:12px" onclick="aiNav('integrations')">עבור לחיבורים</button>`);
    return;
  }

  host.innerHTML = `
    <div class="ai-filter-row">
      <select class="form-input filter-select" id="ai-comm-channel" onchange="aiFilterComms()">
        <option value="">כל הערוצים</option><option value="email">מייל</option>
        <option value="whatsapp">WhatsApp</option><option value="sms">SMS</option>
        <option value="call">שיחות</option>
      </select>
      <select class="form-input filter-select-wide" id="ai-comm-status" onchange="aiFilterComms()">
        <option value="">כל הסטטוסים</option><option value="waiting_reply">ממתין לתשובה</option>
        <option value="open">פתוח</option><option value="closed">סגור</option>
      </select>
    </div>
    <table class="data-table" id="ai-comm-table"><thead><tr>
      <th>ערוץ</th><th>מי</th><th>נושא</th><th>תיק</th><th>סטטוס</th><th>עדכון אחרון</th>
    </tr></thead><tbody>
      ${threads.map(t => `<tr data-ch="${t.channel}" data-st="${t.status}" onclick="aiOpenThread('${t.id}')">
        <td>${aiChannelIcon(t.channel)} ${escapeHtml(t.channel)}</td>
        <td>${escapeHtml(t.participant_name || t.participant_identifier || '—')}</td>
        <td>${escapeHtml(t.subject || '—')}</td>
        <td>${escapeHtml(aiCaseName(t.matter_id) || '—')}</td>
        <td>${t.status === 'waiting_reply' ? '<span class="badge badge-pending">✋ ממתין לתשובה</span>' : StatusChip(t.status)}</td>
        <td>${aiRelTime(t.last_message_at)}</td>
      </tr>`).join('')}
    </tbody></table>`;
}

function aiFilterComms() {
  const ch = (document.getElementById('ai-comm-channel') || {}).value || '';
  const st = (document.getElementById('ai-comm-status') || {}).value || '';
  document.querySelectorAll('#ai-comm-table tbody tr').forEach(tr => {
    const okCh = !ch || tr.dataset.ch === ch;
    const okSt = !st || tr.dataset.st === st;
    tr.style.display = okCh && okSt ? '' : 'none';
  });
}

async function aiOpenThread(id) {
  document.getElementById('ai-modal-title').textContent = 'שרשור תקשורת';
  const body = document.getElementById('ai-modal-body');
  body.innerHTML = '<div class="empty">טוען...</div>';
  openModal('modal-ai-detail');
  const [{ data: thread, error: tErr }, { data: msgs }] = await Promise.all([
    aiSb().from('communication_threads').select('*').eq('id', id).maybeSingle(),
    aiSb().from('communication_messages').select('*').eq('thread_id', id).order('created_at'),
  ]);
  if (tErr || !thread) { body.innerHTML = aiError((tErr && tErr.message) || 'השרשור לא נמצא', tErr); return; }

  body.innerHTML = `
    <div class="ai-kv">
      <div><span>ערוץ</span><strong>${aiChannelIcon(thread.channel)} ${escapeHtml(thread.channel)}</strong></div>
      <div><span>משתתף</span><strong>${escapeHtml(thread.participant_name || '—')}</strong></div>
      <div><span>תיק</span><strong>${escapeHtml(aiCaseName(thread.matter_id) || '—')}</strong></div>
      <div><span>לקוח</span><strong>${escapeHtml(aiClientName(thread.client_id) || '—')}</strong></div>
    </div>
    <div class="ai-thread">
      ${(msgs || []).map(m => {
        const suspect = m.metadata && m.metadata.injection_suspected;
        return `<div class="ai-msg ai-msg-${m.direction}">
          <div class="ai-msg-head">${m.direction === 'in' ? '← נכנס' : '→ יוצא'}
            · ${escapeHtml(m.sender || m.recipient || '')} · ${aiFmtDate(m.created_at || m.received_at)}
            ${StatusChip(m.status)}</div>
          ${suspect ? `<div class="alert alert-warning" style="margin:6px 0">
            ⚠ בהודעה זו זוהה תוכן שנראה כמנסה להנחות סוכן AI. היא מוצגת כנתון בלבד.</div>` : ''}
          ${m.subject ? `<div class="ai-msg-subject">${escapeHtml(m.subject)}</div>` : ''}
          <div class="ai-msg-body">${escapeHtml(m.body_text || '')}</div>
        </div>`;
      }).join('') || '<div class="empty">אין הודעות</div>'}
    </div>
    <div class="ai-approval-actions">
      <button class="btn btn-primary" onclick="closeModal('modal-ai-detail');aiRunAgent('client-service','הכן תשובה מוצעת לשרשור התקשורת הזה',{matter_id:${thread.matter_id ? aiJsAttr(thread.matter_id) : 'undefined'},client_id:${thread.client_id ? aiJsAttr(thread.client_id) : 'undefined'},payload:{thread_id:${aiJsAttr(id)}}})">◈ הכן תשובה מוצעת</button>
    </div>`;
}

// ============================================================
// למידה
// ============================================================
//
// המסך שסוגר את הלולאה. המערכת אספה מאז ומתמיד את התיקונים שלך
// (edited_payload, rejection_reason, return_instruction) — כאן הם הופכים
// ללקחים שנכנסים ל-prompt של הסוכן.
//
// עיקרון: **לומד מציע, אדם מאשר.** שום תובנה לא משפיעה על התנהגות עד
// שאימצת אותה, וכל אימוץ ניתן לביטול. במערכת שמפיקה מסמכים משפטיים,
// סוכן שמשנה את עצמו בשקט הוא סוכן שאי אפשר להסביר בדיעבד.

const AI_LEARN_KIND = {
  correction: { icon: '✎', label: 'תיקון שלך', cls: 'ai-learn-correction' },
  repetition: { icon: '↻', label: 'עבודה חוזרת ללא תיקונים', cls: 'ai-learn-repetition' },
  recurring_task: { icon: '⏱', label: 'משימה שחוזרת על עצמה', cls: 'ai-learn-repetition' },
  failure_pattern: { icon: '⚠', label: 'כשל חוזר', cls: 'ai-learn-failure' },
};

async function aiRenderLearning(host) {
  const officeId = await aiOfficeId();
  const [{ data: insights, error }, { data: stats }, { data: settings }, agents] = await Promise.all([
    aiSb().from('ai_learning_insights').select('*')
      .order('status').order('confidence', { ascending: false }).limit(100),
    aiSb().rpc('ai_learning_stats', { p_office_id: officeId, p_days: 90 }),
    aiSb().from('ai_settings').select('learning_enabled, learning_repetition_threshold, learning_last_run_at').maybeSingle(),
    aiGetAgents(),
  ]);
  if (error) throw error;

  const agentName = id => (agents.find(a => a.id === id) || {}).name || 'כללי';
  const proposed = (insights || []).filter(i => i.status === 'proposed');
  const accepted = (insights || []).filter(i => i.status === 'accepted');
  const st = settings || {};

  // שיעור התיקונים לאורך זמן הוא המדד היחיד שאומר אם הלמידה עובדת.
  const statRows = (stats || []).slice().sort((a, b) => b.total - a.total);
  const totals = statRows.reduce((acc, s) => ({
    total: acc.total + s.total, edited: acc.edited + s.edited, clean: acc.clean + s.clean,
  }), { total: 0, edited: 0, clean: 0 });

  host.innerHTML = `
    <div class="alert alert-info">
      <strong>איך זה עובד:</strong> בכל פעם שאתה עורך הצעה לפני אישור, דוחה אותה,
      או מחזיר אותה עם הנחיה — המערכת לומדת. היא גם מזהה פעולות שאתה מאשר
      שוב ושוב <strong>בלי לתקן</strong>, ומציעה להעלות לסוכן את רמת העצמאות.
      <div style="margin-top:6px">שום לקח לא נכנס לתוקף עד שתאמץ אותו כאן, וכל אימוץ ניתן לביטול.</div>
    </div>

    <div class="stats-grid" style="margin-top:14px">
      <div class="stat"><div class="stat-label">ממתינות לאישורך</div>
        <div class="stat-value${proposed.length ? ' ai-attention' : ''}">${proposed.length}</div>
        <div class="stat-sub">תובנות חדשות</div></div>
      <div class="stat"><div class="stat-label">לקחים פעילים</div>
        <div class="stat-value">${accepted.length}</div>
        <div class="stat-sub">נכנסים ל-prompt של הסוכנים</div></div>
      <div class="stat"><div class="stat-label">שיעור תיקונים</div>
        <div class="stat-value">${totals.total ? Math.round(totals.edited / totals.total * 100) : 0}%</div>
        <div class="stat-sub">מתוך ${totals.total} הצעות ב-90 יום</div></div>
      <div class="stat"><div class="stat-label">עברו נקי</div>
        <div class="stat-value">${totals.clean}</div>
        <div class="stat-sub">אושרו בלי שנגעת</div></div>
    </div>

    ${!st.learning_enabled ? `<div class="alert alert-warning" style="margin-top:12px">
      הלמידה כבויה. ניתן להפעיל אותה בהגדרות.</div>` : ''}
    ${st.learning_last_run_at
      ? `<div class="ai-muted" style="margin-top:8px">סבב למידה אחרון: ${aiFmtDate(st.learning_last_run_at)}</div>`
      : `<div class="alert alert-warning" style="margin-top:12px">
          טרם רץ סבב למידה. הלמידה רצה מהמתזמן — כל עוד התזמון לא פעיל
          (ראה מסך החיבורים), ניתן להריץ אותה ידנית מכאן.
        </div>`}

    <div style="margin-top:10px">
      <button class="btn btn-sm" onclick="aiRunLearningNow()">◎ הרץ סבב למידה עכשיו</button>
    </div>

    <div class="ai-section-title" style="margin-top:20px">תובנות שממתינות לך (${proposed.length})</div>
    ${proposed.length
      ? proposed.map(i => LearningCard(i, agentName(i.agent_id))).join('')
      : '<div class="empty">אין תובנות חדשות. ככל שתתקן יותר הצעות, כך יהיה יותר ללמוד ממנו.</div>'}

    ${accepted.length ? `
      <div class="ai-section-title" style="margin-top:24px">לקחים פעילים (${accepted.length})</div>
      ${accepted.map(i => `<div class="card ai-learn-accepted">
        <div class="ai-approval-head">
          <div>
            <div class="ai-approval-title">✓ ${escapeHtml(i.title)}</div>
            <div class="ai-approval-sub">${escapeHtml(agentName(i.agent_id))} · אומץ ${aiRelTime(i.reviewed_at)}</div>
          </div>
          <button class="btn btn-sm btn-danger" onclick="aiRevertLesson(${aiJsAttr(i.id)})">בטל לקח</button>
        </div>
        <div class="ai-learn-lesson">${escapeHtml(i.lesson)}</div>
      </div>`).join('')}` : ''}

    ${statRows.length ? `
      <div class="ai-section-title" style="margin-top:24px">כמה אתה מתקן כל סוכן (90 יום)</div>
      <table class="data-table"><thead><tr>
        <th>סוכן</th><th>הצעות</th><th>תיקנת</th><th>דחית</th><th>עבר נקי</th><th>שיעור תיקון</th>
      </tr></thead><tbody>
        ${statRows.map(s => `<tr>
          <td>${escapeHtml(agentName(s.agent_id))}</td>
          <td>${s.total}</td><td>${s.edited}</td><td>${s.rejected}</td><td>${s.clean}</td>
          <td>${Math.round(Number(s.edit_rate) * 100)}%</td>
        </tr>`).join('')}
      </tbody></table>
      <div class="ai-muted" style="margin-top:6px">
        שיעור תיקון שיורד לאורך זמן הוא הסימן שהלמידה עובדת.
      </div>` : ''}`;
}

function LearningCard(i, agentName) {
  const k = AI_LEARN_KIND[i.kind] || AI_LEARN_KIND.correction;
  const ev = i.evidence || {};
  const act = i.suggested_action;

  return `<div class="card ai-learn ${k.cls}" id="insight-${i.id}">
    <div class="ai-approval-head">
      <div>
        <div class="ai-approval-title">${k.icon} ${escapeHtml(i.title)}</div>
        <div class="ai-approval-sub">
          <span class="badge badge-pending">${k.label}</span>
          · ${escapeHtml(agentName)}
          · ${i.occurrences} מופעים
          · ביטחון ${Math.round(Number(i.confidence) * 100)}%
        </div>
      </div>
    </div>

    <div class="ai-learn-lesson">${escapeHtml(i.lesson)}</div>

    <details style="margin-top:8px">
      <summary>על מה זה מבוסס</summary>
      <pre class="ai-payload">${escapeHtml(JSON.stringify(ev, null, 2).slice(0, 3000))}</pre>
    </details>

    ${act && act.type === 'raise_autonomy' ? `<div class="alert alert-warning" style="margin-top:8px">
      <strong>הצעה מבנית:</strong> להעלות את רמת העצמאות של הסוכן מ-${act.from} ל-${act.to}.
      פעולות משפטיות, כספיות ותקשורת חיצונית ימשיכו לדרוש אישור בכל מקרה.
      <div style="margin-top:6px">
        <button class="btn btn-sm btn-warning" onclick="aiApplyAutonomy(${aiJsAttr(i.id)},${aiJsAttr(act.agent_id)},${Number(act.to)})">
          החל את שינוי העצמאות
        </button>
      </div>
    </div>` : ''}

    ${act && act.type === 'create_automation' ? `<div class="alert alert-info" style="margin-top:8px">
      <strong>הצעה:</strong> להפוך את זה לאוטומציה. פתח את מסך האוטומציות והדלק
      את הכלל המתאים, או צור חדש לפי <code>AI_CENTER_AUTOMATIONS.md</code>.
    </div>` : ''}

    <div class="ai-approval-actions">
      <button class="btn btn-success" onclick="aiAcceptLesson(${aiJsAttr(i.id)})">✓ אמץ את הלקח</button>
      <button class="btn btn-danger" onclick="aiDismissLesson(${aiJsAttr(i.id)})">✗ לא רלוונטי</button>
    </div>
  </div>`;
}

async function aiAcceptLesson(id) {
  const { error } = await aiSb().rpc('accept_learning_insight', { p_insight_id: id });
  if (error) { notify('שגיאה: ' + error.message); return; }
  notify('הלקח אומץ — הסוכן ייקח אותו בחשבון מההרצה הבאה');
  renderAiCenter();
}

async function aiDismissLesson(id) {
  const reason = await aiPrompt('למה זה לא רלוונטי? (אופציונלי — עוזר לא להציע שוב)', '');
  if (reason === null) return;
  const { data, error } = await aiSb().rpc('dismiss_learning_insight',
    { p_insight_id: id, p_reason: reason || null });
  if (error) notify('שגיאה: ' + error.message);
  else if (data === false) notify('נדרשת הרשאת בעל משרד');
  else notify('התובנה נדחתה ולא תוצע שוב');
  renderAiCenter();
}

async function aiRevertLesson(id) {
  const ok = await customConfirm(
    'לבטל את הלקח? הוא יימחק מזיכרון הסוכן ולא ישפיע יותר על הטיוטות שלו.',
    { title: 'ביטול לקח', okText: 'בטל את הלקח', danger: true });
  if (!ok) return;
  const { data, error } = await aiSb().rpc('revert_learning_insight', { p_insight_id: id });
  if (error) notify('שגיאה: ' + error.message);
  else if (data === false) notify('נדרשת הרשאת בעל משרד');
  else notify('הלקח בוטל ונמחק');
  renderAiCenter();
}

/** החלת הצעת עצמאות — שינוי הגדרה, ולכן owner בלבד ובאישור מפורש. */
async function aiApplyAutonomy(insightId, agentId, level) {
  const ok = await customConfirm(
    `להעלות את רמת העצמאות של הסוכן ל-${level}?\n\n` +
    `פעולות ברמת סיכון נמוכה יותר יבוצעו מעתה בלי לחכות לאישור שלך. ` +
    `מסמכים משפטיים, כספים ותקשורת חיצונית ימשיכו לדרוש אישור תמיד.`,
    { title: 'שינוי רמת עצמאות', okText: 'העלה רמה', danger: true });
  if (!ok) return;
  try {
    await aiUpdateChecked('ai_agents', { autonomy_level: level },
      q => q.eq('id', agentId), AI_OWNER_ONLY);
    await aiSb().rpc('accept_learning_insight', { p_insight_id: insightId });
    aiCache.agents = null;
    notify('רמת העצמאות עודכנה');
  } catch (e) {
    notify('שגיאה: ' + e.message);
  }
  renderAiCenter();
}

async function aiRunLearningNow() {
  notify('מריץ סבב למידה...');
  try {
    const res = await aiInvoke('ai-gateway', { action: 'learn' });
    notify(res && res.insights ? `נמצאו ${res.insights} תובנות חדשות` : 'לא נמצאו תובנות חדשות');
  } catch (e) {
    notify('שגיאה: ' + e.message);
  }
  renderAiCenter();
}

// ============================================================
// אוטומציות
// ============================================================

async function aiRenderAutomations(host) {
  const { data, error } = await aiSb().from('automation_rules').select('*').order('name');
  if (error) throw error;
  const { data: settings } = await aiSb().from('ai_settings').select('automations_paused').maybeSingle();

  host.innerHTML = `
    ${settings && settings.automations_paused ? `<div class="alert alert-warning">
      ⏸ כל האוטומציות מושהות כרגע. ניתן להפעיל מחדש בהגדרות.</div>` : ''}
    <div class="alert alert-info">
      אוטומציות כבויות כברירת מחדל. הפעלה תגרום לסוכנים לרוץ מעצמם —
      אבל <strong>כל פעולה עדיין תעבור דרך מסך האישורים</strong> לפני שתתבצע.
    </div>
    ${(data || []).map(r => `<div class="card ai-automation">
      <div class="ai-approval-head">
        <div>
          <div class="ai-approval-title">${r.is_active ? '✓' : '○'} ${escapeHtml(r.name)}</div>
          <div class="ai-approval-sub">${escapeHtml(r.description || '')}</div>
        </div>
        <label class="ai-switch">
          <input type="checkbox" ${r.is_active ? 'checked' : ''} onchange="aiToggleAutomation('${r.id}',this.checked)">
          <span>${r.is_active ? 'פעילה' : 'כבויה'}</span>
        </label>
      </div>
      <div class="ai-agent-meta">
        <span>טריגר: ${escapeHtml(aiTriggerHe(r.trigger_type))}</span>
        <span>פעולות: ${(r.actions || []).length}</span>
        ${r.requires_approval ? '<span>✋ דורש אישור</span>' : ''}
        ${r.last_run_at ? `<span>הרצה אחרונה: ${aiRelTime(r.last_run_at)}</span>` : '<span>טרם רצה</span>'}
      </div>
      ${r.last_run_status ? `<div class="ai-muted">${escapeHtml(r.last_run_status)}</div>` : ''}
    </div>`).join('') || aiEmpty('אין אוטומציות', 'יש להריץ את מיגרציית הזריעה.')}`;
}

function aiTriggerHe(t) {
  return {
    daily_digest: 'כל בוקר', new_lead: 'ליד חדש', document_unanalyzed: 'מסמך חדש',
    client_no_update: 'לקוח ללא עדכון', payment_overdue: 'תשלום באיחור',
    matter_inactive: 'תיק ללא פעילות', deadline_approaching: 'מועד מתקרב',
    task_overdue: 'משימה באיחור',
  }[t] || t;
}

async function aiToggleAutomation(id, active) {
  try {
    await aiUpdateChecked('automation_rules', { is_active: active },
      q => q.eq('id', id), AI_OWNER_ONLY);
    notify(active ? 'האוטומציה הופעלה' : 'האוטומציה כובתה');
  } catch (e) {
    notify('שגיאה: ' + e.message);
  }
  renderAiCenter();
}

// ============================================================
// חיבורים
// ============================================================

async function aiRenderIntegrations(host) {
  const res = await aiInvoke('ai-comms', { action: 'integrations_status' });
  aiCache.integrations = res;

  host.innerHTML = `
    <div class="ai-integration-grid">
      ${res.integrations.map(IntegrationCard).join('')}
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">ספק ה-AI</div>
      <div class="fin-row"><span>מצב</span><strong>${res.ai_provider.mode === 'mock' ? '🧪 הדגמה (mock)' : '● פעיל'}</strong></div>
      <div class="fin-row"><span>מפתח API בשרת</span><strong>${res.ai_provider.key_present ? '✓ מוגדר' : '✗ חסר'}</strong></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">תזמון אוטומטי</div>
      ${res.scheduler.cron_secret_set
        ? '<div class="alert alert-success">✓ CRON_SECRET מוגדר. יש לוודא שהמתזמן החיצוני אכן קורא ל-ai-cron.</div>'
        : `<div class="alert alert-warning">
            <strong>תזמון: לא פעיל.</strong> הסוכנים ירוצו כרגע רק כשהאפליקציה פתוחה.
            כדי שהמערכת תעבוד גם כשהמחשב כבוי — יש להפעיל מתזמן.
            ההוראות המדויקות ב-<code>docs/AI_CENTER_DEPLOYMENT.md</code>.
          </div>`}
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">מה נדרש מספק טלפוניה</div>
      <div><strong>חובה:</strong><ul>${res.telephony_requirements.required.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
      <div><strong>רשות:</strong><ul>${res.telephony_requirements.optional.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
      <div class="alert alert-warning" style="margin-top:8px">${escapeHtml(res.telephony_requirements.legalNote)}</div>
    </div>`;
}

function IntegrationCard(i) {
  const map = {
    connected: ['✓', 'מחובר', 'active'],
    not_connected: ['○', 'לא מחובר', 'pending'],
    not_configured: ['⚙', 'לא מוגדר בשרת', 'closed'],
    disconnected: ['○', 'לא מחובר', 'pending'],
    error: ['✗', 'תקלה', 'urgent'],
    expired: ['⌛', 'פג תוקף', 'urgent'],
    mock: ['🧪', 'הדגמה', 'pending'],
  };
  const [icon, label, cls] = map[i.status] || ['?', escapeHtml(i.status), 'pending'];
  const isGoogle = i.provider.startsWith('google');

  return `<div class="card ai-integration">
    <div class="ai-approval-head">
      <div class="ai-approval-title">${escapeHtml(i.label)}</div>
      <span class="badge badge-${cls}">${icon} ${label}</span>
    </div>
    ${i.account ? `<div class="ai-muted">חשבון: ${escapeHtml(i.account)}</div>` : ''}
    ${i.last_sync_at ? `<div class="ai-muted">סנכרון אחרון: ${aiFmtDate(i.last_sync_at)}</div>` : ''}
    ${i.token_expires_at ? `<div class="ai-muted">תוקף: ${aiFmtDate(i.token_expires_at)}</div>` : ''}
    ${i.last_error ? `<div class="alert alert-danger" style="margin-top:8px">${escapeHtml(i.last_error)}</div>` : ''}
    ${!i.env_ready && i.provider !== 'telephony' ? `<div class="alert alert-warning" style="margin-top:8px">
      חסרים משתני סביבה בשרת. ראה <code>.env.example</code> ו-<code>docs/AI_CENTER_INTEGRATIONS.md</code>.</div>` : ''}
    ${i.provider === 'telephony' ? `<div class="alert alert-info" style="margin-top:8px">
      נדרש חיבור ספק טלפוניה. טרם נבחר ספק — ראה הדרישות למטה.</div>` : ''}
    <div class="ai-approval-actions">
      ${isGoogle && i.env_ready ? (i.status === 'connected'
        ? `<button class="btn btn-sm" onclick="aiGoogleTest()">בדוק חיבור</button>
           <button class="btn btn-sm" onclick="aiGoogleSync()">סנכרן עכשיו</button>
           <button class="btn btn-sm btn-danger" onclick="aiGoogleDisconnect()">נתק</button>`
        : `<button class="btn btn-sm btn-primary" onclick="aiGoogleConnect()">חבר חשבון Google</button>`) : ''}
    </div>
  </div>`;
}

async function aiGoogleConnect() {
  try {
    const { data, error } = await aiSb().functions.invoke('integrations-google?action=connect', { body: {} });
    if (error) throw error;
    if (!data || !data.url) throw new Error('לא התקבל קישור חיבור');
    // חלון חדש ולא הפניה: כך המשתמש לא מאבד את מצב האפליקציה.
    window.open(data.url, '_blank', 'width=520,height=680');
    notify('השלם את החיבור בחלון שנפתח, ואז לחץ "בדוק חיבור"');
  } catch (e) { notify('שגיאה: ' + e.message); }
}

async function aiGoogleTest() {
  try {
    const { data } = await aiSb().functions.invoke('integrations-google?action=test', { body: {} });
    notify(data && data.gmail && data.gmail.ok ? '✓ החיבור תקין' : 'החיבור אינו תקין: ' + ((data && data.gmail && data.gmail.error) || ''));
    renderAiCenter();
  } catch (e) { notify('שגיאה: ' + e.message); }
}

async function aiGoogleSync() {
  try {
    notify('מסנכרן...');
    const { data } = await aiSb().functions.invoke('integrations-google?action=sync', { body: {} });
    notify(data && data.ok ? `נקלטו ${data.inserted} הודעות חדשות` : (data && data.message) || 'הסנכרון לא בוצע');
    renderAiCenter();
  } catch (e) { notify('שגיאה: ' + e.message); }
}

async function aiGoogleDisconnect() {
  const ok = await customConfirm('לנתק את חשבון Google? הסוכנים לא יוכלו לקרוא מיילים או לגשת ליומן.',
    { title: 'ניתוק חשבון', okText: 'נתק', danger: true });
  if (!ok) return;
  try {
    await aiSb().functions.invoke('integrations-google?action=disconnect', { body: {} });
    notify('החשבון נותק');
    renderAiCenter();
  } catch (e) { notify('שגיאה: ' + e.message); }
}

// ============================================================
// עלויות
// ============================================================

async function aiRenderCosts(host) {
  const officeId = await aiOfficeId();
  const [{ data: daily }, { data: spend }, agents, { data: settings }] = await Promise.all([
    aiSb().from('ai_usage_daily').select('*').order('usage_date', { ascending: false }).limit(120),
    aiSb().rpc('ai_spend_window', { p_office_id: officeId }),
    aiGetAgents(),
    aiSb().from('ai_settings').select('*').maybeSingle(),
  ]);
  const s = Array.isArray(spend) ? spend[0] : spend;
  const st = settings || {};

  const byAgent = {}, byModel = {}, byDay = {};
  for (const r of daily || []) {
    const an = (agents.find(a => a.id === r.agent_id) || {}).name || 'ללא סוכן';
    byAgent[an] = (byAgent[an] || 0) + Number(r.estimated_cost);
    byModel[r.model_name] = (byModel[r.model_name] || 0) + Number(r.estimated_cost);
    byDay[r.usage_date] = (byDay[r.usage_date] || 0) + Number(r.estimated_cost);
  }
  const totalTokensIn = (daily || []).reduce((a, r) => a + Number(r.input_tokens), 0);
  const totalTokensOut = (daily || []).reduce((a, r) => a + Number(r.output_tokens), 0);
  const failures = (daily || []).reduce((a, r) => a + Number(r.failure_count), 0);
  const runsTotal = (daily || []).reduce((a, r) => a + Number(r.runs_count), 0);

  const dailyPct = st.daily_budget_usd ? Math.min(100, (Number(s && s.today_cost) / st.daily_budget_usd) * 100) : 0;
  const monthPct = st.monthly_budget_usd ? Math.min(100, (Number(s && s.month_cost) / st.monthly_budget_usd) * 100) : 0;

  const bar = (pct) => `<div class="progress-wrap"><div class="progress-fill" style="width:${pct.toFixed(0)}%;
    background:${pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warning)' : 'var(--success)'}"></div></div>`;

  host.innerHTML = `
    <div class="two-col">
      <div class="card">
        <div class="card-title">תקציב יומי</div>
        <div class="amount-big">${aiFmtCost(s && s.today_cost)} <span class="ai-muted">מתוך $${st.daily_budget_usd || 0}</span></div>
        ${bar(dailyPct)}
        <div class="ai-muted">${dailyPct.toFixed(0)}% · ${(s && s.today_runs) || 0} הרצות היום</div>
      </div>
      <div class="card">
        <div class="card-title">תקציב חודשי</div>
        <div class="amount-big">${aiFmtCost(s && s.month_cost)} <span class="ai-muted">מתוך $${st.monthly_budget_usd || 0}</span></div>
        ${bar(monthPct)}
        <div class="ai-muted">${monthPct.toFixed(0)}% · ${(s && s.month_runs) || 0} הרצות החודש</div>
      </div>
    </div>

    ${monthPct >= 90 ? '<div class="alert alert-danger">⚠ מעל 90% מהתקציב החודשי נוצל.</div>'
      : monthPct >= 70 ? '<div class="alert alert-warning">מעל 70% מהתקציב החודשי נוצל.</div>' : ''}

    <div class="stats-grid" style="margin-top:16px">
      <div class="stat"><div class="stat-label">סה"כ הרצות</div><div class="stat-value">${runsTotal}</div></div>
      <div class="stat"><div class="stat-label">כשלונות</div><div class="stat-value">${failures}</div></div>
      <div class="stat"><div class="stat-label">טוקנים נכנסים</div><div class="stat-value">${totalTokensIn.toLocaleString()}</div></div>
      <div class="stat"><div class="stat-label">טוקנים יוצאים</div><div class="stat-value">${totalTokensOut.toLocaleString()}</div></div>
    </div>

    <div class="two-col" style="margin-top:16px">
      <div class="card"><div class="card-title">עלות לפי סוכן</div>
        ${Object.entries(byAgent).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
          `<div class="fin-row"><span>${escapeHtml(k)}</span><strong>${aiFmtCost(v)}</strong></div>`).join('') || '<div class="empty">אין נתונים</div>'}
      </div>
      <div class="card"><div class="card-title">עלות לפי מודל</div>
        ${Object.entries(byModel).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
          `<div class="fin-row"><span>${escapeHtml(k)}</span><strong>${aiFmtCost(v)}</strong></div>`).join('') || '<div class="empty">אין נתונים</div>'}
      </div>
    </div>

    <div class="card" style="margin-top:16px"><div class="card-title">14 הימים האחרונים</div>
      ${Object.entries(byDay).sort().reverse().slice(0, 14).map(([d, v]) =>
        `<div class="fin-row"><span>${aiDisplayDate(d)}</span><strong>${aiFmtCost(v)}</strong></div>`).join('') || '<div class="empty">אין נתונים</div>'}
    </div>`;
}

// ============================================================
// יומן ביקורת
// ============================================================

async function aiRenderAudit(host) {
  const { data, error } = await aiSb().from('audit_logs')
    .select('*').order('created_at', { ascending: false }).limit(150);
  if (error) throw error;
  const security = (data || []).filter(l => l.severity === 'security');

  host.innerHTML = `
    ${security.length ? `<div class="alert alert-danger">
      <strong>${security.length} אירועי אבטחה</strong> נרשמו: ניסיונות גישה חורגת, prompt injection,
      או ניסיון שליחה ללא אישור. כולם נחסמו.</div>` : ''}
    <div class="ai-filter-row">
      <select class="form-input filter-select-wide" id="ai-audit-sev" onchange="aiFilterAudit()">
        <option value="">הכול</option><option value="security">אבטחה</option>
        <option value="warning">אזהרות</option><option value="error">שגיאות</option>
      </select>
      <select class="form-input filter-select-wide" id="ai-audit-actor" onchange="aiFilterAudit()">
        <option value="">כל המבצעים</option><option value="user">משתמש</option>
        <option value="agent">סוכן</option><option value="automation">אוטומציה</option>
        <option value="webhook">webhook</option><option value="system">מערכת</option>
      </select>
    </div>
    <table class="data-table" id="ai-audit-table"><thead><tr>
      <th>מתי</th><th>מבצע</th><th>פעולה</th><th>ישות</th><th>חומרה</th>
    </tr></thead><tbody>
      ${(data || []).map(l => `<tr data-sev="${l.severity}" data-actor="${l.actor_type}">
        <td>${aiFmtDate(l.created_at)}</td>
        <td>${{ user: '👤 משתמש', agent: '◈ סוכן', system: '⚙ מערכת', automation: '↻ אוטומציה', webhook: '⇄ webhook' }[l.actor_type] || l.actor_type}</td>
        <td>${escapeHtml(l.action)}</td>
        <td>${escapeHtml(l.entity_type || '—')}${l.matter_id ? ` · ${escapeHtml(aiCaseName(l.matter_id) || '')}` : ''}</td>
        <td>${l.severity === 'security' ? '<span class="badge badge-urgent">🔒 אבטחה</span>'
          : l.severity === 'warning' ? '<span class="badge badge-pending">⚠ אזהרה</span>'
          : l.severity === 'error' ? '<span class="badge badge-urgent">✗ שגיאה</span>'
          : '<span class="badge badge-active">✓ רגיל</span>'}</td>
      </tr>`).join('')}
    </tbody></table>`;
}

function aiFilterAudit() {
  const sev = (document.getElementById('ai-audit-sev') || {}).value || '';
  const actor = (document.getElementById('ai-audit-actor') || {}).value || '';
  document.querySelectorAll('#ai-audit-table tbody tr').forEach(tr => {
    tr.style.display = (!sev || tr.dataset.sev === sev) && (!actor || tr.dataset.actor === actor) ? '' : 'none';
  });
}

// ============================================================
// הגדרות
// ============================================================

async function aiRenderSettings(host) {
  const { data: s, error } = await aiSb().from('ai_settings').select('*').maybeSingle();
  if (error) throw error;
  const st = s || {};
  const om = st.office_memory || {};

  host.innerHTML = `
    <div class="card ai-emergency">
      <div class="card-title">⛔ עצירת חירום</div>
      <p class="ai-muted">עוצר מיידית את כל הסוכנים — כולל הרצות שכבר באוויר. שום פעולה חדשה לא תתחיל.</p>
      <button class="btn ${st.emergency_stop ? 'btn-success' : 'btn-danger'}"
        onclick="aiToggleEmergency(${!st.emergency_stop})">
        ${st.emergency_stop ? '▶ בטל עצירת חירום והפעל מחדש' : '⛔ עצור את כל הסוכנים'}
      </button>
      ${st.emergency_stop ? `<div class="alert alert-danger" style="margin-top:10px">
        המערכת עצורה מאז ${aiFmtDate(st.emergency_stop_at)}.
        ${st.emergency_stop_reason ? escapeHtml(st.emergency_stop_reason) : ''}</div>` : ''}

      <div class="ai-toggles">
        ${aiToggle('outbound_messages_paused', 'השהה הודעות יוצאות', st.outbound_messages_paused)}
        ${aiToggle('automations_paused', 'השהה את כל האוטומציות', st.automations_paused)}
        ${aiToggle('read_only_mode', 'מצב קריאה בלבד', st.read_only_mode)}
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">תקציב</div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">תקציב יומי (USD)</label>
          <input class="form-input" type="number" step="0.5" min="0" id="ai-set-daily" value="${st.daily_budget_usd || 5}"></div>
        <div class="form-group"><label class="form-label">תקציב חודשי (USD)</label>
          <input class="form-input" type="number" step="1" min="0" id="ai-set-monthly" value="${st.monthly_budget_usd || 50}"></div>
      </div>
      <div class="form-group"><label class="form-label">בחריגה מהתקציב</label>
        <select class="form-input" id="ai-set-exceed">
          <option value="stop" ${st.on_budget_exceeded === 'stop' ? 'selected' : ''}>עצור את הסוכנים</option>
          <option value="downgrade" ${st.on_budget_exceeded === 'downgrade' ? 'selected' : ''}>עבור למודל זול יותר</option>
        </select></div>
      <div class="form-group"><label class="form-label">מצב ספק AI</label>
        <select class="form-input" id="ai-set-mode">
          <option value="live" ${st.ai_provider_mode === 'live' ? 'selected' : ''}>פעיל — קריאות אמיתיות בתשלום</option>
          <option value="mock" ${st.ai_provider_mode === 'mock' ? 'selected' : ''}>הדגמה — ללא קריאות ובלי עלות</option>
        </select></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">למידה מתמשכת</div>
      <p class="ai-muted">
        כשהיא פעילה, המערכת לומדת מהתיקונים שלך ומזהה עבודה שחוזרת על עצמה.
        התובנות מוצגות במסך "למידה" — <strong>אף אחת לא נכנסת לתוקף בלי שתאמץ אותה</strong>.
      </p>
      <div class="ai-toggles">
        ${aiToggle('learning_enabled', 'למד מהתיקונים שלי', st.learning_enabled)}
      </div>
      <div class="form-group" style="margin-top:10px">
        <label class="form-label">כמה אישורים נקיים ברצף לפני שתוצע העלאת עצמאות</label>
        <input class="form-input" type="number" min="3" max="50" id="ai-set-learn-threshold"
          value="${Number(st.learning_repetition_threshold) || 5}">
        <div class="ai-muted" style="margin-top:4px">
          ערך גבוה יותר = המערכת זהירה יותר לפני שתציע לסוכן לפעול לבד.
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">זיכרון המשרד</div>
      <p class="ai-muted">מידע זה נשלח לכל סוכן. ככל שהוא מדויק יותר, כך הפלט יתאים יותר למשרד.</p>
      ${aiMemField('practiceAreas', 'תחומי התמחות', om.practiceAreas, 'הוצאה לפועל, חדלות פירעון, ליטיגציה אזרחית')}
      ${aiMemField('writingStyle', 'סגנון כתיבה', om.writingStyle, 'ענייני, תמציתי, בלי הכבדה מיותרת')}
      ${aiMemField('draftingRules', 'כללי ניסוח', om.draftingRules, 'תמיד לפרט את הסעד המבוקש בסעיף נפרד')}
      ${aiMemField('workingHours', 'שעות פעילות', om.workingHours, 'א׳-ה׳ 09:00-18:00')}
      ${aiMemField('signature', 'חתימה', om.signature, 'בכבוד רב, עו״ד ...')}
      ${aiMemField('communicationPolicy', 'מדיניות תקשורת', om.communicationPolicy, 'לא לשלוח הודעות אחרי 20:00')}
    </div>

    <button class="btn btn-primary" style="margin-top:16px" onclick="aiSaveSettings()">שמור הגדרות</button>`;
}

function aiToggle(key, label, value) {
  return `<label class="ai-switch">
    <input type="checkbox" ${value ? 'checked' : ''} onchange="aiSaveToggle('${key}',this.checked)">
    <span>${escapeHtml(label)}</span></label>`;
}

function aiMemField(key, label, value, placeholder) {
  return `<div class="form-group"><label class="form-label">${escapeHtml(label)}</label>
    <textarea class="form-input" id="ai-mem-${key}" rows="2"
      placeholder="${escapeHtml(placeholder)}">${escapeHtml(value || '')}</textarea></div>`;
}

async function aiSaveToggle(key, value) {
  const patch = {}; patch[key] = value;
  const officeId = await aiOfficeId();
  try {
    await aiUpdateChecked('ai_settings', patch,
      q => q.eq('office_id', officeId), AI_OWNER_ONLY);
    notify('ההגדרה נשמרה');
  } catch (e) {
    notify('שגיאה: ' + e.message);
    renderAiCenter();   // מחזיר את המתג למצבו האמיתי
  }
}

async function aiToggleEmergency(on) {
  if (on) {
    const ok = await customConfirm(
      'לעצור את כל סוכני ה-AI?\n\nכל ההרצות ייעצרו מיידית ולא יתחילו חדשות, עד לביטול העצירה.',
      { title: 'עצירת חירום', okText: 'כן, עצור הכול', danger: true });
    if (!ok) return;
  }
  // ⚠ הבדיקה כאן קריטית מכל השאר. RLS מגביל את ai_settings לבעל המשרד,
  // וכשהוא חוסם — PostgREST מחזיר הצלחה עם אפס שורות. בלי אימות, עורך דין
  // או מזכיר/ה היו רואים "⛔ כל הסוכנים נעצרו" בזמן שהסוכנים ממשיכים לרוץ.
  const officeId = await aiOfficeId();
  try {
    await aiUpdateChecked('ai_settings', {
      emergency_stop: on,
      emergency_stop_at: on ? new Date().toISOString() : null,
      emergency_stop_reason: on ? 'הופעל ידנית ממרכז השליטה' : null,
    }, q => q.eq('office_id', officeId),
      'עצירת החירום לא בוצעה — נדרשת הרשאת בעל משרד. פנה לבעל המשרד מיד.');
    notify(on ? '⛔ כל הסוכנים נעצרו' : '▶ המערכת הופעלה מחדש');
  } catch (e) {
    notify('שגיאה: ' + e.message);
  }
  renderAiCenter();
}

async function aiSaveSettings() {
  const om = {};
  ['practiceAreas', 'writingStyle', 'draftingRules', 'workingHours', 'signature', 'communicationPolicy']
    .forEach(k => {
      const el = document.getElementById('ai-mem-' + k);
      if (el && el.value.trim()) om[k] = el.value.trim();
    });
  const officeId = await aiOfficeId();
  try {
    await aiUpdateChecked('ai_settings', {
      daily_budget_usd: Number(document.getElementById('ai-set-daily').value) || 0,
      monthly_budget_usd: Number(document.getElementById('ai-set-monthly').value) || 0,
      on_budget_exceeded: document.getElementById('ai-set-exceed').value,
      ai_provider_mode: document.getElementById('ai-set-mode').value,
      // הצמדה ל-3..50: מתחת ל-3 "דפוס" הוא צירוף מקרים, ומעל 50 אף פעם
      // לא תוצע העלאת עצמאות — שתי הקצוות מבטלות את התכונה בשקט.
      learning_repetition_threshold: Math.min(50, Math.max(3,
        Number(document.getElementById('ai-set-learn-threshold').value) || 5)),
      office_memory: om,
    }, q => q.eq('office_id', officeId), AI_OWNER_ONLY);
    notify('ההגדרות נשמרו');
  } catch (e) {
    notify('שגיאה: ' + e.message);
  }
}

// ============================================================
// עזרים
// ============================================================

// המטמון ממופתח לפי מזהה המשתמש ולא גלובלי: בלי זה, החלפת משתמש בלי רענון
// דף (התנתקות והתחברות אחרת) הייתה משאירה את מזהה המשרד הקודם, והמונים
// ושאילתת התקציב היו מדווחים על משרד זר.
let _aiOfficeId = null;
let _aiOfficeUserId = null;
async function aiOfficeId() {
  const { data: { user } } = await aiSb().auth.getUser();
  if (!user) { _aiOfficeId = null; _aiOfficeUserId = null; return null; }
  if (_aiOfficeId && _aiOfficeUserId === user.id) return _aiOfficeId;
  const { data } = await aiSb().from('office_members')
    .select('office_id').eq('user_id', user.id).limit(1).maybeSingle();
  _aiOfficeId = data ? data.office_id : null;
  _aiOfficeUserId = user.id;
  return _aiOfficeId;
}

/** מונים בטאבים — מספר האישורים הממתינים הוא המידע הכי דחוף במסך. */
async function aiRefreshBadges() {
  try {
    const [{ count: approvals }, { count: jobs }, { count: drafts }] = await Promise.all([
      aiSb().from('ai_approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      aiSb().from('ai_jobs').select('id', { count: 'exact', head: true }).in('status', ['queued', 'running']),
      // .catch: מיגרציית הצוות (20261031000000) עשויה טרם לרוץ. בלי זה
      // Promise.all היה נכשל כולו, והמונה של האישורים הממתינים — הדבר
      // החשוב באמת בסרגל — היה נעלם בגלל תכונה משנית.
      aiSb().from('ai_work_items').select('id', { count: 'exact', head: true })
        .eq('status', 'draft').then(r => r, () => ({ count: 0 })),
    ]);
    const setCount = (id, n) => {
      const el = document.getElementById('ai-count-' + id);
      if (el) { el.textContent = n ? String(n) : ''; el.style.display = n ? '' : 'none'; }
    };
    setCount('approvals', approvals || 0);
    setCount('work', drafts || 0);
    setCount('advanced', jobs || 0);
    // ⚠ הסמן בתפריט הראשי סופר **רק** אישורים ממתינים. תובנות למידה
    // אינן דחופות — הן ימתינו שבוע בלי נזק — ומיזוג שלהן לאותו מספר היה
    // הופך את הסמן שאומר "יש פעולה שממתינה לך" לרעש.
    const badge = document.getElementById('ai-nav-badge');
    if (badge) {
      badge.textContent = approvals || '';
      badge.style.display = approvals ? '' : 'none';
    }
  } catch (e) { /* מונה שלא התעדכן אינו סיבה לשבור את המסך */ }
}

/**
 * Realtime — "משימה התחילה / דורשת אישור / הושלמה" בלי רענון (סעיף 20).
 * RLS חל גם על ערוצי Realtime, ולכן אין כאן חשיפה בין משרדים.
 */
function aiSubscribeRealtime() {
  if (aiRealtimeChannel) return;
  try {
    aiRealtimeChannel = aiSb().channel('ai-center')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ai_runs' }, () => {
        aiRefreshBadges();
        if (aiCurrentRunId) aiRefreshRunModal();
        if (['overview', 'runs', 'jobs'].includes(aiTab)) renderAiCenter();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ai_approvals' }, (p) => {
        aiRefreshBadges();
        if (p.new && p.new.status === 'pending') notify('✋ פעולה חדשה ממתינה לאישור');
        if (aiTab === 'approvals') renderAiCenter();
      })
      .subscribe();
  } catch (e) { /* Realtime לא זמין — המסך עדיין עובד עם רענון ידני */ }
}

/** תיבת קלט מודאלית — במערכת אין prompt() מותאם, ו-window.prompt חסום ב-WebView. */
function aiPrompt(message, defaultValue) {
  return new Promise(resolve => {
    const body = document.getElementById('ai-prompt-body');
    document.getElementById('ai-prompt-msg').textContent = message;
    const input = document.getElementById('ai-prompt-input');
    input.value = defaultValue || '';
    window._aiPromptResolve = resolve;
    openModal('modal-ai-prompt');
    setTimeout(() => input.focus(), 50);
  });
}
function aiPromptResolve(ok) {
  const input = document.getElementById('ai-prompt-input');
  const r = window._aiPromptResolve;
  window._aiPromptResolve = null;
  closeModal('modal-ai-prompt');
  if (r) r(ok ? input.value.trim() : null);
}

// לחיצה על רקע המודל קוראת ל-closeModal (app.js רושם מאזין backdrop על כל
// .modal-overlay בטעינה). בלי העטיפה הזו ה-Promise של aiPrompt היה נשאר
// תלוי לנצח, ו-await aiPrompt(...) בדחיית אישור, בהחזרה לסוכן או במשוב
// שלילי פשוט לא היה חוזר — בלי שגיאה ובלי שינוי במסך.
// זו אותה מלכודת שכבר מתועדת עבור modal-confirm בתוך closeModal עצמו.
// העטיפה כאן ולא ב-app.js כדי לשמור את השינויים שם מינימליים; ai-center.js
// נטען אחריו, ולכן closeModal כבר מוגדר.
if (typeof closeModal === 'function' && !closeModal._aiPromptAware) {
  const _origCloseModal = closeModal;
  closeModal = function (id) {
    if (id === 'modal-ai-prompt' && window._aiPromptResolve) {
      const r = window._aiPromptResolve;
      window._aiPromptResolve = null;
      r(null);
    }
    return _origCloseModal.apply(this, arguments);
  };
  closeModal._aiPromptAware = true;
}

// תאריכים — מקבילים ל-localDateISO/heToISO ב-app.js, בזמן מקומי ולא UTC
// (ההערה ב-app.js:512 מסבירה למה toISOString שובר תאריכים בישראל בערב).
function aiTodayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function aiAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function aiDisplayDate(iso) {
  const m = String(iso || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '—');
}
/**
 * ימים מאז הפעילות האחרונה בתיק.
 *
 * נופל חזרה ל-c.opened כשאין יומן — בדיוק כמו analyzeCaseload ב-app.js:4556.
 * בלי הנפילה הזו, כל תיק שנפתח היום (saveCase יוצר diary:[] ריק) היה מוחזר
 * כ"לא ידוע", והקורא שמתייחס ל-null כאל "תקוע" היה מסמן תיק בן שעה כתיק
 * ללא פעילות שבועיים — וגם מזין אותו כך לסוכן מנהל המשרד.
 */
function aiIdleDays(c) {
  const diary = Array.isArray(c.diary) ? c.diary : [];
  const parseHe = (v) => {
    const part = String(v || '').split(',')[0].trim();
    const mm = part.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
    return mm ? new Date(Number(mm[3]), Number(mm[2]) - 1, Number(mm[1])).getTime() : 0;
  };
  const times = diary.map(e => parseHe(e.date)).filter(Boolean);
  if (!times.length) {
    const opened = parseHe(c.opened);
    if (!opened) return null;
    return Math.floor((Date.now() - opened) / 86400000);
  }
  // Math.floor ולא Math.round — בדיוק כמו daysSinceHE ב-app.js:507.
  // עם round, רשומת יומן מלפני 13 ימים ו-16 שעות הייתה נספרת כ-14, מה
  // שהיה מסמן את התיק כ"תקוע" יום שלם לפני הזמן — ומציג מספר אחר מזה
  // שאותו מסך עצמו מציג דרך daysSinceHE.
  return Math.floor((Date.now() - Math.max.apply(null, times)) / 86400000);
}

// ============================================================
// שילוב בכרטיסי ה-CRM (סעיף 6)
// ============================================================

/**
 * כפתורי AI בתוך כרטיס תיק. נקרא מ-app.js דרך hook יחיד, כדי לא לפזר
 * שינויים בפונקציות הענק הקיימות.
 */
function AiMatterActions(caseId) {
  const acts = [
    ['נתח את התיק', 'matter-summary-goal'],
    ['סכם מסמכים חדשים', 'docs'],
    ['צור ציר זמן', 'timeline'],
    ['אתר סתירות', 'contradictions'],
    ['אתר מסמכים חסרים', 'missing'],
    ['הכן טיוטת בקשה', 'draft'],
    ['בדוק טיוטה', 'review'],
    ['הכן עדכון ללקוח', 'update'],
    ['הצע משימות המשך', 'tasks'],
    ['בדוק מועדים', 'deadlines'],
  ];
  return `<div class="ai-actions-bar">
    <div class="ai-actions-title">◈ פעולות AI</div>
    ${acts.map(([label, key]) =>
      `<button class="btn btn-sm" onclick="aiMatterAction(${aiJsAttr(caseId)},${aiJsAttr(key)})">${label}</button>`).join('')}
  </div>`;
}

function aiMatterAction(caseId, key) {
  const goals = {
    'matter-summary-goal': ['office-manager', 'נתח את התיק במלואו: מצב נוכחי, מה חסר, מה הסיכונים, ומה הפעולה הבאה'],
    docs: ['document-analysis', 'סכם את המסמכים בתיק שטרם נותחו וחלץ מהם תאריכים, סכומים וצדדים'],
    timeline: ['document-analysis', 'בנה ציר זמן מלא של התיק מכל המקורות הזמינים'],
    contradictions: ['legal-review', 'אתר סתירות בין המסמכים ובין הטענות בתיק'],
    missing: ['document-analysis', 'אתר אילו מסמכים חסרים בתיק ומדוע הם נדרשים'],
    draft: ['legal-drafting', 'הכן טיוטת בקשה מתאימה לשלב הנוכחי של התיק'],
    review: ['legal-review', 'בדוק את הטיוטה האחרונה בתיק כאילו אתה מייצג את הצד שכנגד'],
    update: ['client-service', 'הכן עדכון מצב ללקוח על התיק, בשפה ברורה'],
    tasks: ['office-manager', 'הצע משימות המשך קונקרטיות לתיק, עם מועדי יעד'],
    deadlines: ['deadlines-risk', 'בדוק את כל המועדים בתיק ואתר סיכונים או משימות חסרות'],
  };
  const [agent, goal] = goals[key] || goals['matter-summary-goal'];
  aiRunAgent(agent, goal, { matter_id: caseId });
}

function AiClientActions(clientId) {
  const acts = [
    ['סכם לקוח', 'summary'], ['הכן הודעה', 'message'],
    ['הצג מסמכים חסרים', 'missing'], ['הצע פעולת המשך', 'next'],
    ['הצג סיכונים', 'risks'], ['הפק עדכון ללקוח', 'update'],
  ];
  return `<div class="ai-actions-bar">
    <div class="ai-actions-title">◈ פעולות AI</div>
    ${acts.map(([label, key]) =>
      `<button class="btn btn-sm" onclick="aiClientAction(${aiJsAttr(clientId)},${aiJsAttr(key)})">${label}</button>`).join('')}
  </div>`;
}

function aiClientAction(clientId, key) {
  const goals = {
    summary: ['office-manager', 'סכם את הלקוח: תיקיו, מצבו הכספי, ומה דורש טיפול'],
    message: ['client-service', 'הכן הודעה מוצעת ללקוח'],
    missing: ['matter-opening', 'אילו מסמכים חסרים בתיקים של הלקוח הזה?'],
    next: ['sales-conversion', 'הצע את פעולת ההמשך הנכונה מול הלקוח'],
    risks: ['deadlines-risk', 'אילו סיכונים ומועדים קיימים בתיקים של הלקוח'],
    update: ['client-service', 'הפק עדכון מצב ללקוח על כל תיקיו הפעילים'],
  };
  const [agent, goal] = goals[key] || goals.summary;
  aiRunAgent(agent, goal, { client_id: clientId });
}

/** כפתור AI בודד למסמך — נקרא מרשימת המסמכים. */
function AiDocButton(docId) {
  return `<button class="btn btn-sm" onclick="aiAnalyzeDoc(${aiJsAttr(docId)})" title="ניתוח AI">◈ נתח</button>`;
}
