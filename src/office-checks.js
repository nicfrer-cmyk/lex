// בקרת משרד — בדיקות דטרמיניסטיות שרצות בדפדפן על נתוני המשרד.
//
// נטען אחרי app.js ו-practice.js ומשתמש בגלובלים שלהם: db, saveDB, uid, notify,
// escapeHtml, jsArg, localDateISO, heToISO, daysSinceHE, caseTrustTotals,
// openCaseDetail, openClientDetail, nav.
//
// ## למה בדפדפן ולא בשרת
// כל נתוני המשרד כבר טעונים בזיכרון (db). בדיקה כמו "תיק ללא פעילות 30 יום"
// היא סינון של מערך, לא הסקה — היא רצה בפחות ממילישנייה, בלי רשת, בלי
// מתזמן ובלי עלות. התוצאה זהה בכל מכשיר כי היא נגזרת מהנתונים, לא נשמרת.
// מה שכן נשמר ב-db: ההגדרות (אילו בדיקות דולקות ועם איזה סף), אילו ממצאים
// סומנו "טופל", ואיזו משימה נוצרה מאיזה ממצא (כדי לא ליצור כפולות).
//
// מנוע האוטומציות בשרת (automation-engine) נשאר כפי שהוא; המסך הזה מחליף
// רק את הממשק שלו.

const OC_CATEGORIES = {
  cases:     { label: 'תיקים',   icon: '📁', color: 'var(--accent)' },
  deadlines: { label: 'מועדים',  icon: '📅', color: 'var(--danger)' },
  tasks:     { label: 'משימות',  icon: '☑',  color: 'var(--warning)' },
  clients:   { label: 'לקוחות',  icon: '👤', color: 'var(--success)' },
  finance:   { label: 'כספים',   icon: '₪',  color: '#7c3aed' },
  contracts: { label: 'חוזים',   icon: '📝', color: '#0891b2' },
  docs:      { label: 'מסמכים',  icon: '📄', color: 'var(--text3)' },
};

// ---------- עזרי זמן ----------

function ocToday() { return localDateISO(new Date()); }

