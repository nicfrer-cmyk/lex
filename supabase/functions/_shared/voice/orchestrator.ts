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
import { samePhone, todayISO } from '../security.ts';
import { normalizePhoneNumber } from './phone.ts';
import { supabaseCommandStore } from './commands.ts';

// ============================================================
// מכונת המצבים
// ============================================================
//
// ⚠ נפרד מ-status. `status` הוא מצב השיחה מבחינת הטלפוניה (מצלצל /
// פעילה / הסתיימה) ו-`voice_state` הוא מה שהסוכן עושה **בתוך** שיחה
// פעילה. מיזוגם היה יוצר מצב שבו "בשיחה" לא מבחין בין הקשבה למתקשר
// לבין המתנה לתשובת כלי — וזו בדיוק ההבחנה שדרושה כשמנסים להבין למה
// שיחה נשמעה איטית.

export type VoiceState =
  | 'ringing' | 'answering' | 'listening' | 'transcribing' | 'thinking'
  | 'speaking' | 'waiting_for_tool' | 'on_hold' | 'completing' | 'ended' | 'failed';

/** תווית עברית לכל מצב — מוצגת בכרטיס השיחה החיה. */
export const VOICE_STATE_HE: Record<VoiceState, string> = {
  ringing: 'מצלצל',
  answering: 'עונה לשיחה',
  listening: 'מקשיבה',
  transcribing: 'מתמללת',
  thinking: 'מנסחת תשובה',
  speaking: 'מדברת',
  waiting_for_tool: 'מבצעת פעולה במערכת',
  on_hold: 'בהמתנה',
  completing: 'מסכמת',
  ended: 'הסתיימה',
  failed: 'נכשלה',
};

/**
 * מעבר מצב. כל מעבר מייצר אירוע בציר הזמן.
 *
 * הכתיבה best-effort במכוון: מצב שלא נרשם אינו סיבה להפיל שיחה חיה.
 * המצב האמיתי ממשיך לחיות בזיכרון התהליך; מה שאובד הוא שורה בציר
 * הזמן, וזה נזק קטן בהרבה ממתקשר שנותק.
 */
export async function setVoiceState(
  sb: SupabaseClient, officeId: string, callId: string,
  state: VoiceState, payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    await sb.from('call_sessions')
      .update({ voice_state: state, voice_state_at: new Date().toISOString() })
      .eq('id', callId).eq('office_id', officeId);
    await logEvent(sb, officeId, callId, 'STATE_' + state.toUpperCase(), payload);
  } catch (e) {
    console.warn('[voice] state transition not recorded', state,
      e instanceof Error ? e.message : e);
  }
}

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

  // ---- זהות (20260823000000) ----
  identity_status: 'unidentified' | 'phone_match' | 'verified' | 'rejected';
  identity_verified_at: string | null;
  identity_verification_method: string | null;
  raw_caller_phone: string | null;

  // ---- snapshot של תצורת הסוכן ----
  agent_config_version: string | null;
  prompt_hash: string | null;
  llm_provider: string | null;
  llm_model: string | null;
  stt_provider: string | null;
  tts_provider: string | null;
  agent_snapshot: Record<string, unknown> | null;

  // ---- מכונת מצבים ועיבוד ----
  voice_state: string;
  post_call_status: 'none' | 'pending' | 'processing' | 'done' | 'failed';
  tags: string[] | null;

  // ---- איכות ----
  interruptions_count: number;
  silence_events: number;
  stt_low_confidence_count: number;
  tool_failures_count: number;
  call_completed_normally: boolean | null;
};

