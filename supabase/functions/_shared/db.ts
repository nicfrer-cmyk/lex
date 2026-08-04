// גישה ל-Supabase ול-blob של ה-CRM.
//
// הממצא המרכזי של ה-Audit: אין טבלאות clients/cases/tasks. כל ה-CRM הוא
// ערך jsonb יחיד ב-app_data.data, שורה אחת לכל משרד (platform.web.js:468).
// לכן "שאילתה" כאן היא טעינת ה-blob וסינון בזיכרון — לא SQL.
//
// שתי השלכות שמעצבות את הקובץ:
//
//  1. טוענים פעם אחת להרצה (loadOfficeDb מטמין ב-ctx). סוכן שקורא ל-6 כלים
//     לא יטען את ה-blob 6 פעמים — במשרד גדול זה מגה-בייטים לכל קריאה.
//
//  2. **לא כותבים ל-app_data מכאן.** כתיבה היא read-modify-write על שורה
//     שלמה; אם ה-worker יכתוב במקביל למשתמש שעובד בדפדפן, אחד ידרוס את
//     השני בשקט. הסוכן מציע דרך ai_approvals, וההחלה נעשית בדפדפן. ראה
//     ההערה על ai_approvals ב-20260804000000_ai_center.sql.
//     saveOfficeDb קיימת רק עבור נתיבים שאין להם דפדפן (webhook שיוצר ליד),
//     והיא מוגנת ב-optimistic concurrency check.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { AppError } from './http.ts';

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/** לקוח service_role. לעולם לא נחשף ללקוח — Edge Functions בלבד. */
export function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

// ---------- זהות ----------

export type Caller = {
  userId: string;
  email: string;
  officeId: string;
  role: 'owner' | 'lawyer' | 'secretary';
};

/**
 * מזהה את הקורא מה-JWT ומחזיר את המשרד והתפקיד שלו.
 *
 * זו הנקודה שבה נקבע office_id לכל שאר הבקשה — **הוא לעולם לא מגיע
 * מה-payload**. זה מה שהופך את "שינוי מזהה תיק ב-URL" (סעיף 23.4) לחסר
 * משמעות: גם אם התוקף ישלח matter_id של משרד אחר, ה-blob שייטען הוא של
 * המשרד שלו, והתיק פשוט לא יימצא בו.
 */
export async function resolveCaller(req: Request, sb: SupabaseClient): Promise<Caller> {
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) throw new AppError('unauthenticated', 'לא מחובר', 401);

  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !userData?.user) throw new AppError('unauthenticated', 'לא מחובר', 401);

  // limit(1) לפני maybeSingle: אין אילוץ ייחודי על office_members.user_id,
  // ו-maybeSingle מחזיר **שגיאה** כששתי שורות תואמות. משתמש ששייך לשני
  // משרדים היה מקבל 500 על כל קריאה. current_office_id() ב-SQL כבר משתמש
  // ב-limit 1 מאותה סיבה.
  const { data: member, error: memberErr } = await sb
    .from('office_members')
    .select('office_id, role')
    .eq('user_id', userData.user.id)
    .limit(1)
    .maybeSingle();
  if (memberErr) throw new AppError('db_error', memberErr.message, 500);
  if (!member) throw new AppError('no_office', 'לא נמצא משרד מקושר למשתמש', 403);

  return {
    userId: userData.user.id,
    email: userData.user.email || '',
    officeId: member.office_id,
    role: member.role,
  };
}

// ---------- ה-blob של ה-CRM ----------
//
// שמות השדות למטה נלקחו מהקוד בפועל (saveCase app.js:440, saveClient 2281,
// saveTask 2499, saveEvent 2615, saveDoc 3117, savePayment 2627). שתי
// מלכודות ששווה לשמור מול העיניים:
//   • ב-case המזהה של הלקוח הוא `client` — לא `clientId`.
//   • תאריכים מעורבים: tasks.due/events.date/payments.date הם YYYY-MM-DD,
//     אבל cases.opened/docs.date/timeEntries.date הם "5.7.2026" (he-IL).