function ocDaysBetween(aISO, bISO) {
  if (!aISO || !bISO) return null;
  const a = new Date(aISO + 'T00:00:00'), b = new Date(bISO + 'T00:00:00');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** תאריך he-IL ("5.7.2026, 10:30") → ISO יום. מחזיר null אם לא ניתן לפענח. */
function ocHeToISO(s) {
  if (!s) return null;
  const datePart = String(s).split(',')[0].trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
  const p = datePart.split('.');
  if (p.length !== 3) return null;
  const d = new Date(+p[2], +p[1] - 1, +p[0]);
  return isNaN(d) ? null : localDateISO(d);
}

/** היום האחרון שבו נרשמה פעילות בתיק: רשומת יומן אחרונה, ואם אין — פתיחה. */
function ocLastActivityISO(c) {
  const diary = (c.diary || []).map(e => ocHeToISO(e.date)).filter(Boolean).sort();
  if (diary.length) return diary[diary.length - 1];
  return ocHeToISO(c.opened);
}

function ocIdleDays(c, today) {
  const last = ocLastActivityISO(c);
  return last ? ocDaysBetween(last, today) : null;
}

const ocActiveCases = (db) => (db.cases || []).filter(c => c.status !== 'closed');
const ocCaseName = (db, id) => { const c = (db.cases || []).find(x => x.id === id); return c ? c.name : ''; };
const ocClientName = (db, id) => { const c = (db.clients || []).find(x => x.id === id); return c ? c.name : ''; };
const ocFmt = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${+d}.${+m}.${y}`; };

// ---------- קטלוג הבדיקות ----------
//
// לכל בדיקה: מפתח קבוע (זהה לטריגר בשרת כשיש כזה), קטגוריה, שם ותיאור
// בעברית פשוטה, פרמטר אחד לכל היותר (ימים/שעות/סכום), ופונקציית run שמקבלת
// את ה-db ומחזירה ממצאים. ממצא = {entityType, entityId, title, detail, severity,
// caseId, task:{text, due}}.

const OFFICE_CHECKS = [
  // ===== תיקים =====
  {
    key: 'matter_inactive', cat: 'cases', label: 'תיק ללא פעילות',
    describe: cfg => `תיק פעיל שלא נרשמה בו פעילות ביומן מעל ${cfg.days} יום.`,
    param: { key: 'days', label: 'ימים', default: 30, min: 7 },
    run(db, cfg, t) {
      return ocActiveCases(db).map(c => ({ c, idle: ocIdleDays(c, t.today) }))
        .filter(x => x.idle !== null && x.idle >= cfg.days)
        .sort((a, b) => b.idle - a.idle)
        .map(({ c, idle }) => ({
          entityType: 'case', entityId: c.id, caseId: c.id,
          title: c.name, detail: `${idle} יום ללא פעילות · שלב: ${c.stage || '—'}`,
          severity: idle >= cfg.days * 2 ? 'high' : 'normal',
          task: { text: `בדיקת מצב התיק ${c.name} — ${idle} יום ללא פעילות`, days: 3 },
        }));
    },
  },
  {
    key: 'matter_no_next_action', cat: 'cases', label: 'תיק בלי צעד הבא',
    describe: () => 'תיק פעיל שאין בו אף משימה פתוחה ואף מועד עתידי — אף אחד לא יודע מה הצעד הבא.',
    run(db, cfg, t) {
      const openTask = new Set((db.tasks || []).filter(x => !x.done && x.caseId).map(x => x.caseId));
      const futureEv = new Set((db.events || []).filter(e => e.caseId && e.date >= t.today).map(e => e.caseId));
      return ocActiveCases(db).filter(c => !openTask.has(c.id) && !futureEv.has(c.id)).map(c => ({
        entityType: 'case', entityId: c.id, caseId: c.id,
        title: c.name, detail: `שלב: ${c.stage || '—'} · אין משימה פתוחה ואין מועד ביומן`,
        severity: 'normal',
        task: { text: `לקבוע את הצעד הבא בתיק ${c.name}`, days: 2 },
      }));
    },
  },
  {
    key: 'matter_missing_docs', cat: 'cases', label: 'תיק בלי הסכם שכ"ט או ייפוי כוח',
    describe: cfg => `תיק גבייה פעיל שנפתח לפני יותר מ-${cfg.days} ימים ועדיין לא הופק בו הסכם שכר טרחה או ייפוי כוח.`,
    param: { key: 'days', label: 'ימים מהפתיחה', default: 7, min: 0 },
    run(db, cfg, t) {
      return ocActiveCases(db).filter(c => (typeof isDebtCase === 'function' ? isDebtCase(c) : !c.caseType || c.caseType === 'debt'))
        .filter(c => { const o = ocHeToISO(c.opened); return o && ocDaysBetween(o, t.today) >= cfg.days; })
        .map(c => {
          const ld = c.legalDocs || {};
          const missing = [!ld.atfDraft && 'הסכם שכ"ט', !ld.poaDraft && 'ייפוי כוח'].filter(Boolean);
          return missing.length ? {
            entityType: 'case', entityId: c.id, caseId: c.id,
            title: c.name, detail: `חסר: ${missing.join(' ו')}`, severity: 'normal',
            task: { text: `להפיק ${missing.join(' ו')} בתיק ${c.name}`, days: 3 },
          } : null;
        }).filter(Boolean);
    },
  },
  {
    key: 'matter_incomplete', cat: 'cases', label: 'תיק חדש עם פרטים חסרים',
    describe: cfg => `תיק שנפתח ב-${cfg.days} הימים האחרונים וחסרים בו פרטים מהותיים (לקוח, סכום, פרטי הצד השני).`,
    param: { key: 'days', label: 'ימים מהפתיחה', default: 30, min: 1 },
    run(db, cfg, t) {
      return ocActiveCases(db).filter(c => { const o = ocHeToISO(c.opened); return o && ocDaysBetween(o, t.today) <= cfg.days; })
        .map(c => {
          const cl = (db.clients || []).find(x => x.id === c.client);
          const debt = typeof isDebtCase === 'function' ? isDebtCase(c) : !c.caseType || c.caseType === 'debt';
          const missing = [
            !cl && 'לקוח', cl && !cl.phone && !cl.email && 'טלפון/אימייל של הלקוח',
            debt && !(c.amount > 0) && 'סכום החוב', debt && !c.debtorName && 'שם החייב',
            debt && !c.debtorId && 'ת.ז/ח.פ של החייב',
          ].filter(Boolean);
          return missing.length ? {
            entityType: 'case', entityId: c.id, caseId: c.id,
            title: c.name, detail: `חסר: ${missing.join(', ')}`, severity: 'low',
            task: { text: `להשלים פרטים בתיק ${c.name}: ${missing.join(', ')}`, days: 2 },
          } : null;
        }).filter(Boolean);
    },
  },
  {
    key: 'matter_high_value_idle', cat: 'cases', label: 'תיק בסכום גבוה ללא פעילות',
    describe: cfg => `תיק בסכום של ₪${Number(cfg.amount).toLocaleString('he-IL')} ומעלה שלא נרשמה בו פעילות 14 יום.`,
    param: { key: 'amount', label: 'סכום מינימלי (₪)', default: 100000, min: 0, step: 10000 },
    run(db, cfg, t) {
      return ocActiveCases(db).filter(c => (c.amount || 0) >= cfg.amount)
        .map(c => ({ c, idle: ocIdleDays(c, t.today) })).filter(x => x.idle !== null && x.idle >= 14)
        .map(({ c, idle }) => ({
          entityType: 'case', entityId: c.id, caseId: c.id,
          title: c.name, detail: `₪${(c.amount || 0).toLocaleString('he-IL')} · ${idle} יום ללא פעילות`, severity: 'high',
          task: { text: `תיק בסכום גבוה ללא תנועה: ${c.name}`, days: 1 },
        }));
    },
  },

  // ===== מועדים =====
  {
    key: 'deadline_soon', cat: 'deadlines', label: 'מועד אחרון קרוב',
    describe: cfg => `מועד אחרון (הגשה, ערעור, תגובה) בתוך ${cfg.days} ימים.`,
    param: { key: 'days', label: 'ימים מראש', default: 3, min: 1 },
    run(db, cfg, t) {
      return (db.events || []).filter(e => /מועד אחרון|הגשה|ערעור/.test(e.type || '') && e.date >= t.today && ocDaysBetween(t.today, e.date) <= cfg.days)
        .map(e => {
          const d = ocDaysBetween(t.today, e.date);
          return {
            entityType: 'event', entityId: e.id, caseId: e.caseId,
            title: e.title, detail: `${d === 0 ? 'היום' : `בעוד ${d} ימים`} (${ocFmt(e.date)})${e.caseId ? ' · ' + ocCaseName(db, e.caseId) : ''}`,
            severity: 'high',
            task: { text: `להשלים לפני המועד: ${e.title}`, days: Math.max(0, d - 1) },
          };
        });
    },
  },
  {
    key: 'event_without_prep_task', cat: 'deadlines', label: 'דיון בלי משימת הכנה',
    describe: cfg => `דיון או פגישה ב-${cfg.days} הימים הקרובים שבתיק שלהם אין אף משימה פתוחה.`,
    param: { key: 'days', label: 'ימים מראש', default: 7, min: 1 },
    run(db, cfg, t) {
      const openByCase = new Set((db.tasks || []).filter(x => !x.done && x.caseId).map(x => x.caseId));
      return (db.events || []).filter(e => e.caseId && e.date >= t.today && ocDaysBetween(t.today, e.date) <= cfg.days
          && /דיון|קדם|הוכחות|פגישה|ישיבה/.test(e.type || e.title || '') && !openByCase.has(e.caseId))
        .map(e => ({
          entityType: 'event', entityId: e.id, caseId: e.caseId,
          title: e.title, detail: `${ocFmt(e.date)}${e.time ? ' ' + e.time : ''} · ${ocCaseName(db, e.caseId)} · אין משימת הכנה`,
          severity: 'high',
          task: { text: `הכנה ל${e.title} (${ocFmt(e.date)})`, days: Math.max(0, ocDaysBetween(t.today, e.date) - 2) },
        }));
    },
  },
  {
    key: 'event_passed_unmarked', cat: 'deadlines', label: 'מועד שעבר ולא תועד',
    describe: cfg => `אירוע שתאריכו עבר לפני ${cfg.days} ימים לפחות ולא נרשמה אחריו שום רשומה ביומן התיק.`,
    param: { key: 'days', label: 'ימי חסד', default: 1, min: 0 },
    run(db, cfg, t) {
      return (db.events || []).filter(e => e.caseId && e.date < t.today && ocDaysBetween(e.date, t.today) >= cfg.days
          && ocDaysBetween(e.date, t.today) <= 60)
        .map(e => {
          const c = (db.cases || []).find(x => x.id === e.caseId);
          if (!c || c.status === 'closed') return null;
          const after = (c.diary || []).some(d => { const iso = ocHeToISO(d.date); return iso && iso >= e.date; });
          return after ? null : {
            entityType: 'event', entityId: e.id, caseId: c.id,
            title: e.title, detail: `${ocFmt(e.date)} · ${c.name} · מה קרה? לא נרשם ביומן`, severity: 'normal',
            task: { text: `לתעד ביומן התיק את תוצאת "${e.title}"`, days: 1 },
          };
        }).filter(Boolean);
    },
  },
  {
    key: 'event_conflict', cat: 'deadlines', label: 'התנגשות ביומן',
    describe: () => 'שני אירועים או יותר באותו יום ובאותה שעה.',
    run(db, cfg, t) {
      const slots = {};
      for (const e of (db.events || [])) {
        if (!e.time || e.date < t.today) continue;
        (slots[`${e.date} ${e.time}`] ||= []).push(e);
      }
      return Object.entries(slots).filter(([, evs]) => evs.length > 1).map(([slot, evs]) => ({
        entityType: 'event', entityId: evs[0].id, caseId: evs[0].caseId,
        title: `${evs.length} אירועים ב-${ocFmt(slot.slice(0, 10))} ${slot.slice(11)}`,
        detail: evs.map(e => e.title).join(' / '), severity: 'high',
        task: { text: `לפתור התנגשות ביומן: ${evs.map(e => e.title).join(' / ')}`, days: 0 },
      }));
    },
  },

  // ===== משימות =====
  {
    key: 'task_overdue', cat: 'tasks', label: 'משימה באיחור',
    describe: cfg => `משימה שעבר מועד היעד שלה לפני ${cfg.days} ימים לפחות ולא סומנה כהושלמה.`,
    param: { key: 'days', label: 'ימי איחור', default: 1, min: 0 },
    run(db, cfg, t) {
      return (db.tasks || []).filter(x => !x.done && x.due && ocDaysBetween(x.due, t.today) >= cfg.days)
        .map(x => { const late = ocDaysBetween(x.due, t.today); return {
          entityType: 'task', entityId: x.id, caseId: x.caseId,
          title: x.text, detail: `באיחור ${late} ימים${x.caseId ? ' · ' + ocCaseName(db, x.caseId) : ''}`,
          severity: late >= 14 ? 'high' : 'normal',
        }; }).sort((a, b) => (b.severity === 'high') - (a.severity === 'high'));
    },
  },
  {
    key: 'task_no_due_date', cat: 'tasks', label: 'משימה בלי תאריך יעד',
    describe: () => 'משימה פתוחה שלא נקבע לה מועד — היא לא תופיע בשום תזכורת.',
    run(db) {
      return (db.tasks || []).filter(x => !x.done && !x.due).map(x => ({
        entityType: 'task', entityId: x.id, caseId: x.caseId,
        title: x.text, detail: x.caseId ? ocCaseName(db, x.caseId) : 'משימה כללית', severity: 'low',
      }));
    },
  },

  // ===== לקוחות =====
  {
    key: 'client_no_update', cat: 'clients', label: 'לקוח שלא קיבל עדכון',
    describe: cfg => `לקוח עם תיק פעיל שבכל התיקים שלו לא נרשמה פעילות מעל ${cfg.days} יום.`,
    param: { key: 'days', label: 'ימים', default: 45, min: 7 },
    run(db, cfg, t) {
      const byClient = {};
      for (const c of ocActiveCases(db)) {
        if (!c.client) continue;
        const idle = ocIdleDays(c, t.today);
        const cur = byClient[c.client];
        if (!cur || (idle !== null && idle < cur.idle)) byClient[c.client] = { idle: idle === null ? Infinity : idle, cases: (cur ? cur.cases : 0) + 1 };
        else cur.cases++;
      }
      return Object.entries(byClient).filter(([, v]) => v.idle !== Infinity && v.idle >= cfg.days).map(([id, v]) => {
        const cl = (db.clients || []).find(x => x.id === id);
        return cl ? {
          entityType: 'client', entityId: id,
          title: cl.name, detail: `${v.idle} יום בלי פעילות ב-${v.cases} ${v.cases === 1 ? 'תיק' : 'תיקים'}`, severity: 'normal',
          task: { text: `לעדכן את ${cl.name} במצב התיק`, days: 2 },
          ai: `נסח הודעת עדכון קצרה ללקוח ${cl.name} על מצב התיקים שלו`,
        } : null;
      }).filter(Boolean);
    },
  },
  {
    key: 'client_missing_contact', cat: 'clients', label: 'לקוח בלי פרטי קשר',
    describe: () => 'לקוח עם תיק פעיל שאין לו טלפון ואין לו אימייל.',
    run(db) {
      const active = new Set(ocActiveCases(db).map(c => c.client));
      return (db.clients || []).filter(cl => active.has(cl.id) && !cl.phone && !cl.email).map(cl => ({
        entityType: 'client', entityId: cl.id, title: cl.name, detail: 'אין טלפון ואין אימייל', severity: 'low',
        task: { text: `להשלים פרטי קשר של ${cl.name}`, days: 3 },
      }));
    },
  },
  {
    key: 'lead_untouched', cat: 'clients', label: 'ליד שלא טופל',
    describe: cfg => `פנייה חדשה שנכנסה לפני יותר מ-${cfg.days} ימים ועדיין במצב "חדש".`,
    param: { key: 'days', label: 'ימים', default: 3, min: 1 },
    run(db, cfg, t) {
      return (db.leads || []).filter(l => (!l.status || l.status === 'new') && l.createdAt)
        .map(l => ({ l, age: ocDaysBetween(String(l.createdAt).slice(0, 10), t.today) }))
        .filter(x => x.age !== null && x.age >= cfg.days)
        .map(({ l, age }) => ({
          entityType: 'lead', entityId: l.id, title: l.name || l.phone || l.email || 'ליד',
          detail: `${age} ימים ללא טיפול${l.source ? ' · ' + l.source : ''}`, severity: 'high',
          task: { text: `לחזור לליד ${l.name || l.phone || ''}`, days: 0 },
        }));
    },
  },

  // ===== כספים =====
  {
    key: 'unbilled_hours', cat: 'finance', label: 'שעות שלא חויבו',
    describe: cfg => `תיק שנצברו בו ${cfg.hours} שעות עבודה ומעלה שעדיין לא נכנסו לדרישת תשלום.`,
    param: { key: 'hours', label: 'שעות', default: 5, min: 1 },
    run(db, cfg) {
      const byCase = {};
      for (const te of (db.timeEntries || [])) if (te.caseId && !te.billedStatementId) byCase[te.caseId] = (byCase[te.caseId] || 0) + (te.duration || 0);
      return Object.entries(byCase).map(([id, sec]) => ({ id, h: sec / 3600 })).filter(x => x.h >= cfg.hours).map(({ id, h }) => ({
        entityType: 'case', entityId: id, caseId: id, title: ocCaseName(db, id) || 'תיק',
        detail: `${h.toFixed(1)} שעות לא חויבו`, severity: 'normal',
        task: { text: `להפיק דרישת תשלום בתיק ${ocCaseName(db, id)} (${h.toFixed(1)} ש')`, days: 3 },
      }));
    },
  },
  {
    key: 'statement_unpaid', cat: 'finance', label: 'דרישת תשלום שלא שולמה',
    describe: cfg => `דרישת תשלום שנשלחה לפני יותר מ-${cfg.days} ימים ולא סומנה כשולמה.`,
    param: { key: 'days', label: 'ימים', default: 30, min: 7 },
    run(db, cfg, t) {
      return (db.billingStatements || []).filter(s => s.status === 'sent' && s.date && ocDaysBetween(s.date, t.today) >= cfg.days).map(s => ({
        entityType: 'statement', entityId: s.id, caseId: s.caseId,
        title: `דרישה מס׳ ${s.number} — ${ocClientName(db, s.clientId) || ocCaseName(db, s.caseId)}`,
        detail: `₪${Math.round(s.total || 0).toLocaleString('he-IL')} · נשלחה ${ocFmt(s.date)} (${ocDaysBetween(s.date, t.today)} ימים)`, severity: 'high',
        task: { text: `תזכורת תשלום: דרישה ${s.number} ל${ocClientName(db, s.clientId)}`, days: 1 },
        ai: `נסח תזכורת תשלום מנומסת ללקוח ${ocClientName(db, s.clientId)} על דרישת תשלום מס׳ ${s.number}`,
      }));
    },
  },
  {
    key: 'trust_in_closed_case', cat: 'finance', label: 'יתרת נאמנות בתיק סגור',
    describe: () => 'תיק שנסגר ועדיין יש בו יתרה בחשבון הנאמנות.',
    run(db) {
      // מחושב מה-db שהתקבל ולא מהגלובלי, כדי שהבדיקה תהיה טהורה וניתנת לבדיקה.
      const delta = typeof trustLedgerDelta === 'function' ? trustLedgerDelta : () => 0;
      return (db.cases || []).filter(c => c.status === 'closed').map(c => {
        const balance = (db.trustTransactions || []).filter(t => t.caseId === c.id).reduce((s, t) => s + delta(t), 0);
        return Math.abs(balance) >= 1 ? {
          entityType: 'case', entityId: c.id, caseId: c.id, title: c.name,
          detail: `יתרת נאמנות ₪${Math.round(balance).toLocaleString('he-IL')}`, severity: 'high',
          task: { text: `לטפל ביתרת הנאמנות בתיק הסגור ${c.name}`, days: 2 },
        } : null;
      }).filter(Boolean);
    },
  },

  // ===== חוזים =====
  {
    key: 'contract_ending', cat: 'contracts', label: 'הסכם שמסתיים',
    describe: cfg => `הסכם שתוקפו מסתיים בתוך ${cfg.days} ימים.`,
    param: { key: 'days', label: 'ימים מראש', default: 60, min: 7 },
    run(db, cfg, t) {
      return ocActiveCases(db).filter(c => c.caseType === 'contract' && c.contract && c.contract.endDate)
        .map(c => ({ c, d: ocDaysBetween(t.today, c.contract.endDate) })).filter(x => x.d !== null && x.d >= 0 && x.d <= cfg.days)
        .map(({ c, d }) => ({
          entityType: 'case', entityId: c.id, caseId: c.id, title: c.name,
          detail: `סיום תוקף ${ocFmt(c.contract.endDate)} (בעוד ${d} ימים)${c.contract.renewal === 'auto' ? ' · מתחדש אוטומטית' : ''}`,
          severity: d <= 14 ? 'high' : 'normal',
          task: { text: `להחליט על חידוש/סיום ההסכם ${c.name}`, days: Math.max(0, d - 7) },
        }));
    },
  },
  {
    key: 'contract_notice', cat: 'contracts', label: 'מועד הודעה על חידוש',
    describe: () => 'הסכם שהמועד האחרון להודיע על אי-חידוש חל בתוך 14 יום.',
    run(db, cfg, t) {
      return ocActiveCases(db).filter(c => c.caseType === 'contract' && c.contract && c.contract.endDate && c.contract.noticeDays > 0)
        .map(c => {
          const end = new Date(c.contract.endDate + 'T00:00:00'); end.setDate(end.getDate() - c.contract.noticeDays);
          const notice = localDateISO(end); const d = ocDaysBetween(t.today, notice);
          return d !== null && d >= 0 && d <= 14 ? {
            entityType: 'case', entityId: c.id, caseId: c.id, title: c.name,
            detail: `מועד אחרון להודעה: ${ocFmt(notice)} (בעוד ${d} ימים)`, severity: 'high',
            task: { text: `לשלוח הודעה על חידוש/אי-חידוש: ${c.name}`, days: Math.max(0, d - 2) },
          } : null;
        }).filter(Boolean);
    },
  },

  // ===== מסמכים =====
  {
    key: 'document_unlinked', cat: 'docs', label: 'מסמך שלא שויך לתיק',
    describe: () => 'מסמך שהועלה ולא נקשר לאף תיק.',
    run(db) {
      return (db.docs || []).filter(d => !d.caseId).map(d => ({
        entityType: 'doc', entityId: d.id, title: d.name || 'מסמך', detail: d.date ? `הועלה ${d.date}` : '', severity: 'low',
      }));
    },
  },
];

