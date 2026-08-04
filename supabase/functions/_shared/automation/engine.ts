// המנוע של מרכז האוטומציות.
//
// טריגר → תנאים → פעולות → לוג → מדדים. הכל כאן, ב-Edge Function אחת,
// כי אין טבלאות ל-CRM וכל בדיקה מחייבת את ה-blob בזיכרון.
//
// ## מה שומר על זה מלהפוך למטרד
// ארבעה מנגנונים, וכל אחד מהם קיים בגלל כשל ספציפי:
//   activation_grace_at — לא לפעול על היסטוריה ברגע ההדלקה
//   cooldown_minutes    — לא להתריע כל יום על אותו תיק תקוע
//   deduplication_key   — לא לבצע אותה פעולה פעמיים
//   failure_count       — כלל שבור מכבה את עצמו במקום למלא את הלוג
//
// בלי ארבעתם, מערכת אוטומציות במשרד עורכי דין הופכת תוך שבוע למקור רעש
// שמתעלמים ממנו — וזה גרוע יותר מלא להתקין אותה בכלל.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { CrmDb, loadOfficeDb } from '../db.ts';
import { evaluate, explainResult, inQuietHours } from './conditions.ts';
import { TRIGGER_MAP, Subject, TriggerExtra } from './triggers.ts';
import { ACTION_MAP, ActionCtx, effectiveLevel, ExecLevel } from './actions.ts';
import { stableHash } from '../crypto.ts';

export type Rule = {
  id: string; office_id: string; name: string; description: string;
  trigger_type: string; trigger_config: Record<string, unknown>;
  conditions: unknown; actions: Array<Record<string, unknown>>;
  is_active: boolean; execution_level: ExecLevel; severity: string;
  cooldown_minutes: number; quiet_hours: Record<string, unknown> | null;
  activation_grace_at: string | null; paused_until: string | null;
  max_actions_per_run: number; estimated_minutes_saved: number;
  failure_count: number; version: number; recipients: unknown;
};

export type RunOutcome = {
  rule: string;
  ruleId: string;
  matched: number;
  processed: number;
  skipped: number;
  runs: string[];
  error?: string;
};

const todayISO = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

/** מעל כמה כשלים רצופים כלל מכבה את עצמו. */
const MAX_FAILURES = 5;

// ============================================================

export async function runRule(
  sb: SupabaseClient, rule: Rule, db: CrmDb, extra: TriggerExtra,
  opts: { dryRun?: boolean; now?: Date; costPerHour?: number } = {},
): Promise<RunOutcome> {
  const now = opts.now || new Date();
  const dryRun = !!opts.dryRun;
  const out: RunOutcome = { rule: rule.name, ruleId: rule.id, matched: 0, processed: 0, skipped: 0, runs: [] };

  const trigger = TRIGGER_MAP.get(rule.trigger_type);
  if (!trigger) {
    out.error = `טריגר לא מוכר: ${rule.trigger_type}`;
    return out;
  }

  // ---- שעות שקטות ----
  // ⚠ נבדק לפני איסוף הנושאים ולא אחריו. בדיקה בסוף הייתה מבזבזת טעינת
  // blob וסריקה מלאה בכל טיק לאורך כל הלילה.
  if (!dryRun && inQuietHours(rule.quiet_hours as never, now)) {
    out.skipped = 1;
    return out;
  }

  // ---- השהיה זמנית ----
  if (!dryRun && rule.paused_until && Date.parse(rule.paused_until) > now.getTime()) {
    out.skipped = 1;
    return out;
  }

  // ---- איסוף ----
  let subjects: Subject[] = [];
  try {
    subjects = trigger.collect(db, rule.trigger_config || {}, now, extra);
  } catch (e) {
    out.error = 'הטריגר נכשל: ' + (e instanceof Error ? e.message : String(e));
    if (!dryRun) await recordFailure(sb, rule, out.error);
    return out;
  }
  out.matched = subjects.length;

  // ---- תנאים ----
  const passing: Array<{ s: Subject; reason: string; trace: unknown }> = [];
  for (const s of subjects) {
    const res = evaluate(rule.conditions as never, s.data, now.getTime());
    if (res.passed) {
      passing.push({ s, reason: explainResult(res, rule.name), trace: res.trace });
    }
  }

  const cap = Math.max(1, Number(rule.max_actions_per_run) || 10);
  const selected = passing.slice(0, cap);

  for (const { s, reason, trace } of selected) {
    try {
      const did = await processSubject(sb, rule, db, s, reason, trace, { dryRun, now, costPerHour: opts.costPerHour });
      if (did) { out.processed++; out.runs.push(did); } else { out.skipped++; }
    } catch (e) {
      out.skipped++;
      console.error('[automation] subject failed', rule.name, s.entityId, e);
    }
  }

  if (!dryRun) {
    await sb.from('automation_rules').update({
      last_run_at: now.toISOString(),
      last_run_status: `נבדקו ${out.matched}, תואמים ${passing.length}, בוצעו ${out.processed}`,
      run_count: (rule as Record<string, any>).run_count + 1 || 1,
      failure_count: 0,
    }).eq('id', rule.id);
  }

  return out;
}

