// Agent Worker + Orchestrator (סעיפים 3.3, 3.5).
//
// תופס job מהתור, טוען את הסוכן והגרסה הפעילה שלו, בונה context מינימלי,
// מריץ לולאת tool-use מוגבלת, ומתעד כל צעד. פעולות שמשנות נתונים לא
// מבוצעות כאן — הן נשמרות כהצעות ב-ai_approvals (ראה ההערה בראש
// _shared/tools.ts להסבר המלא, כולל הסיבה הטכנית של ה-blob).
//
// Deploy: supabase functions deploy ai-worker --no-verify-jwt
//   --no-verify-jwt כי גם ה-cron קורא לפונקציה, ולתזמון אין משתמש מחובר.
//   האימות נעשה בקוד: רק service_role key מתקבל (ראה assertServiceRole).

import { admin, loadOfficeDb, CrmDb } from '../_shared/db.ts';
import { json, preflight, errorResponse } from '../_shared/http.ts';
import { getProvider, pickModel, AIMessage } from '../_shared/provider.ts';
import { buildContext, BASE_SYSTEM_RULES } from '../_shared/context.ts';
import { execTool, toolDefsForModel, ToolCtx, Proposal } from '../_shared/tools.ts';
import { needsApproval, approvalLabel, maxRisk, RiskLevel, ApprovalPolicy } from '../_shared/approvals.ts';
import { audit } from '../_shared/audit.ts';
import { evaluateBudget } from '../_shared/cost.ts';
import { TOOL_MAP } from '../_shared/tools.ts';

const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/**
 * ה-worker חייב להיפרס עם --no-verify-jwt (ה-cron קורא לו בלי משתמש),
 * ולכן האימות נעשה כאן ידנית. בלי הבדיקה הזו כל אחד ברשת יכול היה להריץ
 * סוכנים על חשבון המשרד.
 */
function assertServiceRole(req: Request): void {
  const auth = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (auth !== SERVICE_ROLE_KEY) {
    throw Object.assign(new Error('לא מורשה'), { status: 401 });
  }
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    assertServiceRole(req);
  } catch {
    return json({ error: 'לא מורשה' }, 401);
  }

  const sb = admin();
  try {
    const body = await req.json().catch(() => ({}));
    // batch=N מנקז כמה משימות בקריאה אחת — ה-cron משתמש בזה.
    const batch = Math.min(Number(body.batch) || 1, 5);
    const results: unknown[] = [];

    for (let i = 0; i < batch; i++) {
      const { data: job, error } = await sb.rpc('claim_ai_job', { worker_id: 'edge' });
      if (error) { console.error('[worker] claim failed', error); break; }
      if (!job || !job.id) break;               // התור ריק
      results.push(await runJob(sb, job));
    }

    return json({ processed: results.length, results });
  } catch (e) {
    return errorResponse(e);
  }
});

// ============================================================