export type VoiceAgentRow = {
  id: string; office_id: string; slug: string; name: string;
  description: string | null;
  role: string; system_prompt: string; greeting: string; language: string;
  llm_provider: string; llm_model: string; temperature: number;
  // ⚠ הספקים כאן הם ההגדרה. מה שרץ בפועל מגיע מה-heartbeat של שרת הקול,
  // ו-providerName() מעדיף אותו — הגדרה אומרת מה רצינו, heartbeat אומר
  // מה באמת ענה למתקשר.
  stt_provider: string | null; stt_model: string | null;
  voice_provider: string | null; voice_id: string | null;
  max_turns: number; business_hours: Record<string, unknown>;
  escalation_rules: Record<string, unknown>; urgency_rules: Record<string, unknown>;
  is_active: boolean;
  updated_at: string | null;
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

/** מצב הספקים כפי ששרת הקול דיווח בו ב-heartbeat האחרון. */
async function loadGatewayProviders(
  sb: SupabaseClient, officeId: string,
): Promise<Record<string, Record<string, unknown>>> {
  const { data } = await sb.from('voice_gateway_status')
    .select('providers').eq('office_id', officeId).maybeSingle();
  return (data?.providers || {}) as Record<string, Record<string, unknown>>;
}

/**
 * שם הספק שנרשם על השיחה.
 *
 * ⚠ מעדיף את מה ששרת הקול **מדווח בפועל** על פני מה שמוגדר בסוכן.
 * הגדרה אומרת מה רצינו; ה-heartbeat אומר מה באמת רץ. כששניהם נבדלים,
 * זה השני שקובע מה השיחה הזו שמעה.
 */
function providerName(
  providers: Record<string, Record<string, unknown>>, kind: string, fallback?: string | null,
): string {
  const p = providers[kind];
  if (p && typeof p.name === 'string' && p.name) return String(p.name);
  if (p && typeof p.mode === 'string' && p.mode) return String(p.mode);
  return fallback || 'mock';
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
  const phoneInfo = normalizePhoneNumber(params.callerPhone);
  const callerPhone = phoneInfo.normalized || params.callerPhone || '';
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

  // ---- Snapshot של תצורת הסוכן ----
  //
  // ⚠ נלקח **עכשיו** ולא נקרא בדיעבד. prompt שישונה בצהריים לא יכול
  // לשנות למפרע את מה ששיחה של הבוקר "התנהלה לפיו" — וזו בדיוק השאלה
  // שנשאלת כשמישהו מתלונן על משהו שהמזכירה אמרה. hash ולא הטקסט המלא:
  // הוא מספיק כדי להוכיח זהות מול גרסה, בלי לשכפל את ה-prompt לכל שורה.
  const llm = await getVoiceLlm(sb, officeId, agent);
  const gwProviders = await loadGatewayProviders(sb, officeId);
  const { stableHash } = await import('../crypto.ts');
  const promptHash = agent ? (await stableHash(agent.system_prompt)).slice(0, 16) : null;
  const toolsPolicyVersion = agent
    ? (await stableHash(JSON.stringify(
        [...(await loadPermissions(sb, agent.id)).entries()].sort()))).slice(0, 16)
    : null;

  // ⚠ זהות: התאמת מספר מעלה ל-phone_match בלבד. היא **לא** verified —
  // טלפון אבוד, בן משפחה או זיוף Caller ID מייצרים אותה התאמה בדיוק.
  const identityStatus = client ? 'phone_match' : 'unidentified';

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
    raw_caller_phone: phoneInfo.raw || params.callerPhone || null,
    identity_status: identityStatus,
    voice_state: 'answering',
    voice_state_at: new Date().toISOString(),
    post_call_status: 'none',
    agent_config_version: agent ? String(agent.updated_at || agent.id) : null,
    prompt_version: promptHash,
    prompt_hash: promptHash,
    tools_policy_version: toolsPolicyVersion,
    llm_provider: llm.isMock ? 'mock' : (agent?.llm_provider || 'anthropic'),
    llm_model: llm.isMock ? 'mock' : (agent?.llm_model || null),
    stt_provider: providerName(gwProviders, 'stt', agent?.stt_provider),
    stt_model: agent?.stt_model || null,
    tts_provider: providerName(gwProviders, 'tts', agent?.voice_provider),
    tts_model: agent?.voice_id || null,
    agent_snapshot: agent
      ? {
          slug: agent.slug, name: agent.name, role: agent.role,
          greeting: agent.greeting, language: agent.language,
          temperature: agent.temperature, max_turns: agent.max_turns,
          business_hours: agent.business_hours,
          escalation_rules: agent.escalation_rules,
          urgency_rules: agent.urgency_rules,
          prompt_hash: promptHash,
        }
      : null,
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

  if (client) {
    await logEvent(sb, officeId, session.id, 'IDENTITY_PHONE_MATCH', {
      client_id: client.id,
      // ההודעה נשמרת בציר הזמן כדי שיהיה ברור בדיעבד שהזהות לא אומתה.
      note: 'התאמת מספר בלבד — הזהות לא אומתה',
    });
  }

  await addSegment(sb, officeId, session.id, 'agent', greeting, { sequence: 0 });
  await sb.from('call_sessions').update({ status: 'active' }).eq('id', session.id);
  session.status = 'active';
  await setVoiceState(sb, officeId, session.id, 'listening');

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

/**
 * מדדים ששרת הקול מדד ואינם ניתנים למדידה כאן.
 *
 * STT ו-TTS קורים במכונה אחרת; ה-CRM לא יכול לתזמן אותם ואין טעם
 * שינחש. הם מגיעים מבחוץ, וההשהיה הכוללת מורכבת מהם יחד עם מה
 * שנמדד כאן (מודל וכלים).
 */
export type ExternalTurnMetrics = {
  turnIndex?: number;
  sttLatencyMs?: number;
  ttsFirstAudioMs?: number;
  ttsTotalMs?: number;
  /** משך ההמתנה מרגע שהמתקשר סיים לדבר — נמדד בשרת הקול. */
  speechEndedAgoMs?: number;
  interrupted?: boolean;
};

export async function handleUtterance(
  sb: SupabaseClient, officeId: string, callId: string, utterance: string,
  opts: {
    speaker?: 'caller' | 'human';
    confidence?: number;
    metrics?: ExternalTurnMetrics;
  } = {},
): Promise<TurnResult> {
  const turnStartedAt = Date.now();
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
    agentId: agent.id,
    // ⚠ כל כתיבה עוברת דרך רישום הפקודות. בלעדיו runCommand נכשל
    // במפורש, כדי שאידמפוטנטיות לא תיעלם בשקט.
    commandStore: supabaseCommandStore(sb, officeId),
    identityStatus: (session.identity_status || 'unidentified') as VoiceToolCtx['identityStatus'],
    identityPolicy: (settings.identity_policy || 'strict') as VoiceToolCtx['identityPolicy'],
  } as VoiceToolCtx;

  const actions: TurnResult['actions'] = [];
  let classification: VoiceClassification = {};
  let reply = '';
  let done = false;
  let cost = 0;
  let toolFailed = false;

  const toolSpecs = toolDefsForModel(permissions);
  let llmTotalMs = 0;
  let llmFirstTokenMs: number | null = null;
  let toolTotalMs = 0;

  await setVoiceState(sb, officeId, callId, 'thinking');

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const llmStartedAt = Date.now();
    await logEvent(sb, officeId, callId, 'LLM_STARTED', { step });

    const resp = await llm.turn({
      systemPrompt: buildSystemPrompt(agent, session, settings),
      history, tools: toolSpecs,
      model: agent.llm_model, temperature: Number(agent.temperature) || 0.3,
      callerPhone: session.caller_phone,
    });

    const llmMs = Date.now() - llmStartedAt;
    llmTotalMs += llmMs;
    // ⚠ אומדן ולא מדידה: הנתיב הזה אינו זורם, ולכן "הטוקן הראשון"
    // מגיע יחד עם התשובה כולה. כשיתווסף נתיב זורם, הערך יגיע ממנו.
    // עדיף אומדן מסומן על שדה ריק שנראה כמו תקלה במדידה.
    if (llmFirstTokenMs === null) llmFirstTokenMs = llmMs;
    await logEvent(sb, officeId, callId, 'LLM_FIRST_TOKEN', { step, ms: llmMs, estimated: true });

    cost += resp.costUsd || 0;
    if (resp.classification) classification = { ...classification, ...resp.classification };

    if (!resp.toolCalls.length) {
      reply = resp.text || 'רשמתי. משהו נוסף?';
      done = resp.done;
      history.push({ role: 'agent', text: reply });
      break;
    }

    await setVoiceState(sb, officeId, callId, 'waiting_for_tool',
      { tools: resp.toolCalls.map((t) => t.name) });

    for (const tc of resp.toolCalls) {
      history.push({ role: 'tool_call', id: tc.id, name: tc.name, input: tc.input });
      const toolStartedAt = Date.now();
      await logEvent(sb, officeId, callId, 'TOOL_STARTED', { tool: tc.name, tool_call_id: tc.id });

      const outcome = await executeToolForCall(sb, officeId, callId, {
        ...tc,
        // מזהה קריאת הכלי של המודל הוא מה שמבדיל בין בקשה חדשה לבין
        // שידור חוזר של אותה בקשה.
        toolCallId: tc.id,
        schemaVersion: '1',
      }, permissions, toolCtx);
      toolTotalMs += Date.now() - toolStartedAt;
      await logEvent(sb, officeId, callId, 'TOOL_COMPLETED', {
        tool: tc.name, tool_call_id: tc.id, status: outcome.status,
        ms: Date.now() - toolStartedAt,
      });

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

  if (reply) {
    await setVoiceState(sb, officeId, callId, 'speaking');
    await addSegment(sb, officeId, callId, 'agent', reply);
  }

  // ---- מדדי התור ----
  //
  // ⚠ turn_latency_ms הוא מה שהאדם בקו מרגיש: מרגע שסיים לדבר ועד
  // שהתשובה מתחילה להישמע. הוא מורכב מ-STT (נמדד בשרת הקול), מהמודל
  // ומהכלים (נמדדים כאן), ומ-TTS (שוב בשרת הקול). ממוצע על השיחה
  // מסתיר את התור האחד שלקח שמונה שניות — וזה זה שגרם לניתוק.
  const ext = opts.metrics || {};
  const turnIndex = ext.turnIndex ?? (session.turn_count || 0);
  const serverMs = Date.now() - turnStartedAt;
  const turnLatencyMs = serverMs + (ext.sttLatencyMs || 0) + (ext.ttsFirstAudioMs || 0);

  try {
    await sb.from('call_turn_metrics').upsert({
      office_id: officeId, call_id: callId, turn_index: turnIndex,
      stt_latency_ms: ext.sttLatencyMs ?? null,
      llm_first_token_ms: llmFirstTokenMs,
      llm_total_ms: llmTotalMs,
      tool_latency_ms: toolTotalMs || null,
      tts_first_audio_ms: ext.ttsFirstAudioMs ?? null,
      tts_total_ms: ext.ttsTotalMs ?? null,
      turn_latency_ms: turnLatencyMs,
      tool_calls: actions.length,
      interrupted: Boolean(ext.interrupted),
      stt_confidence: opts.confidence ?? null,
    }, { onConflict: 'call_id,turn_index' });
  } catch (e) {
    // מדידה שלא נשמרה אינה סיבה להפיל תור שיחה שהצליח.
    console.warn('[voice] turn metrics not saved', e instanceof Error ? e.message : e);
  }

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
    tool_failures_count: (session.tool_failures_count || 0) +
      actions.filter((a) => a.status !== 'success').length,
    stt_low_confidence_count: (session.stt_low_confidence_count || 0) +
      // ⚠ 0.6 הוא הסף שמתחתיו התמלול כבר לא אמין מספיק כדי לפעול לפיו.
      // נספר ולא חוסם: המודל עדיין יקבל את הטקסט, אבל בסיום השיחה
      // יהיה ברור אם היא התנהלה על תמלול רעוע.
      (opts.confidence != null && opts.confidence < 0.6 ? 1 : 0),
    interruptions_count: (session.interruptions_count || 0) +
      (opts.metrics?.interrupted ? 1 : 0),
    metadata: {
      ...(session.metadata || {}),
      conversation: history.slice(-MAX_HISTORY_BLOCKS),
      urgency_reasons: verdict.reasons,
      provider_mode: llm.isMock ? 'mock' : 'live',
    },
  }).eq('id', callId);

  // חזרה להקשבה, אלא אם הסוכן סיים מצידו.
  await setVoiceState(sb, officeId, callId, done ? 'completing' : 'listening');

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

/**
 * סיום שיחה — **הנתיב המהיר בלבד**.
 *
 * ## ההפרדה, ולמה היא לא אופטימיזציה
 * סיכום ע"י מודל לוקח שניות. אם הוא ירוץ כאן, שרת הקול ממתין לתשובה
 * לפני שהוא מנתק — והמתקשר שומע שקט בקצה השיחה, או גרוע מכך, הערוץ
 * נשאר פתוח. מה שקורה כאן הוא רק מה שחייב לקרות לפני הניתוק: לסגור
 * את השיחה, לקבוע תוצאה, ולוודא שלא אבדה פנייה.
 *
 * הסיכום, הסיווג המפורט, הרגש והתגיות מסומנים כ-pending ורצים אחר כך
 * (`postProcessCall`). קריאה חוזרת ל-endCall אינה מייצרת סיכום שני.
 */
export async function endCall(
  sb: SupabaseClient, officeId: string, callId: string, params: EndCallParams = {},
): Promise<{ summary: string; outcome: string; session: CallSession; postCallQueued: boolean }> {
  const { data: sessionRow } = await sb.from('call_sessions')
    .select('*').eq('id', callId).eq('office_id', officeId).maybeSingle();
  if (!sessionRow) throw new Error('השיחה לא נמצאה');
  const session = sessionRow as CallSession;

  // אידמפוטנטי: "השיחה הסתיימה" שנשלח פעמיים לא סוגר אותה שוב.
  if (session.ended_at) {
    return {
      summary: session.summary || '', outcome: session.outcome || 'completed',
      session, postCallQueued: session.post_call_status === 'pending',
    };
  }

  const { data: actionRows } = await sb.from('call_actions')
    .select('tool_name, status, response_payload, entity_type, entity_id')
    .eq('call_id', callId).order('started_at');
  const actions = actionRows || [];

  const outcome = params.outcome || deriveOutcome(actions, session);
  const endedAt = params.endedAt || new Date().toISOString();
  const duration = params.durationSeconds ??
    Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(session.started_at)) / 1000));
  const status = params.status || 'completed';

  // ---- מדדי איכות מצטברים ----
  const { data: turnRows } = await sb.from('call_turn_metrics')
    .select('turn_latency_ms').eq('call_id', callId);
  const latencies = ((turnRows || []) as Array<{ turn_latency_ms: number | null }>)
    .map((t) => Number(t.turn_latency_ms))
    .filter((n: number) => Number.isFinite(n) && n > 0);
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((a: number, b: number) => a + b, 0) / latencies.length)
    : null;
  const maxLatency = latencies.length ? Math.max(...latencies) : null;

  // ⚠ סיכום זמני ועובדתי, שנכתב **מיד**. הוא נדרש כי משימת ההמשך
  // למטה מצטטת אותו, ובגלל שבחלון שבין הניתוק לבין העיבוד עורך הדין
  // כבר עשוי לפתוח את השיחה. הסיכום המלא ידרוס אותו בהמשך.
  const provisional = provisionalSummary(session, actions);

  await sb.from('call_sessions').update({
    status,
    ended_at: endedAt,
    duration_seconds: duration,
    outcome,
    summary: provisional,
    transcript_status: 'final',
    voice_state: status === 'completed' ? 'ended' : 'failed',
    voice_state_at: new Date().toISOString(),
    call_completed_normally: status === 'completed',
    avg_turn_latency_ms: avgLatency,
    max_turn_latency_ms: maxLatency,
    post_call_status: 'pending',
  }).eq('id', callId);

  await logEvent(sb, officeId, callId, 'CALL_ENDED', {
    outcome, duration_seconds: duration, actions: actions.length,
  });

  // ⚠ רשת ביטחון — נשארת בנתיב המהיר בכוונה. שיחה דחופה שלא הותירה
  // עקבות היא פנייה שאבדה, ודחיית היצירה לעיבוד מאוחר הייתה פותחת
  // חלון שבו היא לא קיימת בשום מקום.
  await ensureFollowupTask(sb, officeId, session, actions, provisional);

  const { data: updated } = await sb.from('call_sessions').select('*').eq('id', callId).single();
  return {
    summary: provisional, outcome,
    session: updated as CallSession, postCallQueued: true,
  };
}