// ============================================================

async function processSubject(
  sb: SupabaseClient, rule: Rule, db: CrmDb, subject: Subject,
  reason: string, trace: unknown,
  opts: { dryRun: boolean; now: Date; costPerHour?: number },
): Promise<string | null> {
  const { dryRun, now } = opts;

  // ---- מפתח ייחודיות ----
  //
  // כולל את היום: אותו נושא לא יטופל פעמיים באותו יום. **לא** כולל את
  // גרסת הכלל: עריכת הכלל לא אמורה לפתוח מחדש את כל ההתראות שכבר נשלחו.
  const dedupe = await stableHash('automation', rule.id, subject.entityType, subject.entityId, todayISO());

  if (!dryRun) {
    // ---- תקופת חסד מההדלקה ----
    //
    // ⚠ ההגנה מפני הצפה ביום הראשון. אירוע שקרה לפני שהכלל הודלק לא
    // נחשב — אחרת הדלקת "תיק ללא פעילות 14 יום" על מסד עם היסטוריה
    // הייתה מייצרת עשרות הצעות בבת אחת, והמשתמש היה מסיק שהמערכת שבורה
    // ומכבה אותה. סעיף 35 במפרט.
    if (rule.activation_grace_at) {
      const graceMs = Date.parse(rule.activation_grace_at);
      const evTime = subjectTimestamp(subject);
      if (evTime && evTime < graceMs) return null;
    }

    // ---- cooldown ----
    //
    // ⚠ בלי זה, תיק שתקוע חודש מייצר התראה כל יום במשך חודש. אחרי
    // שלושה ימים אף אחד לא קורא אותן, וההתראה על התיק שבאמת בוער
    // נקברת ביניהן.
    if (rule.cooldown_minutes > 0) {
      const since = new Date(now.getTime() - rule.cooldown_minutes * 60000).toISOString();
      const { data: recent } = await sb.from('automation_runs')
        .select('id').eq('automation_rule_id', rule.id)
        .eq('trigger_entity_id', subject.entityId)
        .gte('started_at', since).limit(1);
      if (recent?.length) return null;
    }
  }

  // ---- פתיחת ההרצה ----
  const startedAt = Date.now();
  let runId: string;

  if (dryRun) {
    runId = 'dry-' + subject.entityId;
  } else {
    const { data: run, error } = await sb.from('automation_runs').insert({
      office_id: rule.office_id, automation_rule_id: rule.id, rule_version: rule.version,
      trigger_type: rule.trigger_type,
      trigger_entity_type: subject.entityType, trigger_entity_id: subject.entityId,
      status: 'running', reason,
      conditions_checked: trace as never, conditions_result: true,
      actions_requested: rule.actions.length,
      input_snapshot: { subject: subject.data, label: subject.label },
      deduplication_key: dedupe,
    }).select('id').single();

    // 23505 = כבר טופל. תקין, לא שגיאה.
    if (error) return null;
    runId = run.id;
  }

  // ---- פעולות ----
  const ctx: ActionCtx = {
    sb, officeId: rule.office_id, runId, ruleId: dryRun ? null : rule.id,
    ruleName: rule.name, db,
    subject: {
      entityType: subject.entityType, entityId: subject.entityId, label: subject.label,
      clientId: subject.clientId, matterId: subject.matterId, data: subject.data,
    },
    reason, dryRun,
  };

  let completed = 0, failed = 0, approvals = 0, minutes = 0;
  const results: unknown[] = [];

  for (let i = 0; i < rule.actions.length; i++) {
    const cfg = rule.actions[i] || {};
    const def = ACTION_MAP.get(String(cfg.type));

    if (!def) {
      // ⚠ חייב להירשם ללוג ולא רק להיספר.
      //
      // ה-`continue` המוקדם שהיה כאן דילג על רישום ה-action log, וכך
      // כלל עם פעולה לא מוכרת הציג "0 פעולות" במסך במקום "פעולה לא
      // מוכרת" — כלומר הכשל היחיד שהמשתמש לא יכול לאבחן לבד היה גם
      // היחיד שלא הופיע בשום מקום. סעיף 35: "אל תסתיר כשלים".
      const msg = `פעולה לא מוכרת: ${cfg.type ?? '(ללא סוג)'}`;
      results.push({ action: cfg.type, status: 'failed', message: msg });
      failed++;
      if (!dryRun) {
        await sb.from('automation_action_logs').insert({
          office_id: rule.office_id, automation_run_id: runId, action_index: i,
          action_type: String(cfg.type ?? 'unknown'), action_payload: cfg,
          status: 'failed', error: msg, executed_at: new Date().toISOString(),
        });
      }
      continue;
    }

    // ⚠ המחסום. פעולה רגישה יורדת מ-auto ל-prepare תמיד, ללא קשר להגדרה.
    const level = effectiveLevel(def, rule.execution_level);

    let res;
    if (level === 'notify') {
      // ברמה 1 שום פעולה לא מבוצעת — רק מתועדת. `describe` מובטח שלא
      // נוגע בנתונים, ולכן אפשר לקרוא לו בבטחה.
      res = { status: 'skipped' as const, message: 'רמת התראה בלבד: ' + def.describe(cfg, ctx) };
    } else if (level === 'prepare' && !def.sensitive && def.type !== 'notify' && def.type !== 'escalate') {
      // פעולה לא רגישה ברמת "הכנה" — מוצעת לאישור במקום להתבצע.
      res = await proposeGeneric(ctx, def.type, def.label, cfg);
    } else {
      res = await def.run(cfg, ctx);
    }

    results.push({ action: def.type, ...res });
    if (res.status === 'executed') { completed++; minutes += def.minutesSaved; }
    else if (res.status === 'awaiting_approval') { approvals++; }
    else if (res.status === 'failed') { failed++; }

    if (!dryRun) {
      await sb.from('automation_action_logs').insert({
        office_id: rule.office_id, automation_run_id: runId, action_index: i,
        action_type: def.type, action_payload: cfg,
        status: res.status === 'executed' ? 'executed'
          : res.status === 'awaiting_approval' ? 'awaiting_approval'
          : res.status === 'failed' ? 'failed' : 'skipped',
        result: { message: res.message, ...(res.data || {}) },
        error: res.status === 'failed' ? res.message : null,
        executed_at: new Date().toISOString(),
      });
    }
  }

  if (dryRun) return runId;

  // ---- סגירה ----
  const costPerHour = Number(opts.costPerHour ?? 60);
  const costSaved = (minutes / 60) * costPerHour;

  await sb.from('automation_runs').update({
    status: failed > 0 && completed === 0 ? 'failed' : failed > 0 ? 'partial' : 'completed',
    actions_completed: completed, actions_failed: failed,
    approval_status: approvals > 0 ? 'pending' : 'not_required',
    output_snapshot: { results },
    estimated_minutes_saved: minutes, estimated_cost_saved: costSaved,
    completed_at: new Date().toISOString(), duration_ms: Date.now() - startedAt,
  }).eq('id', runId);

  await sb.rpc('automation_metrics_upsert', {
    p_office: rule.office_id, p_rule: rule.id, p_period: todayISO(),
    p_success: failed === 0 ? 1 : 0, p_failure: failed > 0 ? 1 : 0,
    p_actions: completed, p_approvals: approvals,
    p_minutes: minutes, p_cost: costSaved,
  });

  return runId;
}

