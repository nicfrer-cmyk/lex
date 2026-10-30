// Agent Gateway — נקודת הכניסה היחידה להפעלת AI ממרכז השליטה (סעיף 3.2).
//
// "אין לאפשר ל-Frontend לפנות ישירות ל-API של מודל AI."
//
// יחס ל-ai-proxy הקיים: הוא **לא משתנה ולא מוחלף**. הוא ממשיך לשרת את
// צ'אט הסוכן הישן ואת "הכן בקשה" — קוד עובד ומוכח שאין סיבה לסכן. מרכז
// ה-AI מוסיף מסלול נפרד שיש בו מה שחסר שם: תור, הרצות מתועדות, אישורים,
// idempotency ותקציב בדולרים. שני המסלולים חולקים את אותו ANTHROPIC_API_KEY.
//
// Deploy: supabase functions deploy ai-gateway

import { admin, resolveCaller, loadOfficeDb, findCase, findClient, findLead } from '../_shared/db.ts';
import { json, preflight, errorResponse, AppError } from '../_shared/http.ts';
import { stableHash } from '../_shared/crypto.ts';
import { audit } from '../_shared/audit.ts';
import { evaluateBudget } from '../_shared/cost.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/**
 * אילו תפקידים רשאים להפעיל אילו סוכנים.
 *
 * מזכיר/ה לא מפעיל/ה סוכן ניסוח משפטי או סוכן כספים — לא כי אין בו אמון,
 * אלא כי הפלט של אותם סוכנים הוא חומר משפטי או כספי שמחייב שיפוט של עורך
 * דין גם בשלב ההזמנה, לא רק בשלב האישור.
 */
const AGENT_ROLE_RESTRICTIONS: Record<string, string[]> = {
  'legal-drafting': ['owner', 'lawyer'],
  'legal-review': ['owner', 'lawyer'],
  'legal-research': ['owner', 'lawyer'],
  'finance-collections': ['owner', 'lawyer'],
  'sales-conversion': ['owner', 'lawyer'],
};

/** ניתוב כוונה → סוכן, כשלא נמסר סוכן מפורש (תיבת הפקודה החופשית, סעיף 4.2). */
const INTENT_ROUTES: Array<{ re: RegExp; agent: string; jobType: string }> = [
  // סוכני מסמכים (ניסוח, ביקורת, סיכום, ניתוח, מחקר) הושבתו בכוונה — בעל
  // המשרד עובד על מסמכים ישירות עם Claude. בקשות כאלה נופלות למנהל המשרד,
  // שעונה מהנתונים ומסביר איפה לעשות את זה.
  { re: /ליד|פניה\s+חדשה|פנייה\s+חדשה/, agent: 'lead-intake', jobType: 'process_lead' },
  { re: /גביי?ה|תשלום|חוב|חשבונית|דרישת\s+תשלום/, agent: 'finance-collections', jobType: 'finance_report' },
  { re: /הודעה\s+ל|עדכון\s+ל|תשובה\s+ל|תזכורת\s+ל/, agent: 'client-service', jobType: 'draft_client_update' },
  { re: /פסיק(ה|ות)|חקיקה|הלכ(ה|ות)|חדשות\s+משפטיות/, agent: 'legal-watch', jobType: 'legal_watch' },
  { re: /מאמר|כתבה\s+לאתר|בלוג/, agent: 'content-writer', jobType: 'article' },
  { re: /ביטאון|ניוזלטר|דיוור/, agent: 'newsletter-editor', jobType: 'newsletter' },
  { re: /פוסט|רילס|סטורי|קריאייטיב|סקריפט/, agent: 'creative', jobType: 'post' },
  { re: /שיווק|קמפיין|תוכנית\s+תוכן|מודעה/, agent: 'marketing-manager', jobType: 'content_plan' },
  { re: /דיגיטל|פרסומים|ביקורות|גוגל\s+עסק/, agent: 'digital-manager', jobType: 'digital_report' },
  { re: /הצעת\s+שכר|מעקב\s+אחרי\s+הצעה|המר(ה|ות)|מכירות/, agent: 'sales-conversion', jobType: 'sales_followup' },
];

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const sb = admin();
  try {
    const caller = await resolveCaller(req, sb);
    const body = await req.json().catch(() => {
      throw new AppError('bad_json', 'גוף הבקשה אינו JSON תקין', 400);
    });

    const action = String(body.action || 'run');

    if (action === 'run') return await handleRun(req, sb, caller, body);
    if (action === 'status') return await handleStatus(sb, caller, body);
    if (action === 'cancel') return await handleCancel(sb, caller, body);
    if (action === 'route') return await handleRoutePreview(sb, caller, body);
    if (action === 'learn') return await handleLearn(sb, caller);
    throw new AppError('unknown_action', `פעולה לא מוכרת: ${action}`, 400);
  } catch (e) {
    return errorResponse(e);
  }
});

