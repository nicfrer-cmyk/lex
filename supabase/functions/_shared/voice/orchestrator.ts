// מנוע השיחה.
//
// ## הקובץ היחיד שמנהל שיחה
// שיחה אמיתית מ-Asterisk ושיחת סימולציה מהדפדפן נכנסות שתיהן לכאן, לאותן
// שלוש פונקציות: startCall / handleUtterance / endCall. ההבדל היחיד הוא
// מי ממלא את VoiceLlm ומאיפה מגיע הטקסט (STT או תיבת קלט). זו הסיבה
// שאפשר לסמוך על מצב הבדיקה: הוא לא בודק חיקוי של המערכת, הוא בודק את
// המערכת.
//
// ## מה נרשם, ולמה הכול
// כל שיחה מייצרת ארבעה סוגי רשומות, וכל אחד עונה על שאלה אחרת שנשאלת
// בדיעבד:
//   call_transcript_segments — מה נאמר
//   call_events              — מה קרה ומתי (ציר הזמן)
//   call_actions             — מה ה-AI ניסה לעשות, כולל מה שנחסם
//   call_sessions            — התוצאה: סיווג, דחיפות, סיכום
//
// ## עמידות
// כלי שנכשל אינו מפיל את השיחה. הוא מסמן manual_followup_required, נרשם
// כ-failed, והמודל מקבל הודעת שגיאה קצרה וממשיך. מתקשר שנותק כי בדיקת
// יומן נפלה הוא התוצאה הגרועה ביותר האפשרית במערכת הזו.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import type { CrmDb } from '../db.ts';
import {
  toolDefsForModel,
  type CallCenterSettings, type ToolPermission, type VoiceToolCtx,
} from './tools.ts';
import { executeToolForCall } from './gateway.ts';
import {
  MockVoiceLlm, AnthropicVoiceLlm, type VoiceLlm, type VoiceMsg,
  type VoiceClassification, callerText,
} from './llm.ts';
import { scoreUrgency, guessCategory, type Urgency, type UrgencyRules } from './urgency.ts';
import { normalizePhone, samePhone, todayISO } from '../security.ts';

// ============================================================
// טיפוסים
// ============================================================

export type CallSession = {
  id: string;
  office_id: string;
  external_call_id: string;
  agent_id: string | null;
  phone_line_id: string | null;
  direction: string;
  caller_phone: string | null;
  called_phone: string | null;
  client_id: string | null;
  lead_id: string | null;
  matter_id: string | null;
  status: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number;
  category: string | null;
  subcategory: string | null;
  urgency: string;
  sentiment: string | null;
  outcome: string | null;
  summary: string | null;
  transcript_status: string;
  recording_status: string;
  manual_followup_required: boolean;
  followup_reason: string | null;
  is_simulation: boolean;
  turn_count: number;
  metadata: Record<string, unknown>;
};

export type VoiceAgentRow = {
  id: string; office_id: string; slug: string; name: string;
  role: string; system_prompt: string; greeting: string; language: string;
  llm_provider: string; llm_model: string; temperature: number;
  max_turns: number; business_hours: Record<string, unknown>;
  escalation_rules: Record<string, unknown>; urgency_rules: Record<string, unknown>;
  is_active: boolean;
};

const MAX_TOOL_STEPS = 6;
/** תקרת ההיסטוריה שנשמרת. שיחה ארוכה לא אמורה לנפח שורה בלי גבול. */
const MAX_HISTORY_BLOCKS = 80;

// ============================================================
// עזרים
// ============================================================

export async function logEvent(
  sb: SupabaseClient, officeId: string, callId: string,
  eventType: string, payload: Record<string, unknown> = {},
): Promise<void> {
  // אירוע שלא נרשם לא מצדיק להפיל שיחה — אותו עיקרון של audit.ts.
  const { error } = await sb.from('call_events').insert({
    office_id: officeId, call_id: callId, event_type: eventType, payload,
  });
  if (error) console.error('[voice] event insert failed', eventType, error.message);
}

