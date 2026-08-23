// ביצוע כלי בהקשר של שיחה — הנתיב היחיד, לכל הקוראים.
//
// שלושה קוראים שונים מגיעים לפונקציה אחת:
//   • ה-orchestrator, כשהמודל ביקש כלי בתוך תור שיחה.
//   • שרת קול שמריץ מודל משלו וקורא tool.execute ישירות.
//   • מסך הבדיקה ב-CRM.
//
// שלושתם עוברים כאן, ולכן שלושתם מקבלים בדיוק את אותה בדיקת הרשאות,
// אותה אידמפוטנטיות ואותו רישום. נתיב עוקף היה בדיוק המקום שבו הבדיקה
// שנשמעת מיותרת נשמטת — ואז מתגלה שהיא לא הייתה מיותרת.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import type { CrmDb } from '../db.ts';
import {
  VOICE_TOOLS, VOICE_TOOL_MAP, execVoiceTool,
  type CallCenterSettings, type ToolPermission, type VoiceToolCtx, type ExecOutcome,
} from './tools.ts';

/** מיפוי כלי → סוג אירוע בציר הזמן. */
export const TOOL_EVENT: Record<string, string> = {
  lookup_client: 'CLIENT_LOOKUP',
  lookup_lead: 'LEAD_LOOKUP',
  create_lead: 'LEAD_CREATED',
  create_task: 'TASK_CREATED',
  request_human_callback: 'TASK_CREATED',
  create_note: 'NOTE_CREATED',
  check_calendar: 'CALENDAR_CHECK',
  create_appointment: 'APPOINTMENT_CREATED',
  send_message: 'MESSAGE_SENT',
  transfer_call: 'TRANSFER_REQUESTED',
};

export type ToolCallRequest = { id: string; name: string; input: Record<string, unknown> };

/** סידור מפתחות לפני גיבוב — {a:1,b:2} ו-{b:2,a:1} חייבים לתת אותו מפתח. */
export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined || val === '' || val === null) continue;
      out[k] = canonicalize(val);
    }
    return out;
  }
  return v;
}

/**
 * ביצוע כלי בודד, כולל רישום ואידמפוטנטיות.
 *
 * ⚠ מפתח האידמפוטנטיות נגזר מהכלי + הקלט המנורמל. אותה בקשה בדיוק בתוך
 * אותה שיחה מחזירה את התוצאה הקודמת במקום לבצע שוב — זה מה שמונע פגישה
 * שנייה כשהמודל חוזר על עצמו או כששרת הקול שידר את הבקשה מחדש אחרי
 * timeout. המפרט דורש זאת במפורש: "אותה פעולה לא יכולה ליצור שתי פגישות
 * בגלל Retry".
 */
export async function executeToolForCall(
  sb: SupabaseClient, officeId: string, callId: string,
  tc: ToolCallRequest,
  permissions: Map<string, ToolPermission>,
  ctx: VoiceToolCtx,
): Promise<ExecOutcome> {
  const { stableHash } = await import('../crypto.ts');
  const idem = await stableHash(tc.name, canonicalize(tc.input));

  const { data: prior } = await sb.from('call_actions')
    .select('id, status, response_payload, entity_type, entity_id')
    .eq('call_id', callId).eq('idempotency_key', idem).maybeSingle();

  if (prior && prior.status === 'success') {
    const payload = (prior.response_payload || {}) as Record<string, unknown>;
    return {
      status: 'success',
      result: {
        ok: true,
        message: String(payload.message || 'הפעולה כבר בוצעה בשיחה זו.'),
        data: (payload.data || undefined) as Record<string, unknown> | undefined,
        entityType: prior.entity_type || undefined,
        entityId: prior.entity_id || undefined,
      },
    };
  }

  const def = VOICE_TOOL_MAP.get(tc.name);
  const { data: actionRow } = await sb.from('call_actions').upsert({
    office_id: officeId, call_id: callId, tool_name: tc.name,
    request_payload: tc.input, status: 'executing',
    idempotency_key: idem, started_at: new Date().toISOString(),
  }, { onConflict: 'call_id,idempotency_key' }).select('id').single();

  const outcome = await execVoiceTool(tc.name, tc.input, permissions.get(tc.name) || null, ctx);

  if (actionRow) {
    await sb.from('call_actions').update({
      status: outcome.status,
      response_payload: { message: outcome.result.message, data: outcome.result.data || null },
      error: outcome.status === 'success' ? null : outcome.result.message,
      entity_type: outcome.result.entityType || null,
      entity_id: outcome.result.entityId || null,
      completed_at: new Date().toISOString(),
    }).eq('id', actionRow.id);
  }

  const eventType = outcome.status === 'success'
    ? (TOOL_EVENT[tc.name] || 'TOOL_EXECUTED')
    : (outcome.status === 'blocked' ? 'TOOL_BLOCKED' : 'TOOL_FAILED');

  // ⚠ מה שהמתקשר אמר **לא** נרשם כאן. ציר הזמן מתאר מה קרה; התוכן חי
  // בתמלול, תחת אותה מדיניות שמירה. שכפול שלו לתוך payload היה יוצר
  // עותק שני שאיש לא זוכר למחוק.
  await sb.from('call_events').insert({
    office_id: officeId, call_id: callId, event_type: eventType,
    payload: {
      tool: tc.name,
      ok: outcome.result.ok,
      message: outcome.result.message.slice(0, 300),
      entity_type: outcome.result.entityType || null,
      entity_id: outcome.result.entityId || null,
      read_only: def?.readOnly || false,
    },
  });

  return outcome;
}