// ============================================================

async function handleRun(
  req: Request, sb: ReturnType<typeof admin>,
  caller: Awaited<ReturnType<typeof resolveCaller>>, body: Record<string, unknown>,
) {
  const officeId = caller.officeId;

  // ---- 1. מפסקי חירום (סעיף 8.5) ----
  const { data: settings } = await sb.from('ai_settings')
    .select('*').eq('office_id', officeId).maybeSingle();

  if (settings?.emergency_stop) {
    throw new AppError('emergency_stop',
      `כל סוכני ה-AI מושבתים${settings.emergency_stop_reason ? ': ' + settings.emergency_stop_reason : ''}.`, 423);
  }

  // ---- 2. תקציב (סעיף 21) ----
  const { data: spendRows } = await sb.rpc('ai_spend_window', { p_office_id: officeId });
  const spend = Array.isArray(spendRows) ? spendRows[0] : spendRows;
  const budget = evaluateBudget(
    Number(spend?.today_cost || 0), Number(spend?.month_cost || 0),
    Number(settings?.daily_budget_usd ?? 5), Number(settings?.monthly_budget_usd ?? 50),
    (settings?.on_budget_exceeded || 'stop') as 'stop' | 'downgrade',
  );
  if (budget.exceeded && budget.action === 'stop') {
    throw new AppError('budget_exceeded',
      `חריגה מתקציב ה-AI (היום $${budget.todayCost.toFixed(2)} מתוך $${budget.dailyBudget}, ` +
      `החודש $${budget.monthCost.toFixed(2)} מתוך $${budget.monthlyBudget}). ` +
      `ניתן להעלות את התקציב בהגדרות מרכז ה-AI.`, 429);
  }

  // ---- 3. ניתוב לסוכן ----
  const goal = String(body.goal || body.prompt || '').trim();
  let agentSlug = body.agent_slug ? String(body.agent_slug) : '';
  let jobType = body.job_type ? String(body.job_type) : '';

  if (!agentSlug) {
    const route = INTENT_ROUTES.find((r) => r.re.test(goal));
    // ברירת המחדל היא סוכן מנהל המשרד: הוא קריאה-בלבד, ולכן ניתוב שגוי
    // אליו הוא לכל היותר תשובה לא רלוונטית — לא פעולה שגויה.
    agentSlug = route?.agent || 'office-manager';
    if (!jobType) jobType = route?.jobType || 'general_query';
  }
  if (!jobType) jobType = 'general_query';

  const { data: agent, error: agentErr } = await sb.from('ai_agents')
    .select('id, slug, name, status, autonomy_level')
    .eq('office_id', officeId).eq('slug', agentSlug).maybeSingle();
  if (agentErr) throw new AppError('db_error', agentErr.message, 500);
  if (!agent) {
    throw new AppError('agent_not_found',
      `הסוכן "${agentSlug}" לא נמצא. ייתכן שיש להריץ את זריעת הסוכנים (seed).`, 404);
  }
  if (agent.status !== 'active') {
    throw new AppError('agent_disabled', `הסוכן "${agent.name}" מושבת.`, 423);
  }

  // ---- 4. הרשאת תפקיד ----
  const allowedRoles = AGENT_ROLE_RESTRICTIONS[agent.slug];
  if (allowedRoles && !allowedRoles.includes(caller.role)) {
    await audit(sb, {
      officeId, actorType: 'user', userId: caller.userId, action: 'agent_run_denied',
      entityType: 'ai_agent', entityId: agent.id, severity: 'security',
      after: { agent: agent.slug, role: caller.role }, req,
    });
    throw new AppError('forbidden',
      `לתפקיד "${caller.role}" אין הרשאה להפעיל את הסוכן "${agent.name}".`, 403);
  }

  // ---- 5. אימות scope מול ה-blob של המשרד ----
  //
  // זו הבדיקה שהופכת "שינוי מזהה תיק ב-URL" (סעיף 23.4) לחסר תועלת: ה-blob
  // נטען לפי office_id שנגזר מה-JWT, ולכן מזהה של משרד אחר פשוט לא נמצא בו.
  const clientId = body.client_id ? String(body.client_id) : null;
  const matterId = body.matter_id ? String(body.matter_id) : null;
  const leadId = body.lead_id ? String(body.lead_id) : null;

  if (clientId || matterId || leadId) {
    const db = await loadOfficeDb(sb, officeId);
    if (matterId && !findCase(db, matterId)) {
      await audit(sb, {
        officeId, actorType: 'user', userId: caller.userId, action: 'scope_violation',
        entityType: 'matter', entityId: matterId, severity: 'security', req,
      });
      throw new AppError('not_found', 'התיק לא נמצא במשרד זה.', 404);
    }
    if (clientId && !findClient(db, clientId)) {
      await audit(sb, {
        officeId, actorType: 'user', userId: caller.userId, action: 'scope_violation',
        entityType: 'client', entityId: clientId, severity: 'security', req,
      });
      throw new AppError('not_found', 'הלקוח לא נמצא במשרד זה.', 404);
    }
    if (leadId && !findLead(db, leadId)) {
      throw new AppError('not_found', 'הליד לא נמצא במשרד זה.', 404);
    }
  }

  // ---- 6. ולידציית payload ----
  const payload = (body.payload && typeof body.payload === 'object'
    ? body.payload : {}) as Record<string, unknown>;
  if (goal.length > 8000) throw new AppError('payload_too_large', 'הבקשה ארוכה מדי.', 413);
  if (JSON.stringify(payload).length > 200_000) {
    throw new AppError('payload_too_large', 'נתוני המשימה גדולים מדי.', 413);
  }
  if (!goal && !Object.keys(payload).length) {
    throw new AppError('empty_request', 'לא נמסרה משימה.', 400);
  }

  // ---- 7. Idempotency ----
  //
  // המפתח נגזר מהתוכן כשלא נמסר במפורש. זה מה שמונע שני jobs זהים כשמשתמש
  // לוחץ פעמיים, או כשספק שולח webhook פעמיים — סעיף 22 ("מניעת ניתוח
  // מסמך כפול", "מניעת יצירת ליד כפול").
  const idempotencyKey = body.idempotency_key
    ? String(body.idempotency_key)
    : await stableHash(agent.id, jobType, matterId, clientId, leadId, goal, payload);

  const { data: existing } = await sb.from('ai_jobs')
    .select('id, status, result')
    .eq('office_id', officeId).eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existing) {
    const { data: run } = await sb.from('ai_runs')
      .select('id').eq('job_id', existing.id).maybeSingle();
    return json({
      job_id: existing.id, run_id: run?.id || null,
      status: existing.status, deduplicated: true,
      message: 'בקשה זהה כבר נשלחה — מוצגת התוצאה הקיימת.',
    });
  }

  // ---- 8. יצירת job + run ----
  const priority = Number(body.priority) || (body.trigger_type === 'manual' ? 3 : 5);
  const { data: job, error: jobErr } = await sb.from('ai_jobs').insert({
    office_id: officeId, agent_id: agent.id, job_type: jobType,
    client_id: clientId, matter_id: matterId,
    user_id: caller.userId, priority,
    status: 'queued',
    payload: { ...payload, goal, lead_id: leadId, budget_downgrade: budget.action === 'downgrade' },
    idempotency_key: idempotencyKey,
    trigger_type: String(body.trigger_type || 'manual'),
  }).select('id').single();
  if (jobErr) {
    // מרוץ: שתי בקשות זהות בו-זמנית. האינדקס הייחודי תפס — נחזיר את הקיים.
    if (jobErr.code === '23505') {
      const { data: dup } = await sb.from('ai_jobs')
        .select('id, status').eq('office_id', officeId)
        .eq('idempotency_key', idempotencyKey).maybeSingle();
      if (dup) return json({ job_id: dup.id, status: dup.status, deduplicated: true });
    }
    throw new AppError('db_error', jobErr.message, 500);
  }

  const { data: run, error: runErr } = await sb.from('ai_runs').insert({
    office_id: officeId, job_id: job.id, agent_id: agent.id,
    client_id: clientId, matter_id: matterId, user_id: caller.userId,
    trigger_type: String(body.trigger_type || 'manual'),
    status: 'pending', goal, input_data: payload,
  }).select('id').single();
  if (runErr) throw new AppError('db_error', runErr.message, 500);

  await audit(sb, {
    officeId, actorType: 'user', userId: caller.userId, agentId: agent.id,
    runId: run.id, clientId, matterId, action: 'agent_run_requested',
    entityType: 'ai_job', entityId: job.id,
    after: { agent: agent.slug, jobType, goal: goal.slice(0, 200) },
    correlationId: run.id, req,
  });

  // ---- 9. הפעלת ה-worker ----
  //
  // fire-and-forget: לא ממתינים לסיום. הרצת סוכן אורכת שניות עד דקות, וזמן
  // התגובה של הדפדפן צריך להיות מיידי — המשתמש רואה את ה-run מתעדכן
  // דרך Realtime. אם ההפעלה נכשלת, ה-job נשאר בתור וייאסף ע"י ה-cron.
  kickWorker(job.id).catch((e) => console.error('[gateway] worker kick failed', e));

  return json({
    job_id: job.id, run_id: run.id, status: 'queued',
    agent: { slug: agent.slug, name: agent.name },
    budget_warning: budget.warn90 ? 'התקציב החודשי מעל 90%'
      : budget.warn70 ? 'התקציב החודשי מעל 70%' : null,
    downgraded: budget.action === 'downgrade',
  });
}