export async function addSegment(
  sb: SupabaseClient, officeId: string, callId: string,
  speaker: 'caller' | 'agent' | 'human' | 'system', text: string,
  opts: { sequence?: number; startedAtMs?: number; endedAtMs?: number; confidence?: number } = {},
): Promise<number> {
  // ⚠ Number() מפורש, ו-`sequence` מוצהר כ-number ולא נגזר: התשובה
  // מ-PostgREST מגיעה כ-any, והשמה של any ל-`let` שהוסק כ-number|undefined
  // מחזירה אותו לטיפוס המוצהר. התוצאה הייתה sequence אפשרי-undefined
  // שנכתב לעמודה not null — כלומר קטע תמלול שנופל בשקט באמצע שיחה.
  let sequence: number;
  if (opts.sequence != null) {
    sequence = opts.sequence;
  } else {
    const { data } = await sb.from('call_transcript_segments')
      .select('sequence').eq('call_id', callId)
      .order('sequence', { ascending: false }).limit(1).maybeSingle();
    const last = Number(data?.sequence);
    sequence = (Number.isFinite(last) ? last : -1) + 1;
  }
  // upsert ולא insert: מסירה חוזרת של אותו קטע (retry של שרת הקול)
  // מעדכנת ולא מכפילה. האילוץ (call_id, sequence) הוא מה שהופך את זה
  // לאפשרי.
  const { error } = await sb.from('call_transcript_segments').upsert({
    office_id: officeId, call_id: callId, sequence, speaker,
    text: String(text || '').slice(0, 8000),
    started_at_ms: opts.startedAtMs ?? null,
    ended_at_ms: opts.endedAtMs ?? null,
    confidence: opts.confidence ?? null,
    is_final: true,
  }, { onConflict: 'call_id,sequence' });
  if (error) console.error('[voice] segment upsert failed', error.message);
  return sequence;
}

async function loadSettings(sb: SupabaseClient, officeId: string): Promise<CallCenterSettings> {
  const { data } = await sb.from('call_center_settings')
    .select('public_office_phone, human_transfer_number, recording_enabled, ai_enabled, emergency_stop')
    .eq('office_id', officeId).maybeSingle();
  return data || {};
}

async function loadAgent(
  sb: SupabaseClient, officeId: string, agentId?: string | null,
): Promise<VoiceAgentRow | null> {
  let q = sb.from('voice_agents').select('*').eq('office_id', officeId).eq('is_active', true);
  q = agentId ? q.eq('id', agentId) : q.eq('slug', 'receptionist');
  const { data } = await q.limit(1).maybeSingle();
  return (data as VoiceAgentRow) || null;
}

async function loadPermissions(
  sb: SupabaseClient, agentId: string,
): Promise<Map<string, ToolPermission>> {
  const { data } = await sb.from('agent_tools')
    .select('tool_name, enabled, available, requires_confirmation, risk_level, unavailable_reason')
    .eq('agent_id', agentId);
  const map = new Map<string, ToolPermission>();
  for (const r of data || []) map.set(r.tool_name, r as ToolPermission);
  return map;
}

/**
 * בוחר את מנוע השפה.
 *
 * הסדר מכוון: מצב mock מפורש גובר על הכול (כך אפשר לבדוק מול DB אמיתי
 * בלי לשלוח בקשה החוצה), ואחריו — היעדר מפתח API. **אין נפילה שקטה**:
 * המצב שנבחר מוחזר ומוצג במסך, כי מערכת שמראה "פעיל" בזמן שהיא במצב
 * הדגמה היא בדיוק מה שהמפרט אוסר.
 */
