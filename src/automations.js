// מרכז האוטומציות — הממשק.
//
// נטען אחרי app.js ואחרי ai-center.js, ומשתמש בגלובלים שלהם: notify,
// escapeHtml, customConfirm, aiSb, aiInvoke, aiUpdateChecked, aiJsAttr,
// aiOfficeId, aiFmtDate, aiRelTime. אין כאן העתקה שלהם — פונקציה כפולה
// שמתפצלת בהתנהגות היא בדיוק סוג הבאג שאי אפשר לאתר.
//
// ## מה זה לא
// זה לא מסך תצוגה. כל מתג כאן כותב ל-DB, כל כפתור בדיקה מריץ dry run
// אמיתי בשרת, וכל מספר מגיע משאילתה. סעיף 35 במפרט אוסר כפתורים שאינם
// מחוברים, ובצדק — מסך אוטומציות שנראה עשיר ולא עושה כלום גרוע יותר
// מהיעדרו, כי הוא יוצר אמון שגוי.

let autoTab = 'dashboard';
let autoFilter = { category: '', status: '', severity: '', search: '' };
let autoCatalog = null;   // נטען פעם אחת מהשרת

const AUTO_TABS = [
  { id: 'dashboard',     label: 'סקירה',      icon: '▦' },
  { id: 'rules',         label: 'אוטומציות',  icon: '⚙' },
  { id: 'notifications', label: 'התראות',     icon: '🔔' },
  { id: 'history',       label: 'היסטוריה',   icon: '⏱' },
  { id: 'savings',       label: 'חיסכון',     icon: '₪' },
  { id: 'settings',      label: 'הגדרות',     icon: '⚙' },
];

const SEVERITY_HE = { low: 'נמוכה', normal: 'רגילה', high: 'גבוהה', critical: 'קריטית' };
const LEVEL_HE = {
  notify: 'התראה בלבד',
  prepare: 'הכנה לאישור',
  auto: 'ביצוע אוטומטי',
};
const LEVEL_ICON = { notify: '🔔', prepare: '✋', auto: '⚡' };

// ============================================================

function renderAutomations() {
  const tabsEl = document.getElementById('auto-tabs');
  const host = document.getElementById('auto-body');
  if (!tabsEl || !host) return;

  tabsEl.innerHTML = AUTO_TABS.map(t =>
    `<button class="tab${t.id === autoTab ? ' active' : ''}" onclick="autoNav('${t.id}')">
      ${t.icon} ${escapeHtml(t.label)}
      <span class="ai-tab-count" id="auto-count-${t.id}"></span></button>`).join('');

  host.innerHTML = '<div class="empty">טוען…</div>';

  const fn = {
    dashboard: autoRenderDashboard, rules: autoRenderRules,
    notifications: autoRenderNotifications, history: autoRenderHistory,
    savings: autoRenderSavings, settings: autoRenderSettings,
  }[autoTab];

  Promise.resolve().then(() => fn(host))
    .catch(e => { host.innerHTML = autoError((e && e.message) || String(e), e); });

  autoRefreshBadges();
}

function autoNav(tab) { autoTab = tab; renderAutomations(); }

function autoError(msg, err) {
  const code = err && (err.code || (err.cause && err.cause.code));
  if (code === '42P01' || /relation .* does not exist|could not find the table/i.test(msg || '')) {
    return `<div class="alert alert-warning">
      <strong>מרכז האוטומציות טרם הותקן.</strong>
      <div style="margin-top:6px">יש להריץ את המיגרציות:</div>
      <pre class="ai-payload" style="margin-top:8px">supabase db push</pre>
      <div style="margin-top:8px"><button class="btn btn-sm" onclick="renderAutomations()">↻ בדוק שוב</button></div>
    </div>`;
  }
  if (code === '42501' || /permission denied|row-level security/i.test(msg || '')) {
    return `<div class="alert alert-warning"><strong>אין לך הרשאה לפעולה זו.</strong>
      <div class="ai-muted" style="margin-top:6px">שינוי אוטומציות מותר לבעל המשרד בלבד.</div></div>`;
  }
  return `<div class="alert alert-danger"><strong>שגיאה:</strong> ${escapeHtml(msg)}
    <div style="margin-top:8px"><button class="btn btn-sm" onclick="renderAutomations()">↻ נסה שוב</button></div></div>`;
}

async function autoCatalogLoad() {
  if (autoCatalog) return autoCatalog;
  // הקטלוג מגיע מהקוד ולא מהטבלה: טריגר שאין לו מימוש לא יעבוד גם אם
  // הוא רשום ב-DB, ולהציג אותו כזמין זו הטעיה.
  autoCatalog = await aiInvoke('automation-engine', { action: 'catalog' });
  return autoCatalog;
}

// ============================================================
// סקירה
// ============================================================