// ---------- הגדרות ומצב ----------

function ocSettings(db) {
  const s = (db.settings && db.settings.officeChecks) || {};
  const out = {};
  for (const ch of OFFICE_CHECKS) {
    const cur = s[ch.key] || {};
    out[ch.key] = { enabled: cur.enabled !== false };
    if (ch.param) {
      const v = Number(cur[ch.param.key]);
      out[ch.key][ch.param.key] = Number.isFinite(v) && v >= (ch.param.min || 0) ? v : ch.param.default;
    }
  }
  return out;
}

function ocState(db) {
  if (!db.checkState) db.checkState = { dismissed: {}, taskLinks: {}, lastRunAt: null };
  db.checkState.dismissed ||= {}; db.checkState.taskLinks ||= {};
  return db.checkState;
}

const ocFindingKey = (f) => `${f.check}:${f.entityId}`;

/**
 * מריץ את כל הבדיקות הדולקות ומחזיר ממצאים. טהור: לא כותב ל-db.
 * `opts.includeDismissed` מחזיר גם ממצאים שסומנו "טופל" (לסטטיסטיקה).
 */
function runOfficeChecks(db, now, opts) {
  const today = localDateISO(now || new Date());
  const settings = ocSettings(db);
  const state = (db.checkState || {});
  const dismissed = state.dismissed || {};
  const taskLinks = state.taskLinks || {};
  const openTasks = new Set((db.tasks || []).filter(t => !t.done).map(t => t.id));
  const findings = [];
  for (const ch of OFFICE_CHECKS) {
    const cfg = settings[ch.key];
    if (!cfg.enabled) continue;
    let items = [];
    try { items = ch.run(db, cfg, { today }) || []; }
    catch (e) { console.warn('office check failed', ch.key, e); continue; }
    for (const it of items) {
      const f = Object.assign({ check: ch.key, cat: ch.cat, checkLabel: ch.label, severity: 'normal' }, it);
      const k = ocFindingKey(f);
      f.dismissedUntil = dismissed[k] && dismissed[k] > today ? dismissed[k] : null;
      f.taskId = taskLinks[k] && openTasks.has(taskLinks[k]) ? taskLinks[k] : null;
      if (f.dismissedUntil && !(opts && opts.includeDismissed)) continue;
      findings.push(f);
    }
  }
  const sev = { high: 0, normal: 1, low: 2 };
  findings.sort((a, b) => sev[a.severity] - sev[b.severity]);
  return findings;
}