export async function getVoiceLlm(
  sb: SupabaseClient, officeId: string, agent: VoiceAgentRow | null,
): Promise<VoiceLlm> {
  const { data: aiSettings } = await sb.from('ai_settings')
    .select('ai_provider_mode').eq('office_id', officeId).maybeSingle();

  const envMode = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } })
    .Deno?.env.get('AI_PROVIDER_MODE')?.toLowerCase();
  const hasKey = Boolean(
    (globalThis as { Deno?: { env: { get(k: string): string | undefined } } })
      .Deno?.env.get('ANTHROPIC_API_KEY'));

  if (envMode === 'mock' || aiSettings?.ai_provider_mode === 'mock' || !hasKey) {
    return new MockVoiceLlm();
  }
  if (agent && agent.llm_provider !== 'anthropic') {
    // ספק אחר הוגדר אך אינו ממומש. לא מתחזים לו — נופלים ל-mock ומודיעים.
    console.warn(`[voice] llm_provider "${agent.llm_provider}" אינו ממומש; מצב הדגמה`);
    return new MockVoiceLlm();
  }
  const { AnthropicProvider } = await import('../provider.ts');
  return new AnthropicVoiceLlm(new AnthropicProvider());
}

// ============================================================
// פתיחת שיחה
// ============================================================

export type StartCallParams = {
  externalCallId: string;
  callerPhone: string;
  calledPhone?: string;
  direction?: 'inbound' | 'outbound';
  isSimulation?: boolean;
  agentId?: string | null;
  startedAt?: string;
};

export type StartCallResult = {
  session: CallSession;
  agent: VoiceAgentRow | null;
  greeting: string;
  created: boolean;
  providerMode: 'live' | 'mock';
};

export async function startCall(
  sb: SupabaseClient, officeId: string, params: StartCallParams,
): Promise<StartCallResult> {
  const callerPhone = normalizePhone(params.callerPhone) || params.callerPhone || '';
  const settings = await loadSettings(sb, officeId);
  const agent = await loadAgent(sb, officeId, params.agentId);

  // ⚠ אידמפוטנטיות. שרת הקול חוזר על "שיחה התקבלה" כשלא קיבל תשובה.
  // בלי הבדיקה הזו כל retry היה יוצר שיחה, ליד ומשימה נוספים.
  const { data: existing } = await sb.from('call_sessions')
    .select('*').eq('office_id', officeId)
    .eq('external_call_id', params.externalCallId).maybeSingle();

  if (existing) {
    const llm = await getVoiceLlm(sb, officeId, agent);
    return {
      session: existing as CallSession, agent,
      greeting: (existing.metadata as Record<string, unknown>)?.greeting as string || agent?.greeting || '',
      created: false,
      providerMode: llm.isMock ? 'mock' : 'live',
    };
  }

  const { data: line } = await sb.from('phone_lines')
    .select('id').eq('office_id', officeId).eq('is_active', true)
    .order('created_at').limit(1).maybeSingle();

  // זיהוי מוקדם, לפני שהסוכן אומר מילה: כך "שלום ישראל" אפשרי, ובעיקר
  // כך המסך מציג שם ולא מספר בזמן שהשיחה עדיין מצלצלת.
  const { loadOfficeDb } = await import('../db.ts');
  const db = await loadOfficeDb(sb, officeId);
  const client = db.clients.find((c) =>
    (c.phone && samePhone(String(c.phone), callerPhone)) ||
    (c.contactPhone && samePhone(String(c.contactPhone), callerPhone)));
  const lead = !client
    ? db.leads.find((l) => l.phone && samePhone(String(l.phone), callerPhone))
    : null;
  const matter = client
    ? db.cases.find((c) => c.client === client.id && c.status !== 'closed')
    : null;

  const greeting = agent?.greeting || 'שלום, הגעת למשרד עורכי הדין. איך אפשר לעזור?';

  const { data: inserted, error } = await sb.from('call_sessions').insert({
    office_id: officeId,
    external_call_id: params.externalCallId,
    phone_line_id: line?.id || null,
    agent_id: agent?.id || null,
    direction: params.direction || 'inbound',
    caller_phone: callerPhone,
    called_phone: params.calledPhone || settings.public_office_phone || null,
    client_id: client?.id || null,
    lead_id: lead?.id || null,
    matter_id: matter?.id || null,
    status: 'answering',
    started_at: params.startedAt || new Date().toISOString(),
    answered_at: new Date().toISOString(),
    // הקלטה כבויה כברירת מחדל, וההגדרה היא מה שקובע — לא הקוד.
    recording_status: settings.recording_enabled ? 'pending' : 'disabled',
    transcript_status: 'partial',
    is_simulation: Boolean(params.isSimulation),
    metadata: { greeting, conversation: [] as VoiceMsg[] },
  }).select('*').single();

  if (error) {
    // 23505 = מירוץ עם מסירה מקבילה של אותה שיחה. קוראים את מה שנוצר.
    if ((error as { code?: string }).code === '23505') {
      const { data: raced } = await sb.from('call_sessions').select('*')
        .eq('office_id', officeId).eq('external_call_id', params.externalCallId).single();
      const llm = await getVoiceLlm(sb, officeId, agent);
      return {
        session: raced as CallSession, agent, greeting, created: false,
        providerMode: llm.isMock ? 'mock' : 'live',
      };
    }
    throw new Error('יצירת השיחה נכשלה: ' + error.message);
  }

  const session = inserted as CallSession;
  await logEvent(sb, officeId, session.id, 'CALL_RECEIVED', {
    from: callerPhone, to: session.called_phone, simulation: session.is_simulation,
  });
  await logEvent(sb, officeId, session.id, 'CALL_ANSWERED', { agent: agent?.name || null });
  await logEvent(sb, officeId, session.id, 'CLIENT_LOOKUP', { phone: callerPhone });
  if (client) {
    await logEvent(sb, officeId, session.id, 'CLIENT_FOUND', {
      client_id: client.id, name: client.name,
    });
  }

  await addSegment(sb, officeId, session.id, 'agent', greeting, { sequence: 0 });
  await sb.from('call_sessions').update({ status: 'active' }).eq('id', session.id);
  session.status = 'active';

  const llm = await getVoiceLlm(sb, officeId, agent);
  return { session, agent, greeting, created: true, providerMode: llm.isMock ? 'mock' : 'live' };
}

