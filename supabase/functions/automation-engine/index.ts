// מרכז האוטומציות — נקודת הכניסה.
//
// שני קהלים, שתי דרכי אימות:
//   service_role / CRON_SECRET → הרצה תקופתית על כל המשרדים
//   JWT של משתמש              → בדיקה יבשה (dry run) ו"הרץ עכשיו" על המשרד שלו
//
// Deploy: supabase functions deploy automation-engine --no-verify-jwt
//   --no-verify-jwt כי גם ה-cron קורא לפונקציה. האימות נעשה בקוד.

import { admin, resolveCaller, loadOfficeDb } from '../_shared/db.ts';
import { json, preflight, errorResponse, AppError } from '../_shared/http.ts';
import { timingSafeEqual } from '../_shared/crypto.ts';
import { audit } from '../_shared/audit.ts';
import { runRule, loadThreads, Rule } from '../_shared/automation/engine.ts';
import { TRIGGERS, TRIGGER_MAP } from '../_shared/automation/triggers.ts';
import { ACTIONS } from '../_shared/automation/actions.ts';

const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';

function isMachine(req: Request): boolean {
  const auth = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (auth && timingSafeEqual(auth, SERVICE_ROLE_KEY)) return true;
  const secret = req.headers.get('x-cron-secret') || '';
  return !!CRON_SECRET && timingSafeEqual(secret, CRON_SECRET);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const sb = admin();
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'tick');

    // ---- קטלוג: מה המנוע יודע לעשות ----
    // נקרא ע"י ה-UI כדי לבנות את בורר הכללים. מוחזר מהקוד ולא מה-DB,
    // כי הקוד הוא מקור האמת: טריגר שאין לו מימוש לא יעבוד גם אם הוא
    // רשום בטבלה.
    if (action === 'catalog') {
      return json({
        triggers: TRIGGERS.map((t) => ({
          type: t.type, label: t.label, category: t.category,
          description: t.description, kind: t.kind, requires: t.requires || [],
        })),
        actions: ACTIONS.map((a) => ({
          type: a.type, label: a.label, category: a.category,
          description: a.description, sensitive: a.sensitive,
          minutesSaved: a.minutesSaved, requires: a.requires || [],
        })),
      });
    }

    // ---- מסלול מכונה: טיק תקופתי ----
    if (isMachine(req)) {
      if (action === 'tick') return json(await tickAll(sb, body));
      throw new AppError('unknown_action', `פעולה לא מוכרת: ${action}`, 400);
    }

    // ---- מסלול משתמש ----
    const caller = await resolveCaller(req, sb);

    if (action === 'dry_run') return json(await dryRun(sb, caller, body));
    if (action === 'run_now') return json(await runNow(sb, caller, body));

    throw new AppError('unknown_action', `פעולה לא מוכרת: ${action}`, 400);
  } catch (e) {
    return errorResponse(e);
  }
});

// ============================================================

async function tickAll(sb: ReturnType<typeof admin>, body: Record<string, unknown>) {
  const officeFilter = body.office_id ? String(body.office_id) : null;

  const { data: rules, error } = await sb.from('automation_rules')
    .select('*').eq('is_active', true);
  if (error) return { error: error.message };
  if (!rules?.length) return { offices: 0, rules: 0, processed: 0 };

  const byOffice = new Map<string, Rule[]>();
  for (const r of rules as Rule[]) {
    if (officeFilter && r.office_id !== officeFilter) continue;
    if (!byOffice.has(r.office_id)) byOffice.set(r.office_id, []);
    byOffice.get(r.office_id)!.push(r);
  }

  const results: unknown[] = [];
  let processed = 0;

  for (const [officeId, officeRules] of byOffice) {
    const { data: st } = await sb.from('ai_settings')
      .select('emergency_stop, automations_paused, automation_engine_paused, hourly_cost_secretary')
      .eq('office_id', officeId).maybeSingle();

    // ⚠ שני מתגי עצירה נפרדים ובכוונה.
    //
    // automations_paused עוצר את הסוכנים (שיקול עלות). automation_engine_paused
    // עוצר את המנוע הדטרמיניסטי (שיקול רעש). הם לא אותו דבר: אפשר לרצות
    // שהתראות ימשיכו בזמן שהסוכנים כבויים. emergency_stop עוצר הכל.
    if (st?.emergency_stop || st?.automation_engine_paused) {
      results.push({ office: officeId, skipped: 'המנוע מושהה' });
      continue;
    }

    const db = await loadOfficeDb(sb, officeId);
    const needThreads = officeRules.some((r) => r.trigger_type === 'thread_no_reply');
    const threads = needThreads ? await loadThreads(sb, officeId) : [];
    const costPerHour = Number(st?.hourly_cost_secretary ?? 60);

    for (const rule of officeRules) {
      // טריגר שאין לו מימוש בקוד מדולג בשקט — ייתכן שהכלל נוצר בגרסה
      // חדשה יותר של הקוד, ונפילה כאן הייתה עוצרת את שאר הכללים.
      if (!TRIGGER_MAP.has(rule.trigger_type)) continue;
      const out = await runRule(sb, rule, db, { threads }, { costPerHour });
      processed += out.processed;
      if (out.matched || out.error) results.push({ office: officeId, ...out });
    }
  }

  return { offices: byOffice.size, rules: rules.length, processed, results };
}