function ocSummary(findings) {
  const byCat = {};
  for (const f of findings) byCat[f.cat] = (byCat[f.cat] || 0) + 1;
  return { total: findings.length, high: findings.filter(f => f.severity === 'high').length, byCat };
}

// ---------- פעולות על ממצא ----------

function ocCreateTaskFromFinding(db, f, today) {
  const state = ocState(db);
  const k = ocFindingKey(f);
  const existing = state.taskLinks[k] && (db.tasks || []).find(t => t.id === state.taskLinks[k] && !t.done);
  if (existing) return existing;
  const spec = f.task || { text: `${f.checkLabel}: ${f.title}`, days: 2 };
  const due = new Date((today || localDateISO(new Date())) + 'T00:00:00'); due.setDate(due.getDate() + (spec.days || 0));
  const t = {
    id: uid(), text: spec.text, due: localDateISO(due), caseId: f.caseId || '',
    priority: f.severity === 'high' ? 'urgent' : 'normal', notes: `נוצר מבקרת המשרד: ${f.checkLabel}`, done: false,
    source: { check: f.check, entityId: f.entityId },
  };
  if (!db.tasks) db.tasks = [];
  db.tasks.unshift(t);
  state.taskLinks[k] = t.id;
  return t;
}

function ocDismissFinding(db, f, days, today) {
  const state = ocState(db);
  const until = new Date((today || localDateISO(new Date())) + 'T00:00:00'); until.setDate(until.getDate() + days);
  state.dismissed[ocFindingKey(f)] = localDateISO(until);
}

