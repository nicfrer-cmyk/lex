// צוות ה-AI — הממשק: הצוות, התוצרים, הגדרות וחיבורים, ומסך "מתקדם".
//
// נטען אחרי ai-center.js ומשתמש בגלובלים שלו (aiSb, aiInvoke, aiUpdateChecked,
// aiRunAgent, aiOfficeId, aiRelTime, aiFmtDate, aiJsAttr, StatusChip,
// aiCommandBarHtml, aiOpenAgentDetail, aiToggleAgent, IntegrationCard,
// aiToggleEmergency, aiSaveToggle, AI_OWNER_ONLY, AI_APPROVER_ONLY) ושל app.js
// (db, notify, escapeHtml, customConfirm, openModal, closeModal).
//
// ## העיקרון
// הצוות עובד לבד, לפי לוח, ומייצר **טיוטות**. בעל המשרד רואה אותן במקום
// אחד ("תוצרים"), מאשר, מעתיק או מסמן כפורסם. שום דבר לא יוצא מהמשרד בלי
// לחיצה שלו. זה לא עניין של UX אלא של אחריות מקצועית: כל מילה שיוצאת בשם
// המשרד היא בשם עורך הדין.

'use strict';

const AI_WORK_KIND_HE = {
  post: 'פוסט', reel_script: 'סקריפט לרילס', article: 'מאמר', newsletter: 'ביטאון', campaign: 'תוכנית תוכן',
  ad_copy: 'טקסט למודעה', email_template: 'תבנית מייל', lead_followup: 'מעקב לידים', brief: 'סקירה משפטית',
  report: 'דוח', idea: 'רעיון',
};
const AI_WORK_KIND_ICON = {
  post: '📱', reel_script: '🎬', article: '📝', newsletter: '📰', campaign: '🗓', ad_copy: '📣',
  email_template: '✉', lead_followup: '🤝', brief: '⚖️', report: '📊', idea: '💡',
};
const AI_CHANNEL_HE = {
  facebook: 'פייסבוק', instagram: 'אינסטגרם', linkedin: 'לינקדאין', tiktok: 'טיקטוק', youtube: 'יוטיוב',
  website: 'אתר', google_business: 'גוגל לעסקים', newsletter: 'ביטאון', email: 'מייל', whatsapp: 'וואטסאפ', internal: 'פנימי',
};
const AI_WORK_STATUS_HE = {
  draft: 'ממתין לאישור', approved: 'מאושר', scheduled: 'מתוזמן', published: 'פורסם', rejected: 'נדחה', archived: 'בארכיון',
};

let aiWorkFilter = { status: 'draft', kind: '' };
let aiAdvTab = 'runs';
let aiStaffCache = { ownerTasks: null };

/** אותה לוגיקה כמו scheduleLabelHe בשרת — מוצגת בכרטיס הסוכן. */
function aiScheduleLabel(s) {
  if (!s || !s.freq) return 'לפי דרישה';
  const h = String(s.hour ?? 8).padStart(2, '0') + ':00';
  const names = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  if (s.freq === 'daily') return `כל יום ב-${h}`;
  if (s.freq === 'weekdays') return `ימי חול ב-${h}`;
  if (s.freq === 'weekly') return `ימי ${(s.days || [0]).map(d => names[d] || d).join(', ')} ב-${h}`;
  if (s.freq === 'monthly') return `ב-${s.dom || 1} לחודש ב-${h}`;
  return 'לפי דרישה';
}

function aiStaffHero(title, sub, stats, extra) {
  return `<div class="st-hero">
    <div class="st-hero-text"><div class="st-hero-title">${title}</div><div class="st-hero-sub">${sub}</div></div>
    <div class="st-hero-stats">${stats.map(s => `<button class="st-stat${s.alert ? ' alert' : ''}" onclick="${s.onclick || ''}">
      <div class="st-stat-num">${s.value}</div><div class="st-stat-label">${s.label}</div></button>`).join('')}</div>
    ${extra || ''}
  </div>`;
}

// ============================================================
// הצוות
// ============================================================

