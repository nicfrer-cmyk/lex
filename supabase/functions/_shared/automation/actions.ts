// רישום הפעולות של מרכז האוטומציות (סעיף 5 במפרט).
//
// ## למה זה הקובץ החשוב במודול
// עד היום אוטומציה ידעה לעשות דבר אחד: להעיר סוכן AI. כלומר כל אוטומציה
// עלתה כסף, כל תוצאה הייתה טקסט של מודל, וכל דבר קטן — "פתח משימה",
// "שנה סטטוס" — עבר דרך קריאה לענן. רוב הפעולות במפרט אינן דורשות מודל
// כלל. הרישום כאן הוא המנוע הדטרמיניסטי שרץ **לצד** הסוכנים, לא במקומם.
//
// ## שלוש רמות ביצוע (סעיף 6)
//   notify  — הפעולה לא מבוצעת, רק מתועדת ומתריעה
//   prepare — נוצרת רשומה ב-ai_approvals וממתינה לאדם
//   auto    — מבוצעת מיד
//
// ## המחסום
// `sensitive: true` פירושו שהפעולה **לעולם** לא תרוץ ב-auto, גם אם המשתמש
// הגדיר כך. אותו עיקרון של ALWAYS_APPROVE ב-approvals.ts: הנחיה מנחה, קוד
// אוכף. במערכת שמפיקה מסמכים משפטיים ומזיזה כסף, הגדרה שגויה במסך אינה
// יכולה להיות מרחק של קליק מפעולה בלתי הפיכה.

// ⚠ ייבוא טיפוסים בלבד בראש הקובץ, ו-saveOfficeDb נטען דינמית בתוך
// הפעולות שצריכות אותו.
//
// db.ts מושך את supabase-js מ-https://esm.sh בזמן טעינת המודול. ייבוא
// רגיל היה הופך את קובץ הפעולות לבלתי ניתן לבדיקה ב-Node — וזה הקובץ
// שקובע מה מותר לרוץ אוטומטית על תיקים משפטיים. הוא **חייב** להיבדק.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import type { CrmDb } from '../db.ts';

/** זהה ל-uid() ב-db.ts ובדפדפן: base36, לא uuid. חייב להישאר תואם. */
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

/** נטען רק כשפעולה באמת כותבת ל-blob. */
async function writeDb(sb: SupabaseClient, officeId: string, mutate: (d: CrmDb) => void) {
  const { saveOfficeDb } = await import('../db.ts');
  return saveOfficeDb(sb, officeId, mutate);
}

export type ExecLevel = 'notify' | 'prepare' | 'auto';

export type ActionCtx = {
  sb: SupabaseClient;
  officeId: string;
  runId: string;
  ruleId: string | null;
  ruleName: string;
  /** ה-blob, כבר טעון. פעולות קוראות ממנו וכותבות דרך saveOfficeDb. */
  db: CrmDb;
  /** הישות שהטריגר מצא. */
  subject: {
    entityType: string; entityId: string; label: string;
    clientId?: string | null; matterId?: string | null;
    data: Record<string, unknown>;
  };
  reason: string;
  /** ב-dry run שום פעולה לא נוגעת בנתונים. */
  dryRun: boolean;
};

export type ActionResult = {
  status: 'executed' | 'awaiting_approval' | 'skipped' | 'dry_run' | 'failed';
  message: string;
  data?: Record<string, unknown>;
};

export type ActionDef = {
  type: string;
  label: string;
  category: 'task' | 'matter' | 'notify' | 'comms' | 'finance' | 'ai' | 'system';
  description: string;
  /** לעולם לא ב-auto. */
  sensitive: boolean;
  /** דקות עבודה אנושית שנחסכו (סעיף 22). */
  minutesSaved: number;
  /** ישויות/שדות שחייבים להתקיים. ריק = עובד על המערכת כמו שהיא. */
  requires?: string[];
  /** תיאור למצב בדיקה — מה **היה** קורה. חייב לא לגעת בכלום. */
  describe: (cfg: Record<string, unknown>, ctx: ActionCtx) => string;
  run: (cfg: Record<string, unknown>, ctx: ActionCtx) => Promise<ActionResult>;
};