// ============================================================
// ממשק
// ============================================================

let ocFilterCat = '';
let ocShowSettings = false;
let ocLastFindings = [];

function renderOfficeChecks() {
  const host = document.getElementById('oc-body');
  if (!host) return;
  const findings = runOfficeChecks(db);
  ocLastFindings = findings;
  const sum = ocSummary(findings);
  const state = ocState(db);
  const visible = ocFilterCat ? findings.filter(f => f.cat === ocFilterCat) : findings;
  const grouped = {};
  for (const f of visible) (grouped[f.cat] ||= []).push(f);

  host.innerHTML = `
    <div class="oc-hero">
      <div class="oc-hero-main">
        <div class="oc-hero-num${sum.total ? '' : ' oc-ok'}">${sum.total}</div>
        <div>
          <div class="oc-hero-title">${sum.total ? 'ממצאים שדורשים בדיקה' : 'המשרד נקי'}</div>
          <div class="oc-hero-sub">${sum.high ? `<span class="oc-hero-high">${sum.high} דחופים</span> · ` : ''}
            ${state.lastRunAt ? `בדיקה אחרונה ${aiRelTimeSafe(state.lastRunAt)}` : 'טרם הורצה בדיקה'} · הבדיקות רצות על הנתונים העדכניים בכל פתיחה</div>
        </div>
      </div>
      <div class="oc-hero-actions">
        <button class="oc-run" onclick="ocRunNow()">▶ הרץ בדיקת משרד</button>
        <button class="btn btn-sm oc-ghost" onclick="ocToggleSettings()">${ocShowSettings ? '✕ סגור הגדרות' : '⚙ אילו בדיקות רצות'}</button>
      </div>
    </div>

    <div class="oc-cats">
      <button class="oc-cat${ocFilterCat ? '' : ' active'}" onclick="ocSetCat('')">הכל <b>${sum.total}</b></button>
      ${Object.entries(OC_CATEGORIES).map(([k, c]) => `<button class="oc-cat${ocFilterCat === k ? ' active' : ''}${sum.byCat[k] ? '' : ' oc-cat-empty'}"
          style="--cat:${c.color}" onclick="ocSetCat(${jsArg(k)})">${c.icon} ${c.label} <b>${sum.byCat[k] || 0}</b></button>`).join('')}
    </div>

    ${ocShowSettings ? ocSettingsHtml() : ''}

    ${visible.length ? Object.entries(grouped).map(([cat, list]) => `
      <div class="oc-group">
        <div class="oc-group-title" style="--cat:${OC_CATEGORIES[cat].color}">${OC_CATEGORIES[cat].icon} ${OC_CATEGORIES[cat].label} <span>${list.length}</span></div>
        ${list.map(ocFindingHtml).join('')}
      </div>`).join('')
      : `<div class="oc-empty"><div class="oc-empty-icon">✓</div>
          <div class="oc-empty-title">${ocFilterCat ? 'אין ממצאים בקטגוריה הזו' : 'אין ממצאים. כל הכבוד.'}</div>
          <div class="oc-empty-sub">${ocFilterCat ? '' : 'כשתיק יירדם, מועד יתקרב בלי הכנה או דרישת תשלום תישאר פתוחה — זה יופיע כאן.'}</div></div>`}

    ${ocDismissedCount(db) ? `<div class="oc-muted-row">${ocDismissedCount(db)} ממצאים סומנו "טופל" ומוסתרים · <a href="#" onclick="ocClearDismissed();return false">הצג אותם שוב</a></div>` : ''}`;

  ocUpdateBadge(sum);
}