// ============================================================
// תור שיחה
// ============================================================

export type TurnResult = {
  reply: string;
  done: boolean;
  actions: Array<{ tool: string; status: string; message: string; entityType?: string; entityId?: string }>;
  urgency: Urgency;
  category: string | null;
  providerMode: 'live' | 'mock';
  costUsd: number;
};

export async function handleUtterance(
  sb: SupabaseClient, officeId: string, callId: string, utterance: string,
  opts: { speaker?: 'caller' | 'human'; confidence?: number } = {},
): Promise<TurnResult> {
  const { data: sessionRow } = await sb.from('call_sessions')
    .select('*').eq('id', callId).eq('office_id', officeId).maybeSingle();
  if (!sessionRow) throw new Error('השיחה לא נמצאה');
  const session = sessionRow as CallSession;

  if (['completed', 'failed', 'missed'].includes(session.status)) {
    throw new Error('השיחה כבר הסתיימה');
  }

  const settings = await loadSettings(sb, officeId);
  if (settings.emergency_stop || settings.ai_enabled === false) {
    const msg = 'המזכירה הדיגיטלית אינה פעילה כרגע. הפנייה נרשמה ועורך הדין יחזור אליך.';
    await addSegment(sb, officeId, callId, 'agent', msg);
    await logEvent(sb, officeId, callId, 'AGENT_DISABLED', {});
    await sb.from('call_sessions')
      .update({ manual_followup_required: true, followup_reason: 'המזכירה הדיגיטלית מושבתת' })
      .eq('id', callId);
    return {
      reply: msg, done: true, actions: [], urgency: session.urgency as Urgency,
      category: session.category, providerMode: 'mock', costUsd: 0,
    };
  }

  const agent = await loadAgent(sb, officeId, session.agent_id);
  if (!agent) throw new Error('לא הוגדר סוכן קולי פעיל למשרד');
  const permissions = await loadPermissions(sb, agent.id);
  const llm = await getVoiceLlm(sb, officeId, agent);

  const { loadOfficeDb } = await import('../db.ts');
  let db: CrmDb = await loadOfficeDb(sb, officeId);

  await addSegment(sb, officeId, callId, opts.speaker || 'caller', utterance,
    { confidence: opts.confidence });
  await logEvent(sb, officeId, callId, 'CALLER_UTTERANCE', { chars: utterance.length });

  // ---- היסטוריה ----
  const history: VoiceMsg[] =
    Array.isArray((session.metadata || {}).conversation)
      ? ((session.metadata as Record<string, unknown>).conversation as VoiceMsg[]).slice()
      : [];
  if (!history.length && session.metadata?.greeting) {
    history.push({ role: 'agent', text: String(session.metadata.greeting) });
  }
  history.push({ role: 'caller', text: utterance });

  const ctxState = {
    clientId: session.client_id,
    leadId: session.lead_id,
    matterId: session.matter_id,
  };

  const toolCtx: VoiceToolCtx = {
    sb, officeId, callId,
    callerPhone: session.caller_phone,
    get clientId() { return ctxState.clientId; },
    get leadId() { return ctxState.leadId; },
    get matterId() { return ctxState.matterId; },
    get db() { return db; },
    settings,
    refresh: (next: CrmDb) => { db = next; },
    isSimulation: session.is_simulation,
  } as VoiceToolCtx;

  const actions: TurnResult['actions'] = [];
  let classification: VoiceClassification = {};
  let reply = '';
  let done = false;
  let cost = 0;
  let toolFailed = false;

  const toolSpecs = toolDefsForModel(permissions);

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const resp = await llm.turn({
      systemPrompt: buildSystemPrompt(agent, session, settings),
      history, tools: toolSpecs,
      model: agent.llm_model, temperature: Number(agent.temperature) || 0.3,
      callerPhone: session.caller_phone,
    });
    cost += resp.costUsd || 0;
    if (resp.classification) classification = { ...classification, ...resp.classification };

    if (!resp.toolCalls.length) {
      reply = resp.text || 'רשמתי. משהו נוסף?';
      done = resp.done;
      history.push({ role: 'agent', text: reply });
      break;
    }

    for (const tc of resp.toolCalls) {
      history.push({ role: 'tool_call', id: tc.id, name: tc.name, input: tc.input });
      const outcome = await executeToolForCall(sb, officeId, callId, tc, permissions, toolCtx);

      if (outcome.status !== 'success') toolFailed = true;
      actions.push({
        tool: tc.name, status: outcome.status, message: outcome.result.message,
        entityType: outcome.result.entityType, entityId: outcome.result.entityId,
      });

      // מזהים שנוצרו נכנסים להקשר, כך שכלי הבא בשרשרת יידע לשייך אליהם.
      const d = outcome.result.data || {};
      if (d.client_id) ctxState.clientId = String(d.client_id);
      if (d.lead_id) ctxState.leadId = String(d.lead_id);

      history.push({
        role: 'tool_result', id: tc.id, name: tc.name,
        ok: outcome.result.ok, message: outcome.result.message,
        data: outcome.result.data,
      });
    }
    // המודל מקבל את התוצאות וממשיך. אם מיצה את הצעדים — יוצאים עם מה שיש.
    if (step === MAX_TOOL_STEPS - 1) {
      reply = 'רשמתי את הפרטים. עורך הדין יחזור אליך.';
      history.push({ role: 'agent', text: reply });
      done = true;
    }
  }

  if (reply) await addSegment(sb, officeId, callId, 'agent', reply);

  // ---- סיווג ודחיפות ----
  const fullText = callerText(history);
  const verdict = scoreUrgency({
    transcript: fullText,
    modelUrgency: classification.urgency || null,
    deadlineISO: classification.deadlineISO || null,
    todayISO: todayISO(),
    isExistingClient: Boolean(ctxState.clientId),
    hoursSincePreviousCall: null,
  }, (agent.urgency_rules || {}) as UrgencyRules);

  const category = classification.category || session.category || guessCategory(fullText);
  const urgencyChanged = verdict.urgency !== session.urgency;

  await sb.from('call_sessions').update({
    client_id: ctxState.clientId,
    lead_id: ctxState.leadId,
    matter_id: ctxState.matterId,
    category,
    subcategory: classification.subcategory || session.subcategory,
    urgency: verdict.urgency,
    sentiment: classification.sentiment || session.sentiment,
    turn_count: (session.turn_count || 0) + 1,
    transcript_status: 'partial',
    manual_followup_required: session.manual_followup_required || toolFailed,
    followup_reason: toolFailed
      ? (session.followup_reason || 'פעולה אוטומטית נכשלה במהלך השיחה')
      : session.followup_reason,
    metadata: {
      ...(session.metadata || {}),
      conversation: history.slice(-MAX_HISTORY_BLOCKS),
      urgency_reasons: verdict.reasons,
      provider_mode: llm.isMock ? 'mock' : 'live',
    },
  }).eq('id', callId);

  if (urgencyChanged && (verdict.urgency === 'high' || verdict.urgency === 'critical')) {
    await logEvent(sb, officeId, callId, 'URGENCY_DETECTED', {
      urgency: verdict.urgency, reasons: verdict.reasons,
    });
  }
  if (reply) await logEvent(sb, officeId, callId, 'AGENT_REPLY', { chars: reply.length });

  return {
    reply, done, actions,
    urgency: verdict.urgency, category,
    providerMode: llm.isMock ? 'mock' : 'live',
    costUsd: cost,
  };
}