/** סיכום עובדתי מיידי, בלי מודל ובלי רשת. */
function provisionalSummary(
  session: CallSession, actions: Array<{ tool_name: string; status: string }>,
): string {
  const done = actions.filter((a) => a.status === 'success').map((a) => a.tool_name);
  const bits = [
    `פנייה טלפונית${session.caller_phone ? ` מהמספר ${session.caller_phone}` : ''}` +
    `${session.category ? ` בנושא ${session.category}` : ''}.`,
    done.includes('create_lead') ? 'נפתחה פנייה.' : '',
    done.includes('create_task') || done.includes('request_human_callback')
      ? 'נוצרה משימה לעורך הדין.' : '',
    done.includes('create_appointment') ? 'נקבעה פגישה.' : '',
    'הסיכום המלא בהכנה.',
  ].filter(Boolean);
  return bits.join(' ');
}

/**
 * העיבוד שאחרי השיחה — סיכום מלא, סיווג, רגש ותגיות.
 *
 * רץ אחרי שהשיחה כבר נסגרה והמתקשר ניתק, ולכן מותר לו לקחת זמן. נקרא
 * ע"י שרת הקול אחרי הניתוק, ע"י המסך, וע"י ה-cron כרשת ביטחון לשיחות
 * שנשארו pending.
 *
 * אידמפוטנטי: שיחה שכבר עובדה מוחזרת כמות שהיא.
 */