function aiRelTimeSafe(iso) { return typeof aiRelTime === 'function' ? aiRelTime(iso) : (iso || ''); }

function ocFindingHtml(f) {
  const i = ocLastFindings.indexOf(f);
  const sevLabel = { high: 'דחוף', normal: '', low: 'קל' }[f.severity];
  return `<div class="oc-item oc-sev-${f.severity}" style="--cat:${OC_CATEGORIES[f.cat].color}">
    <div class="oc-item-main">
      <div class="oc-item-title">${escapeHtml(f.title)} ${sevLabel ? `<span class="oc-sev">${sevLabel}</span>` : ''}</div>
      <div class="oc-item-detail">${escapeHtml(f.checkLabel)}${f.detail ? ' · ' + escapeHtml(f.detail) : ''}</div>
    </div>
    <div class="oc-item-actions">
      ${ocOpenButton(f)}
      ${f.taskId ? `<span class="oc-linked" title="נוצרה משימה">☑ במשימות</span>`
        : f.entityType !== 'task' ? `<button class="btn btn-sm" onclick="ocMakeTask(${i})">+ משימה</button>` : ''}
      ${f.ai ? `<button class="btn btn-sm" onclick="ocAskAI(${i})" title="שלח לעוזר ה-AI">✦ נסח</button>` : ''}
      <button class="btn btn-sm oc-dismiss" onclick="ocDismiss(${i})" title="הסתר ל-30 יום">טופל</button>
    </div>
  </div>`;
}

