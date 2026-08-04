// מתזמן — מנקז את התור ומריץ אוטומציות (סעיף 14).
//
// ## למה זה קיים בכלל
// דרישה מרכזית בפרומט: "לעבוד גם כאשר המחשב של בעל המשרד כבוי". זה אפשרי
// רק אם משהו קורא לקוד הזה על טיימר, ללא דפדפן.
//
// ## מצב התזמון בפרויקט — ביושר
// pg_cron **אינו מופעל**. זה מתועד ב-check-and-send-reminders/index.ts:14
// ("couldn't enable that extension myself"). לכן הפונקציה הזו לא רצה מעצמה
// עדיין. שלוש דרכים להפעיל אותה, לפי סדר עדיפות — ראה AI_CENTER_DEPLOYMENT.md:
//   A. pg_cron (עדיף — SQL מסופק שם)
//   B. cron חיצוני (cron-job.org / GitHub Actions) שקורא ל-URL הזה
//   C. ניקוז מהדפדפן (aiDrainQueue ב-ai-center.js) — עובד היום, אבל רק
//      כשהאפליקציה פתוחה
//
// עד שA או B מופעלים, מסך ההגדרות מציג "תזמון: לא פעיל". לא מציגים מערכת
// כאוטונומית כשהיא לא (סעיף 29).
//
// Deploy: supabase functions deploy ai-cron --no-verify-jwt
// אבטחה: CRON_SECRET בכותרת x-cron-secret, או service_role key.

import { admin, loadOfficeDb, CrmDb, CrmCase } from '../_shared/db.ts';
import { json, preflight, errorResponse } from '../_shared/http.ts';
import { timingSafeEqual, stableHash } from '../_shared/crypto.ts';
import { audit } from '../_shared/audit.ts';
import { todayISO, addDaysISO, daysBetweenISO, heToISO } from '../_shared/security.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';