/** הצעה גנרית לאישור עבור פעולה שאינה רגישה אך הוגדרה ברמת "הכנה". */
async function proposeGeneric(
  ctx: ActionCtx, type: string, label: string, cfg: Record<string, unknown>,
) {
  const { data, error } = await ctx.sb.from('ai_approvals').insert({
    office_id: ctx.officeId,
    client_id: ctx.subject.clientId || null, matter_id: ctx.subject.matterId || null,
    action_type: type, action_label: `${label} — ${ctx.subject.label}`,
    proposed_payload: { ...cfg, subject: ctx.subject },
    risk_level: 'low', status: 'pending',
    reason_required: ctx.reason, source: 'automation', automation_run_id: ctx.runId,
  }).select('id').single();

  if (error) return { status: 'failed' as const, message: error.message };
  return { status: 'awaiting_approval' as const, message: `ממתין לאישור: ${label}`, data: { approvalId: data.id } };
}

/**
 * מתי "קרה" האירוע שהנושא מייצג — לצורך תקופת החסד.
 * מחזיר null כשאין תאריך משמעותי, ואז הנושא תמיד נחשב.
 */
function subjectTimestamp(s: Subject): number | null {
  const d = s.data as Record<string, unknown>;
  const cand = d.due || d.date || d.last_message_at || d.opened || d.createdAt;
  if (!cand) return null;
  const t = Date.parse(String(cand) + (String(cand).length === 10 ? 'T00:00:00Z' : ''));
  return Number.isFinite(t) ? t : null;
}