async function runJob(sb: ReturnType<typeof admin>, job: Record<string, any>) {
  const officeId = job.office_id as string;
  const startedAt = Date.now();

  // ה-run כבר נוצר ע"י ה-gateway. בנתיבי webhook/אוטומציה ייתכן שלא.
  // limit(1) ולא maybeSingle(): אם משום מה קיימות שתי הרצות לאותו job,
  // maybeSingle מחזיר **שגיאה** ולא שורה — וכל ניסיון חוזר היה יוצר עוד
  // הרצה, ומחמיר את המצב בכל סבב.
  const { data: runRows } = await sb.from('ai_runs')
    .select('*').eq('job_id', job.id).order('created_at').limit(1);
  let run = runRows && runRows.length ? runRows[0] : null;

  if (!run) {
    const { data: created, error: createErr } = await sb.from('ai_runs').insert({
      office_id: officeId, job_id: job.id, agent_id: job.agent_id,
      client_id: job.client_id, matter_id: job.matter_id, user_id: job.user_id,
      trigger_type: job.trigger_type, status: 'pending',
      goal: String(job.payload?.goal || job.job_type), input_data: job.payload,
    }).select('*').single();
    // בלי בדיקת השגיאה, `created` היה null ו-`run!.id` היה זורק TypeError
    // **מחוץ** ל-try של runJob — כלומר release_ai_job לא היה נקרא, ה-job
    // היה נשאר 'running' עם locked_at, ושאר האצווה הייתה ננטשת. ההתאוששות
    // הייתה מגיעה רק 10 דקות אחר כך דרך reap_stale_ai_jobs.
    if (createErr || !created) {
      const msg = createErr?.message || 'לא ניתן היה ליצור רשומת הרצה';
      await sb.rpc('release_ai_job', { p_job_id: job.id, p_status: 'failed', p_error: msg });
      return { job_id: job.id, status: 'failed', error: msg };
    }
    run = created;
  }
  const runId = run.id as string;

  // ממשיכים את המספור מהניסיון הקודם. ai_run_steps ייחודי ב-(run_id,
  // step_number); בהרצה חוזרת (release_ai_job מחזיר לתור עד max_attempts)
  // אותה שורת run נעשית שימוש חוזר, ואיפוס ל-0 היה מתנגש ב-23505 על כל
  // צעד — כלומר ציר הפעולה של כל ניסיון חוזר נמחק בשקט.
  const { data: lastStep } = await sb.from('ai_run_steps')
    .select('step_number').eq('run_id', runId)
    .order('step_number', { ascending: false }).limit(1);
  let stepNumber = lastStep && lastStep.length ? Number(lastStep[0].step_number) : 0;

  const failRun = async (code: string, message: string) => {
    await sb.from('ai_runs').update({
      status: 'failed', error_code: code, error_message: message,
      completed_at: new Date().toISOString(), duration_ms: Date.now() - startedAt,
    }).eq('id', runId);
    await sb.rpc('release_ai_job', { p_job_id: job.id, p_status: 'failed', p_error: message });
    return { job_id: job.id, run_id: runId, status: 'failed', error: message };
  };

  try {
    // ---- הגדרות + עצירת חירום ----
    const { data: settings } = await sb.from('ai_settings')
      .select('*').eq('office_id', officeId).maybeSingle();
    if (settings?.emergency_stop) {
      await sb.from('ai_runs').update({
        status: 'stopped', error_code: 'emergency_stop',
        error_message: 'עצירת חירום פעילה', completed_at: new Date().toISOString(),
      }).eq('id', runId);
      await sb.rpc('release_ai_job', { p_job_id: job.id, p_status: 'cancelled', p_error: 'עצירת חירום' });
      return { job_id: job.id, run_id: runId, status: 'stopped' };
    }

    // ---- הסוכן + הגרסה הפעילה ----
    const { data: agent } = await sb.from('ai_agents')
      .select('*').eq('id', job.agent_id).eq('office_id', officeId).maybeSingle();
    if (!agent) return await failRun('agent_missing', 'הסוכן לא נמצא');
    if (agent.status !== 'active') return await failRun('agent_disabled', `הסוכן "${agent.name}" מושבת`);

    const { data: version } = await sb.from('ai_agent_versions')
      .select('*').eq('agent_id', agent.id).eq('is_active', true).maybeSingle();

    // ---- הכלים המותרים ----
    //
    // הרשימה נקראת מה-DB בכל הרצה, לא מ-payload ולא מהמודל. זהו קו ההגנה
    // האמיתי מפני prompt injection: מסמך זדוני לא יכול להוסיף כלי.
    const { data: agentTools } = await sb.from('ai_agent_tools')
      .select('tool_id, permission_level, requires_approval, ai_tools(slug, risk_level)')
      .eq('agent_id', agent.id).eq('permission_level', 'allow');

    const allowedSlugs = new Set<string>();
    const approvalBySlug = new Map<string, boolean>();
    const riskBySlug = new Map<string, RiskLevel>();
    for (const at of agentTools || []) {
      const tool = (at as Record<string, any>).ai_tools;
      if (!tool?.slug || !TOOL_MAP.has(tool.slug)) continue;
      allowedSlugs.add(tool.slug);
      approvalBySlug.set(tool.slug, !!(at as Record<string, any>).requires_approval);
      riskBySlug.set(tool.slug, (tool.risk_level || 'none') as RiskLevel);
    }
    if (!allowedSlugs.size) {
      return await failRun('no_tools', `לסוכן "${agent.name}" לא הוגדרו כלים.`);
    }

    // ---- בדיקת הרשאה חוזרת ----
    //
    // ה-job עשוי להמתין בתור דקות. אם התפקיד של מי שהזמין אותו השתנה
    // בינתיים (או שהוא הוסר מהמשרד), אין להריץ. סעיף 3.5 דורש זאת
    // מפורשות: "בדיקת הרשאה חוזרת".
    if (job.user_id) {
      const { data: member } = await sb.from('office_members')
        .select('role').eq('user_id', job.user_id).eq('office_id', officeId).maybeSingle();
      if (!member) {
        return await failRun('permission_revoked', 'המשתמש שהזמין את המשימה אינו חבר במשרד עוד.');
      }
    }

    // ---- תקציב ----
    const { data: spendRows } = await sb.rpc('ai_spend_window', { p_office_id: officeId });
    const spend = Array.isArray(spendRows) ? spendRows[0] : spendRows;
    const budget = evaluateBudget(
      Number(spend?.today_cost || 0), Number(spend?.month_cost || 0),
      Number(settings?.daily_budget_usd ?? 5), Number(settings?.monthly_budget_usd ?? 50),
      (settings?.on_budget_exceeded || 'stop') as 'stop' | 'downgrade',
    );
    if (budget.exceeded && budget.action === 'stop') {
      return await failRun('budget_exceeded', 'חריגה מתקציב ה-AI — ההרצה נעצרה.');
    }

    // ---- מודל ----
    const modelConfig = (version?.model_config || {}) as Record<string, unknown>;
    let model = String(modelConfig.model || agent.default_model);
    model = pickModel(String(job.job_type), model);
    // חריגה מתקציב במצב downgrade → מודל זול במקום לעצור (סעיף 21).
    if (budget.exceeded && budget.action === 'downgrade') {
      model = String(settings?.cheap_model || 'claude-haiku-4-5-20251001');
    }
    const maxSteps = Number(modelConfig.max_steps || agent.max_steps || 8);
    const maxCost = Number(agent.max_cost_per_run || 0.5);
    const temperature = Number(modelConfig.temperature ?? agent.default_temperature ?? 0.3);
    const maxTokens = Number(modelConfig.max_tokens || 4000);

    await sb.from('ai_runs').update({
      status: 'running', started_at: new Date().toISOString(),
      agent_version_id: version?.id || null,
      model_provider: 'anthropic', model_name: model,
    }).eq('id', runId);

    // ---- context ----
    const db: CrmDb = await loadOfficeDb(sb, officeId);
    const { data: office } = await sb.from('offices').select('name').eq('id', officeId).maybeSingle();

    const ctxParts = await buildContext({
      sb, officeId, db,
      agentId: agent.id,
      clientId: job.client_id, matterId: job.matter_id,
      goal: String(job.payload?.goal || job.job_type),
      payload: job.payload || {},
      officeName: office?.name,
      officeMemory: (settings?.office_memory || {}) as Record<string, unknown>,
    });

    await sb.from('ai_runs').update({ context_summary: ctxParts.full.slice(0, 12000) }).eq('id', runId);
    await sb.from('ai_run_steps').insert({
      office_id: officeId, run_id: runId, step_number: ++stepNumber,
      step_type: 'context', status: 'completed',
      tool_output: { tokens: ctxParts.tokens, sections: {
        office: !!ctxParts.office, client: !!ctxParts.client,
        matter: !!ctxParts.matter, memories: !!ctxParts.memories } },
    });

    // ---- הלולאה ----
    const provider = getProvider(settings?.ai_provider_mode);
    const systemPrompt = [
      BASE_SYSTEM_RULES, '',
      String(version?.system_prompt || agent.system_prompt || ''), '',
      '## הקשר', ctxParts.full,
    ].join('\n');

    const toolCtx: ToolCtx = {
      sb, officeId, userId: job.user_id, role: 'agent', db,
      runId, agentId: agent.id,
      clientId: job.client_id, matterId: job.matter_id,
      proposals: [], injectionFlags: [],
    };

    const messages: AIMessage[] = [{
      role: 'user',
      content: String(job.payload?.goal || `בצע משימה מסוג ${job.job_type}`),
    }];
    const toolDefs = toolDefsForModel([...allowedSlugs]);

    let totalIn = 0, totalOut = 0, totalCost = 0;
    let finalText = '';
    let blockedForApproval = false;
    let stopFlag = '';

    for (let step = 0; step < maxSteps; step++) {
      // עצירת חירום נבדקת בכל איטרציה, לא רק בהתחלה — כדי שלחיצה על
      // "עצור הכול" תעצור גם הרצות שכבר באוויר (סעיף 8.5).
      const { data: liveSettings } = await sb.from('ai_settings')
        .select('emergency_stop').eq('office_id', officeId).maybeSingle();
      if (liveSettings?.emergency_stop) { stopFlag = 'emergency_stop'; break; }

      const { data: liveJob } = await sb.from('ai_jobs')
        .select('status').eq('id', job.id).maybeSingle();
      if (liveJob?.status === 'cancelled') { stopFlag = 'cancelled'; break; }

      const resp = await provider.generate({
        model, system: systemPrompt, messages,
        tools: toolDefs, maxTokens, temperature,
      });

      totalIn += resp.inputTokens;
      totalOut += resp.outputTokens;
      totalCost += resp.cost;

      await sb.from('ai_run_steps').insert({
        office_id: officeId, run_id: runId, step_number: ++stepNumber,
        step_type: 'model', status: 'completed',
        model_output: resp.text ? resp.text.slice(0, 20000) : null,
        input_tokens: resp.inputTokens, output_tokens: resp.outputTokens,
        tool_output: { stop_reason: resp.stopReason, tool_calls: resp.toolCalls.map((c) => c.name) },
      });

      if (resp.text) finalText = resp.text;

      // תקרת עלות להרצה — עוצרת ריצה שיצאה משליטה לפני שהיא יקרה.
      if (totalCost > maxCost) {
        stopFlag = 'max_cost';
        finalText += `\n\n⚠ ההרצה נעצרה: חריגה מתקרת העלות של הסוכן ($${maxCost}).`;
        break;
      }

      if (resp.stopReason !== 'tool_use' || !resp.toolCalls.length) break;

      // ---- ביצוע הכלים ----
      messages.push({ role: 'assistant', content: resp.rawContent });
      const toolResults: unknown[] = [];

      for (const call of resp.toolCalls) {
        const before = toolCtx.proposals.length;
        const result = await execTool(call.name, call.input, toolCtx, allowedSlugs);
        const newProposals = toolCtx.proposals.slice(before);

        await sb.from('ai_run_steps').insert({
          office_id: officeId, run_id: runId, step_number: ++stepNumber,
          step_type: 'tool', tool_slug: call.name,
          tool_input: call.input,
          tool_output: { ok: result.ok, text: String(result.text).slice(0, 8000), data: result.data },
          status: result.ok ? 'completed' : 'failed',
          error: result.ok ? null : result.text,
        });

        await audit(sb, {
          officeId, actorType: 'agent', agentId: agent.id, runId,
          clientId: job.client_id, matterId: job.matter_id,
          action: `tool:${call.name}`, entityType: 'ai_tool', entityId: call.name,
          after: { input: call.input, ok: result.ok }, correlationId: runId,
          severity: result.ok ? 'info' : 'warning',
        });

        // כל הצעה הופכת לשורת אישור.
        //
        // החלטת האישור מחושבת **לכל הצעה בנפרד, לפי ה-slug והסיכון שלה** —
        // ולא לפי הכלי שנקרא. ההבחנה מהותית: כלי יכול להסלים סיכון בתוך
        // עצמו לפי הקלט. draft_email עם recipient_is_opposing_party=true
        // מייצר הצעה בשם send_letter_opposing ברמת critical, ו-draft_message
        // עם contains_legal_advice=true מייצר send_legal_notice ברמת high.
        // חישוב לפי הכלי היה מתייחס לשניהם כ-medium ומאפשר החלה אוטומטית
        // של מכתב לצד שכנגד — בדיוק הפעולה שנמצאת ברשימה הקשיחה.
        for (const p of newProposals) {
          // רמת הסיכון שהוגדרה ב-ai_tools משמשת רצפה, לא תחליף: הכלי יכול
          // רק להחמיר מעליה, לעולם לא להקל. כך משרד שסימן כלי כמסוכן יותר
          // מקבל את מבוקשו, בלי לבטל את ההסלמה שהקוד עושה לפי הקלט.
          const effectiveRisk = maxRisk(
            p.riskLevel, riskBySlug.get(call.name) || 'none',
          );
          const decision = needsApproval({
            toolSlug: p.toolSlug,
            riskLevel: effectiveRisk,
            agentPolicy: (agent.approval_policy || 'sensitive') as ApprovalPolicy,
            autonomyLevel: Number(agent.autonomy_level || 2),
            // הסימון ב-DB חל על הכלי שנקרא בפועל
            toolRequiresApproval: approvalBySlug.get(call.name) || false,
            outboundPaused: !!settings?.outbound_messages_paused,
            readOnlyMode: !!settings?.read_only_mode,
          });
          await createApproval(sb, {
            officeId, runId, jobId: job.id, agentId: agent.id,
            clientId: (p.payload.clientId as string) || job.client_id,
            matterId: (p.payload.caseId as string) || job.matter_id,
            // הרמה האפקטיבית היא זו שנשמרת ומוצגת במסך האישורים — אחרת
            // המשתמש היה רואה "בינוני" על פעולה שהמערכת טיפלה בה כקריטית.
            proposal: { ...p, riskLevel: effectiveRisk },
            decision, userId: job.user_id,
          });
          if (decision.required) blockedForApproval = true;
        }

        toolResults.push({
          type: 'tool_result', tool_use_id: call.id,
          content: result.text,
          is_error: !result.ok,
        });
      }

      messages.push({ role: 'user', content: toolResults });

      if (step === maxSteps - 1) stopFlag = 'max_steps';
    }

    // ---- סיום ----
    // max_cost / max_steps מסומנים כ-failed ולא כ-completed: הרצה שנעצרה
    // כי נגמר לה התקציב או הצעדים לא סיימה את המשימה, והצגתה כ"הושלם"
    // גורמת למשתמש להניח שיש לו תשובה מלאה כשאין.
    const finalStatus = stopFlag === 'emergency_stop' ? 'stopped'
      : stopFlag === 'cancelled' ? 'cancelled'
      : blockedForApproval ? 'waiting_approval'
      : (stopFlag === 'max_cost' || stopFlag === 'max_steps') ? 'failed'
      : 'completed';

    const flags: Record<string, unknown> = {};
    if (stopFlag) flags[stopFlag] = true;
    if (toolCtx.injectionFlags.length) {
      flags.injection_suspected = true;
      flags.injection_details = toolCtx.injectionFlags;
      await audit(sb, {
        officeId, actorType: 'agent', agentId: agent.id, runId,
        action: 'prompt_injection_detected', severity: 'security',
        after: { details: toolCtx.injectionFlags }, correlationId: runId,
      });
    }
    if (budget.exceeded && budget.action === 'downgrade') flags.budget_downgraded = true;

    await sb.from('ai_runs').update({
      status: finalStatus,
      error_code: stopFlag === 'max_cost' ? 'max_cost'
        : stopFlag === 'max_steps' ? 'max_steps' : null,
      error_message: stopFlag === 'max_cost' ? 'ההרצה נעצרה: חריגה מתקרת העלות של הסוכן'
        : stopFlag === 'max_steps' ? 'ההרצה נעצרה: מספר הצעדים המרבי מוצה' : null,
      output_data: { text: finalText, proposals: toolCtx.proposals.length },
      input_tokens: totalIn, output_tokens: totalOut,
      estimated_cost: totalCost, steps_used: stepNumber,
      flags, completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
    }).eq('id', runId);

    await sb.rpc('ai_usage_daily_upsert', {
      p_office_id: officeId, p_agent_id: agent.id, p_model: model, p_provider: 'anthropic',
      p_in_tokens: totalIn, p_out_tokens: totalOut, p_cost: totalCost,
      p_success: finalStatus === 'completed' || finalStatus === 'waiting_approval',
    });

    // חריגת עלות/צעדים נשלחת כ-dead_letter ולא כ-failed: 'failed' מפעיל
    // את מסלול ה-backoff וההרצה החוזרת ב-release_ai_job, וניסיון חוזר של
    // הרצה שנגמר לה התקציב פשוט ישרוף עוד כסף ויעצר באותה נקודה.
    // dead_letter הוא מצב סופי, והמסך מציע עליו "הרץ שוב" ידני.
    await sb.rpc('release_ai_job', {
      p_job_id: job.id,
      p_status: finalStatus === 'waiting_approval' ? 'waiting_approval'
        : finalStatus === 'stopped' ? 'cancelled'
        : finalStatus === 'failed' ? 'dead_letter' : finalStatus,
      p_error: stopFlag === 'max_cost' ? 'חריגה מתקרת העלות'
        : stopFlag === 'max_steps' ? 'מספר הצעדים המרבי מוצה' : null,
      p_result: { text: finalText.slice(0, 20000), cost: totalCost, proposals: toolCtx.proposals.length },
    });

    return {
      job_id: job.id, run_id: runId, status: finalStatus,
      cost: totalCost, steps: stepNumber, proposals: toolCtx.proposals.length,
    };
  } catch (e) {
    console.error('[worker] run failed', e);
    return await failRun('exception', e instanceof Error ? e.message : String(e));
  }
}

