// לוג ביקורת.
//
// "כל פעולה של סוכן חייבת להיות מתועדת" (סעיף 29). audit_logs הוא
// insert-only מבחינת המשתמש — אין policy ל-update או delete על הטבלה.
// לוג ביקורת שניתן לערוך אינו לוג ביקורת.
//
// כתיבת לוג לעולם לא מפילה את הפעולה שהיא מתעדת: אם ה-insert נכשל אנחנו
// מדפיסים ל-console וממשיכים. ההפך — לאבד הרצה שהצליחה בגלל שגיאת לוג —
// גרוע יותר.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

export type AuditEntry = {
  officeId: string;
  actorType: 'user' | 'agent' | 'system' | 'automation' | 'webhook';
  actorId?: string | null;
  userId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  clientId?: string | null;
  matterId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  severity?: 'info' | 'warning' | 'security' | 'error';
  correlationId?: string | null;
  req?: Request;
};

export async function audit(sb: SupabaseClient, e: AuditEntry): Promise<void> {
  try {
    const { error } = await sb.from('audit_logs').insert({
      office_id: e.officeId,
      actor_type: e.actorType,
      actor_id: e.actorId ?? null,
      user_id: e.userId ?? null,
      agent_id: e.agentId ?? null,
      run_id: e.runId ?? null,
      client_id: e.clientId ?? null,
      matter_id: e.matterId ?? null,
      action: e.action,
      entity_type: e.entityType ?? null,
      entity_id: e.entityId ?? null,
      before_data: e.before ?? null,
      after_data: truncateForLog(e.after),
      severity: e.severity ?? 'info',
      ip_address: e.req?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: e.req?.headers.get('user-agent') ?? null,
      correlation_id: e.correlationId ?? null,
    });
    // supabase-js מחזיר {error} ולא זורק, ולכן ה-catch למטה לא היה נתפס
    // אף פעם וכשלי כתיבת ביקורת היו בלתי נראים לחלוטין.
    if (error) console.error('[audit] insert failed', error.message, e.action);
  } catch (err) {
    console.error('[audit] failed to write audit log', err);
  }
}

/**
 * חוסם ערכים ענקיים בלוג. פלט של סוכן מנסח יכול להיות מסמך שלם — שמירת
 * עשרות KB בכל שורת audit מנפחת את הטבלה עד שהמסך שקורא אותה נהיה איטי.
 * הטקסט המלא ממילא נשמר ב-ai_run_steps וב-ai_approvals.
 */
function truncateForLog(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const s = JSON.stringify(v);
  if (s.length <= 4000) return v;
  return { _truncated: true, _originalLength: s.length, preview: s.slice(0, 4000) };
}