/**
 * מפעיל את ai-worker בלי לחכות לו.
 * ההזמנה נעשית עם service_role — ai-worker נפרס עם --no-verify-jwt כי
 * גם ה-cron קורא לו, ול-cron אין משתמש מחובר.
 */
async function kickWorker(jobId: string): Promise<void> {
  const url = `${SUPABASE_URL}/functions/v1/ai-worker`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ job_id: jobId, source: 'gateway' }),
  });
}

// ============================================================

async function handleStatus(
  sb: ReturnType<typeof admin>, caller: Awaited<ReturnType<typeof resolveCaller>>,
  body: Record<string, unknown>,
) {
  const runId = String(body.run_id || '');
  if (!runId) throw new AppError('bad_request', 'חסר run_id', 400);

  const { data: run, error } = await sb.from('ai_runs')
    .select('*').eq('id', runId).eq('office_id', caller.officeId).maybeSingle();
  if (error) throw new AppError('db_error', error.message, 500);
  if (!run) throw new AppError('not_found', 'ההרצה לא נמצאה.', 404);

  const { data: steps } = await sb.from('ai_run_steps')
    .select('step_number, step_type, tool_slug, model_output, status, error, duration_ms, tool_input, tool_output')
    .eq('run_id', runId).order('step_number');

  const { data: approvals } = await sb.from('ai_approvals')
    .select('id, action_type, action_label, risk_level, status, reason_required, proposed_content')
    .eq('run_id', runId);

  return json({ run, steps: steps || [], approvals: approvals || [] });
}