// ============================================================
// System prompt
// ============================================================

export function buildSystemPrompt(
  agent: VoiceAgentRow, session: CallSession, settings: CallCenterSettings,
): string {
  const parts = [agent.system_prompt];

  parts.push(`\n## הקשר השיחה\nמספר המתקשר: ${session.caller_phone || 'לא ידוע'}\n` +
    `תאריך היום: ${todayISO()}\n` +
    (session.is_simulation ? 'זוהי שיחת בדיקה מתוך המערכת, לא שיחה אמיתית.\n' : ''));

  // ⚠ ההנחיה הזו נאמרת למודל, אבל האכיפה שלה בקוד: transfer_call מסומן
  // available=false כל עוד אין מספר העברה, וה-gateway חוסם אותו. הטקסט
  // כאן קיים כדי שהמודל לא ינסה מלכתחילה ויבזבז תור.
  if (!settings.human_transfer_number) {
    parts.push('\nהעברת שיחה לנציג אינה זמינה. כשהמתקשר מבקש לדבר עם אדם — ' +
      'השתמשי ב-request_human_callback והסבירי שעורך הדין יחזור אליו.');
  }

  parts.push(`
## כללי עבודה עם כלים
- זהי תמיד את המתקשר לפני שאת מוסרת מידע כלשהו.
- אל תמציאי מועד פגישה. קודם check_calendar, ורק מועד שהוחזר ממנו.
- אל תדווחי על פעולה כבוצעה לפני שהכלי החזיר הצלחה.
- אם כלי נכשל — אל תנסי שוב יותר מפעם אחת. אמרי שהפנייה נרשמה וצרי משימה.
`.trim());

  return parts.join('\n');
}