async function aiRenderTeam(host) {
  const sb = aiSb();
  const [{ data: agents, error }, { data: runs }, { count: drafts }, { count: pending }, { data: jobs }, { data: settings }, { data: sched }] = await Promise.all([
    sb.from('ai_agents').select('*').eq('visible', true).order('sort_order').order('name'),
    sb.from('ai_runs').select('agent_id,status,goal,created_at,estimated_cost,id').order('created_at', { ascending: false }).limit(200),
    sb.from('ai_work_items').select('id', { count: 'exact', head: true }).eq('status', 'draft'),
    sb.from('ai_approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    sb.from('ai_jobs').select('id,status').in('status', ['queued', 'running']),
    sb.from('ai_settings').select('emergency_stop,automations_paused,ai_provider_mode').maybeSingle(),
    sb.from('ai_jobs').select('id').eq('trigger_type', 'schedule').gte('created_at', new Date(Date.now() - 2 * 86400000).toISOString()).limit(1),
  ]);
  if (error) throw error;
  if (!agents || !agents.length) {
    host.innerHTML = aiEmpty('הצוות עדיין לא הוקם', 'יש להריץ את המיגרציה 20261031000000_ai_staff.sql. ההוראות ב-docs/AI_STAFF_HE.md.');
    return;
  }
  const last = new Map();
  for (const r of runs || []) if (!last.has(r.agent_id)) last.set(r.agent_id, r);
  const active = agents.filter(a => a.status === 'active').length;
  const schedulerOn = !!(sched && sched.length);
  const st = settings || {};
  const stopped = st.emergency_stop || st.automations_paused;

  const byCat = {};
  for (const a of agents) (byCat[a.category || 'אחר'] ||= []).push(a);

  host.innerHTML = `
    ${aiStaffHero('צוות ה-AI שלך',
      `${active} מתוך ${agents.length} עובדים פעילים · ${schedulerOn ? 'המתזמן פעיל — הצוות עובד לפי לוח' : 'המתזמן עדיין לא הופעל — הצוות רץ בלחיצה בלבד'}`,
      [
        { value: drafts || 0, label: 'טיוטות לאישור', alert: !!drafts, onclick: "aiNav('work')" },
        { value: pending || 0, label: 'אישורים ממתינים', alert: !!pending, onclick: "aiNav('approvals')" },
        { value: (jobs || []).length, label: 'עובדים כרגע', onclick: "aiNav('advanced');aiAdvNav('jobs')" },
      ],
      stopped ? `<div class="st-hero-warn">⛔ ${st.emergency_stop ? 'עצירת חירום פעילה' : 'הצוות מושהה'} — שום סוכן לא רץ. <a href="#" onclick="aiNav('setup');return false">להגדרות</a></div>`
        : !schedulerOn ? `<div class="st-hero-warn soft">⏱ כדי שהצוות יעבוד לבד גם כשהמחשב כבוי, צריך להפעיל את המתזמן פעם אחת. <a href="#" onclick="aiNav('setup');return false">מה נדרש ממך ›</a></div>` : '')}

    ${aiCommandBarHtml()}

    ${Object.entries(byCat).map(([cat, list]) => `
      <div class="st-section-title">${escapeHtml(cat)}</div>
      <div class="st-grid">${list.map(a => aiAgentCardHtml(a, last.get(a.id))).join('')}</div>`).join('')}`;
}

function aiAgentCardHtml(a, r) {
  const on = a.status === 'active';
  const sched = aiScheduleLabel(a.schedule);
  const next = a.next_run_at && on && a.schedule ? `הבא: ${aiFmtDate(a.next_run_at)}` : '';
  const lastHtml = r ? `${StatusChip(r.status)} <span class="ai-muted">${aiRelTime(r.created_at)}</span>` : '<span class="ai-muted">טרם רץ</span>';
  return `<div class="st-agent${on ? '' : ' off'}">
    <div class="st-agent-head">
      <div class="st-agent-icon">${a.icon || '◈'}</div>
      <div class="st-agent-titles">
        <div class="st-agent-name">${escapeHtml(a.name)}</div>
        <div class="st-agent-sched">${a.slug === 'office-manager' ? '💬 הצ׳אט הצף · תמיד זמין' : `⏱ ${escapeHtml(sched)}${next ? ' · ' + next : ''}`}</div>
      </div>
      <label class="oc-switch" title="${on ? 'השבת' : 'הפעל'}"><input type="checkbox" ${on ? 'checked' : ''} onchange="aiToggleAgent(${aiJsAttr(a.id)},${aiJsAttr(a.status)})"><span></span></label>
    </div>
    <div class="st-agent-desc">${escapeHtml(a.description || '')}</div>
    <div class="st-agent-last">ריצה אחרונה: ${lastHtml}${r && r.id ? ` <a href="#" onclick="aiOpenRun('${r.id}');return false">פרטים</a>` : ''}</div>
    <div class="st-agent-actions">
      ${a.slug === 'office-manager'
        ? `<button class="btn btn-sm btn-primary" onclick="if(typeof toggleAgent==='function')toggleAgent()">💬 פתח צ׳אט</button>`
        : `<button class="btn btn-sm btn-primary" ${on ? '' : 'disabled'} onclick="aiStaffRunNow(${aiJsAttr(a.slug)})">▶ הפעל עכשיו</button>
           <button class="btn btn-sm" ${on ? '' : 'disabled'} onclick="aiAgentRunPrompt(${aiJsAttr(a.slug)},${aiJsAttr(a.name)})">משימה מותאמת</button>`}
      <button class="btn btn-sm" onclick="aiOpenAgentDetail('${a.id}')">פרטים</button>
    </div>
  </div>`;
}

/** "הפעל עכשיו" = להריץ את שגרת העבודה של הסוכן, בדיוק כמו שהמתזמן היה מריץ. */
async function aiStaffRunNow(slug) {
  const agents = await aiGetAgents();
  const a = agents.find(x => x.slug === slug);
  if (!a) { notify('הסוכן לא נמצא'); return; }
  const goal = a.routine_goal || `בצע/י את שגרת העבודה שלך (${a.name}).`;
  notify(`${a.icon || ''} ${a.name} יוצא/ת לעבודה…`);
  await aiRunAgent(slug, goal, { job_type: 'routine' });
}

// ============================================================
// תוצרים
// ============================================================

async function aiRenderWork(host) {
  const f = aiWorkFilter;
  let q = aiSb().from('ai_work_items').select('*').order('created_at', { ascending: false }).limit(80);
  if (f.status && f.status !== 'any') q = q.eq('status', f.status);
  if (f.kind) q = q.eq('kind', f.kind);
  const [{ data, error }, agents, { data: counts }] = await Promise.all([
    q, aiGetAgents(), aiSb().from('ai_work_items').select('status'),
  ]);
  if (error) throw error;
  const agentOf = id => agents.find(a => a.id === id) || {};
  const n = {};
  for (const c of counts || []) n[c.status] = (n[c.status] || 0) + 1;

  const chip = (k, label) => `<button class="oc-cat${f.status === k ? ' active' : ''}" onclick="aiWorkSet('status',${aiJsAttr(k)})">${label} <b>${k === 'any' ? (counts || []).length : (n[k] || 0)}</b></button>`;
  host.innerHTML = `
    ${aiStaffHero('תוצרים', 'כל מה שהצוות הכין. כלום לא מתפרסם ולא נשלח בלי אישור שלך.', [
      { value: n.draft || 0, label: 'ממתינים לאישור', alert: !!n.draft, onclick: "aiWorkSet('status','draft')" },
      { value: n.approved || 0, label: 'מאושרים, טרם פורסמו', onclick: "aiWorkSet('status','approved')" },
      { value: n.published || 0, label: 'פורסמו', onclick: "aiWorkSet('status','published')" },
    ])}
    <div class="oc-cats">
      ${chip('draft', 'לאישור')}${chip('approved', 'מאושר')}${chip('published', 'פורסם')}${chip('rejected', 'נדחה')}${chip('any', 'הכל')}
      <select class="form-input" style="max-width:180px;padding:5px 10px;font-size:12.5px" onchange="aiWorkSet('kind',this.value)">
        <option value="">כל הסוגים</option>
        ${Object.entries(AI_WORK_KIND_HE).map(([k, v]) => `<option value="${k}" ${f.kind === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>
    ${(data || []).length ? (data || []).map(w => aiWorkCardHtml(w, agentOf(w.agent_id))).join('')
      : `<div class="oc-empty"><div class="oc-empty-icon" style="background:var(--accent-dim);color:var(--accent)">▤</div>
          <div class="oc-empty-title">${f.status === 'draft' ? 'אין טיוטות שממתינות לך' : 'אין תוצרים בסינון הזה'}</div>
          <div class="oc-empty-sub">כשהצוות יכין פוסט, מאמר או ביטאון, הוא יופיע כאן. אפשר גם לבקש בצ׳אט: "תכין לי פוסט על…".</div></div>`}`;
}

function aiWorkSet(k, v) { aiWorkFilter[k] = v; renderAiCenter(); }

function aiWorkCardHtml(w, agent) {
  const editable = w.status === 'draft' || w.status === 'rejected';
  const md = w.metadata || {};
  return `<div class="st-work st-work-${w.status}" id="work-${w.id}">
    <div class="st-work-head">
      <div class="st-work-kind">${AI_WORK_KIND_ICON[w.kind] || '▤'} ${AI_WORK_KIND_HE[w.kind] || escapeHtml(w.kind)}</div>
      <div class="st-work-meta">
        <span class="badge badge-${w.status === 'published' ? 'active' : w.status === 'rejected' ? 'closed' : w.status === 'approved' ? 'active' : 'pending'}">${AI_WORK_STATUS_HE[w.status] || w.status}</span>
        <span>${AI_CHANNEL_HE[w.channel] || escapeHtml(w.channel)}</span>
        ${agent.name ? `<span>${agent.icon || ''} ${escapeHtml(agent.name)}</span>` : ''}
        <span>${aiRelTime(w.created_at)}</span>
      </div>
    </div>
    <div class="st-work-title">${escapeHtml(w.title)}</div>
    ${w.summary && w.summary !== w.body.slice(0, 220) ? `<div class="st-work-summary">${escapeHtml(w.summary)}</div>` : ''}
    <details class="st-work-body" ${w.status === 'draft' ? 'open' : ''}>
      <summary>הטקסט המלא (${String(w.body || '').length.toLocaleString('he-IL')} תווים)</summary>
      ${editable
        ? `<textarea class="form-input ai-approval-text" id="work-body-${w.id}" rows="${Math.min(22, Math.max(6, String(w.body || '').split('\n').length + 1))}">${escapeHtml(w.body || '')}</textarea>`
        : `<div class="st-work-text">${escapeHtml(w.body || '')}</div>`}
      ${md.meta_description ? `<div class="ai-muted" style="margin-top:6px"><strong>תיאור מטא:</strong> ${escapeHtml(md.meta_description)}</div>` : ''}
      ${(w.tags || []).length ? `<div class="ai-muted" style="margin-top:4px">${w.tags.map(t => '#' + escapeHtml(t)).join(' ')}</div>` : ''}
      ${w.published_ref ? `<div class="ai-muted" style="margin-top:4px">פורסם: ${escapeHtml(w.published_ref)}</div>` : ''}
    </details>
    <div class="st-work-actions">
      ${w.status === 'draft' ? `<button class="btn btn-sm btn-success" onclick="aiWorkSetStatus(${aiJsAttr(w.id)},'approved')">✓ אשר</button>` : ''}
      ${w.status === 'approved' ? `<button class="btn btn-sm btn-primary" onclick="aiWorkMarkPublished(${aiJsAttr(w.id)})">🚀 סמן כפורסם</button>` : ''}
      ${w.status === 'approved' || w.status === 'published' ? `<button class="btn btn-sm" onclick="aiWorkSetStatus(${aiJsAttr(w.id)},'draft')">↩ החזר לטיוטה</button>` : ''}
      ${editable ? `<button class="btn btn-sm" onclick="aiWorkSaveBody(${aiJsAttr(w.id)})">💾 שמור עריכה</button>` : ''}
      <button class="btn btn-sm" onclick="aiWorkCopy(${aiJsAttr(w.id)})">📋 העתק</button>
      ${w.status === 'draft' ? `<button class="btn btn-sm btn-danger" onclick="aiWorkSetStatus(${aiJsAttr(w.id)},'rejected')">✗ דחה</button>` : ''}
      ${w.status !== 'archived' && w.status !== 'draft' ? `<button class="btn btn-sm" style="color:var(--text3)" onclick="aiWorkSetStatus(${aiJsAttr(w.id)},'archived')">ארכב</button>` : ''}
      ${w.run_id ? `<button class="btn btn-sm" onclick="aiOpenRun('${w.run_id}')">איך זה נוצר</button>` : ''}
    </div>
  </div>`;
}

async function aiWorkSetStatus(id, status) {
  try {
    const { data: { user } } = await aiSb().auth.getUser();
    const patch = { status, reviewed_by: user ? user.id : null };
    if (status === 'draft') { patch.published_at = null; patch.published_ref = null; }
    await aiUpdateChecked('ai_work_items', patch, q => q.eq('id', id), AI_APPROVER_ONLY);
    notify({ approved: 'אושר. עכשיו אפשר להעתיק ולפרסם, ואז לסמן כפורסם.', rejected: 'נדחה', archived: 'הועבר לארכיון', draft: 'הוחזר לטיוטה' }[status] || 'עודכן');
  } catch (e) { notify('שגיאה: ' + e.message); }
  renderAiCenter();
}

async function aiWorkSaveBody(id) {
  const el = document.getElementById('work-body-' + id);
  if (!el) return;
  try {
    await aiUpdateChecked('ai_work_items', { body: el.value }, q => q.eq('id', id), AI_APPROVER_ONLY);
    notify('העריכה נשמרה');
  } catch (e) { notify('שגיאה: ' + e.message); }
}

async function aiWorkMarkPublished(id) {
  const ref = await aiPrompt('איפה פורסם? (קישור או ערוץ — אופציונלי)', '');
  if (ref === null) return;
  try {
    const { data: { user } } = await aiSb().auth.getUser();
    await aiUpdateChecked('ai_work_items', {
      status: 'published', published_at: new Date().toISOString(), published_ref: ref || null, reviewed_by: user ? user.id : null,
    }, q => q.eq('id', id), AI_APPROVER_ONLY);
    notify('סומן כפורסם');
  } catch (e) { notify('שגיאה: ' + e.message); }
  renderAiCenter();
}

async function aiWorkCopy(id) {
  const el = document.getElementById('work-body-' + id);
  let text = el ? el.value : null;
  if (text === null) {
    const { data } = await aiSb().from('ai_work_items').select('title,body').eq('id', id).maybeSingle();
    text = data ? data.body : '';
  }
  try { await navigator.clipboard.writeText(text || ''); notify('הועתק. אפשר להדביק בפייסבוק, באתר או במייל.'); }
  catch (e) { notify('לא ניתן להעתיק אוטומטית — סמן את הטקסט והעתק ידנית.'); }
}

// ============================================================
// הגדרות וחיבורים
// ============================================================

const AI_BRAND_FIELDS = [
  ['name', 'שם המותג / המשרד', 'משרד עו"ד ...'],
  ['practiceAreas', 'תחומי התמחות', 'הוצאה לפועל, חדלות פירעון, ליטיגציה אזרחית, חוזים'],
  ['audience', 'קהל יעד', 'בעלי עסקים קטנים, נושים פרטיים, אנשים בחובות'],
  ['valueProp', 'הצעת הערך במשפט', 'ליווי אישי, מענה מהיר, ניסיון של X שנים'],
  ['tone', 'טון וסגנון', 'מקצועי, חם, ישיר, בלי ז׳רגון'],
  ['cta', 'קריאה לפעולה קבועה', 'לשיחת ייעוץ ראשונית: 05X-XXXXXXX'],
  ['website', 'אתר', 'https://'],
  ['facebook', 'פייסבוק', 'https://facebook.com/...'],
  ['instagram', 'אינסטגרם', '@'],
  ['linkedin', 'לינקדאין', 'https://linkedin.com/in/...'],
  ['hashtags', 'האשטאגים קבועים', '#עורךדין #הוצאהלפועל'],
  ['forbidden', 'נושאים ומילים אסורים', 'לא להזכיר לקוחות, לא "הכי טוב", לא הבטחות'],
];

async function aiRenderSetup(host) {
  const [{ data: s }, integ, { data: tasks }] = await Promise.all([
    aiSb().from('ai_settings').select('*').maybeSingle(),
    aiInvoke('ai-comms', { action: 'integrations_status' }).catch(() => null),
    aiSb().from('ai_owner_tasks').select('*').order('status').order('sort_order'),
  ]);
  const st = s || {};
  const om = st.office_memory || {};
  const brand = om.brand || {};
  const open = (tasks || []).filter(t => t.status === 'open');
  const done = (tasks || []).filter(t => t.status !== 'open');
  const kindHe = { connection: 'חיבור', purchase: 'רכישה / מפתח', decision: 'החלטה', setup: 'הגדרה' };

  host.innerHTML = `
    ${aiStaffHero('הגדרות וחיבורים', 'ערכת המותג, תקציב, חיבורים חיצוניים, ומה שרק אתה יכול לעשות.', [
      { value: open.length, label: 'דברים שנדרשים ממך', alert: !!open.length, onclick: "document.getElementById('st-owner').scrollIntoView({behavior:'smooth'})" },
      { value: integ ? integ.integrations.filter(i => i.status === 'connected').length : '—', label: 'חיבורים פעילים' },
      { value: aiFmtCost(st.monthly_budget_usd || 50), label: 'תקציב חודשי' },
    ])}

    <div class="card ${st.emergency_stop ? 'ai-emergency' : ''}">
      <div class="card-title">שליטה</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn ${st.emergency_stop ? 'btn-success' : 'btn-danger'}" onclick="aiToggleEmergency(${!st.emergency_stop})">
          ${st.emergency_stop ? '▶ בטל עצירת חירום' : '⛔ עצור את כל הצוות'}</button>
        <label class="ai-switch"><input type="checkbox" ${st.automations_paused ? 'checked' : ''} onchange="aiSaveToggle('automations_paused',this.checked)"><span>השהה שגרות אוטומטיות (הצוות רץ רק בלחיצה)</span></label>
        <label class="ai-switch"><input type="checkbox" ${st.outbound_messages_paused ? 'checked' : ''} onchange="aiSaveToggle('outbound_messages_paused',this.checked)"><span>השהה הודעות יוצאות</span></label>
      </div>
      ${st.emergency_stop ? `<div class="alert alert-danger" style="margin-top:10px">הצוות עצור מאז ${aiFmtDate(st.emergency_stop_at)}.</div>` : ''}
    </div>

    <div class="card" id="st-brand">
      <div class="card-title">ערכת המותג — מה הצוות יודע על המשרד</div>
      <p class="ai-muted" style="margin-bottom:10px">כל סוכן קורא את זה לפני שהוא כותב. ככל שזה מדויק יותר, התוכן נשמע כמוך ולא כמו תבנית.</p>
      <div class="form-row st-brand-grid">
        ${AI_BRAND_FIELDS.map(([k, label, ph]) => `<div class="form-group"><label class="form-label">${label}</label>
          <input class="form-input" id="ai-brand-${k}" value="${escapeHtml(Array.isArray(brand[k]) ? brand[k].join(', ') : (brand[k] || (k === 'practiceAreas' ? om.practiceAreas : k === 'tone' ? om.writingStyle : '') || ''))}" placeholder="${escapeHtml(ph)}"></div>`).join('')}
        <div class="form-group"><label class="form-label">חתימה</label><input class="form-input" id="ai-brand-signature" value="${escapeHtml(om.signature || '')}" placeholder="בכבוד רב, עו״ד ..."></div>
        <div class="form-group"><label class="form-label">שעות פעילות</label><input class="form-input" id="ai-brand-workingHours" value="${escapeHtml(om.workingHours || '')}" placeholder="א׳-ה׳ 09:00-18:00"></div>
        <div class="form-group"><label class="form-label">מדיניות תקשורת</label><input class="form-input" id="ai-brand-communicationPolicy" value="${escapeHtml(om.communicationPolicy || '')}" placeholder="לא לשלוח אחרי 20:00"></div>
      </div>
      <button class="btn btn-primary" onclick="aiSaveBrand()">שמור ערכת מותג</button>
    </div>

    <div class="card">
      <div class="card-title">תקציב AI</div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">תקציב יומי (USD)</label>
          <input class="form-input" type="number" step="0.5" min="0" id="ai-set-daily" value="${st.daily_budget_usd || 5}"></div>
        <div class="form-group"><label class="form-label">תקציב חודשי (USD)</label>
          <input class="form-input" type="number" step="1" min="0" id="ai-set-monthly" value="${st.monthly_budget_usd || 50}"></div>
        <div class="form-group"><label class="form-label">בחריגה</label>
          <select class="form-input" id="ai-set-exceed">
            <option value="stop" ${st.on_budget_exceeded === 'stop' ? 'selected' : ''}>עצור את הצוות</option>
            <option value="downgrade" ${st.on_budget_exceeded === 'downgrade' ? 'selected' : ''}>עבור למודל זול יותר</option>
          </select></div>
      </div>
      <div class="ai-muted" style="margin-bottom:8px">צוות מלא שעובד כל יום עולה בדרך כלל $20–60 בחודש. העלויות בפועל בלשונית "מתקדם ← עלויות".</div>
      <button class="btn btn-primary" onclick="aiSaveBudget()">שמור תקציב</button>
    </div>

    <div class="card" id="st-owner">
      <div class="card-title">מה נדרש ממך (${open.length} פתוחים)</div>
      <p class="ai-muted" style="margin-bottom:10px">דברים שרק בעל המשרד יכול לעשות: חיבורים, מפתחות, החלטות. כל אחד פותח יכולת לצוות.</p>
      ${(tasks || []).length ? [...open, ...done].map(t => `<div class="st-owner-task${t.status !== 'open' ? ' done' : ''}">
          <label class="oc-switch" title="${t.status === 'open' ? 'סמן כבוצע' : 'פתח מחדש'}"><input type="checkbox" ${t.status !== 'open' ? 'checked' : ''} onchange="aiOwnerTaskToggle(${aiJsAttr(t.id)},this.checked)"><span></span></label>
          <div style="flex:1;min-width:0">
            <div class="st-owner-title"><span class="st-owner-kind">${kindHe[t.kind] || t.kind}</span> ${escapeHtml(t.title)}</div>
            <div class="ai-muted">${escapeHtml(t.detail || '')}</div>
            ${t.unlocks ? `<div class="st-owner-unlocks">🔓 פותח: ${escapeHtml(t.unlocks)}</div>` : ''}
          </div>
          ${t.url ? `<a class="btn btn-sm" href="${escapeHtml(t.url)}" target="_blank" rel="noopener">פתח ›</a>` : ''}
        </div>`).join('') : '<div class="empty">אין משימות. (המיגרציה של צוות ה-AI טרם רצה?)</div>'}
    </div>

    <div class="card">
      <div class="card-title">חיבורים חיצוניים</div>
      ${integ ? `<div class="ai-integration-grid">${integ.integrations.map(IntegrationCard).join('')}</div>
        <div class="fin-row" style="margin-top:10px"><span>ספק AI</span><strong>${integ.ai_provider.mode === 'mock' ? '🧪 הדגמה' : '● פעיל'}${integ.ai_provider.key_present ? '' : ' · ✗ חסר מפתח'}</strong></div>
        <div class="fin-row"><span>מתזמן (CRON_SECRET)</span><strong>${integ.scheduler.cron_secret_set ? '✓ מוגדר' : '✗ לא מוגדר'}</strong></div>`
        : '<div class="empty">לא ניתן לקרוא את מצב החיבורים כרגע.</div>'}
    </div>`;
}

async function aiSaveBrand() {
  const officeId = await aiOfficeId();
  const { data: s } = await aiSb().from('ai_settings').select('office_memory').eq('office_id', officeId).maybeSingle();
  const om = Object.assign({}, (s && s.office_memory) || {});
  const brand = {};
  for (const [k] of AI_BRAND_FIELDS) {
    const v = (document.getElementById('ai-brand-' + k) || {}).value || '';
    if (v.trim()) brand[k] = v.trim();
  }
  om.brand = brand;
  // השדות הישנים שהסוכנים כבר קוראים — נשמרים במקביל כדי לא לשבור prompts קיימים.
  if (brand.practiceAreas) om.practiceAreas = brand.practiceAreas;
  if (brand.tone) om.writingStyle = brand.tone;
  for (const k of ['signature', 'workingHours', 'communicationPolicy']) {
    const v = ((document.getElementById('ai-brand-' + k) || {}).value || '').trim();
    if (v) om[k] = v; else delete om[k];
  }
  try {
    await aiUpdateChecked('ai_settings', { office_memory: om }, q => q.eq('office_id', officeId), AI_OWNER_ONLY);
    notify('ערכת המותג נשמרה. הצוות ישתמש בה מהריצה הבאה.');
  } catch (e) { notify('שגיאה: ' + e.message); }
}

async function aiSaveBudget() {
  const officeId = await aiOfficeId();
  try {
    await aiUpdateChecked('ai_settings', {
      daily_budget_usd: Number(document.getElementById('ai-set-daily').value) || 0,
      monthly_budget_usd: Number(document.getElementById('ai-set-monthly').value) || 0,
      on_budget_exceeded: document.getElementById('ai-set-exceed').value,
    }, q => q.eq('office_id', officeId), AI_OWNER_ONLY);
    notify('התקציב נשמר');
  } catch (e) { notify('שגיאה: ' + e.message); }
}

async function aiOwnerTaskToggle(id, done) {
  try {
    await aiUpdateChecked('ai_owner_tasks', { status: done ? 'done' : 'open', done_at: done ? new Date().toISOString() : null },
      q => q.eq('id', id), AI_OWNER_ONLY);
    notify(done ? 'סומן כבוצע' : 'נפתח מחדש');
  } catch (e) { notify('שגיאה: ' + e.message); }
  renderAiCenter();
}

// ============================================================
// מתקדם — כל המסכים הישנים, במקום אחד
// ============================================================

const AI_ADV_TABS = [
  ['runs', 'הרצות', 'aiRenderRuns'], ['jobs', 'תור', 'aiRenderJobs'], ['communications', 'תקשורת', 'aiRenderCommunications'],
  ['learning', 'למידה', 'aiRenderLearning'], ['costs', 'עלויות', 'aiRenderCosts'], ['audit', 'יומן ביקורת', 'aiRenderAudit'],
  ['agents', 'כל הסוכנים', 'aiRenderAgents'], ['settings', 'הגדרות מלאות', 'aiRenderSettings'], ['overview', 'סקירה', 'aiRenderOverview'],
];

async function aiRenderAdvanced(host) {
  host.innerHTML = `
    <div class="st-adv-nav">${AI_ADV_TABS.map(([id, label]) =>
      `<button class="oc-cat${aiAdvTab === id ? ' active' : ''}" onclick="aiAdvNav(${aiJsAttr(id)})">${label}</button>`).join('')}</div>
    <div id="ai-adv-body"><div class="empty">טוען…</div></div>`;
  const inner = document.getElementById('ai-adv-body');
  const [, , fnName] = AI_ADV_TABS.find(t => t[0] === aiAdvTab) || AI_ADV_TABS[0];
  const fn = window[fnName];
  if (typeof fn !== 'function') { inner.innerHTML = '<div class="empty">המסך לא זמין</div>'; return; }
  try { await fn(inner); }
  catch (e) { inner.innerHTML = aiError((e && e.message) || String(e), e); }
}

function aiAdvNav(id) { aiAdvTab = id; if (aiTab !== 'advanced') { aiTab = 'advanced'; } renderAiCenter(); }