/**
 * בדיקה יבשה (סעיף 27).
 *
 * ⚠ `dryRun: true` מועבר לכל פעולה, וכל `run` בודק אותו לפני שהוא נוגע
 * בנתונים. זו הסיבה שכל פעולה חייבת גם `describe` — הוא מה שמוצג כאן,
 * והוא מובטח חסר תופעות לוואי.
 */
async function dryRun(
  sb: ReturnType<typeof admin>,
  caller: Awaited<ReturnType<typeof resolveCaller>>,
  body: Record<string, unknown>,
) {
  const ruleId = String(body.rule_id || '');
  if (!ruleId) throw new AppError('bad_request', 'חסר rule_id', 400);

  const { data: rule } = await sb.from('automation_rules')
    .select('*').eq('id', ruleId).eq('office_id', caller.officeId).maybeSingle();
  if (!rule) throw new AppError('not_found', 'הכלל לא נמצא', 404);

  const trigger = TRIGGER_MAP.get(rule.trigger_type);
  if (!trigger) throw new AppError('bad_trigger', `הטריגר "${rule.trigger_type}" אינו ממומש`, 400);

  const db = await loadOfficeDb(sb, caller.officeId);
  const threads = rule.trigger_type === 'thread_no_reply'
    ? await loadThreads(sb, caller.officeId) : [];

  const now = new Date();
  const subjects = trigger.collect(db, rule.trigger_config || {}, now, { threads });

  const { evaluate, explainResult } = await import('../_shared/automation/conditions.ts');
  const { ACTION_MAP, effectiveLevel } = await import('../_shared/automation/actions.ts');

  const matched: unknown[] = [];
  for (const s of subjects.slice(0, 50)) {
    const res = evaluate(rule.conditions as never, s.data, now.getTime());
    if (!res.passed) continue;

    const wouldDo = (rule.actions || []).map((cfg: Record<string, unknown>) => {
      const def = ACTION_MAP.get(String(cfg.type));
      if (!def) return { action: cfg.type, label: String(cfg.type), level: 'notify',
                         downgraded: false, description: 'פעולה לא מוכרת — לא תבוצע' };
      const level = effectiveLevel(def, rule.execution_level);
      return {
        action: def.type, label: def.label,
        level,
        // מציג במפורש כשההגדרה הורדה בכוח — זו בדיוק ההפתעה שעדיף
        // שהמשתמש יגלה כאן ולא בפעם הראשונה שהכלל רץ.
        downgraded: rule.execution_level === 'auto' && def.sensitive,
        description: def.describe(cfg, {
          sb, officeId: caller.officeId, runId: 'dry', ruleId: rule.id,
          ruleName: rule.name, db,
          subject: { entityType: s.entityType, entityId: s.entityId, label: s.label,
                     clientId: s.clientId, matterId: s.matterId, data: s.data },
          reason: '', dryRun: true,
        } as never),
      };
    });

    matched.push({
      entityType: s.entityType, entityId: s.entityId, label: s.label,
      reason: explainResult(res, rule.name),
      conditions: res.trace,
      actions: wouldDo,
    });
  }

  const cap = Math.max(1, Number(rule.max_actions_per_run) || 10);
  return {
    rule: rule.name,
    scanned: subjects.length,
    matched: matched.length,
    capped: matched.length > cap ? cap : matched.length,
    cap,
    note: matched.length > cap
      ? `נמצאו ${matched.length} פריטים אך הכלל מוגבל ל-${cap} בהרצה. השאר יטופלו בהרצות הבאות.`
      : null,
    items: matched.slice(0, 25),
  };
}

/** הרצה מיידית של כלל אחד — בעל משרד בלבד. */
async function runNow(
  sb: ReturnType<typeof admin>,
  caller: Awaited<ReturnType<typeof resolveCaller>>,
  body: Record<string, unknown>,
) {
  if (caller.role !== 'owner') {
    throw new AppError('forbidden', 'הרצה ידנית מותרת לבעל המשרד בלבד.', 403);
  }
  const ruleId = String(body.rule_id || '');
  const { data: rule } = await sb.from('automation_rules')
    .select('*').eq('id', ruleId).eq('office_id', caller.officeId).maybeSingle();
  if (!rule) throw new AppError('not_found', 'הכלל לא נמצא', 404);

  const { data: st } = await sb.from('ai_settings')
    .select('emergency_stop, automation_engine_paused, hourly_cost_secretary')
    .eq('office_id', caller.officeId).maybeSingle();
  if (st?.emergency_stop || st?.automation_engine_paused) {
    throw new AppError('paused', 'מנוע האוטומציות מושהה.', 423);
  }

  const db = await loadOfficeDb(sb, caller.officeId);
  const threads = rule.trigger_type === 'thread_no_reply'
    ? await loadThreads(sb, caller.officeId) : [];

  const out = await runRule(sb, rule as Rule, db, { threads },
    { costPerHour: Number(st?.hourly_cost_secretary ?? 60) });

  await audit(sb, {
    officeId: caller.officeId, actorType: 'user', actorId: caller.userId,
    action: 'automation_manual_run', entityType: 'automation_rule', entityId: ruleId,
    after: out as never,
  });
  return out;
}