function ocOpenButton(f) {
  if (f.caseId && (f.entityType === 'case' || f.entityType === 'event' || f.entityType === 'statement' || f.entityType === 'task'))
    return `<button class="btn btn-sm btn-primary" onclick="openCaseDetail(${jsArg(f.caseId)})">פתח תיק</button>`;
  if (f.entityType === 'client') return `<button class="btn btn-sm btn-primary" onclick="openClientDetail(${jsArg(f.entityId)})">פתח לקוח</button>`;
  if (f.entityType === 'task') return `<button class="btn btn-sm btn-primary" onclick="nav('tasks',document.querySelectorAll('.nav-item')[3])">למשימות</button>`;
  if (f.entityType === 'doc') return `<button class="btn btn-sm btn-primary" onclick="nav('docs',document.querySelectorAll('.nav-item')[6])">למסמכים</button>`;
  if (f.entityType === 'lead') return `<button class="btn btn-sm btn-primary" onclick="if(typeof aiNav==='function'){nav('ai-center',document.getElementById('nav-ai-center-item'));aiNav('inbox')}">ללידים</button>`;
  return '';
}

function ocSettingsHtml() {
  const s = ocSettings(db);
  const byCat = {};
  for (const ch of OFFICE_CHECKS) (byCat[ch.cat] ||= []).push(ch);
  return `<div class="oc-settings">
    <div class="oc-settings-head">אילו בדיקות רצות ומתי. כל שינוי נשמר מיד.</div>
    ${Object.entries(byCat).map(([cat, list]) => `
      <div class="oc-settings-cat" style="--cat:${OC_CATEGORIES[cat].color}">${OC_CATEGORIES[cat].icon} ${OC_CATEGORIES[cat].label}</div>
      ${list.map(ch => { const cfg = s[ch.key]; return `
        <div class="oc-setting${cfg.enabled ? '' : ' off'}">
          <label class="oc-switch"><input type="checkbox" ${cfg.enabled ? 'checked' : ''} onchange="ocSetEnabled(${jsArg(ch.key)},this.checked)"><span></span></label>
          <div class="oc-setting-main">
            <div class="oc-setting-label">${escapeHtml(ch.label)}</div>
            <div class="oc-setting-desc">${escapeHtml(ch.describe(cfg))}</div>
          </div>
          ${ch.param ? `<div class="oc-setting-param"><input type="number" class="form-input" min="${ch.param.min || 0}" step="${ch.param.step || 1}"
              value="${cfg[ch.param.key]}" onchange="ocSetParam(${jsArg(ch.key)},${jsArg(ch.param.key)},this.value)"><span>${escapeHtml(ch.param.label)}</span></div>` : ''}
        </div>`; }).join('')}`).join('')}
  </div>`;
}