// ============================================================
// הפעלה עצמאית — שרת קול שמריץ מודל משלו
// ============================================================

export async function buildCallToolCtx(
  sb: SupabaseClient, officeId: string, callId: string,
): Promise<{ ctx: VoiceToolCtx; permissions: Map<string, ToolPermission>; agentId: string | null }> {
  const { data: session } = await sb.from('call_sessions')
    .select('*').eq('id', callId).eq('office_id', officeId).maybeSingle();
  if (!session) throw new Error('השיחה לא נמצאה');

  const { data: settings } = await sb.from('call_center_settings')
    .select('public_office_phone, human_transfer_number, recording_enabled, ai_enabled, emergency_stop')
    .eq('office_id', officeId).maybeSingle();

  const { loadOfficeDb } = await import('../db.ts');
  let db: CrmDb = await loadOfficeDb(sb, officeId);

  const state = {
    clientId: session.client_id as string | null,
    leadId: session.lead_id as string | null,
    matterId: session.matter_id as string | null,
  };

  const ctx = {
    sb, officeId, callId,
    callerPhone: session.caller_phone,
    get clientId() { return state.clientId; },
    get leadId() { return state.leadId; },
    get matterId() { return state.matterId; },
    get db() { return db; },
    settings: (settings || {}) as CallCenterSettings,
    refresh: (next: CrmDb) => { db = next; },
    isSimulation: Boolean(session.is_simulation),
  } as VoiceToolCtx;

  const permissions = await loadToolPermissions(sb, session.agent_id);
  return { ctx, permissions, agentId: session.agent_id };
}

export async function loadToolPermissions(
  sb: SupabaseClient, agentId: string | null,
): Promise<Map<string, ToolPermission>> {
  const map = new Map<string, ToolPermission>();
  if (!agentId) return map;
  const { data } = await sb.from('agent_tools')
    .select('tool_name, enabled, available, requires_confirmation, risk_level, unavailable_reason')
    .eq('agent_id', agentId);
  for (const r of data || []) map.set(r.tool_name, r as ToolPermission);
  return map;
}

/** הפעלת כלי יחיד מבחוץ (tool.execute). עובר בדיוק באותם שערים. */
export async function runStandaloneTool(
  sb: SupabaseClient, officeId: string, callId: string,
  toolName: string, input: Record<string, unknown>,
): Promise<ExecOutcome> {
  const { ctx, permissions } = await buildCallToolCtx(sb, officeId, callId);
  return executeToolForCall(sb, officeId, callId,
    { id: 'ext_' + Date.now().toString(36), name: toolName, input }, permissions, ctx);
}

/**
 * הכלים שהסוכן רשאי להפעיל, בפורמט שמודל חיצוני יכול לצרוך.
 *
 * מוחזרים גם כלים שאינם זמינים, עם הסיבה — כדי ששרת קול יוכל להסביר
 * למה משהו לא נעשה, במקום לגלות זאת רק כשהבקשה נדחית.
 */
export async function listToolsForAgent(
  sb: SupabaseClient, officeId: string, agentId: string | null,
): Promise<Array<Record<string, unknown>>> {
  let resolvedId = agentId;
  if (!resolvedId) {
    const { data } = await sb.from('voice_agents')
      .select('id').eq('office_id', officeId).eq('slug', 'receptionist')
      .eq('is_active', true).limit(1).maybeSingle();
    resolvedId = data?.id || null;
  }
  const permissions = await loadToolPermissions(sb, resolvedId);

  return VOICE_TOOLS.map((t) => {
    const p = permissions.get(t.name);
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      risk_level: p?.risk_level || t.risk,
      read_only: t.readOnly,
      enabled: Boolean(p?.enabled),
      available: Boolean(p?.available),
      requires_confirmation: Boolean(p?.requires_confirmation),
      unavailable_reason: p?.unavailable_reason || null,
      input_schema: {
        type: 'object',
        properties: t.schema.properties || {},
        required: t.schema.required || [],
      },
    };
  });
}