// ============================================================
// סיום שיחה
// ============================================================

export type EndCallParams = {
  status?: 'completed' | 'failed' | 'missed';
  outcome?: string;
  durationSeconds?: number;
  endedAt?: string;
};

export async function endCall(
  sb: SupabaseClient, officeId: string, callId: string, params: EndCallParams = {},
): Promise<{ summary: string; outcome: string; session: CallSession }> {
  const { data: sessionRow } = await sb.from('call_sessions')
    .select('*').eq('id', callId).eq('office_id', officeId).maybeSingle();
  if (!sessionRow) throw new Error('השיחה לא נמצאה');
  const session = sessionRow as CallSession;

  // אידמפוטנטי: "השיחה הסתיימה" שנשלח פעמיים לא מייצר סיכום שני.
  if (session.ended_at) {
    return {
      summary: session.summary || '', outcome: session.outcome || 'completed', session,
    };
  }

  const { data: segments } = await sb.from('call_transcript_segments')
    .select('speaker, text').eq('call_id', callId).order('sequence');
  const { data: actionRows } = await sb.from('call_actions')
    .select('tool_name, status, response_payload, entity_type, entity_id')
    .eq('call_id', callId).order('started_at');

  const summary = await buildSummary(sb, officeId, session, segments || [], actionRows || []);
  const outcome = params.outcome || deriveOutcome(actionRows || [], session);

  const endedAt = params.endedAt || new Date().toISOString();
  const duration = params.durationSeconds ??
    Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(session.started_at)) / 1000));

  await sb.from('call_sessions').update({
    status: params.status || 'completed',
    ended_at: endedAt,
    duration_seconds: duration,
    summary,
    outcome,
    transcript_status: 'final',
  }).eq('id', callId);

  await logEvent(sb, officeId, callId, 'CALL_ENDED', {
    outcome, duration_seconds: duration,
    actions: (actionRows || []).length,
  });

  // ⚠ רשת ביטחון. שיחה שהסתיימה בלי שנוצרה ממנה שום פעולה, ושסווגה
  // כדחופה או שנכשלה בה פעולה — לא יכולה פשוט להיעלם. נוצרת משימה,
  // כי פנייה שאבדה במשרד עורכי דין היא נזק אמיתי ללקוח.
  await ensureFollowupTask(sb, officeId, session, actionRows || [], summary);

  const { data: updated } = await sb.from('call_sessions').select('*').eq('id', callId).single();
  return { summary, outcome, session: updated as CallSession };
}