// ============================================================
// עזרים
// ============================================================

/** תבנית טקסט: {{subject.label}}, {{reason}}, {{matter.name}} */
export function render(tpl: string, ctx: ActionCtx): string {
  return String(tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const src: Record<string, unknown> = {
      subject: ctx.subject, reason: ctx.reason, rule: ctx.ruleName,
      matter: ctx.subject.data, client: ctx.subject.data,
      today: new Date().toISOString().slice(0, 10),
    };
    let cur: unknown = src;
    for (const p of path.split('.')) {
      if (cur == null || typeof cur !== 'object') return '';
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur == null ? '' : String(cur);
  });
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const todayISO = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

/**
 * יצירת רשומת אישור.
 *
 * משתמשת ב-`ai_approvals` הקיימת ולא בטבלה חדשה. שני מרכזי אישורים
 * מקבילים היו מפצלים את תשומת הלב של עורך הדין בין שני מסכים — וכל דבר
 * שמפצל תשומת לב במערכת אישורים הופך אותה בסופו של דבר לחותמת גומי.
 */
async function propose(
  ctx: ActionCtx, actionType: string, label: string,
  payload: Record<string, unknown>, risk: string, content?: string,
): Promise<ActionResult> {
  if (ctx.dryRun) {
    return { status: 'dry_run', message: `היה נוצר אישור ממתין: ${label}` };
  }
  const { data, error } = await ctx.sb.from('ai_approvals').insert({
    office_id: ctx.officeId,
    client_id: ctx.subject.clientId || null,
    matter_id: ctx.subject.matterId || null,
    action_type: actionType, action_label: label,
    proposed_payload: payload, proposed_content: content || null,
    risk_level: risk, status: 'pending',
    reason_required: ctx.reason,
    source: 'automation', automation_run_id: ctx.runId,
  }).select('id').single();

  if (error) return { status: 'failed', message: 'יצירת האישור נכשלה: ' + error.message };
  return { status: 'awaiting_approval', message: `נוצר אישור ממתין: ${label}`, data: { approvalId: data.id } };
}

async function notify(
  ctx: ActionCtx, level: string, title: string, body: string,
  dedupe: string, recipients?: unknown,
): Promise<ActionResult> {
  if (ctx.dryRun) return { status: 'dry_run', message: `היתה נשלחת התראה: ${title}` };

  const link = ctx.subject.matterId ? { type: 'case', id: ctx.subject.matterId }
    : ctx.subject.clientId ? { type: 'client', id: ctx.subject.clientId }
    : null;

  // ⚠ ignoreDuplicates ולא זריקה: התנגשות על dedupe_key היא **המטרה**
  // של המנגנון, לא תקלה. בלי זה, תיק תקוע היה מייצר שגיאה בלוג כל טיק.
  const { error } = await ctx.sb.from('automation_notifications').upsert({
    office_id: ctx.officeId, automation_run_id: ctx.runId, rule_id: ctx.ruleId,
    level, title, body, link,
    target_role: typeof recipients === 'string' ? recipients : null,
    dedupe_key: dedupe,
  }, { onConflict: 'office_id,dedupe_key', ignoreDuplicates: true });

  if (error) return { status: 'failed', message: error.message };
  return { status: 'executed', message: title };
}

// ============================================================
// הפעולות
// ============================================================

export const ACTIONS: ActionDef[] = [

  // ---------- משימות ----------
  {
    type: 'create_task',
    label: 'יצירת משימה',
    category: 'task',
    description: 'פותח משימה חדשה ומשייך אותה לתיק.',
    sensitive: false,
    minutesSaved: 4,
    describe: (cfg, ctx) =>
      `היתה נפתחת משימה: "${render(String(cfg.text || ''), ctx)}"` +
      (cfg.due_in_days ? ` ליום ${addDays(todayISO(), Number(cfg.due_in_days))}` : ''),
    run: async (cfg, ctx) => {
      const text = render(String(cfg.text || ''), ctx).trim();
      if (!text) return { status: 'failed', message: 'חסר תיאור למשימה' };
      if (ctx.dryRun) return { status: 'dry_run', message: `היתה נפתחת משימה: "${text}"` };

      const matterId = ctx.subject.matterId || '';

      // ⚠ מניעת כפילות ברמת הנתונים ולא רק ברמת ה-run.
      //
      // ה-cooldown מונע הפעלה חוזרת של הכלל, אבל שני כללים שונים (או כלל
      // שנערך ואיבד את ה-dedupe הקודם) עדיין היו יוצרים שתי משימות זהות
      // באותו תיק. משימות כפולות הן בדיוק מה שגורם לאדם להפסיק לסמוך על
      // רשימת המשימות שלו.
      const dup = ctx.db.tasks.find((t) =>
        !t.done && t.caseId === matterId && t.text === text);
      if (dup) return { status: 'skipped', message: 'משימה זהה כבר פתוחה בתיק' };

      const task = {
        id: uid(), text,
        due: cfg.due_in_days ? addDays(todayISO(), Number(cfg.due_in_days)) : '',
        caseId: matterId,
        priority: String(cfg.priority || 'normal'),
        notes: render(String(cfg.notes || ''), ctx),
        done: false,
        createdByAutomation: ctx.ruleName,
      };
      await writeDb(ctx.sb, ctx.officeId, (d) => { d.tasks.unshift(task); });
      return { status: 'executed', message: `נפתחה משימה: ${text}`, data: { taskId: task.id } };
    },
  },

  {
    type: 'set_task_priority',
    label: 'שינוי עדיפות משימה',
    category: 'task',
    description: 'מעלה או מוריד את עדיפות המשימה שהטריגר מצא.',
    sensitive: false,
    minutesSaved: 1,
    describe: (cfg) => `עדיפות המשימה היתה משתנה ל-${cfg.priority}`,
    run: async (cfg, ctx) => {
      if (ctx.subject.entityType !== 'task') {
        return { status: 'skipped', message: 'הפעולה חלה על משימות בלבד' };
      }
      const pri = String(cfg.priority || 'urgent');
      if (ctx.dryRun) return { status: 'dry_run', message: `העדיפות היתה משתנה ל-${pri}` };

      let changed = false;
      await writeDb(ctx.sb, ctx.officeId, (d) => {
        const t = d.tasks.find((x) => x.id === ctx.subject.entityId);
        if (t && t.priority !== pri) { t.priority = pri; changed = true; }
      });
      return changed
        ? { status: 'executed', message: `העדיפות שונתה ל-${pri}` }
        : { status: 'skipped', message: 'העדיפות כבר במצב הרצוי' };
    },
  },

  // ---------- תיקים ----------
  {
    type: 'add_case_diary',
    label: 'רישום ביומן התיק',
    category: 'matter',
    description: 'מוסיף רשומה ליומן התיק. זהו התיעוד שמסביר בדיעבד למה נעשתה פעולה.',
    sensitive: false,
    minutesSaved: 2,
    describe: (cfg, ctx) => `היתה נרשמת ביומן: "${render(String(cfg.text || ''), ctx)}"`,
    run: async (cfg, ctx) => {
      const matterId = ctx.subject.matterId;
      if (!matterId) return { status: 'skipped', message: 'אין תיק משויך' };
      const text = render(String(cfg.text || ''), ctx).trim();
      if (!text) return { status: 'failed', message: 'חסר טקסט לרישום' };
      if (ctx.dryRun) return { status: 'dry_run', message: `היה נרשם ביומן: "${text}"` };

      await writeDb(ctx.sb, ctx.officeId, (d) => {
        const c = d.cases.find((x) => x.id === matterId);
        if (!c) return;
        if (!Array.isArray(c.diary)) c.diary = [];
        c.diary.push({ date: todayISO(), text: `[אוטומציה] ${text}` });
      });
      return { status: 'executed', message: 'נרשם ביומן התיק' };
    },
  },

  {
    type: 'set_case_status',
    label: 'שינוי סטטוס תיק',
    category: 'matter',
    // ⚠ רגיש: סטטוס תיק מזין דוחות, גבייה וסינון. שינוי אוטומטי שגוי
    // "מעלים" תיק פעיל מכל המסכים בלי שאיש שם לב.
    sensitive: true,
    description: 'משנה את סטטוס התיק. דורש אישור תמיד.',
    minutesSaved: 2,
    describe: (cfg, ctx) => `סטטוס התיק "${ctx.subject.label}" היה משתנה ל-${cfg.status}`,
    run: async (cfg, ctx) => {
      const matterId = ctx.subject.matterId;
      if (!matterId) return { status: 'skipped', message: 'אין תיק משויך' };
      return propose(ctx, 'update_case', `שינוי סטטוס תיק ל-${cfg.status}`,
        { caseId: matterId, status: cfg.status }, 'medium');
    },
  },

  // ---------- יומן ----------
  {
    type: 'create_event',
    label: 'יצירת אירוע ביומן',
    category: 'matter',
    description: 'קובע אירוע או תזכורת ביומן התיק.',
    sensitive: false,
    minutesSaved: 3,
    describe: (cfg, ctx) =>
      `היה נוצר אירוע: "${render(String(cfg.title || ''), ctx)}" בעוד ${cfg.in_days || 0} ימים`,
    run: async (cfg, ctx) => {
      const title = render(String(cfg.title || ''), ctx).trim();
      if (!title) return { status: 'failed', message: 'חסרה כותרת לאירוע' };
      const date = addDays(todayISO(), Number(cfg.in_days || 0));
      if (ctx.dryRun) return { status: 'dry_run', message: `היה נוצר אירוע "${title}" ל-${date}` };

      const ev = {
        id: uid(), title, date, time: String(cfg.time || ''),
        location: '', type: String(cfg.type || 'תזכורת'),
        caseId: ctx.subject.matterId || '', notes: ctx.reason.slice(0, 500),
      };
      await writeDb(ctx.sb, ctx.officeId, (d) => { d.events.push(ev); });
      return { status: 'executed', message: `נוצר אירוע ל-${date}`, data: { eventId: ev.id } };
    },
  },

  // ---------- התראות ----------
  {
    type: 'notify',
    label: 'התראה במערכת',
    category: 'notify',
    description: 'מציג התראה במרכז ההתראות ומקשר לתיק או ללקוח.',
    sensitive: false,
    minutesSaved: 3,
    describe: (cfg, ctx) => `היתה מוצגת התראה: "${render(String(cfg.title || ''), ctx)}"`,
    run: (cfg, ctx) => notify(
      ctx, String(cfg.level || 'info'),
      render(String(cfg.title || ctx.ruleName), ctx),
      render(String(cfg.body || ctx.reason), ctx),
      `${ctx.ruleId}:${ctx.subject.entityId}:${todayISO()}`,
      cfg.role,
    ),
  },

  {
    type: 'escalate',
    label: 'הסלמה למנהל',
    category: 'notify',
    description: 'מסמן שהעניין לא טופל בזמן ומעביר אותו לבעל המשרד.',
    sensitive: false,
    minutesSaved: 5,
    describe: (_c, ctx) => `היתה נשלחת הסלמה לבעל המשרד על "${ctx.subject.label}"`,
    run: (cfg, ctx) => notify(
      ctx, 'escalation',
      `הסלמה: ${render(String(cfg.title || ctx.subject.label), ctx)}`,
      ctx.reason, `esc:${ctx.ruleId}:${ctx.subject.entityId}`, 'owner',
    ),
  },

  // ---------- תקשורת ----------
  {
    type: 'draft_message',
    label: 'הכנת טיוטת הודעה',
    category: 'comms',
    // ⚠ רגיש: הודעה יוצאת ללקוח היא מסמך שיוצא מהמשרד בשמו.
    sensitive: true,
    description: 'מכין טיוטת הודעה ללקוח וממתין לאישור. לעולם לא נשלח אוטומטית.',
    minutesSaved: 8,
    describe: (cfg, ctx) => `היתה מוכנה טיוטת ${cfg.channel || 'הודעה'} אל ${ctx.subject.label}`,
    run: (cfg, ctx) => propose(
      ctx, 'send_message',
      `טיוטת ${cfg.channel === 'whatsapp' ? 'וואטסאפ' : 'הודעה'} — ${ctx.subject.label}`,
      { channel: cfg.channel || 'whatsapp', clientId: ctx.subject.clientId, matterId: ctx.subject.matterId },
      'high', render(String(cfg.body || ''), ctx),
    ),
  },

  // ---------- AI ----------
  {
    type: 'invoke_agent',
    label: 'הפעלת סוכן AI',
    category: 'ai',
    description: 'מעיר סוכן שיכתוב, ינתח או יסכם. זו הפעולה היחידה כאן שעולה כסף.',
    sensitive: false,
    minutesSaved: 15,
    describe: (cfg, ctx) => `היה מופעל הסוכן "${cfg.agent}" על "${ctx.subject.label}"`,
    run: async (cfg, ctx) => {
      if (ctx.dryRun) return { status: 'dry_run', message: `היה מופעל הסוכן ${cfg.agent}` };

      // עצירת חירום נבדקת גם כאן ולא רק במנוע: זו הפעולה היחידה שמוציאה
      // כסף, וכיבוי הסוכנים חייב לעצור אותה בכל נתיב אפשרי.
      const { data: st } = await ctx.sb.from('ai_settings')
        .select('emergency_stop, automations_paused').eq('office_id', ctx.officeId).maybeSingle();
      if (st?.emergency_stop || st?.automations_paused) {
        return { status: 'skipped', message: 'סוכני ה-AI מושהים' };
      }

      const { data: agent } = await ctx.sb.from('ai_agents')
        .select('id').eq('office_id', ctx.officeId).eq('slug', String(cfg.agent))
        .eq('status', 'active').maybeSingle();
      if (!agent) return { status: 'skipped', message: `הסוכן "${cfg.agent}" אינו פעיל` };

      const { error } = await ctx.sb.from('ai_jobs').insert({
        office_id: ctx.officeId, agent_id: agent.id,
        job_type: String(cfg.job_type || 'automation_task'),
        client_id: ctx.subject.clientId || null, matter_id: ctx.subject.matterId || null,
        priority: Number(cfg.priority) || 6, status: 'queued', trigger_type: 'automation',
        idempotency_key: `auto:${ctx.runId}:${cfg.agent}`,
        payload: { goal: render(String(cfg.goal || ctx.ruleName), ctx), subject: ctx.subject },
      });
      if (error && error.code !== '23505') return { status: 'failed', message: error.message };
      return { status: 'executed', message: `הסוכן "${cfg.agent}" הוזמן` };
    },
  },

  // ---------- מערכת ----------
  {
    type: 'webhook',
    label: 'קריאה ל-webhook',
    category: 'system',
    sensitive: true,
    description: 'שולח POST לכתובת חיצונית. דורש אישור — מוציא מידע מהמשרד.',
    minutesSaved: 2,
    describe: (cfg) => `היתה נשלחת קריאה ל-${cfg.url}`,
    run: async (cfg, ctx) => {
      if (ctx.dryRun) return { status: 'dry_run', message: `היתה נשלחת קריאה ל-${cfg.url}` };
      const url = String(cfg.url || '');
      // ⚠ https בלבד. webhook ב-http שולח פרטי לקוח בטקסט גלוי.
      if (!/^https:\/\//i.test(url)) {
        return { status: 'failed', message: 'כתובת webhook חייבת להיות https' };
      }
      try {
        const r = await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rule: ctx.ruleName, reason: ctx.reason, subject: ctx.subject }),
          signal: AbortSignal.timeout(10000),
        });
        return r.ok
          ? { status: 'executed', message: `webhook הוחזר ${r.status}` }
          : { status: 'failed', message: `webhook החזיר ${r.status}` };
      } catch (e) {
        return { status: 'failed', message: 'webhook נכשל: ' + (e instanceof Error ? e.message : String(e)) };
      }
    },
  },
];

export const ACTION_MAP = new Map(ACTIONS.map((a) => [a.type, a]));

/**
 * רמת הביצוע בפועל.
 *
 * ⚠ זו הפונקציה שאוכפת את המחסום. פעולה רגישה יורדת מ-auto ל-prepare
 * **תמיד**, ללא קשר להגדרה. המשתמש יכול להחמיר ולא להקל.
 */
export function effectiveLevel(action: ActionDef, configured: ExecLevel): ExecLevel {
  if (configured === 'auto' && action.sensitive) return 'prepare';
  return configured;
}