function ocDismissedCount(db) {
  const today = ocToday();
  return Object.values((db.checkState && db.checkState.dismissed) || {}).filter(d => d > today).length;
}

// ---------- פעולות מהממשק ----------

function ocRunNow() {
  const state = ocState(db);
  state.lastRunAt = new Date().toISOString();
  const findings = runOfficeChecks(db);
  saveDB().catch(() => {});
  renderOfficeChecks();
  notify(findings.length ? `נמצאו ${findings.length} ממצאים${findings.filter(f => f.severity === 'high').length ? `, ${findings.filter(f => f.severity === 'high').length} דחופים` : ''}` : 'המשרד נקי, אין ממצאים');
}

function ocSetCat(k) { ocFilterCat = k; renderOfficeChecks(); }
function ocToggleSettings() { ocShowSettings = !ocShowSettings; renderOfficeChecks(); }

function ocWriteSetting(key, patch) {
  if (!db.settings) db.settings = {};
  if (!db.settings.officeChecks) db.settings.officeChecks = {};
  db.settings.officeChecks[key] = Object.assign({}, db.settings.officeChecks[key] || {}, patch);
  saveDB().catch(() => {});
  renderOfficeChecks();
}
function ocSetEnabled(key, on) { ocWriteSetting(key, { enabled: !!on }); }
function ocSetParam(key, p, v) { ocWriteSetting(key, { [p]: Number(v) }); }

function ocMakeTask(i) {
  const f = ocLastFindings[i]; if (!f) return;
  const t = ocCreateTaskFromFinding(db, f);
  saveDB().catch(() => {});
  notify(`נוצרה משימה: ${t.text}`);
  renderOfficeChecks();
}

function ocDismiss(i) {
  const f = ocLastFindings[i]; if (!f) return;
  ocDismissFinding(db, f, 30);
  saveDB().catch(() => {});
  renderOfficeChecks();
}

function ocClearDismissed() {
  ocState(db).dismissed = {};
  saveDB().catch(() => {});
  renderOfficeChecks();
}

function ocAskAI(i) {
  const f = ocLastFindings[i]; if (!f || !f.ai) return;
  if (typeof toggleAgent !== 'function') return;
  const panel = document.getElementById('agent-panel');
  if (panel && !panel.classList.contains('open')) toggleAgent();
  const input = document.getElementById('agent-input');
  if (input) { input.value = f.ai; input.focus(); if (typeof agentGrow === 'function') agentGrow(input); }
}

// ---------- תג בסיידבר וכרטיס בלוח הבקרה ----------

function ocUpdateBadge(sum) {
  const badge = document.getElementById('auto-nav-badge');
  if (!badge) return;
  const n = sum ? sum.high : 0;
  badge.textContent = n || '';
  badge.style.display = n ? '' : 'none';
}

/** כרטיס "דורש בדיקה" בלוח הבקרה הראשי. נקרא מ-renderDashboard. */
function officeChecksDashboard() {
  const content = document.querySelector('#panel-dashboard .content');
  if (!content) return;
  let box = document.getElementById('oc-dash');
  if (!box) {
    box = document.createElement('div'); box.id = 'oc-dash';
    const agenda = document.getElementById('practice-agenda');
    if (agenda) agenda.insertAdjacentElement('afterend', box); else content.appendChild(box);
  }
  const findings = runOfficeChecks(db);
  const sum = ocSummary(findings);
  ocUpdateBadge(sum);
  const top = findings.slice(0, 5);
  box.innerHTML = `<div class="card oc-dash-card" onclick="nav('automations',document.getElementById('nav-automations-item'))">
    <div class="oc-dash-head">
      <div><span class="oc-dash-num${sum.total ? '' : ' oc-ok'}">${sum.total}</span> <span class="oc-dash-title">${sum.total ? 'ממצאים דורשים בדיקה' : 'בקרת משרד: נקי'}</span>
        ${sum.high ? `<span class="oc-sev">${sum.high} דחופים</span>` : ''}</div>
      <span class="oc-dash-link">לבקרת המשרד ›</span>
    </div>
    ${top.length ? `<div class="oc-dash-list">${top.map(f => `<div class="oc-dash-row" style="--cat:${OC_CATEGORIES[f.cat].color}">
        <span class="oc-dash-dot"></span><span class="oc-dash-text">${escapeHtml(f.title)}</span><span class="oc-dash-meta">${escapeHtml(f.checkLabel)}</span></div>`).join('')}
      ${sum.total > 5 ? `<div class="oc-dash-more">ועוד ${sum.total - 5}…</div>` : ''}</div>` : ''}
  </div>`;
}