function authorized(req: Request): boolean {
  const auth = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (auth && timingSafeEqual(auth, SERVICE_ROLE_KEY)) return true;
  const secret = req.headers.get('x-cron-secret') || '';
  return !!CRON_SECRET && timingSafeEqual(secret, CRON_SECRET);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (!authorized(req)) return json({ error: 'לא מורשה' }, 401);

  const sb = admin();
  try {
    const body = await req.json().catch(() => ({}));
    const tasks = (body.tasks as string[]) || ['reap', 'drain', 'automations', 'learn'];
    const out: Record<string, unknown> = {};

    // 1. שחרור jobs שננעלו ע"י worker שמת (deploy באמצע, timeout).
    if (tasks.includes('reap')) {
      const { data, error } = await sb.rpc('reap_stale_ai_jobs', { stale_minutes: 10 });
      out.reaped = error ? { error: error.message } : data;
    }

    // 2. הרצת האוטומציות — לפני הניקוז, כדי שמה שהן יוצרות ייקלט באותה סבב.
    if (tasks.includes('automations')) {
      out.automations = await runAutomations(sb);
    }

    // 3. ניקוז התור.
    if (tasks.includes('drain')) {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/ai-worker`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_ROLE_KEY}` },
        body: JSON.stringify({ batch: 5, source: 'cron' }),
      });
      out.drained = await resp.json().catch(() => ({ error: 'worker לא החזיר JSON' }));
    }

    // 4. תפוגת אישורים ישנים. מותנה ב-'reap' ולא ב-'automations': תפוגה
    //    היא תחזוקה, ואין לה שום קשר למנוע האוטומציות.
    if (tasks.includes('reap')) {
      const { data: expired } = await sb.from('ai_approvals')
        .update({ status: 'expired' })
        .eq('status', 'pending').lt('expires_at', new Date().toISOString())
        .select('id');
      out.expired_approvals = expired?.length || 0;
    }

    // 5. לולאת הלמידה — אחרונה בכוונה: היא קוראת את האישורים שנוצרו
    //    בסבבים קודמים, ולכן אין טעם להריץ אותה לפני שהתור התנקז.
    //    רצה בתדירות נמוכה (ברירת מחדל: פעם ב-6 שעות) כי זיקוק עולה כסף
    //    והדפוסים ממילא נצברים לאט.
    if (tasks.includes('learn')) {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/ai-learn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_ROLE_KEY}` },
        body: JSON.stringify({}),
      });
      out.learned = await resp.json().catch(() => ({ error: 'ai-learn לא החזיר JSON' }));
    }

    return json({ ok: true, at: new Date().toISOString(), ...out });
  } catch (e) {
    return errorResponse(e);
  }
});

// ============================================================
// מנוע האוטומציות
// ============================================================
//
// כל אוטומציה = Trigger + Conditions + Actions (סעיף 14). ה-trigger מספק
// "נושאים" (subjects) — תיק, לקוח, ליד — התנאים מסננים אותם, וכל נושא
// ששרד הופך ל-job.
//
// **מפתח ה-idempotency נגזר מהנושא ומהיום**, ולכן אוטומציה שרצה כל 5 דקות
// לא תיצור 288 jobs זהים ביום על אותו תיק. זה מה שהופך את המנוע לבטוח
// להרצה תכופה — בלי זה כל טעות בתזמון הופכת להצפה של הרצות בתשלום.

type AutomationRule = {
  id: string; office_id: string; name: string;
  trigger_type: string; trigger_config: Record<string, unknown>;
  conditions: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
  requires_approval: boolean;
};

async function runAutomations(sb: ReturnType<typeof admin>) {
  const { data: rules, error } = await sb.from('automation_rules')
    .select('*').eq('is_active', true);
  if (error) return { error: error.message };
  if (!rules?.length) return { rules: 0, jobs: 0 };

  // מקבצים לפי משרד כדי לטעון את ה-blob פעם אחת לכל משרד ולא לכל כלל.
  const byOffice = new Map<string, AutomationRule[]>();
  for (const r of rules as AutomationRule[]) {
    if (!byOffice.has(r.office_id)) byOffice.set(r.office_id, []);
    byOffice.get(r.office_id)!.push(r);
  }

  let jobsCreated = 0;
  const details: unknown[] = [];

  for (const [officeId, officeRules] of byOffice) {
    const { data: settings } = await sb.from('ai_settings')
      .select('emergency_stop, automations_paused').eq('office_id', officeId).maybeSingle();
    if (settings?.emergency_stop || settings?.automations_paused) {
      details.push({ office: officeId, skipped: 'אוטומציות מושהות' });
      continue;
    }

    const db = await loadOfficeDb(sb, officeId);

    for (const rule of officeRules) {
      try {
        const subjects = collectSubjects(rule, db);
        const passing = subjects.filter((s) => matchesConditions(s, rule.conditions, db));
        const cap = Number(rule.trigger_config?.max_per_run) || 10;

        for (const subject of passing.slice(0, cap)) {
          // האינדקס מועבר ומשתתף במפתח ה-idempotency. בלעדיו כל הפעולות
          // של אותו כלל על אותו נושא היו מייצרות מפתח זהה, והפעולה השנייה
          // ואילך היו נופלות על 23505 ונבלעות כ"כבר קיים היום" — כלומר
          // כלל עם שתי פעולות היה מריץ רק את הראשונה, לתמיד, בלי שגיאה.
          for (let ai = 0; ai < rule.actions.length; ai++) {
            const created = await enqueueAction(sb, officeId, rule, rule.actions[ai], subject, ai);
            if (created) jobsCreated++;
          }
        }

        await sb.from('automation_rules').update({
          last_run_at: new Date().toISOString(),
          last_run_status: `נמצאו ${passing.length} פריטים`,
          run_count: (rule as Record<string, any>).run_count + 1 || 1,
        }).eq('id', rule.id);

        details.push({ rule: rule.name, matched: passing.length });
      } catch (e) {
        console.error('[cron] rule failed', rule.name, e);
        await sb.from('automation_rules').update({
          last_run_at: new Date().toISOString(),
          last_run_status: 'שגיאה: ' + (e instanceof Error ? e.message : String(e)),
        }).eq('id', rule.id);
      }
    }
  }
  return { rules: rules.length, jobs: jobsCreated, details };
}

type Subject = {
  kind: 'matter' | 'client' | 'lead' | 'office';
  id: string; label: string;
  clientId?: string | null; matterId?: string | null;
  meta: Record<string, unknown>;
};

function collectSubjects(rule: AutomationRule, db: CrmDb): Subject[] {
  const cfg = rule.trigger_config || {};
  const today = todayISO();

  switch (rule.trigger_type) {
    // "סיכום בוקר" — נושא יחיד: המשרד עצמו.
    case 'daily_digest': {
      const hour = Number(cfg.hour ?? 8);
      const nowHour = Number(new Date().toLocaleString('en-US',
        { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }));
      // חלון של שעה: ה-cron רץ כל 5 דק', וה-idempotency היומי מונע כפילות.
      if (nowHour < hour || nowHour > hour + 1) return [];
      return [{ kind: 'office', id: 'office', label: 'סיכום יומי', meta: {} }];
    }

    case 'deadline_approaching': {
      const days = Number(cfg.days ?? 7);
      const until = addDaysISO(today, days);
      return db.events
        .filter((e) => e.date >= today && e.date <= until)
        .map((e) => ({
          kind: 'matter' as const, id: e.id,
          label: `מועד: ${e.title} (${e.date})`,
          matterId: e.caseId || null,
          clientId: db.cases.find((c) => c.id === e.caseId)?.client || null,
          meta: { eventId: e.id, date: e.date, title: e.title, type: e.type },
        }));
    }

    case 'matter_inactive': {
      const days = Number(cfg.days ?? 14);
      return db.cases
        .filter((c) => c.status !== 'closed')
        .filter((c) => (idleDays(c) ?? 999) > days)
        .map((c) => ({
          kind: 'matter' as const, id: c.id, label: `תיק ללא פעילות: ${c.name}`,
          matterId: c.id, clientId: c.client || null,
          meta: { idleDays: idleDays(c), name: c.name },
        }));
    }

    case 'payment_overdue': {
      const min = Number(cfg.min_balance ?? 1000);
      return db.cases
        .filter((c) => c.status !== 'closed')
        .map((c) => {
          const collected = db.payments
            .filter((p) => p.caseId === c.id && p.type === 'debt')
            .reduce((s, p) => s + (Number(p.amount) || 0), 0);
          return { c, balance: (Number(c.amount) || 0) - collected };
        })
        .filter((r) => r.balance >= min)
        .map((r) => ({
          kind: 'matter' as const, id: r.c.id, label: `יתרה פתוחה: ${r.c.name}`,
          matterId: r.c.id, clientId: r.c.client || null,
          meta: { balance: r.balance, name: r.c.name },
        }));
    }

    case 'client_no_update': {
      const days = Number(cfg.days ?? 30);
      return db.clients
        .filter((cl) => db.cases.some((c) => c.client === cl.id && c.status !== 'closed'))
        .filter((cl) => {
          const cases = db.cases.filter((c) => c.client === cl.id);
          const idle = cases.map((c) => idleDays(c) ?? 999);
          return idle.length > 0 && Math.min(...idle) > days;
        })
        .map((cl) => ({
          kind: 'client' as const, id: cl.id, label: `לקוח ללא עדכון: ${cl.name}`,
          clientId: cl.id, meta: { name: cl.name },
        }));
    }

    case 'new_lead': {
      return db.leads
        .filter((l) => !l.status || l.status === 'new')
        .filter((l) => l.score === undefined || l.score === null)   // טרם נוקד
        .map((l) => ({
          kind: 'lead' as const, id: l.id, label: `ליד חדש: ${l.name}`,
          meta: { leadId: l.id, name: l.name, source: l.source },
        }));
    }

    case 'document_unanalyzed': {
      return db.docs
        .filter((d) => d.filePath && !d.aiAnalyzedAt)
        .slice(0, 20)
        .map((d) => ({
          kind: 'matter' as const, id: d.id, label: `מסמך שטרם נותח: ${d.name}`,
          matterId: d.caseId || null,
          meta: { documentId: d.id, name: d.name },
        }));
    }

    case 'task_overdue': {
      return db.tasks
        .filter((t) => !t.done && t.due && t.due < today)
        .map((t) => ({
          kind: 'matter' as const, id: t.id, label: `משימה באיחור: ${t.text}`,
          matterId: t.caseId || null,
          meta: { taskId: t.id, text: t.text, due: t.due,
                  daysLate: daysBetweenISO(String(t.due), today) },
        }));
    }

    default:
      return [];
  }
}

function idleDays(c: CrmCase): number | null {
  const diary = Array.isArray(c.diary) ? c.diary : [];
  if (!diary.length) return null;
  const isos = diary.map((d) => heToISO(d.date)).filter(Boolean) as string[];
  if (!isos.length) return null;
  isos.sort();
  return daysBetweenISO(isos[isos.length - 1], todayISO());
}

/** תנאים: [{field, op, value}]. AND בין כולם. */
function matchesConditions(
  s: Subject, conditions: Array<Record<string, unknown>>, db: CrmDb,
): boolean {
  if (!conditions?.length) return true;
  const c = s.matterId ? db.cases.find((x) => x.id === s.matterId) : null;
  const cl = s.clientId ? db.clients.find((x) => x.id === s.clientId) : null;
  const lead = s.kind === 'lead' ? db.leads.find((x) => x.id === s.id) : null;

  return conditions.every((cond) => {
    const field = String(cond.field || '');
    const op = String(cond.op || 'eq');
    const want = cond.value;

    const actual =
      field.startsWith('matter.') ? (c as Record<string, unknown> | null)?.[field.slice(7)]
      : field.startsWith('client.') ? (cl as Record<string, unknown> | null)?.[field.slice(7)]
      : field.startsWith('lead.') ? (lead as Record<string, unknown> | null)?.[field.slice(5)]
      : s.meta[field];

    switch (op) {
      case 'eq': return String(actual ?? '') === String(want ?? '');
      case 'neq': return String(actual ?? '') !== String(want ?? '');
      case 'gt': return Number(actual) > Number(want);
      case 'gte': return Number(actual) >= Number(want);
      case 'lt': return Number(actual) < Number(want);
      case 'lte': return Number(actual) <= Number(want);
      case 'in': return Array.isArray(want) && want.map(String).includes(String(actual));
      case 'contains': return String(actual ?? '').includes(String(want ?? ''));
      case 'exists': return actual !== undefined && actual !== null && actual !== '';
      case 'empty': return actual === undefined || actual === null || actual === '';
      default: return true;
    }
  });
}

async function enqueueAction(
  sb: ReturnType<typeof admin>, officeId: string,
  rule: AutomationRule, action: Record<string, unknown>, subject: Subject,
  actionIndex: number,
): Promise<boolean> {
  const agentSlug = String(action.agent || 'office-manager');
  const { data: agent } = await sb.from('ai_agents')
    .select('id').eq('office_id', officeId).eq('slug', agentSlug)
    .eq('status', 'active').maybeSingle();
  if (!agent) return false;

  // המפתח כולל את היום, ולכן אותו נושא לא ייווצר פעמיים באותו יום גם אם
  // ה-cron רץ כל 5 דקות. זה הלב של בטיחות המנוע הזה.
  const key = await stableHash(
    'automation', rule.id, actionIndex, String(action.job_type || ''),
    subject.kind, subject.id, todayISO());

  const { error } = await sb.from('ai_jobs').insert({
    office_id: officeId, agent_id: agent.id,
    job_type: String(action.job_type || 'automation_task'),
    client_id: subject.clientId || null, matter_id: subject.matterId || null,
    priority: Number(action.priority) || 6,
    status: 'queued', trigger_type: 'automation',
    idempotency_key: key,
    payload: {
      goal: String(action.goal || rule.name),
      automation_rule: rule.name, automation_id: rule.id,
      subject: { kind: subject.kind, id: subject.id, label: subject.label, ...subject.meta },
    },
  });

  // 23505 = המפתח כבר קיים היום. זו התנהגות תקינה ולא שגיאה.
  if (error && error.code !== '23505') {
    console.error('[cron] enqueue failed', error);
    return false;
  }
  if (error) return false;

  await audit(sb, {
    officeId, actorType: 'automation', actorId: rule.id,
    action: 'automation_triggered', entityType: 'automation_rule', entityId: rule.id,
    matterId: subject.matterId, clientId: subject.clientId,
    after: { rule: rule.name, subject: subject.label },
  });
  return true;
}
