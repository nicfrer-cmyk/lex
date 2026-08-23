// AI Tool Gateway — השכבה **היחידה** שדרכה סוכן קולי נוגע ב-CRM.
//
// ## העיקרון
// ה-AI לעולם לא מקבל גישת SQL ולא כותב ל-blob בעצמו. הוא מבקש כלי בשם עם
// קלט מובנה; הקוד כאן מאמת סכימה, בודק ב-agent_tools שהכלי מותר לסוכן
// הזה, מבצע, ורושם שורה ב-call_actions — גם כשהתשובה היא "לא".
//
// ## ארבע הגנות שקל לוותר עליהן ואסור
//
//  1. **סכימה שדוחה שדות לא מוכרים** (schema.ts, additionalProperties=false).
//     הקלט מגיע ממודל שמאזין למתקשר. הוא לא קלט של מפתח.
//  2. **רשימת היתר ב-DB.** כלי שאינו רשום ב-agent_tools לסוכן הזה נדחה
//     ונרשם כ-blocked. מתקשר משכנע אינו יכול להרחיב סמכות.
//  3. **החזרת המינימום.** lookup_client מחזיר שם וסיכום תיקים פעילים —
//     לא סכומים, לא מסמכים, לא מספרי תיק בבית משפט. מה שלא נשלח לא
//     יכול להיאמר בטלפון למי שהתחזה ללקוח.
//  4. **אידמפוטנטיות.** אותו כלי + אותו קלט + אותה שיחה = אותה שורה.
//     retry אחרי timeout לא קובע פגישה שנייה.
//
// ## למה הקובץ טהור מ-Deno
// זו הלוגיקה שמחליטה מה AI רשאי לעשות בתיקים של משרד עורכי דין. היא
// חייבת להיבדק ישירות ב-`node --test`. לכן: ייבוא **טיפוסים** בלבד בראש
// הקובץ, ו-db.ts / providers נטענים דינמית רק בתוך פעולה שבאמת צריכה
// אותם — אותו דפוס בדיוק כמו automation/actions.ts.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import type { CrmDb, CrmClient, CrmLead } from '../db.ts';
// `type` מפורש על JsonSchema: הוא טיפוס בלבד, ו-type-stripping של Node
// (שבו רצות הבדיקות) לא יכול לדעת זאת לבד — ייבוא רגיל נכשל בזמן ריצה
// עם "does not provide an export named 'JsonSchema'".
import { type JsonSchema, validate, ValidationError } from '../schema.ts';
import { samePhone, todayISO, addDaysISO, isoToHe } from '../security.ts';
import { normalizePhoneNumber } from './phone.ts';
import { VoiceError } from './errors.ts';
import {
  applyOfficeCommand, buildIdempotencyKey, payloadFingerprint, supabaseCommandStore,
  type CommandStore, type CommandType,
} from './commands.ts';

// ---------- טיפוסים ----------

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export type VoiceToolResult = {
  ok: boolean;
  /** טקסט שהמודל יראה. קצר — הוא נאמר בטלפון, לא נקרא במסך. */
  message: string;
  data?: Record<string, unknown>;
  /** מה נוצר ב-CRM, כדי שהמסך יוכל לקשר ישירות. */
  entityType?: string;
  entityId?: string;
};

export type VoiceToolCtx = {
  sb: SupabaseClient;
  officeId: string;
  /** uuid של call_sessions. משמש כ-correlation id בכל לוג ובכל שורה. */
  callId: string;
  callerPhone: string | null;
  clientId: string | null;
  leadId: string | null;
  matterId: string | null;
  /** ה-blob, נטען פעם אחת לתור. */
  db: CrmDb;
  settings: CallCenterSettings;
  /** מרענן את ה-blob אחרי כתיבה, כדי שכלי הבא יראה את מה שקדם לו. */
  refresh: (db: CrmDb) => void;
  isSimulation: boolean;

  // ---- מעטפת הפקודה ----
  // ⚠ toolCallId הוא מה שמבדיל בין "המודל ביקש שוב את אותו דבר" (קריאה
  // חדשה, מזהה חדש → פעולה חדשה ולגיטימית) לבין "אותה בקשה נשלחה
  // פעמיים ברשת" (אותו מזהה → אותה פעולה). בלעדיו, מתקשר שביקש באמת
  // שתי פגישות היה מקבל אחת.
  toolCallId?: string | null;
  agentId?: string | null;
  schemaVersion?: string;
  /** רישום הפקודות. חובה לכל כתיבה — ראה resolveCommandStore. */
  commandStore?: CommandStore;

  // ---- זהות ----
  // ⚠ Caller ID אינו אימות. 'phone_match' אומר שהמספר מוכר, לא שזה
  // האדם: טלפון אבוד, בן משפחה או זיוף Caller ID מייצרים אותה התאמה
  // בדיוק. מסירת פרטי תיק דורשת 'verified'.
  identityStatus?: 'unidentified' | 'phone_match' | 'verified' | 'rejected';
  identityPolicy?: 'strict' | 'phone_match_ok';

  /**
   * איך כותבים ל-CRM, ואיך קוראים אותו מחדש.
   *
   * ברירת המחדל (כשלא נמסרו) היא saveOfficeDb/loadOfficeDb מ-db.ts, וזה
   * מה שרץ בייצור. ההזרקה קיימת כי ההקשר צריך להיות שלם — "הנה הנתונים
   * והנה איך כותבים אליהם" — במקום שכל כלי יסחוב תלות מוסתרת ב-db.ts.
   * תופעת לוואי חיונית: כך אפשר לבדוק את הכלים האלה ב-`node --test` בלי
   * מסד נתונים, ואלה הכלים שמחליטים מה AI עושה בתיקים של משרד עורכי דין.
   */
  writeDb?: (mutate: (d: CrmDb) => void) => Promise<CrmDb>;
  reload?: () => Promise<CrmDb>;
};