function deriveOutcome(
  actions: Array<{ tool_name: string; status: string }>, session: CallSession,
): string {
  const okTools = new Set(actions.filter((a) => a.status === 'success').map((a) => a.tool_name));
  if (okTools.has('create_appointment')) return 'appointment_scheduled';
  if (okTools.has('request_human_callback')) return 'callback_requested';
  if (okTools.has('create_task')) return 'task_created';
  if (okTools.has('create_lead')) return 'lead_created';
  if (session.status === 'missed') return 'missed';
  if (actions.some((a) => a.status === 'failed' || a.status === 'blocked')) return 'partial_failure';
  return 'information_only';
}

const OUTCOME_HE: Record<string, string> = {
  appointment_scheduled: 'נקבעה פגישה',
  callback_requested: 'נרשמה בקשת חזרה',
  task_created: 'נוצרה משימה',
  lead_created: 'נפתחה פנייה',
  information_only: 'מסירת מידע',
  partial_failure: 'טיפול חלקי',
  missed: 'לא נענתה',
};
export function outcomeLabel(outcome: string | null): string {
  return outcome ? (OUTCOME_HE[outcome] || outcome) : '—';
}

/**
 * סיכום השיחה.
 *
 * במצב חי — המודל מסכם. במצב הדגמה — נבנה מהתמלול ומהפעולות בפועל.
 * בשני המקרים הסיכום מתאר **מה נעשה** ולא מה נאמר: זה מה שעורך הדין
 * קורא כשהוא פותח את השיחה למחרת.
 */