async function autoRenderDashboard(host) {
  const officeId = await aiOfficeId();
  const [{ data: stats }, { data: rules, error }] = await Promise.all([
    // שם הפרמטר חייב להיות p_office — כך הוא מוגדר ב-SQL. PostgREST
    // מתאים פונקציה לפי שמות הפרמטרים, ושם שגוי מחזיר 404 ולא שגיאה
    // מובנת, כלומר לוח המחוונים היה פשוט ריק בלי הסבר.
    aiSb().rpc('automation_dashboard', { p_office: officeId }).then(r => r, () => ({ data: null })),
    aiSb().from('automation_rules').select('*').order('is_active', { ascending: false }),
  ]);
  if (error) throw error;

  const s = stats || {};
  const active = (rules || []).filter(r => r.is_active);
  const failing = (rules || []).filter(r => r.failure_count > 0 || r.disabled_reason);

  host.innerHTML = `
    <div class="stats-grid">
      ${Stat('אוטומציות פעילות', active.length, `מתוך ${(rules || []).length}`)}
      ${Stat('פעולות היום', s.actions_today || 0, `${s.runs_today || 0} הפעלות`)}
      ${Stat('ממתין לאישורך', s.pending_approval || 0, 'במרכז האישורים', s.pending_approval > 0)}
      ${Stat('התראות שלא נקראו', s.unread_notifications || 0, '', s.unread_notifications > 0)}
    </div>

    <div class="stats-grid" style="margin-top:12px">
      ${Stat('זמן שנחסך החודש', autoFmtMinutes(s.minutes_saved_month || 0), 'אומדן ניהולי')}
      ${Stat('עלות שנחסכה', '₪' + Math.round(Number(s.cost_saved_month || 0)).toLocaleString('he-IL'), 'אומדן, לא נתון חשבונאי')}
      ${Stat('שיעור הצלחה', s.success_rate == null ? '—' : Math.round(s.success_rate * 100) + '%', '30 יום')}
      ${Stat('כשלים', s.failed_7d || 0, '7 ימים אחרונים', (s.failed_7d || 0) > 0)}
    </div>

    ${failing.length ? `<div class="alert alert-danger" style="margin-top:14px">
      <strong>${failing.length} אוטומציות בבעיה.</strong>
      <ul style="margin:6px 0 0;padding-inline-start:18px">
        ${failing.map(r => `<li>${escapeHtml(r.name)} — ${escapeHtml(r.disabled_reason || `${r.failure_count} כשלים`)}</li>`).join('')}
      </ul></div>` : ''}

    ${!active.length ? `<div class="alert alert-info" style="margin-top:14px">
      <strong>אף אוטומציה אינה פעילה.</strong>
      <div style="margin-top:6px">עבור ללשונית "אוטומציות" והדלק את מה שרלוונטי לך.
      כל אוטומציה מוצגת עם מה בדיוק היא עושה, ואפשר לבדוק אותה לפני ההדלקה.</div>
    </div>` : ''}

    <div class="ai-section-title" style="margin-top:20px">אוטומציות פעילות</div>
    ${active.length
      ? `<table class="data-table"><thead><tr>
          <th>שם</th><th>רמת ביצוע</th><th>הופעלה לאחרונה</th><th>תוצאה</th>
        </tr></thead><tbody>
        ${active.map(r => `<tr>
          <td>${escapeHtml(r.name)}</td>
          <td>${LEVEL_ICON[r.execution_level] || ''} ${LEVEL_HE[r.execution_level] || r.execution_level}</td>
          <td>${r.last_run_at ? aiRelTime(r.last_run_at) : '<span class="ai-muted">טרם רצה</span>'}</td>
          <td class="ai-muted">${escapeHtml(r.last_run_status || '—')}</td>
        </tr>`).join('')}
        </tbody></table>`
      : '<div class="empty">אין אוטומציות פעילות.</div>'}

    ${(s.queue_dead || 0) > 0 ? `<div class="alert alert-warning" style="margin-top:12px">
      ${s.queue_dead} אירועים בתור מיצו את הניסיונות ולא יעובדו שוב.</div>` : ''}`;
}

function Stat(label, value, sub, alert) {
  return `<div class="stat"><div class="stat-label">${escapeHtml(label)}</div>
    <div class="stat-value${alert ? ' ai-attention' : ''}">${escapeHtml(String(value))}</div>
    ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ''}</div>`;
}

function autoFmtMinutes(m) {
  const n = Number(m) || 0;
  if (n < 60) return Math.round(n) + ' דק׳';
  const h = Math.floor(n / 60);
  return h >= 8 ? `${(n / 60).toFixed(1)} שע׳` : `${h}:${String(Math.round(n % 60)).padStart(2, '0')} שע׳`;
}

// ============================================================
// אוטומציות
// ============================================================