export type CallCenterSettings = {
  public_office_phone?: string | null;
  human_transfer_number?: string | null;
  recording_enabled?: boolean;
  ai_enabled?: boolean;
  emergency_stop?: boolean;
  // ⚠ 'strict' הוא ברירת המחדל: התאמת מספר לבדה אינה מספיקה כדי למסור
  // פרטי תיק. ראה lookup_client.
  identity_policy?: 'strict' | 'phone_match_ok';
  live_calls_enabled?: boolean;
  callback_sla_hours?: number;
};

export type VoiceToolDef = {
  name: string;
  title: string;
  description: string;
  risk: RiskLevel;
  /** קורא בלבד — לא נרשם כ"פעולה שבוצעה" במסך הפעולות. */
  readOnly: boolean;
  schema: JsonSchema;
  handler: (input: Record<string, unknown>, ctx: VoiceToolCtx) => Promise<VoiceToolResult>;
};

// ---------- עזרים ----------

const S = (type: JsonSchema['type'], extra: Partial<JsonSchema> = {}): JsonSchema =>
  ({ type, ...extra });
const OBJ = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
  ({ type: 'object', properties, required });

const ok = (message: string, data?: Record<string, unknown>, entityType?: string, entityId?: string):
  VoiceToolResult => ({ ok: true, message, data, entityType, entityId });
const fail = (message: string): VoiceToolResult => ({ ok: false, message });

/** זהה ל-uid() ב-app.js וב-db.ts: base36, לא uuid. חייב להישאר תואם —
 *  המזהים האלה מתערבבים באותן קולקציות עם מזהים שנוצרו בדפדפן. */
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

/** כתיבה ל-blob. db.ts נטען דינמית — רק כשכלי באמת כותב. */
async function writeDb(ctx: VoiceToolCtx, mutate: (d: CrmDb) => void): Promise<CrmDb> {
  if (ctx.writeDb) return ctx.writeDb(mutate);
  const { saveOfficeDb } = await import('../db.ts');
  return saveOfficeDb(ctx.sb, ctx.officeId, mutate);
}

/**
 * רישום הפקודות של ההקשר.
 *
 * ⚠ נכשל במפורש כששניהם חסרים, ולא נופל בשקט לרישום חדש. רישום שנוצר
 * לכל קריאה פירושו שאידמפוטנטיות לא עובדת — ואז retry אחרי timeout
 * קובע פגישה שנייה, שהיא בדיוק התקלה שהשכבה הזו נבנתה למנוע. כשל רועש
 * עדיף על הגנה שנראית קיימת ואינה.
 */
function resolveCommandStore(ctx: VoiceToolCtx): CommandStore {
  if (ctx.commandStore) return ctx.commandStore;
  if (ctx.sb) return supabaseCommandStore(ctx.sb, ctx.officeId);
  // ההודעה מפורשת כי היא נרשמת ב"פעולות שבוצעו" ובלוג — ומי שקורא
  // אותה צריך לדעת מיד שזו תקלת תצורה ולא כשל של הסוכן.
  throw new VoiceError('UNKNOWN_ERROR',
    'command store missing on VoiceToolCtx', null,
    'שגיאת תצורה: הפעולה לא בוצעה — כתיבה ל-CRM ללא אידמפוטנטיות אינה מותרת.');
}

/**
 * כל כלי שכותב ל-CRM עובר כאן. הכלי מרכיב payload; הפקודה מבצעת.
 *
 * ההפרדה אינה קוסמטית: המוטציה עצמה רצה בתוך saveOfficeDb ולכן מורצת
 * שוב על נתונים טריים כשמשתמש כתב במקביל. כלי שהיה כותב ישירות היה
 * מחליט לפי עותק ישן — וזה המקום שבו פגישה כפולה נולדת.
 */