export type CrmCase = {
  id: string; name: string; caseType?: string; client?: string; amount?: number;
  stage?: string; status?: string; number?: string; notes?: string;
  court?: string; courtNumber?: string;
  debtorName?: string; debtorId?: string; debtorAddress?: string;
  debtorPhone?: string; debtorEmail?: string; debtorType?: string; debtDesc?: string;
  feeType?: string; feePct?: number; feeFixed?: number; feeVat?: string;
  expensesType?: string; retainer?: number; feeNotes?: string;
  opened?: string; diary?: Array<{ text: string; date: string }>;
  legalDocs?: Record<string, unknown>; collected?: number;
  caseSubNumber?: string; closedAt?: string | null; trustCloseNote?: string;
  [k: string]: unknown;
};

export type CrmClient = {
  id: string; clientNumber?: string; name: string; type?: string;
  phone?: string; email?: string; address?: string; idNum?: string;
  contact?: string; contactPhone?: string; notes?: string;
  color?: string; textColor?: string; initials?: string;
  [k: string]: unknown;
};

export type CrmTask = {
  id: string; text: string; due?: string; caseId?: string;
  priority?: string; notes?: string; done?: boolean; completedAt?: string | null;
};

export type CrmEvent = {
  id: string; title: string; date: string; time?: string;
  location?: string; type?: string; caseId?: string; notes?: string;
};

export type CrmDoc = {
  id: string; name: string; cat?: string; caseId?: string; notes?: string;
  date?: string; ext?: string; filePath?: string | null; origName?: string | null;
  aiAnalyzedAt?: string; aiSummary?: string;
  [k: string]: unknown;
};

export type CrmPayment = {
  id: string; caseId: string; amount: number; date: string;
  method?: string; type?: string; note?: string;
};

/**
 * ליד — קולקציה **חדשה** ב-blob.
 *
 * ה-CRM היום לא מנהל לידים בכלל (אין db.leads). הפרומט דורש קליטת לידים,
 * ניקוד והמרה (סעיפים 5.2, 6.4). ההרחבה additive ובטוחה: קוד קיים שלא
 * מכיר את המפתח פשוט מתעלם ממנו, ו-app.js מוסיף `if (!db.leads) db.leads=[]`
 * באותו דפוס של payments/trustEntries (app.js:59-65).
 */
export type CrmLead = {
  id: string;
  name: string; phone?: string; email?: string; city?: string;
  area?: string;            // תחום הפנייה
  procedureType?: string; amount?: number; caseNumber?: string;
  nearDeadline?: string; documents?: string; goal?: string;
  otherLawyer?: string; source?: string; availability?: string;
  score?: number; scoreReason?: string; urgency?: string;
  summary?: string; missingInfo?: string[]; followUpQuestions?: string[];
  suggestedMessage?: string; suggestedCallTime?: string;
  status?: string;          // new|contacted|qualified|proposal|won|lost
  clientId?: string; caseId?: string;
  createdAt?: string; updatedAt?: string; lastContactAt?: string;
  notes?: string;
  [k: string]: unknown;
};

export type CrmDb = {
  cases: CrmCase[]; clients: CrmClient[]; tasks: CrmTask[]; events: CrmEvent[];
  docs: CrmDoc[]; payments: CrmPayment[]; leads: CrmLead[];
  timeEntries: Array<Record<string, unknown>>;
  trustTransactions: Array<Record<string, unknown>>;
  efilingBundles: Record<string, unknown>;
  counters: Record<string, unknown>;
  settings: Record<string, unknown>;
  [k: string]: unknown;
};

const EMPTY_DB: CrmDb = {
  cases: [], clients: [], tasks: [], events: [], docs: [], payments: [], leads: [],
  timeEntries: [], trustTransactions: [], efilingBundles: {}, counters: {}, settings: {},
};