// ============================================================

async function createApproval(sb: ReturnType<typeof admin>, opts: {
  officeId: string; runId: string; jobId: string; agentId: string;
  clientId?: string | null; matterId?: string | null;
  proposal: Proposal;
  decision: { required: boolean; reason: string; hardBlock: boolean };
  userId?: string | null;
}) {
  const { proposal: p, decision } = opts;

  // הצעה שלא דורשת אישור נשמרת כ-approved: ההחלה עדיין נעשית בדפדפן
  // (הוא הכותב היחיד ל-app_data), אבל בלי לחכות ללחיצה של אדם. כך רמות
  // 3-4 יכולות לפעול "אוטומטית" בלי לוותר על נתיב כתיבה אחד ובטוח.
  const status = decision.required ? 'pending' : 'approved';

  const { error: insErr } = await sb.from('ai_approvals').insert({
    office_id: opts.officeId, run_id: opts.runId, job_id: opts.jobId,
    agent_id: opts.agentId, client_id: opts.clientId || null, matter_id: opts.matterId || null,
    action_type: p.toolSlug,
    action_label: approvalLabel(p.toolSlug, p.payload),
    risk_level: p.riskLevel,
    proposed_payload: p.payload,
    proposed_content: p.content || null,
    source_refs: p.sourceRefs || [],
    reason_required: decision.required ? decision.reason : null,
    status,
    requested_by: opts.userId || null,
    approved_at: status === 'approved' ? new Date().toISOString() : null,
    // אישור שלא טופל שבועיים כנראה כבר לא רלוונטי; עדיף שיפוג מאשר
    // שיוחל בטעות חודשים אחרי שההקשר השתנה.
    expires_at: new Date(Date.now() + 14 * 86400000).toISOString(),
  });

  // supabase-js לא זורק — הוא מחזיר {error}. בלי הבדיקה הזו, כישלון כתיבה
  // היה משאיר את ההרצה במצב "waiting_approval" בלי שום שורת אישור לאשר:
  // המשתמש רואה משימה תקועה לנצח, והמודל כבר קיבל "ההצעה נשמרה".
  if (insErr) {
    console.error('[worker] approval insert failed', insErr);
    throw new Error('שמירת ההצעה לאישור נכשלה: ' + insErr.message);
  }

  await audit(sb, {
    officeId: opts.officeId, actorType: 'agent', agentId: opts.agentId, runId: opts.runId,
    clientId: opts.clientId, matterId: opts.matterId,
    action: decision.required ? 'approval_requested' : 'action_auto_approved',
    entityType: 'ai_approval', entityId: p.toolSlug,
    after: { risk: p.riskLevel, reason: decision.reason }, correlationId: opts.runId,
    severity: p.riskLevel === 'critical' ? 'warning' : 'info',
  });
}