async function runCommand(
  ctx: VoiceToolCtx, type: CommandType, payload: Record<string, unknown>,
): Promise<VoiceToolResult> {
  const store = resolveCommandStore(ctx);
  const result = await applyOfficeCommand({
    commandId: uid(),
    callId: ctx.callId,
    toolCallId: ctx.toolCallId ?? null,
    agentId: ctx.agentId ?? null,
    idempotencyKey: buildIdempotencyKey({
      callId: ctx.callId,
      toolCallId: ctx.toolCallId,
      type,
      fingerprint: payloadFingerprint(payload),
    }),
    type,
    payload,
    actor: { type: 'agent', id: ctx.agentId ?? null },
    schemaVersion: ctx.schemaVersion || '1',
  }, {
    store,
    write: async (mutate) => {
      const db = await writeDb(ctx, mutate);
      ctx.refresh(db);
      return db;
    },
  });

  return {
    ok: true,
    message: result.message,
    // replayed נחשף למודל ולמסך: "בוצע" ו"כבר היה מבוצע" נראים זהים
    // בלעדיו, ואי אפשר לדעת אם retry עשה משהו.
    data: { ...(result.data || {}), replayed: result.replayed },
    entityType: result.entityType,
    entityId: result.entityId,
  };
}

/** קריאה טרייה של ה-blob — לפני החלטה שתלויה במצב העדכני ביותר. */
async function reloadDb(ctx: VoiceToolCtx): Promise<CrmDb> {
  if (ctx.reload) return ctx.reload();
  const { loadOfficeDb } = await import('../db.ts');
  return loadOfficeDb(ctx.sb, ctx.officeId);
}

/**
 * ניקוי טקסט חופשי שמגיע מהמודל לפני שהוא נכתב ל-CRM.
 *
 * הטקסט מקורו במה שהמתקשר אמר. הוא מוצג אחר כך ב-innerHTML של המסכים
 * (escapeHtml מגן שם), אבל חיתוך אורך והסרת תווי בקרה נעשים כאן כדי
 * שהנתון עצמו יהיה נקי ולא רק התצוגה שלו.
 */