/** ממלא קולקציות חסרות — משרד חדש, או blob ישן שנשמר לפני שקולקציה נוספה. */
function normalizeDb(raw: unknown): CrmDb {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...EMPTY_DB, ...d } as CrmDb;
  for (const k of ['cases', 'clients', 'tasks', 'events', 'docs', 'payments', 'leads',
                   'timeEntries', 'trustTransactions'] as const) {
    if (!Array.isArray(out[k])) (out as Record<string, unknown>)[k] = [];
  }
  for (const k of ['efilingBundles', 'counters', 'settings'] as const) {
    if (!out[k] || typeof out[k] !== 'object') (out as Record<string, unknown>)[k] = {};
  }
  return out;
}

export async function loadOfficeDb(sb: SupabaseClient, officeId: string): Promise<CrmDb> {
  const { data, error } = await sb
    .from('app_data').select('data').eq('office_id', officeId).maybeSingle();
  if (error) throw new AppError('db_error', error.message, 500);
  return normalizeDb(data?.data);
}

/**
 * כתיבה ל-blob — **לשימוש נדיר ומכוון בלבד** (webhook שיוצר ליד; החלת
 * אישור בנתיב שאין בו דפדפן).
 *
 * הבדיקה האופטימית: קוראים את updated_at לפני העדכון וכותבים רק אם הוא לא
 * זז. אם משתמש שמר בדפדפן בינתיים — הכתיבה נדחית ומוחזרת שגיאה, במקום
 * לדרוס בשקט את מה שהוא הרגע הקליד. אובדן נתונים אסור (סעיף 29).
 */
export async function saveOfficeDb(
  sb: SupabaseClient, officeId: string, mutate: (db: CrmDb) => void, retries = 3,
): Promise<CrmDb> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const { data: row, error: readErr } = await sb
      .from('app_data').select('data, updated_at').eq('office_id', officeId).maybeSingle();
    if (readErr) throw new AppError('db_error', readErr.message, 500);

    const db = normalizeDb(row?.data);
    mutate(db);

    if (!row) {
      const { error } = await sb.from('app_data').insert({ office_id: officeId, data: db });
      if (!error) return db;
      // insert התנגש → מישהו יצר את השורה בינתיים; ננסה שוב כ-update.
      continue;
    }

    const { data: updated, error } = await sb
      .from('app_data')
      .update({ data: db })
      .eq('office_id', officeId)
      .eq('updated_at', row.updated_at)   // ← הבדיקה האופטימית
      .select('office_id');
    if (error) throw new AppError('db_error', error.message, 500);
    if (updated && updated.length > 0) return db;
    // 0 שורות = updated_at זז = מישהו כתב בינתיים. נקרא מחדש וננסה שוב.
  }
  throw new AppError(
    'write_conflict',
    'לא ניתן היה לשמור — הנתונים שונו במקביל. נסה שוב.',
    409,
  );
}

// ---------- חיפוש בתוך ה-blob ----------

export function findCase(db: CrmDb, matterId?: string | null): CrmCase | null {
  if (!matterId) return null;
  return db.cases.find((c) => c.id === matterId) || null;
}

export function findClient(db: CrmDb, clientId?: string | null): CrmClient | null {
  if (!clientId) return null;
  return db.clients.find((c) => c.id === clientId) || null;
}

export function findLead(db: CrmDb, leadId?: string | null): CrmLead | null {
  if (!leadId) return null;
  return db.leads.find((l) => l.id === leadId) || null;
}

/**
 * מזהה בסגנון uid() של app.js:115 — base36 של הזמן + 5 תווים אקראיים.
 * חייב להיות באותו פורמט: המזהים האלה מתערבבים באותן קולקציות עם מזהים
 * שנוצרו בדפדפן, וקוד שמניח אורך/צורה יישבר על פורמט אחר.
 */
export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

/** תווית סטטוס תיק בעברית — אותה מפה שחוזרת 4 פעמים ב-app.js (657/693/827/2385). */
export const CASE_STATUS_HE: Record<string, string> = {
  active: 'פעיל', urgent: 'דחוף', pending: 'ממתין', closed: 'סגור',
};

export const TASK_PRIORITY_HE: Record<string, string> = {
  urgent: 'דחוף', normal: 'רגיל', low: 'נמוך',
};