export async function postProcessCall(
  sb: SupabaseClient, officeId: string, callId: string,
): Promise<{ processed: boolean; summary: string }> {
  const { data: row } = await sb.from('call_sessions')
    .select('*').eq('id', callId).eq('office_id', officeId).maybeSingle();
  if (!row) throw new Error('השיחה לא נמצאה');
  const session = row as CallSession;

  if (session.post_call_status === 'done') {
    return { processed: false, summary: session.summary || '' };
  }
  if (!session.ended_at) {
    return { processed: false, summary: session.summary || '' };
  }

  // ⚠ נעילה אופטימית. שני קוראים (שרת הקול וה-cron) עלולים להגיע יחד,
  // ושניהם היו קוראים למודל — כלומר תשלום כפול על אותו סיכום.
  const { data: claimed } = await sb.from('call_sessions')
    .update({ post_call_status: 'processing' })
    .eq('id', callId).in('post_call_status', ['pending', 'failed'])
    .select('id');
  if (!claimed || !claimed.length) {
    return { processed: false, summary: session.summary || '' };
  }

  try {
    const { data: segments } = await sb.from('call_transcript_segments')
      .select('speaker, text').eq('call_id', callId).order('sequence');
    const { data: actionRows } = await sb.from('call_actions')
      .select('tool_name, status, response_payload, entity_type, entity_id')
      .eq('call_id', callId).order('started_at');

    const summary = await buildSummary(sb, officeId, session, segments || [], actionRows || []);
    const rows = (segments || []) as Array<{ speaker: string; text: string }>;
    const transcript = rows.filter((x) => x.speaker === 'caller')
      .map((x) => x.text).join(' ');

    await sb.from('call_sessions').update({
      summary,
      category: session.category || guessCategory(transcript),
      tags: deriveTags(session, actionRows || []),
      post_call_status: 'done',
      post_call_completed_at: new Date().toISOString(),
      post_call_error: null,
    }).eq('id', callId);

    await logEvent(sb, officeId, callId, 'POST_CALL_COMPLETED', {
      chars: summary.length,
    });
    return { processed: true, summary };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ⚠ הסיכום הזמני נשאר. שיחה בלי סיכום כלל היא שיחה שעורך הדין לא
    // יכול לקרוא למחרת; חזרה ל-'failed' מאפשרת ל-cron לנסות שוב.
    await sb.from('call_sessions').update({
      post_call_status: 'failed', post_call_error: msg.slice(0, 500),
    }).eq('id', callId);
    await logEvent(sb, officeId, callId, 'POST_CALL_FAILED', { error: msg.slice(0, 300) });
    return { processed: false, summary: session.summary || '' };
  }
}