function clean(v: unknown, maxLen = 2000): string {
  return String(v == null ? '' : v)
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

function findClientByPhone(db: CrmDb, phone: string): CrmClient | null {
  if (!phone) return null;
  return db.clients.find((c) =>
    (c.phone && samePhone(String(c.phone), phone)) ||
    (c.contactPhone && samePhone(String(c.contactPhone), phone))) || null;
}

function findLeadByPhone(db: CrmDb, phone: string): CrmLead | null {
  if (!phone) return null;
  return db.leads.find((l) => l.phone && samePhone(String(l.phone), phone)) || null;
}

/**
 * האם המספר שייך דווקא לצד שכנגד (חייב בתיק)?
 *
 * ⚠ קריטי. מספר של חייב שמתקשר אינו "לקוח פוטנציאלי": פתיחת ליד עבורו
 * מזהמת את צנרת המכירות, ומסירת פרטים אליו היא דליפה של מידע על הלקוח
 * שנגדו הוא עומד. הכלים למטה בודקים את זה לפני שהם מתייחסים למתקשר
 * כלקוח או כפונה.
 */
function findDebtorCase(db: CrmDb, phone: string) {
  if (!phone) return null;
  return db.cases.find((c) => c.debtorPhone && samePhone(String(c.debtorPhone), phone)) || null;
}

const TIMEZONE = 'Asia/Jerusalem';

/** HH:MM → דקות מתחילת היום. מחזיר null על קלט לא תקין. */
export function timeToMinutes(t: string): number | null {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function minutesToTime(m: number): string {
  const h = Math.floor(m / 60), min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** יום בשבוע (0=ראשון) לתאריך ISO, בלי תלות באזור הזמן של השרת. */
export function isoWeekday(iso: string): number {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const DEFAULT_WORK_HOURS = { startMin: 9 * 60, endMin: 18 * 60 };
/** שישי (5) ושבת (6) — לא ימי עבודה במשרד. */
export const WEEKEND_DAYS = [5, 6];

export type Slot = { date: string; time: string; endTime: string };

/**
 * חלונות פנויים ביום נתון, בהינתן התפוסות הקיימות.
 *
 * טהורה במכוון: זו הפונקציה שקובעת אם תוצע פגישה שכבר תפוסה, וזו טעות
 * שמתגלה רק כששני לקוחות מגיעים לאותה שעה. ראה test/call-center.test.js.
 */
export function freeSlotsForDay(
  dateISO: string,
  busy: Array<{ startMin: number; endMin: number }>,
  durationMin: number,
  work = DEFAULT_WORK_HOURS,
  stepMin = 30,
): Slot[] {
  if (WEEKEND_DAYS.includes(isoWeekday(dateISO))) return [];
  const sorted = busy.slice().sort((a, b) => a.startMin - b.startMin);
  const out: Slot[] = [];
  for (let start = work.startMin; start + durationMin <= work.endMin; start += stepMin) {
    const end = start + durationMin;
    const clash = sorted.some((b) => start < b.endMin && end > b.startMin);
    if (!clash) out.push({ date: dateISO, time: minutesToTime(start), endTime: minutesToTime(end) });
  }
  return out;
}

/** תפוסות מהיומן הפנימי ליום נתון. אירוע ללא שעה נחשב תופס את כל היום. */
export function busyFromEvents(
  events: Array<{ date?: string; time?: string; durationMinutes?: unknown }>,
  dateISO: string,
  defaultDurationMin = 60,
): Array<{ startMin: number; endMin: number }> {
  return events
    .filter((e) => String(e.date || '').slice(0, 10) === dateISO)
    .map((e) => {
      const start = timeToMinutes(String(e.time || ''));
      if (start === null) return { startMin: 0, endMin: 24 * 60 };
      const dur = Number(e.durationMinutes) > 0 ? Number(e.durationMinutes) : defaultDurationMin;
      return { startMin: start, endMin: start + dur };
    });
}

// ============================================================
// הכלים
// ============================================================

export const VOICE_TOOLS: VoiceToolDef[] = [

  // ---------- זיהוי ----------
  {
    name: 'lookup_client',
    title: 'זיהוי לקוח',
    description:
      'בודק אם מספר הטלפון שייך ללקוח קיים של המשרד. מחזיר שם וסיכום קצר של התיקים ' +
      'הפעילים בלבד — לא סכומים, לא מסמכים ולא פרטי הליך.',
    risk: 'none',
    readOnly: true,
    schema: OBJ({
      phone: S('string', { maxLength: 40, description: 'מספר הטלפון של המתקשר' }),
    }, []),
    handler: (input, ctx) => {
      const info = normalizePhoneNumber(clean(input.phone, 40) || ctx.callerPhone || '');
      const phone = info.normalized || clean(input.phone, 40) || ctx.callerPhone || '';
      if (!phone) return Promise.resolve(fail('לא נמסר מספר טלפון לבדיקה.'));

      // הצד שכנגד קודם: אם המספר תואם לחייב, אין להתייחס אליו כלקוח.
      const debtor = findDebtorCase(ctx.db, phone);
      if (debtor) {
        return Promise.resolve(ok(
          'המספר אינו של לקוח המשרד. אין למסור פרטי תיק. יש לרשום את הפנייה ולהעביר לעורך הדין.',
          { found: false, is_opposing_party: true, identity_status: 'rejected' },
        ));
      }

      const client = findClientByPhone(ctx.db, phone);
      if (!client) {
        return Promise.resolve(ok('לא נמצא לקוח עם המספר הזה.',
          { found: false, identity_status: 'unidentified' }));
      }

      const active = ctx.db.cases.filter((c) => c.client === client.id && c.status !== 'closed');
      const summary = active.length
        ? active.slice(0, 5).map((c) => `${c.name} (${c.stage || 'בטיפול'})`).join(', ')
        : 'אין תיקים פעילים';

      // ⚠ שכבת המדיניות. התאמת מספר מעלה את הזהות ל-phone_match בלבד,
      // ובמדיניות 'strict' (ברירת המחדל) זה **לא** מספיק כדי למסור
      // פרטי תיק. שם הלקוח כן נמסר — פנייה בשם היא נוהג מקובל וסיכונה
      // נמוך; שמות תיקים ושלבי הליך הם המידע שדליפתו מזיקה.
      const verified = ctx.identityStatus === 'verified';
      const mayDisclose = verified || ctx.identityPolicy === 'phone_match_ok';

      return Promise.resolve(ok(
        mayDisclose
          ? `הלקוח זוהה: ${client.name}. תיקים פעילים: ${summary}.`
          : `המספר תואם ללקוח ${client.name}, אך הזהות טרם אומתה. ` +
            'אפשר לפנות אליו בשמו ולקבל את פרטי הפנייה, אך אין למסור פרטי תיק.',
        {
          found: true,
          client_id: client.id,
          name: client.name,
          identity_status: verified ? 'verified' : 'phone_match',
          may_disclose_case_details: mayDisclose,
          active_cases_count: active.length,
          // מה שלא נשלח לא יכול להיאמר בטלפון למי שהתחזה.
          active_cases_summary: mayDisclose ? summary : undefined,
        },
        'client', client.id,
      ));
    },
  },

  {
    name: 'lookup_lead',
    title: 'איתור פנייה קודמת',
    description: 'בודק אם כבר קיימת פנייה (ליד) פתוחה מהמספר הזה, כדי לא לפתוח פנייה כפולה.',
    risk: 'none',
    readOnly: true,
    schema: OBJ({ phone: S('string', { maxLength: 40 }) }, []),
    handler: (input, ctx) => {
      const phone = clean(input.phone, 40) || ctx.callerPhone || '';
      if (!phone) return Promise.resolve(fail('לא נמסר מספר טלפון לבדיקה.'));
      const lead = findLeadByPhone(ctx.db, phone);
      if (!lead) return Promise.resolve(ok('לא נמצאה פנייה קודמת מהמספר הזה.', { found: false }));
      return Promise.resolve(ok(
        `קיימת פנייה קודמת: ${lead.name || phone}, סטטוס ${lead.status || 'חדש'}.`,
        {
          found: true, lead_id: lead.id, name: lead.name,
          status: lead.status, summary: lead.summary, created_at: lead.createdAt,
        },
        'lead', lead.id,
      ));
    },
  },

  // ---------- פנייה חדשה ----------
  {
    name: 'create_lead',
    title: 'פתיחת פנייה',
    description: 'פותח פנייה חדשה (ליד) עבור מתקשר שאינו לקוח קיים.',
    risk: 'low',
    readOnly: false,
    schema: OBJ({
      name: S('string', { minLength: 1, maxLength: 120 }),
      phone: S('string', { maxLength: 40 }),
      source: S('string', { maxLength: 40, default: 'voice_ai' }),
      category: S('string', { maxLength: 60 }),
      summary: S('string', { maxLength: 2000 }),
      email: S('string', { maxLength: 120 }),
    }, ['name']),
    handler: (input, ctx) => runCommand(ctx, 'create_lead', {
      name: input.name,
      phone: clean(input.phone, 40) || ctx.callerPhone || '',
      source: input.source,
      category: input.category,
      summary: input.summary,
      email: input.email,
    }),
  },

  // ---------- משימות ----------
  {
    name: 'create_task',
    title: 'יצירת משימה',
    description: 'פותח משימה לעורך הדין במערכת המשימות של המשרד.',
    risk: 'medium',
    readOnly: false,
    schema: OBJ({
      title: S('string', { minLength: 2, maxLength: 200 }),
      description: S('string', { maxLength: 2000 }),
      priority: S('string', { enum: ['urgent', 'normal', 'low'], default: 'normal' }),
      due_date: S('string', { maxLength: 10, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
      client_id: S('string', { maxLength: 40 }),
      lead_id: S('string', { maxLength: 40 }),
      matter_id: S('string', { maxLength: 40 }),
      assigned_to: S('string', { maxLength: 120 }),
    }, ['title']),
    handler: (input, ctx) => runCommand(ctx, 'create_task', {
      title: input.title,
      description: input.description,
      priority: input.priority,
      due_date: input.due_date,
      client_id: clean(input.client_id, 40) || ctx.clientId || '',
      lead_id: clean(input.lead_id, 40) || ctx.leadId || '',
      matter_id: clean(input.matter_id, 40) || ctx.matterId || '',
      assigned_to: input.assigned_to,
      call_phone: ctx.callerPhone || '',
    }),
  },

  {
    name: 'request_human_callback',
    title: 'בקשת חזרה מנציג',
    description:
      'יוצר משימת "חזרה דחופה ללקוח" ומשייך אותה לעורך הדין. זו הפעולה הנכונה כאשר ' +
      'המתקשר מבקש לדבר עם אדם, או כשהנושא חורג מהסמכות שלך.',
    risk: 'low',
    readOnly: false,
    schema: OBJ({
      reason: S('string', { minLength: 2, maxLength: 500 }),
      name: S('string', { maxLength: 120 }),
      phone: S('string', { maxLength: 40 }),
      // מועד מועדף לחזרה — נשמר ב-metadata של הבקשה ומוצג ברשימת
      // הממתינים. טקסט חופשי במכוון: "אחרי 4", "לא בבוקר" ו-"מחר" הם
      // מה שאנשים אומרים בטלפון, וכפייה של פורמט הייתה מאבדת את המידע.
      preferred_time: S('string', { maxLength: 120 }),
      urgency: S('string', { enum: ['low', 'normal', 'high', 'critical'] }),
      priority: S('string', { enum: ['urgent', 'normal'], default: 'urgent' }),
    }, ['reason']),
    handler: (input, ctx) => runCommand(ctx, 'create_callback', {
      reason: input.reason,
      name: clean(input.name, 120) ||
        (ctx.clientId ? (ctx.db.clients.find((c) => c.id === ctx.clientId)?.name || '') : ''),
      phone: clean(input.phone, 40) || ctx.callerPhone || '',
      preferred_time: input.preferred_time,
      // priority נשמר לתאימות לאחור עם קריאות קיימות; urgency הוא השדה
      // המובנה שנשמר ב-metadata של בקשת החזרה.
      urgency: input.urgency ||
        (clean(input.priority, 20) === 'normal' ? 'normal' : 'high'),
      client_id: ctx.clientId || '',
      lead_id: ctx.leadId || '',
      matter_id: ctx.matterId || '',
    }),
  },

  // ---------- הערות ----------
  {
    name: 'create_note',
    title: 'רישום הערה',
    description: 'מצרף את סיכום הפנייה לכרטיס הלקוח, לפנייה או ליומן התיק.',
    risk: 'low',
    readOnly: false,
    schema: OBJ({
      text: S('string', { minLength: 2, maxLength: 4000 }),
      client_id: S('string', { maxLength: 40 }),
      lead_id: S('string', { maxLength: 40 }),
      matter_id: S('string', { maxLength: 40 }),
    }, ['text']),
    handler: (input, ctx) => runCommand(ctx, 'create_note', {
      text: input.text,
      client_id: clean(input.client_id, 40) || ctx.clientId || '',
      lead_id: clean(input.lead_id, 40) || ctx.leadId || '',
      matter_id: clean(input.matter_id, 40) || ctx.matterId || '',
    }),
  },

  // ---------- יומן ----------
  {
    name: 'check_calendar',
    title: 'בדיקת יומן',
    description:
      'מחזיר מועדים פנויים לפגישה. מחזיר **רק** שעות פנויות בשעות הפעילות — ' +
      'לא את תוכן היומן ולא פגישות של לקוחות אחרים.',
    risk: 'none',
    readOnly: true,
    schema: OBJ({
      from_date: S('string', { maxLength: 10, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
      days: S('integer', { minimum: 1, maximum: 21, default: 7 }),
      duration_minutes: S('integer', { minimum: 15, maximum: 240, default: 60 }),
      max_slots: S('integer', { minimum: 1, maximum: 20, default: 6 }),
    }, []),
    handler: async (input, ctx) => {
      const from = clean(input.from_date, 10) || todayISO();
      const days = Number(input.days) || 7;
      const duration = Number(input.duration_minutes) || 60;
      const maxSlots = Number(input.max_slots) || 6;

      // המפרט: להשתמש באינטגרציית היומן **הקיימת** אם היא מחוברת, ולא
      // להוסיף חדשה. getCalendarProvider כבר מחזיר Mock כשאין חיבור.
      let externalBusyByDate: Record<string, Array<{ startMin: number; endMin: number }>> = {};
      let source = 'internal';
      // ספק היומן נטען רק בסביבת ה-Edge Function. מחוצה לה (בדיקות) אין
      // אינטגרציית יומן חיצוני כלל — בדיקה מפורשת עדיפה על ייבוא שנכשל
      // ונבלע ב-catch, שהיה מסתיר גם תקלה אמיתית ביומן מחובר.
      try {
        if (!(globalThis as { Deno?: unknown }).Deno) throw new Error('no external calendar outside Deno');
        const { getCalendarProvider } = await import('../providers/calendar.ts');
        const provider = await getCalendarProvider(ctx.sb, ctx.officeId);
        if (!provider.isMock) {
          source = provider.name;
          const events = await provider.listEvents(
            from + 'T00:00:00Z', addDaysISO(from, days) + 'T23:59:59Z');
          externalBusyByDate = groupExternalBusy(events);
        }
      } catch (e) {
        // יומן חיצוני שנפל אינו סיבה לא להציע פגישה: נופלים ליומן הפנימי
        // ומסמנים שהבדיקה חלקית, במקום להשאיר את המתקשר בלי מענה.
        source = 'internal_fallback';
        if ((globalThis as { Deno?: unknown }).Deno) {
          console.warn('[voice] external calendar unavailable', e instanceof Error ? e.message : e);
        }
      }

      const slots: Slot[] = [];
      for (let i = 0; i < days && slots.length < maxSlots; i++) {
        const date = addDaysISO(from, i);
        const busy = busyFromEvents(ctx.db.events, date, 60)
          .concat(externalBusyByDate[date] || []);
        // היום הנוכחי: לא מציעים שעה שכבר עברה.
        const minStart = date === todayISO() ? nowMinutesInTz() + 60 : 0;
        const free = freeSlotsForDay(date, busy, duration)
          .filter((s) => (timeToMinutes(s.time) ?? 0) >= minStart);
        slots.push(...free.slice(0, 3));
      }

      const trimmed = slots.slice(0, maxSlots);
      if (!trimmed.length) {
        return ok('לא נמצאו מועדים פנויים בטווח שנבדק.', { slots: [], source });
      }
      return ok(
        'מועדים פנויים: ' + trimmed.map((s) => `${isoToHe(s.date)} בשעה ${s.time}`).join('; '),
        { slots: trimmed, source },
      );
    },
  },

  {
    name: 'create_appointment',
    title: 'קביעת פגישה',
    description: 'קובע פגישה ביומן המשרד. אין לקבוע מועד שלא הוחזר מ-check_calendar.',
    risk: 'medium',
    readOnly: false,
    schema: OBJ({
      date: S('string', { pattern: '^\\d{4}-\\d{2}-\\d{2}$', maxLength: 10 }),
      time: S('string', { pattern: '^\\d{1,2}:\\d{2}$', maxLength: 5 }),
      duration_minutes: S('integer', { minimum: 15, maximum: 240, default: 60 }),
      title: S('string', { maxLength: 200 }),
      client_id: S('string', { maxLength: 40 }),
      lead_id: S('string', { maxLength: 40 }),
      matter_id: S('string', { maxLength: 40 }),
      location: S('string', { maxLength: 200 }),
      notes: S('string', { maxLength: 2000 }),
    }, ['date', 'time']),
    handler: async (input, ctx) => {
      const date = clean(input.date, 10);
      const time = clean(input.time, 5);
      const duration = Number(input.duration_minutes) || 60;

      // ולידציות שאינן תלויות בנתונים — נבדקות כאן כדי לא לפתוח פקודה
      // שכבר ידוע שתיכשל.
      if (timeToMinutes(time) === null) return fail('שעה לא תקינה.');
      if (WEEKEND_DAYS.includes(isoWeekday(date))) {
        return fail('המועד המבוקש נופל בסוף השבוע. יש להציע מועד בימים ראשון עד חמישי.');
      }
      if (date < todayISO()) return fail('לא ניתן לקבוע פגישה בתאריך שעבר.');

      // ⚠ בדיקת התפיסה **אינה** כאן. היא בתוך המוטציה, ולכן רצה מחדש על
      // נתונים טריים בכל ניסיון של saveOfficeDb — כולל אחרי שמשתמש קבע
      // פגישה בשנייה שחלפה. בדיקה מוקדמת על עותק ישן היא בדיוק המקום
      // שבו נולדת פגישה כפולה.
      const result = await runCommand(ctx, 'create_appointment', {
        date, time, duration_minutes: duration,
        title: input.title,
        client_id: clean(input.client_id, 40) || ctx.clientId || '',
        lead_id: clean(input.lead_id, 40) || ctx.leadId || '',
        matter_id: clean(input.matter_id, 40) || ctx.matterId || '',
        location: input.location,
        notes: input.notes,
      });

      // דחיפה ליומן החיצוני, אם וכאשר הוא מחובר — best effort. הפגישה
      // כבר קיימת ב-CRM, ולכן כישלון סנכרון אינו מבטל אותה.
      // ⚠ מדולג ב-replay: הפגישה כבר סונכרנה בפעם הראשונה, ודחיפה שנייה
      // הייתה יוצרת אירוע כפול ביומן החיצוני — בדיוק הכפילות שמנענו
      // בצד שלנו.
      let synced: string | null = null;
      if (!result.data?.replayed) {
        try {
          if (!(globalThis as { Deno?: unknown }).Deno) throw new Error('no external calendar');
          const { getCalendarProvider } = await import('../providers/calendar.ts');
          const provider = await getCalendarProvider(ctx.sb, ctx.officeId);
          if (!provider.isMock) {
            const endMin = (timeToMinutes(time) || 0) + duration;
            const r = await provider.createEvent({
              title: String(input.title || 'פגישה'),
              start: `${date}T${time.padStart(5, '0')}:00`,
              end: `${date}T${minutesToTime(endMin)}:00`,
              location: clean(input.location, 200),
              description: clean(input.notes),
            });
            if (r.ok) synced = r.externalId || null;
          }
        } catch { /* הפגישה נשמרה; סנכרון חיצוני הוא תוספת */ }
      }

      return {
        ...result,
        message: `${result.message}`,
        data: { ...(result.data || {}), synced_external: synced },
      };
    },
  },

  // ---------- פעולות שדורשות תשתית שטרם הוגדרה ----------
  {
    name: 'send_message',
    title: 'שליחת הודעה',
    description: 'שולח הודעת טקסט למתקשר. דורש ספק תקשורת מוגדר.',
    risk: 'high',
    readOnly: false,
    schema: OBJ({
      text: S('string', { minLength: 2, maxLength: 1000 }),
      phone: S('string', { maxLength: 40 }),
      channel: S('string', { enum: ['whatsapp', 'sms'], default: 'whatsapp' }),
    }, ['text']),
    handler: (_input, _ctx) => Promise.resolve(fail(
      'שליחת הודעות יוצאות אינה זמינה — לא הוגדר ספק תקשורת. יש לרשום את הפרטים במשימה במקום.',
    )),
  },

  {
    name: 'transfer_call',
    title: 'העברת שיחה לנציג',
    description:
      'מעביר את השיחה לנציג אנושי. זמין רק כאשר הוגדר מספר העברה ייעודי. ' +
      'כאשר אינו זמין — יש להשתמש ב-request_human_callback.',
    risk: 'high',
    readOnly: false,
    schema: OBJ({ reason: S('string', { maxLength: 500 }) }, []),
    handler: (input, ctx) => {
      const target = clean(ctx.settings.human_transfer_number, 40);
      const publicNumber = clean(ctx.settings.public_office_phone, 40);

      if (!target) {
        return Promise.resolve(fail(
          'העברת שיחה אינה זמינה — לא הוגדר מספר העברה. יש ליצור בקשת חזרה במקום ' +
          '(request_human_callback).',
        ));
      }
      // ⚠ ההגנה הקריטית. אם מספר ההעברה זהה למספר הציבורי, והשיחה הופנתה
      // מהמספר הציבורי אל ה-AI, ההעברה תחזיר את השיחה אל עצמה — לולאת
      // ניתוב שמסתיימת בשיחה תקועה ובחיוב. נחסם בקוד ולא בהנחיה, כי
      // הגדרה שגויה במסך לא יכולה להיות מרחק של קליק מלולאה.
      if (publicNumber && samePhone(target, publicNumber)) {
        return Promise.resolve(fail(
          'מספר ההעברה זהה למספר הציבורי של המשרד — העברה אליו הייתה יוצרת לולאת ניתוב. ' +
          'ההעברה בוטלה; יש ליצור בקשת חזרה.',
        ));
      }
      if (ctx.isSimulation) {
        return Promise.resolve(ok('במצב בדיקה: השיחה הייתה מועברת לנציג.',
          { simulated: true, target }));
      }
      // כשתהיה טלפוניה: כאן ה-orchestrator מקבל את ההוראה ומבצע אותה
      // בפועל דרך TelephonyProvider.transfer_call. הכלי מחזיר את הכוונה.
      return Promise.resolve(ok('השיחה מועברת לנציג.', {
        transfer_requested: true, target, reason: clean(input.reason, 500),
      }));
    },
  },
];

export const VOICE_TOOL_MAP: Map<string, VoiceToolDef> =
  new Map(VOICE_TOOLS.map((t) => [t.name, t]));

/** התנגשות שנתגלתה בזמן הכתיבה — נבדלת מכשל כדי שהמודל יציע מועד אחר. */
export class ToolConflictError extends Error {}

function nowMinutesInTz(): number {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
  return d.getHours() * 60 + d.getMinutes();
}

function groupExternalBusy(
  events: Array<{ start: string; end: string; status?: string }>,
): Record<string, Array<{ startMin: number; endMin: number }>> {
  const out: Record<string, Array<{ startMin: number; endMin: number }>> = {};
  for (const e of events) {
    if (e.status === 'cancelled') continue;
    const start = new Date(e.start), end = new Date(e.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    const local = new Date(start.toLocaleString('en-US', { timeZone: TIMEZONE }));
    const localEnd = new Date(end.toLocaleString('en-US', { timeZone: TIMEZONE }));
    const key = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
    (out[key] ||= []).push({
      startMin: local.getHours() * 60 + local.getMinutes(),
      endMin: localEnd.getHours() * 60 + localEnd.getMinutes(),
    });
  }
  return out;
}

// ============================================================
// הרצה
// ============================================================

export type ToolPermission = {
  enabled: boolean;
  available: boolean;
  requires_confirmation: boolean;
  risk_level: string;
  unavailable_reason?: string | null;
};

export type ExecOutcome = {
  status: 'success' | 'failed' | 'blocked';
  result: VoiceToolResult;
};

/**
 * ביצוע כלי, עם כל השערים.
 *
 * הסדר אינו שרירותי: קודם "האם הכלי בכלל קיים", אחר כך "האם הסוכן הזה
 * מורשה", אחר כך "האם הקלט תקין", ורק אז ביצוע. כל שער שנסגר מוקדם יותר
 * חוסך שער מאוחר יותר את הצורך לסמוך על מה שלפניו.
 */
export async function execVoiceTool(
  toolName: string,
  rawInput: unknown,
  permission: ToolPermission | null,
  ctx: VoiceToolCtx,
): Promise<ExecOutcome> {
  const def = VOICE_TOOL_MAP.get(toolName);
  if (!def) {
    return { status: 'blocked', result: fail(`כלי לא מוכר: ${toolName}`) };
  }
  if (!permission) {
    return { status: 'blocked', result: fail(`הכלי ${toolName} אינו מוקצה לסוכן זה.`) };
  }
  if (!permission.enabled) {
    return { status: 'blocked', result: fail(`הכלי ${toolName} מושבת בהגדרות המשרד.`) };
  }
  if (!permission.available) {
    return {
      status: 'blocked',
      result: fail(permission.unavailable_reason || `הכלי ${toolName} אינו זמין כרגע.`),
    };
  }
  if (ctx.settings.emergency_stop) {
    return { status: 'blocked', result: fail('המזכירה הדיגיטלית מושבתת (עצירת חירום).') };
  }

  let input: Record<string, unknown>;
  try {
    input = validate(rawInput ?? {}, def.schema) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof ValidationError ? e.message : String(e);
    return { status: 'failed', result: fail(`קלט לא תקין: ${msg}`) };
  }

  try {
    const result = await def.handler(input, ctx);
    return { status: result.ok ? 'success' : 'failed', result };
  } catch (e) {
    if (e instanceof ToolConflictError) {
      return { status: 'failed', result: fail(e.message) };
    }
    // ⚠ VoiceError נושא קוד יציב והודעה שמיועדת למי ששומע אותה. הקוד
    // עובר ל-data כדי ששרת הקול יוכל להחליט אם לנסות שוב, וההודעה היא
    // מה שהמודל יאמר — בלי הפרטים הטכניים, שנשארים בלוג.
    if (e instanceof VoiceError) {
      console.error(`[voice-tool] ${toolName} ${e.code}`, e.technical);
      return {
        status: e.code === 'TOOL_NOT_ALLOWED' ? 'blocked' : 'failed',
        result: { ok: false, message: e.message, data: { error: e.toUserPayload() } },
      };
    }
    // ⚠ כלי שנפל **לא מפיל את השיחה**. המודל מקבל הודעת שגיאה קצרה
    // וממשיך, ה-orchestrator מסמן manual_followup_required, והאדם מקבל
    // משימה. מתקשר שנותק באמצע כי קריאת יומן נכשלה הוא התוצאה הגרועה
    // ביותר האפשרית כאן.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[voice-tool] ${toolName} failed`, msg);
    return { status: 'failed', result: fail(`הפעולה נכשלה: ${msg}`) };
  }
}

/** הגדרות הכלים בפורמט שהמודל מקבל. רק כלים מותרים וזמינים. */
export function toolDefsForModel(
  permissions: Map<string, ToolPermission>,
): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return VOICE_TOOLS
    .filter((t) => {
      const p = permissions.get(t.name);
      return p && p.enabled && p.available;
    })
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        properties: t.schema.properties || {},
        required: t.schema.required || [],
      },
    }));
}