async function buildSummary(
  sb: SupabaseClient, officeId: string, session: CallSession,
  segments: Array<{ speaker: string; text: string }>,
  actions: Array<{ tool_name: string; status: string; response_payload?: unknown }>,
): Promise<string> {
  const transcript = segments
    .map((s) => `${s.speaker === 'caller' ? 'מתקשר' : 'מזכירה'}: ${s.text}`)
    .join('\n').slice(0, 6000);

  const done = actions.filter((a) => a.status === 'success').map((a) => a.tool_name);
  const failed = actions.filter((a) => a.status === 'failed' || a.status === 'blocked');

  const factual = [
    done.includes('create_lead') ? 'נפתחה פנייה חדשה' : '',
    done.includes('create_task') || done.includes('request_human_callback') ? 'נוצרה משימה לעורך הדין' : '',
    done.includes('create_appointment') ? 'נקבעה פגישה' : '',
    done.includes('create_note') ? 'נרשמה הערה' : '',
    failed.length ? `${failed.length} פעולות לא הושלמו` : '',
  ].filter(Boolean).join('; ');

  const agent = await loadAgent(sb, officeId, session.agent_id);
  const llm = await getVoiceLlm(sb, officeId, agent);

  if (!llm.isMock && agent) {
    try {
      const { AnthropicProvider } = await import('../provider.ts');
      const provider = new AnthropicProvider();
      const resp = await provider.generate({
        model: agent.llm_model,
        system: 'סכם שיחה טלפונית של משרד עורכי דין בשתיים עד ארבע שורות, בעברית, ' +
          'בגוף שלישי, עובדתי בלבד. ציין: מי פנה, בשל מה, מה סוכם ומה נדרש להמשך. ' +
          'אל תוסיף פרשנות משפטית ואל תמציא פרטים שלא נאמרו.',
        messages: [{
          role: 'user',
          content: `תמלול:\n${transcript}\n\nפעולות שבוצעו: ${factual || 'אין'}`,
        }],
        maxTokens: 400,
        temperature: 0.2,
      });
      if (resp.text) return resp.text.trim();
    } catch (e) {
      // סיכום שנכשל אינו מצדיק לאבד את השיחה — נופלים לסיכום עובדתי.
      console.warn('[voice] summary generation failed', e instanceof Error ? e.message : e);
    }
  }

  const callerSaid = segments.filter((s) => s.speaker === 'caller')
    .map((s) => s.text).join(' ').slice(0, 500);
  const bits = [
    `פנייה טלפונית${session.caller_phone ? ` מהמספר ${session.caller_phone}` : ''}` +
    `${session.category ? ` בנושא ${session.category}` : ''}.`,
    callerSaid ? `לדברי הפונה: ${callerSaid}` : '',
    session.urgency === 'high' || session.urgency === 'critical'
      ? `הפנייה סווגה בדחיפות ${session.urgency === 'critical' ? 'קריטית' : 'גבוהה'}.` : '',
    factual ? `${factual}.` : 'לא בוצעו פעולות במערכת.',
  ].filter(Boolean);
  return bits.join(' ');
}

/**
 * משימת רשת ביטחון לשיחה שלא הותירה עקבות.
 *
 * הכתיבה נעשית דרך אותו saveOfficeDb של כל השאר — לא נתיב מיוחד. משימה
 * שנוצרת בדרך אחרת היא משימה שתתנהג אחרת.
 */
async function ensureFollowupTask(
  sb: SupabaseClient, officeId: string, session: CallSession,
  actions: Array<{ tool_name: string; status: string }>, summary: string,
): Promise<void> {
  const created = actions.some((a) =>
    a.status === 'success' &&
    ['create_task', 'request_human_callback', 'create_appointment'].includes(a.tool_name));
  const failed = actions.some((a) => a.status === 'failed' || a.status === 'blocked');
  const urgent = session.urgency === 'high' || session.urgency === 'critical';

  if (created && !failed) return;
  if (!failed && !urgent && !session.manual_followup_required) return;

  try {
    const { saveOfficeDb } = await import('../db.ts');
    const text = `טיפול בפנייה טלפונית — ${session.caller_phone || 'מתקשר לא מזוהה'}`;
    await saveOfficeDb(sb, officeId, (d) => {
      if (d.tasks.some((t) => !t.done && t.text === text)) return;
      d.tasks.unshift({
        id: Date.now().toString(36) + Math.random().toString(36).substring(2, 7),
        text,
        due: todayISO(),
        caseId: session.matter_id || '',
        priority: urgent ? 'urgent' : 'normal',
        notes: `${summary}\n\nנוצר אוטומטית בסיום שיחה שדרשה השלמה ידנית.`,
        done: false,
        createdByCall: session.id,
      } as never);
    });
    await sb.from('call_sessions').update({
      manual_followup_required: true,
      followup_reason: failed ? 'פעולה אוטומטית נכשלה' : 'שיחה דחופה ללא פעולה שהושלמה',
    }).eq('id', session.id);
    await logEvent(sb, officeId, session.id, 'FOLLOWUP_TASK_CREATED', { urgent });
  } catch (e) {
    console.error('[voice] followup task failed', e instanceof Error ? e.message : e);
  }
}