/** תגיות עובדתיות בלבד — מה קרה בשיחה, לא פרשנות. */
function deriveTags(
  session: CallSession, actions: Array<{ tool_name: string; status: string }>,
): string[] {
  const tags = new Set<string>();
  if (session.category) tags.add(session.category);
  if (session.urgency === 'high' || session.urgency === 'critical') tags.add('דחוף');
  if (session.is_simulation) tags.add('בדיקה');
  if (session.manual_followup_required) tags.add('דורש טיפול');
  for (const a of actions) {
    if (a.status !== 'success') continue;
    if (a.tool_name === 'create_appointment') tags.add('פגישה');
    if (a.tool_name === 'create_lead') tags.add('ליד');
    if (a.tool_name === 'request_human_callback') tags.add('בקשת חזרה');
  }
  return [...tags];
}

/**
 * מעבד את כל השיחות שממתינות. נקרא מה-cron — רשת ביטחון לשיחות
 * ששרת הקול לא הספיק לבקש עבורן עיבוד (נפילה, ניתוק רשת).
 */
export async function drainPostCallQueue(
  sb: SupabaseClient, officeId: string, limit = 10,
): Promise<number> {
  const { data } = await sb.from('call_sessions')
    .select('id').eq('office_id', officeId)
    .in('post_call_status', ['pending', 'failed'])
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: true }).limit(limit);

  let processed = 0;
  for (const row of data || []) {
    try {
      const r = await postProcessCall(sb, officeId, row.id as string);
      if (r.processed) processed++;
    } catch (e) {
      console.error('[voice] post-call failed', row.id, e instanceof Error ? e.message : e);
    }
  }
  return processed;
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