async function autoRenderRules(host) {
  const [{ data: rules, error }, { data: templates }, catalog] = await Promise.all([
    aiSb().from('automation_rules').select('*').order('category').order('name'),
    aiSb().from('automation_templates').select('*').order('category').order('name'),
    autoCatalogLoad().catch(() => null),
  ]);
  if (error) throw error;

  const byKey = new Map((rules || []).map(r => [r.template_key, r]));
  const cats = [...new Set([...(rules || []).map(r => r.category || 'general'),
                            ...(templates || []).map(t => t.category)])].filter(Boolean);

  // תבניות שאין להן כלל במשרד — ניתן להוסיף אותן
  const unused = (templates || []).filter(t => !byKey.has(t.key));

  const f = autoFilter;
  const visible = (rules || []).filter(r => {
    if (f.category && (r.category || 'general') !== f.category) return false;
    if (f.status === 'active' && !r.is_active) return false;
    if (f.status === 'inactive' && r.is_active) return false;
    if (f.status === 'failing' && !(r.failure_count > 0 || r.disabled_reason)) return false;
    if (f.severity && r.severity !== f.severity) return false;
    if (f.search && !(`${r.name} ${r.description}`.includes(f.search))) return false;
    return true;
  });

  const grouped = {};
  for (const r of visible) (grouped[r.category || 'general'] ||= []).push(r);

  host.innerHTML = `
    <div class="filters-row" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
      <input class="form-input filter-select" style="max-width:220px" placeholder="חיפוש…"
        value="${escapeHtml(f.search)}" oninput="autoSetFilter('search',this.value)">
      <select class="form-input filter-select" onchange="autoSetFilter('category',this.value)">
        <option value="">כל הקטגוריות</option>
        ${cats.map(c => `<option value="${escapeHtml(c)}" ${f.category === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
      </select>
      <select class="form-input filter-select" onchange="autoSetFilter('status',this.value)">
        <option value="">הכל</option>
        <option value="active" ${f.status === 'active' ? 'selected' : ''}>פעילות</option>
        <option value="inactive" ${f.status === 'inactive' ? 'selected' : ''}>כבויות</option>
        <option value="failing" ${f.status === 'failing' ? 'selected' : ''}>בבעיה</option>
      </select>
      <select class="form-input filter-select" onchange="autoSetFilter('severity',this.value)">
        <option value="">כל רמות החשיבות</option>
        ${Object.entries(SEVERITY_HE).map(([k, v]) =>
          `<option value="${k}" ${f.severity === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      ${(f.category || f.status || f.severity || f.search)
        ? `<button class="btn btn-sm" onclick="autoClearFilters()">נקה סינון</button>` : ''}
    </div>

    ${Object.keys(grouped).length
      ? Object.entries(grouped).map(([cat, list]) => `
        <div class="ai-section-title" style="margin-top:18px">${escapeHtml(cat)} (${list.length})</div>
        ${list.map(r => RuleCard(r, catalog)).join('')}`).join('')
      : '<div class="empty">אין אוטומציות שתואמות את הסינון.</div>'}

    ${unused.length ? `
      <div class="ai-section-title" style="margin-top:26px">תבניות שניתן להוסיף (${unused.length})</div>
      ${unused.map(t => TemplateCard(t)).join('')}` : ''}`;
}

function autoSetFilter(k, v) { autoFilter[k] = v; renderAutomations(); }
function autoClearFilters() { autoFilter = { category: '', status: '', severity: '', search: '' }; renderAutomations(); }

function RuleCard(r, catalog) {
  const blocked = !!r.disabled_reason;
  const trig = catalog && catalog.triggers.find(t => t.type === r.trigger_type);
  const acts = Array.isArray(r.actions) ? r.actions : [];
  const paused = r.paused_until && Date.parse(r.paused_until) > Date.now();

  return `<div class="card ai-approval" id="rule-${r.id}"
      style="border-right-color:${r.is_active ? 'var(--success)' : 'var(--border2)'}">
    <div class="ai-approval-head">
      <div style="flex:1">
        <div class="ai-approval-title">${escapeHtml(r.name)}</div>
        <div class="ai-approval-sub">
          <span class="badge badge-${r.is_active ? 'active' : 'closed'}">${r.is_active ? '✓ פעילה' : '⊘ כבויה'}</span>
          <span class="badge badge-pending">${LEVEL_ICON[r.execution_level] || ''} ${LEVEL_HE[r.execution_level] || r.execution_level}</span>
          · חשיבות ${SEVERITY_HE[r.severity] || r.severity}
          ${paused ? ` · <span class="ai-attention">מושהית עד ${aiFmtDate(r.paused_until)}</span>` : ''}
        </div>
      </div>
      <label class="ai-switch" title="${r.is_active ? 'כבה' : 'הדלק'}">
        <input type="checkbox" ${r.is_active ? 'checked' : ''} ${blocked ? 'disabled' : ''}
          onchange="autoToggleRule(${aiJsAttr(r.id)},this.checked)">
        <span></span>
      </label>
    </div>

    <div class="ai-muted" style="margin-top:6px;font-size:12.5px">${escapeHtml(r.description || '')}</div>

    ${blocked ? `<div class="alert alert-danger" style="margin-top:8px">
      <strong>הושבתה אוטומטית.</strong> ${escapeHtml(r.disabled_reason)}
      <div style="margin-top:6px"><button class="btn btn-sm" onclick="autoClearFailure(${aiJsAttr(r.id)})">אפס ונסה שוב</button></div>
    </div>` : ''}

    <div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;font-size:12px" class="ai-muted">
      <span>טריגר: <strong>${escapeHtml(trig ? trig.label : r.trigger_type)}</strong></span>
      <span>הופעלה: <strong>${r.run_count || 0}</strong> פעמים</span>
      <span>אחרון: ${r.last_run_at ? aiRelTime(r.last_run_at) : 'טרם'}</span>
      <span>חיסכון מוערך: <strong>${r.estimated_minutes_saved || 0}</strong> דק׳ לפעולה</span>
    </div>

    <div style="margin-top:8px;font-size:12px">
      <span class="ai-muted">פעולות:</span>
      ${acts.length
        ? acts.map(a => `<span class="badge badge-pending" style="margin-inline-start:4px">${escapeHtml(autoActionLabel(a, catalog))}</span>`).join('')
        : '<span class="ai-muted">אין</span>'}
    </div>

    ${r.last_run_status ? `<div class="ai-muted" style="margin-top:6px;font-size:11.5px">
      תוצאה אחרונה: ${escapeHtml(r.last_run_status)}</div>` : ''}

    <div class="ai-approval-actions">
      <button class="btn btn-sm" onclick="autoDryRun(${aiJsAttr(r.id)})">🔍 בדיקה ללא ביצוע</button>
      <button class="btn btn-sm" onclick="autoOpenSettings(${aiJsAttr(r.id)})">⚙ הגדרות</button>
      <button class="btn btn-sm" onclick="autoShowHistory(${aiJsAttr(r.id)})">⏱ היסטוריה</button>
      <button class="btn btn-sm" onclick="autoDuplicate(${aiJsAttr(r.id)})">⧉ שכפול</button>
      ${r.is_active ? `<button class="btn btn-sm" onclick="autoPauseRule(${aiJsAttr(r.id)})">⏸ השהה ל-24 שעות</button>` : ''}
      ${r.is_active ? `<button class="btn btn-sm btn-primary" onclick="autoRunNow(${aiJsAttr(r.id)})">▶ הרץ עכשיו</button>` : ''}
    </div>
  </div>`;
}

function autoActionLabel(a, catalog) {
  const def = catalog && catalog.actions.find(x => x.type === a.type);
  return def ? def.label : (a.type || 'לא מוגדר');
}

function TemplateCard(t) {
  const missing = Array.isArray(t.requires) ? t.requires : [];
  return `<div class="card" style="border-right:3px solid var(--border2);opacity:${missing.length ? 0.72 : 1}">
    <div class="ai-approval-head">
      <div>
        <div class="ai-approval-title">${escapeHtml(t.name)}</div>
        <div class="ai-approval-sub">${escapeHtml(t.category)} · חיסכון מוערך ${t.estimated_minutes_saved} דק׳</div>
      </div>
      ${missing.length
        ? `<span class="badge badge-closed" title="${escapeHtml(missing.join(', '))}">דורש הרחבה</span>`
        : `<button class="btn btn-sm btn-primary" onclick="autoAddTemplate(${aiJsAttr(t.key)})">+ הוסף</button>`}
    </div>
    <div class="ai-muted" style="margin-top:6px;font-size:12.5px">${escapeHtml(t.description)}</div>
    ${missing.length ? `<div class="alert alert-warning" style="margin-top:8px;font-size:12px">
      <strong>לא ניתן להפעיל.</strong> התבנית דורשת נתונים שאינם קיימים במערכת:
      <code>${escapeHtml(missing.join(', '))}</code>.
      היא נשמרת כאן כדי שתעבוד מיד כשהם יתווספו.
    </div>` : ''}
  </div>`;
}

// ---------- פעולות על כלל ----------

async function autoToggleRule(id, on) {
  try {
    await aiUpdateChecked('automation_rules', { is_active: on },
      q => q.eq('id', id), AI_OWNER_ONLY);
    notify(on
      ? 'האוטומציה הודלקה. אירועים שקדמו לרגע זה לא ייחשבו.'
      : 'האוטומציה כובתה.');
  } catch (e) {
    notify('שגיאה: ' + e.message);
  }
  renderAutomations();
}

async function autoClearFailure(id) {
  try {
    await aiUpdateChecked('automation_rules',
      { failure_count: 0, disabled_reason: null }, q => q.eq('id', id), AI_OWNER_ONLY);
    notify('הכלל אופס. ניתן להדליק אותו שוב.');
  } catch (e) { notify('שגיאה: ' + e.message); }
  renderAutomations();
}

async function autoPauseRule(id) {
  const until = new Date(Date.now() + 86400000).toISOString();
  try {
    await aiUpdateChecked('automation_rules', { paused_until: until },
      q => q.eq('id', id), AI_OWNER_ONLY);
    notify('הושהתה ל-24 שעות. ההגדרות נשמרו.');
  } catch (e) { notify('שגיאה: ' + e.message); }
  renderAutomations();
}

async function autoRunNow(id) {
  const ok = await customConfirm(
    'להריץ את האוטומציה עכשיו?\n\nפעולות יבוצעו בפועל לפי רמת הביצוע שהוגדרה. ' +
    'אם אתה רק רוצה לראות מה היה קורה — השתמש ב"בדיקה ללא ביצוע".',
    { title: 'הרצה מיידית', okText: 'הרץ' });
  if (!ok) return;
  notify('מריץ…');
  try {
    const r = await aiInvoke('automation-engine', { action: 'run_now', rule_id: id });
    notify(`נבדקו ${r.matched} פריטים, בוצעו ${r.processed}${r.error ? ' — ' + r.error : ''}`);
  } catch (e) { notify('שגיאה: ' + e.message); }
  renderAutomations();
}

async function autoDuplicate(id) {
  const { data: r, error } = await aiSb().from('automation_rules').select('*').eq('id', id).single();
  if (error) { notify('שגיאה: ' + error.message); return; }
  const officeId = await aiOfficeId();
  // ⚠ העתק נכנס תמיד כבוי. שכפול שמדליק מעצמו היה מכפיל בשקט את כמות
  // ההתראות ברגע שנוצר.
  const copy = {
    office_id: officeId, name: r.name + ' (עותק)', description: r.description,
    trigger_type: r.trigger_type, trigger_config: r.trigger_config,
    conditions: r.conditions, actions: r.actions,
    is_active: false, requires_approval: r.requires_approval,
    execution_level: r.execution_level, severity: r.severity, category: r.category,
    cooldown_minutes: r.cooldown_minutes, template_key: r.template_key,
    estimated_minutes_saved: r.estimated_minutes_saved,
    max_actions_per_run: r.max_actions_per_run,
  };
  const { error: insErr } = await aiSb().from('automation_rules').insert(copy);
  if (insErr) notify('שגיאה: ' + insErr.message);
  else notify('שוכפלה. העותק כבוי — הדלק אותו אחרי שתערוך.');
  renderAutomations();
}

async function autoAddTemplate(key) {
  const { data: t, error } = await aiSb().from('automation_templates').select('*').eq('key', key).single();
  if (error) { notify('שגיאה: ' + error.message); return; }
  const officeId = await aiOfficeId();
  const { error: insErr } = await aiSb().from('automation_rules').insert({
    office_id: officeId, template_key: t.key, name: t.name, description: t.description,
    trigger_type: t.trigger_type, trigger_config: t.default_trigger_config,
    conditions: t.default_conditions, actions: t.default_actions,
    is_active: false, requires_approval: t.default_execution_level === 'prepare',
    execution_level: t.default_execution_level, severity: t.default_severity,
    category: t.category, cooldown_minutes: t.default_cooldown_minutes,
    estimated_minutes_saved: t.estimated_minutes_saved,
  });
  if (insErr) notify('שגיאה: ' + insErr.message);
  else notify('נוספה כבויה. בדוק אותה לפני ההדלקה.');
  renderAutomations();
}

// ---------- בדיקה ללא ביצוע ----------

async function autoDryRun(id) {
  openModal('modal-auto-dry');
  const body = document.getElementById('auto-dry-body');
  body.innerHTML = '<div class="empty">בודק…</div>';
  try {
    const r = await aiInvoke('automation-engine', { action: 'dry_run', rule_id: id });
    body.innerHTML = `
      <div class="alert alert-info">
        <strong>זו בדיקה בלבד — שום פעולה לא בוצעה.</strong>
      </div>
      <div class="stats-grid" style="margin-top:12px">
        ${Stat('נסרקו', r.scanned, 'פריטים')}
        ${Stat('תואמים לתנאים', r.matched, '')}
        ${Stat('היו מטופלים כעת', r.capped, `תקרה ${r.cap} להרצה`)}
      </div>
      ${r.note ? `<div class="alert alert-warning" style="margin-top:10px">${escapeHtml(r.note)}</div>` : ''}
      ${r.items.length ? r.items.map(it => `
        <div class="card" style="margin-top:10px">
          <div class="ai-approval-title">${escapeHtml(it.label)}</div>
          <div class="ai-learn-lesson">${escapeHtml(it.reason)}</div>
          <div style="margin-top:8px"><span class="ai-muted">מה היה קורה:</span>
            <ul style="margin:6px 0 0;padding-inline-start:18px;font-size:12.5px">
              ${it.actions.map(a => `<li>
                <strong>${escapeHtml(a.label || a.action)}</strong> — ${escapeHtml(a.description || '')}
                ${a.downgraded ? '<br><span class="ai-attention">⚠ פעולה רגישה: תרד אוטומטית ל"הכנה לאישור" גם אם הוגדר ביצוע אוטומטי.</span>' : ''}
              </li>`).join('')}
            </ul>
          </div>
        </div>`).join('')
        : '<div class="empty" style="margin-top:12px">אף פריט אינו תואם כרגע. האוטומציה לא תעשה כלום.</div>'}`;
  } catch (e) {
    body.innerHTML = autoError(e.message, e);
  }
}

// ---------- הגדרות כלל ----------

async function autoOpenSettings(id) {
  const [{ data: r, error }, catalog] = await Promise.all([
    aiSb().from('automation_rules').select('*').eq('id', id).single(),
    autoCatalogLoad().catch(() => null),
  ]);
  if (error) { notify('שגיאה: ' + error.message); return; }

  const cfg = r.trigger_config || {};
  const q = r.quiet_hours || {};
  openModal('modal-auto-settings');
  document.getElementById('auto-settings-title').textContent = r.name;
  document.getElementById('auto-settings-body').innerHTML = `
    <input type="hidden" id="as-id" value="${escapeHtml(r.id)}">

    <div class="form-group"><label class="form-label">שם</label>
      <input class="form-input" id="as-name" value="${escapeHtml(r.name)}"></div>

    <div class="form-group"><label class="form-label">תיאור</label>
      <textarea class="form-input" id="as-desc" rows="2">${escapeHtml(r.description || '')}</textarea></div>

    <div class="form-group">
      <label class="form-label">רמת ביצוע</label>
      <select class="form-input" id="as-level">
        ${Object.entries(LEVEL_HE).map(([k, v]) =>
          `<option value="${k}" ${r.execution_level === k ? 'selected' : ''}>${LEVEL_ICON[k]} ${v}</option>`).join('')}
      </select>
      <div class="ai-muted" style="margin-top:4px;font-size:11.5px">
        פעולות רגישות — מסמכים משפטיים, כספים, הודעות יוצאות — יורדות אוטומטית
        ל"הכנה לאישור" גם אם תבחר ביצוע אוטומטי. זו מגבלה בקוד ואי אפשר לעקוף אותה מכאן.
      </div>
    </div>

    <div class="form-row">
      <div class="form-group"><label class="form-label">רמת חשיבות</label>
        <select class="form-input" id="as-sev">
          ${Object.entries(SEVERITY_HE).map(([k, v]) =>
            `<option value="${k}" ${r.severity === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
      <div class="form-group"><label class="form-label">מקסימום פעולות בהרצה</label>
        <input class="form-input" type="number" min="1" max="100" id="as-cap"
          value="${Number(r.max_actions_per_run) || 10}"></div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">תקופת צינון (דקות)</label>
        <input class="form-input" type="number" min="0" id="as-cooldown" value="${Number(r.cooldown_minutes) || 0}">
        <div class="ai-muted" style="font-size:11.5px;margin-top:4px">
          אותו פריט לא יטופל שוב לפני שיעברו כך וכך דקות. 1440 = פעם ביום.
        </div>
      </div>
      <div class="form-group"><label class="form-label">דקות שנחסכות לפעולה</label>
        <input class="form-input" type="number" min="0" id="as-minutes"
          value="${Number(r.estimated_minutes_saved) || 0}"></div>
    </div>

    ${autoTriggerFields(r.trigger_type, cfg, catalog)}

    <div class="ai-section-title" style="margin-top:14px">שעות שקטות</div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">מ־</label>
        <input class="form-input" type="time" id="as-quiet-from" value="${escapeHtml(q.from || '')}"></div>
      <div class="form-group"><label class="form-label">עד</label>
        <input class="form-input" type="time" id="as-quiet-to" value="${escapeHtml(q.to || '')}"></div>
    </div>
    <label class="ai-switch"><input type="checkbox" id="as-quiet-weekend"
      ${Array.isArray(q.days) && q.days.includes(6) ? 'checked' : ''}>
      <span>לא להפעיל בשישי ושבת</span></label>

    <div style="margin-top:16px;display:flex;gap:8px">
      <button class="btn btn-primary" onclick="autoSaveSettings()">שמור</button>
      <button class="btn" onclick="closeModal('modal-auto-settings')">ביטול</button>
    </div>`;
}

/** שדות הטריגר — משתנים לפי סוג, כי לכל טריגר פרמטרים אחרים. */
function autoTriggerFields(type, cfg, catalog) {
  const trig = catalog && catalog.triggers.find(t => t.type === type);
  const head = `<div class="ai-section-title" style="margin-top:14px">תנאי הפעלה</div>
    ${trig ? `<div class="ai-muted" style="font-size:12px;margin-bottom:8px">${escapeHtml(trig.description)}</div>` : ''}`;

  const numField = (id, label, val, hint) =>
    `<div class="form-group"><label class="form-label">${label}</label>
      <input class="form-input" type="number" min="0" id="${id}" value="${Number(val) || 0}">
      ${hint ? `<div class="ai-muted" style="font-size:11.5px;margin-top:4px">${hint}</div>` : ''}</div>`;

  if (['matter_inactive', 'client_no_update', 'matter_stuck_in_stage'].includes(type))
    return head + numField('as-cfg-days', 'אחרי כמה ימים ללא פעילות', cfg.days ?? 14);
  if (['event_approaching', 'event_without_prep_task', 'task_due_soon'].includes(type))
    return head + numField('as-cfg-days', 'כמה ימים מראש', cfg.days ?? 7);
  if (type === 'task_overdue')
    return head + numField('as-cfg-min_days_late', 'מינימום ימי איחור', cfg.min_days_late ?? 1);
  if (type === 'matter_incomplete')
    return head + numField('as-cfg-opened_within_days', 'תיקים שנפתחו בתוך כמה ימים', cfg.opened_within_days ?? 30,
      'מגביל לתיקים חדשים כדי לא להציף בהתראות על תיקים ישנים.');
  if (type === 'thread_no_reply')
    return head + numField('as-cfg-hours', 'אחרי כמה שעות ללא מענה', cfg.hours ?? 4);
  if (type === 'daily_digest')
    return head + numField('as-cfg-hour', 'שעה (0-23)', cfg.hour ?? 8);
  if (type === 'event_passed_unmarked')
    return head + numField('as-cfg-grace_days', 'ימי חסד אחרי המועד', cfg.grace_days ?? 1);
  return head + '<div class="ai-muted">לטריגר זה אין פרמטרים להגדרה.</div>';
}

async function autoSaveSettings() {
  const id = document.getElementById('as-id').value;
  const g = (x) => document.getElementById(x);

  const cfg = {};
  for (const el of document.querySelectorAll('[id^="as-cfg-"]')) {
    cfg[el.id.replace('as-cfg-', '')] = Number(el.value) || 0;
  }

  const from = g('as-quiet-from').value, to = g('as-quiet-to').value;
  const weekend = g('as-quiet-weekend').checked;
  const quiet = (from && to) || weekend
    ? { ...(from && to ? { from, to } : {}), ...(weekend ? { days: [5, 6] } : {}) }
    : null;

  // ⚠ קריאה לפני כתיבה רק בשביל הגרסה.
  //
  // `version: undefined` פשוט נעלם בסריאליזציה ל-JSON, כלומר הגרסה לא
  // הייתה מתקדמת אף פעם — ואז ההיסטוריה מציגה rule_version זהה לכל
  // ההרצות ואי אפשר לדעת לפי איזו הגדרה כל אחת רצה. סעיף 35 דורש
  // גרסאות, וזה מה שנותן להן משמעות.
  const { data: cur } = await aiSb().from('automation_rules').select('version').eq('id', id).maybeSingle();

  try {
    await aiUpdateChecked('automation_rules', {
      version: (Number(cur?.version) || 1) + 1,
      name: g('as-name').value.trim() || 'ללא שם',
      description: g('as-desc').value.trim(),
      execution_level: g('as-level').value,
      severity: g('as-sev').value,
      max_actions_per_run: Math.max(1, Number(g('as-cap').value) || 10),
      cooldown_minutes: Math.max(0, Number(g('as-cooldown').value) || 0),
      estimated_minutes_saved: Math.max(0, Number(g('as-minutes').value) || 0),
      trigger_config: cfg,
      quiet_hours: quiet,
    }, q => q.eq('id', id), AI_OWNER_ONLY);
    notify('ההגדרות נשמרו');
    closeModal('modal-auto-settings');
  } catch (e) {
    notify('שגיאה: ' + e.message);
  }
  renderAutomations();
}

// ============================================================
// התראות
// ============================================================

async function autoRenderNotifications(host) {
  const { data, error } = await aiSb().from('automation_notifications')
    .select('*').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;

  const unread = (data || []).filter(n => !n.read_at);
  const LEVEL = {
    info: ['badge-active', 'ℹ'], warning: ['badge-pending', '⚠'],
    urgent: ['badge-urgent', '🔴'], escalation: ['badge-urgent', '⬆'],
  };

  host.innerHTML = `
    ${unread.length ? `<div style="margin-bottom:12px">
      <button class="btn btn-sm" onclick="autoMarkAllRead()">סמן הכל כנקרא (${unread.length})</button>
    </div>` : ''}
    ${(data || []).length
      ? (data || []).map(n => {
          const [cls, icon] = LEVEL[n.level] || LEVEL.info;
          return `<div class="card" style="opacity:${n.read_at ? 0.6 : 1};border-right:3px solid ${
            n.level === 'urgent' || n.level === 'escalation' ? 'var(--danger)'
            : n.level === 'warning' ? 'var(--warning)' : 'var(--accent2)'}">
            <div class="ai-approval-head">
              <div>
                <div class="ai-approval-title">${icon} ${escapeHtml(n.title)}</div>
                <div class="ai-approval-sub">
                  <span class="badge ${cls}">${escapeHtml(n.level)}</span> · ${aiRelTime(n.created_at)}
                </div>
              </div>
              <div style="display:flex;gap:6px">
                ${n.link ? `<button class="btn btn-sm" onclick="autoOpenLink(${aiJsAttr(JSON.stringify(n.link))})">פתח</button>` : ''}
                ${!n.read_at ? `<button class="btn btn-sm" onclick="autoMarkRead(${aiJsAttr(n.id)})">✓</button>` : ''}
              </div>
            </div>
            ${n.body ? `<div class="ai-muted" style="margin-top:6px;font-size:12.5px">${escapeHtml(n.body)}</div>` : ''}
          </div>`;
        }).join('')
      : '<div class="empty">אין התראות. ברגע שאוטומציה תזהה משהו, זה יופיע כאן.</div>'}`;
}

async function autoMarkRead(id) {
  const { data: u } = await aiSb().auth.getUser();
  await aiSb().from('automation_notifications')
    .update({ read_at: new Date().toISOString(), read_by: u?.user?.id || null }).eq('id', id);
  renderAutomations();
}

async function autoMarkAllRead() {
  const { data: u } = await aiSb().auth.getUser();
  await aiSb().from('automation_notifications')
    .update({ read_at: new Date().toISOString(), read_by: u?.user?.id || null })
    .is('read_at', null);
  notify('סומן הכל כנקרא');
  renderAutomations();
}

function autoOpenLink(json) {
  let l; try { l = JSON.parse(json); } catch { return; }
  if (l.type === 'case' && typeof openCaseDetail === 'function') openCaseDetail(l.id);
  else if (l.type === 'client' && typeof openClientDetail === 'function') openClientDetail(l.id);
}

// ============================================================
// היסטוריה
// ============================================================

async function autoRenderHistory(host, ruleId) {
  let q = aiSb().from('automation_runs')
    .select('*, automation_rules(name)').order('started_at', { ascending: false }).limit(80);
  if (ruleId) q = q.eq('automation_rule_id', ruleId);
  const { data, error } = await q;
  if (error) throw error;

  const STATUS = {
    completed: ['badge-active', '✓ הושלם'], partial: ['badge-pending', '◐ חלקי'],
    failed: ['badge-urgent', '✕ נכשל'], skipped: ['badge-closed', '⊘ דולג'],
    running: ['badge-pending', '⏳ רץ'], dry_run: ['badge-closed', '🔍 בדיקה'],
  };

  host.innerHTML = `
    ${ruleId ? `<button class="btn btn-sm" onclick="autoNav('history')">← כל ההיסטוריה</button>` : ''}
    ${(data || []).length
      ? (data || []).map(r => {
          const [cls, label] = STATUS[r.status] || ['badge-closed', r.status];
          return `<div class="card">
            <div class="ai-approval-head">
              <div>
                <div class="ai-approval-title">${escapeHtml(r.automation_rules?.name || 'אוטומציה שנמחקה')}</div>
                <div class="ai-approval-sub">
                  <span class="badge ${cls}">${label}</span>
                  · ${aiRelTime(r.started_at)}
                  ${r.duration_ms ? ` · ${r.duration_ms}ms` : ''}
                  ${r.actions_completed ? ` · ${r.actions_completed} פעולות` : ''}
                  ${r.actions_failed ? ` · <span class="ai-attention">${r.actions_failed} כשלים</span>` : ''}
                </div>
              </div>
              <button class="btn btn-sm" onclick="autoShowRun(${aiJsAttr(r.id)})">פרטים</button>
            </div>
            ${r.reason ? `<div class="ai-learn-lesson">${escapeHtml(r.reason)}</div>` : ''}
            ${r.error_message ? `<div class="alert alert-danger" style="margin-top:8px">${escapeHtml(r.error_message)}</div>` : ''}
          </div>`;
        }).join('')
      : '<div class="empty">אין הפעלות עדיין.</div>'}`;
}

function autoShowHistory(ruleId) {
  autoTab = 'history';
  const tabsEl = document.getElementById('auto-tabs');
  const host = document.getElementById('auto-body');
  tabsEl.innerHTML = AUTO_TABS.map(t =>
    `<button class="tab${t.id === 'history' ? ' active' : ''}" onclick="autoNav('${t.id}')">${t.icon} ${escapeHtml(t.label)}</button>`).join('');
  autoRenderHistory(host, ruleId).catch(e => { host.innerHTML = autoError(e.message, e); });
}

async function autoShowRun(id) {
  const [{ data: run }, { data: logs }] = await Promise.all([
    aiSb().from('automation_runs').select('*').eq('id', id).single(),
    aiSb().from('automation_action_logs').select('*').eq('automation_run_id', id).order('action_index'),
  ]);
  if (!run) return;

  openModal('modal-auto-dry');
  document.getElementById('auto-dry-body').innerHTML = `
    <div class="ai-section-title">למה זה הופעל</div>
    <div class="ai-learn-lesson">${escapeHtml(run.reason || 'לא נשמר הסבר.')}</div>

    <div class="ai-section-title" style="margin-top:14px">פעולות (${(logs || []).length})</div>
    ${(logs || []).length ? (logs || []).map(l => `
      <div class="ai-approval-mini">
        <span class="badge badge-${l.status === 'executed' ? 'active' : l.status === 'failed' ? 'urgent' : 'pending'}">${escapeHtml(l.status)}</span>
        <strong>${escapeHtml(l.action_type)}</strong>
        <span class="ai-muted">${escapeHtml((l.result && l.result.message) || l.error || '')}</span>
      </div>`).join('') : '<div class="empty">לא בוצעו פעולות.</div>'}

    <details style="margin-top:14px">
      <summary class="ai-muted">התנאים שנבדקו</summary>
      <pre class="ai-payload">${escapeHtml(JSON.stringify(run.conditions_checked, null, 2).slice(0, 4000))}</pre>
    </details>
    <div class="ai-muted" style="margin-top:10px;font-size:11.5px">
      חיסכון מוערך בהרצה זו: ${run.estimated_minutes_saved} דק׳ · ₪${Math.round(Number(run.estimated_cost_saved) || 0)}
    </div>`;
}

// ============================================================
// חיסכון
// ============================================================

async function autoRenderSavings(host) {
  const [{ data: metrics, error }, { data: rules }, { data: settings }] = await Promise.all([
    aiSb().from('automation_metrics').select('*').order('period', { ascending: false }).limit(400),
    aiSb().from('automation_rules').select('id, name'),
    aiSb().from('ai_settings').select('hourly_cost_secretary, hourly_cost_intern, hourly_cost_lawyer').maybeSingle(),
  ]);
  if (error) throw error;

  const nameOf = id => (rules || []).find(r => r.id === id)?.name || 'אוטומציה שנמחקה';
  const byRule = {};
  for (const m of metrics || []) {
    const k = m.automation_rule_id || 'null';
    byRule[k] ||= { runs: 0, actions: 0, minutes: 0, cost: 0, fails: 0 };
    byRule[k].runs += m.run_count; byRule[k].actions += m.actions_executed;
    byRule[k].minutes += Number(m.minutes_saved); byRule[k].cost += Number(m.estimated_cost_saved);
    byRule[k].fails += m.failure_count;
  }
  const rows = Object.entries(byRule).sort((a, b) => b[1].minutes - a[1].minutes);
  const tot = rows.reduce((a, [, v]) => ({
    runs: a.runs + v.runs, actions: a.actions + v.actions,
    minutes: a.minutes + v.minutes, cost: a.cost + v.cost,
  }), { runs: 0, actions: 0, minutes: 0, cost: 0 });

  const st = settings || {};
  host.innerHTML = `
    <div class="alert alert-warning">
      <strong>הנתונים כאן הם אומדן ניהולי ולא נתון חשבונאי מחייב.</strong>
      החישוב: מספר הפעולות שבוצעו × הזמן המוערך לפעולה × עלות שעת עבודה.
      אפשר לשנות את שני האחרונים בהגדרות.
    </div>

    <div class="stats-grid" style="margin-top:14px">
      ${Stat('סה״כ זמן שנחסך', autoFmtMinutes(tot.minutes), '')}
      ${Stat('עלות מוערכת', '₪' + Math.round(tot.cost).toLocaleString('he-IL'), `לפי ₪${st.hourly_cost_secretary || 60} לשעה`)}
      ${Stat('פעולות שבוצעו', tot.actions, `ב-${tot.runs} הפעלות`)}
    </div>

    <div class="ai-section-title" style="margin-top:20px">פירוט לפי אוטומציה</div>
    ${rows.length
      ? `<table class="data-table"><thead><tr>
          <th>אוטומציה</th><th>הפעלות</th><th>פעולות</th><th>זמן</th><th>עלות</th><th>כשלים</th>
        </tr></thead><tbody>
        ${rows.map(([id, v]) => `<tr>
          <td>${escapeHtml(nameOf(id))}</td><td>${v.runs}</td><td>${v.actions}</td>
          <td>${autoFmtMinutes(v.minutes)}</td>
          <td>₪${Math.round(v.cost).toLocaleString('he-IL')}</td>
          <td>${v.fails ? `<span class="ai-attention">${v.fails}</span>` : '0'}</td>
        </tr>`).join('')}</tbody></table>`
      : '<div class="empty">אין נתונים עדיין. הנתונים נצברים מרגע שאוטומציה מבצעת פעולה.</div>'}`;
}

// ============================================================
// הגדרות
// ============================================================

async function autoRenderSettings(host) {
  const { data: s, error } = await aiSb().from('ai_settings').select('*').maybeSingle();
  if (error) throw error;
  const st = s || {};

  host.innerHTML = `
    <div class="card ai-emergency">
      <div class="card-title">⏸ השהיית מנוע האוטומציות</div>
      <p class="ai-muted">
        עוצר את כל האוטומציות הדטרמיניסטיות. <strong>נפרד</strong> מהשהיית הסוכנים:
        אפשר להשאיר התראות פעילות בזמן שהסוכנים כבויים מסיבות עלות.
      </p>
      <button class="btn ${st.automation_engine_paused ? 'btn-success' : 'btn-danger'}"
        onclick="autoTogglePause(${!st.automation_engine_paused})">
        ${st.automation_engine_paused ? '▶ הפעל מחדש' : '⏸ השהה את כל האוטומציות'}
      </button>
      ${st.automation_engine_paused
        ? '<div class="alert alert-danger" style="margin-top:10px">המנוע מושהה. שום אוטומציה לא רצה.</div>' : ''}
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">עלות שעת עבודה</div>
      <p class="ai-muted">משמשת לחישוב החיסכון המוערך בלבד. אינה משפיעה על שום פעולה.</p>
      <div class="form-row">
        <div class="form-group"><label class="form-label">מזכירות (₪)</label>
          <input class="form-input" type="number" min="0" id="au-cost-sec" value="${st.hourly_cost_secretary ?? 60}"></div>
        <div class="form-group"><label class="form-label">מתמחה (₪)</label>
          <input class="form-input" type="number" min="0" id="au-cost-int" value="${st.hourly_cost_intern ?? 90}"></div>
        <div class="form-group"><label class="form-label">עורך דין (₪)</label>
          <input class="form-input" type="number" min="0" id="au-cost-law" value="${st.hourly_cost_lawyer ?? 350}"></div>
      </div>
      <button class="btn btn-primary" onclick="autoSaveCosts()">שמור</button>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">אזור זמן</div>
      <p class="ai-muted">כל התזמונים, שעות השקט וחישובי הימים מתבצעים לפי אזור זה.</p>
      <div class="form-group"><input class="form-input" id="au-tz" value="${escapeHtml(st.timezone || 'Asia/Jerusalem')}"></div>
    </div>`;
}

async function autoTogglePause(on) {
  const officeId = await aiOfficeId();
  const target = typeof on === 'boolean' ? on : true;
  if (target) {
    const ok = await customConfirm('להשהות את כל האוטומציות?\n\nההגדרות נשמרות, שום אוטומציה לא תרוץ עד שתפעיל מחדש.',
      { title: 'השהיית המנוע', okText: 'השהה', danger: true });
    if (!ok) return;
  }
  try {
    await aiUpdateChecked('ai_settings', { automation_engine_paused: target },
      q => q.eq('office_id', officeId), AI_OWNER_ONLY);
    notify(target ? '⏸ כל האוטומציות הושהו' : '▶ המנוע הופעל מחדש');
  } catch (e) { notify('שגיאה: ' + e.message); }
  renderAutomations();
}

async function autoSaveCosts() {
  const officeId = await aiOfficeId();
  try {
    await aiUpdateChecked('ai_settings', {
      hourly_cost_secretary: Number(document.getElementById('au-cost-sec').value) || 0,
      hourly_cost_intern: Number(document.getElementById('au-cost-int').value) || 0,
      hourly_cost_lawyer: Number(document.getElementById('au-cost-law').value) || 0,
      timezone: document.getElementById('au-tz').value.trim() || 'Asia/Jerusalem',
    }, q => q.eq('office_id', officeId), AI_OWNER_ONLY);
    notify('נשמר');
  } catch (e) { notify('שגיאה: ' + e.message); }
}

// ============================================================
// מונים
// ============================================================

async function autoRefreshBadges() {
  try {
    const [{ count: unread }, { count: failing }] = await Promise.all([
      aiSb().from('automation_notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
      aiSb().from('automation_runs').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
    ]);
    const set = (id, n) => {
      const el = document.getElementById('auto-count-' + id);
      if (el) { el.textContent = n ? String(n) : ''; el.style.display = n ? '' : 'none'; }
    };
    set('notifications', unread || 0);
    set('history', failing || 0);
    const badge = document.getElementById('auto-nav-badge');
    if (badge) {
      badge.textContent = unread || '';
      badge.style.display = unread ? '' : 'none';
    }
  } catch (e) { /* מונה שלא התעדכן אינו סיבה לשבור מסך */ }
}