/**
 * הרצת סבב למידה ידנית ממסך הלמידה.
 *
 * ai-learn עצמו מקבל רק service_role או CRON_SECRET — ובצדק: הוא סורק את
 * כל המשרדים. הנתיב הזה הוא הגשר: הוא מאמת משתמש מחובר, מוודא שהוא בעל
 * המשרד, ומעביר ל-ai-learn **את המשרד שלו בלבד**.
 *
 * החסימה של שעה אינה נימוס — זיקוק עולה כסף, והדפוסים נצברים לאט ממילא.
 * לחיצה חוזרת דקה אחרי סבב לא הייתה מוצאת דבר חדש, רק מחייבת.
 */
async function handleLearn(
  sb: ReturnType<typeof admin>, caller: Awaited<ReturnType<typeof resolveCaller>>,
) {
  if (caller.role !== 'owner') {
    throw new AppError('forbidden', 'הרצת סבב למידה מותרת לבעל המשרד בלבד.', 403);
  }

  const { data: settings } = await sb.from('ai_settings')
    .select('learning_enabled, learning_last_run_at').eq('office_id', caller.officeId).maybeSingle();
  if (!settings?.learning_enabled) {
    throw new AppError('learning_disabled', 'הלמידה כבויה. ניתן להפעיל אותה בהגדרות.', 400);
  }
  const last = settings.learning_last_run_at ? Date.parse(settings.learning_last_run_at) : 0;
  if (last && Date.now() - last < 3600_000) {
    const mins = Math.ceil((3600_000 - (Date.now() - last)) / 60000);
    throw new AppError('too_soon',
      `סבב למידה רץ לאחרונה. ניתן להריץ שוב בעוד ${mins} דקות.`, 429);
  }

  const resp = await fetch(`${SUPABASE_URL}/functions/v1/ai-learn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ office_id: caller.officeId }),
  });
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new AppError('learn_failed', out.error || 'סבב הלמידה נכשל', 502);

  const first = Array.isArray(out.results) ? out.results[0] : null;
  await audit(sb, {
    officeId: caller.officeId, actorType: 'user', actorId: caller.userId,
    action: 'learning_manual_run', after: first || {},
  });
  return json({ ok: true, insights: Number(first?.insights || 0), signals: Number(first?.signals || 0) });
}

async function handleCancel(
  sb: ReturnType<typeof admin>, caller: Awaited<ReturnType<typeof resolveCaller>>,
  body: Record<string, unknown>,
) {
  const jobId = String(body.job_id || '');
  if (!jobId) throw new AppError('bad_request', 'חסר job_id', 400);

  const { data: job } = await sb.from('ai_jobs')
    .select('id, status').eq('id', jobId).eq('office_id', caller.officeId).maybeSingle();
  if (!job) throw new AppError('not_found', 'המשימה לא נמצאה.', 404);
  if (['completed', 'cancelled'].includes(job.status)) {
    return json({ ok: true, status: job.status, message: 'המשימה כבר הסתיימה.' });
  }

  await sb.from('ai_jobs').update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .eq('id', jobId);
  await sb.from('ai_runs').update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .eq('job_id', jobId).in('status', ['pending', 'running', 'waiting_approval']);

  await audit(sb, {
    officeId: caller.officeId, actorType: 'user', userId: caller.userId,
    action: 'agent_run_cancelled', entityType: 'ai_job', entityId: jobId, severity: 'warning',
  });
  return json({ ok: true, status: 'cancelled' });
}

/** תצוגה מקדימה של הניתוב — "להציג למשתמש מה הסוכן מתכוון לבצע" (סעיף 4.2). */
async function handleRoutePreview(
  sb: ReturnType<typeof admin>, caller: Awaited<ReturnType<typeof resolveCaller>>,
  body: Record<string, unknown>,
) {
  const goal = String(body.goal || '').trim();
  const route = INTENT_ROUTES.find((r) => r.re.test(goal));
  const slug = route?.agent || 'office-manager';
  const { data: agent } = await sb.from('ai_agents')
    .select('slug, name, description, autonomy_level, approval_policy')
    .eq('office_id', caller.officeId).eq('slug', slug).maybeSingle();
  return json({
    agent: agent || null,
    job_type: route?.jobType || 'general_query',
    matched: !!route,
    allowed: !AGENT_ROLE_RESTRICTIONS[slug] || AGENT_ROLE_RESTRICTIONS[slug].includes(caller.role),
  });
}