async function recordFailure(sb: SupabaseClient, rule: Rule, error: string) {
  const next = (Number(rule.failure_count) || 0) + 1;
  const patch: Record<string, unknown> = {
    failure_count: next, last_run_status: 'שגיאה: ' + error.slice(0, 200),
    last_run_at: new Date().toISOString(),
  };
  // ⚠ Kill switch. כלל שבור מייצר שגיאה כל 5 דקות לנצח וממלא את הלוג עד
  // שאי אפשר לראות בו שום דבר אחר. אחרי 5 כשלים רצופים הוא מכבה את עצמו
  // ומסביר למה — במקום להמשיך לצרוח בשקט.
  if (next >= MAX_FAILURES) {
    patch.is_active = false;
    patch.disabled_reason = `הושבת אוטומטית אחרי ${next} כשלים רצופים. השגיאה האחרונה: ${error.slice(0, 300)}`;
  }
  await sb.from('automation_rules').update(patch).eq('id', rule.id);
}

/** טעינת שרשורי תקשורת — רק כשיש כלל שצריך אותם. */
export async function loadThreads(sb: SupabaseClient, officeId: string) {
  const { data: threads } = await sb.from('communication_threads')
    .select('id, channel, participant_name, participant_identifier, client_id, matter_id, lead_id, last_message_at, status')
    .eq('office_id', officeId).in('status', ['open', 'waiting_reply'])
    .order('last_message_at', { ascending: false }).limit(200);
  if (!threads?.length) return [];

  const { data: msgs } = await sb.from('communication_messages')
    .select('thread_id, direction, created_at')
    .in('thread_id', threads.map((t) => t.id))
    .order('created_at', { ascending: true });

  const last = new Map<string, string>();
  for (const m of msgs || []) last.set(m.thread_id as string, m.direction === 'out' ? 'out' : 'in');
  return threads.map((t) => ({ ...t, lastDirection: last.get(t.id) ?? null }));
}

export { loadOfficeDb };
