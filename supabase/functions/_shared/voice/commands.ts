// שכבת המוטציה הבטוחה — הנתיב היחיד שבו AI משנה את ה-CRM.
//
// ## הבעיה שהיא פותרת
// כל ה-CRM הוא ערך jsonb יחיד ב-app_data. כתיבה היא read-modify-write על
// שורה שלמה. אם הסוכן כותב בזמן שעורך הדין עורך כרטיס לקוח בדפדפן, אחד
// מהם דורס את השני — ואיש לא יודע שזה קרה.
//
// ## איך זה נפתר, ומה לא נבנה מחדש
// `saveOfficeDb` (db.ts) כבר עושה בדיוק את הדבר הנכון: קורא, מחיל את
// פונקציית המוטציה, וכותב **רק אם** updated_at לא זז. אם זז — קורא מחדש
// ומחיל את המוטציה שוב, הפעם על הנתונים החדשים. זה המפתח: המוטציה היא
// ממוקדת ("הוסף את המשימה הזו"), ולא "כתוב את ה-blob הזה". לכן שינוי של
// המשתמש ושינוי של ה-AI **שניהם שורדים**.
//
// הקובץ הזה לא מחליף את saveOfficeDb ולא מוסיף מנגנון מקביל. הוא עוטף
// אותו בשלושה דברים שחסרו:
//
//   1. **אידמפוטנטיות** — פקודה נרשמת לפני שהיא מוחלת. הרצה שנייה של
//      אותו idempotency_key מחזירה את התוצאה הראשונה ולא נוגעת ב-blob.
//      זה מה שהופך retry אחרי timeout לבטוח: השיחה לא תיצור פגישה שנייה.
//   2. **רשימת פקודות סגורה** — ה-AI לא מספק פונקציית mutate. הוא שולח
//      שם מתוך רשימה, והקוד בוחר את המוטציה. אין נתיב שבו קלט מהמודל
//      הופך לקוד שרץ על הנתונים.
//   3. **תוצאה שמורה** — כדי שאפשר יהיה להחזיר אותה שוב, ולענות בדיעבד
//      על "מה ה-AI שינה".
//
// טהור מ-Deno: המוטציות הן פונקציות של (db, payload) ונבדקות ישירות.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import type { CrmDb } from '../db.ts';
import { todayISO } from '../security.ts';
import { normalizePhoneNumber, samePhoneNumber } from './phone.ts';
import { VoiceError } from './errors.ts';

// ============================================================
// טיפוסים
// ============================================================

export type CommandType =
  | 'create_lead'
  | 'update_lead'
  | 'create_task'
  | 'create_note'
  | 'create_appointment'
  | 'create_callback'
  | 'update_callback';

export type CommandActor = {
  type: 'agent' | 'user' | 'system' | 'webhook';
  id?: string | null;
};

export type CommandEnvelope = {
  commandId: string;
  callId?: string | null;
  toolCallId?: string | null;
  agentId?: string | null;
  idempotencyKey: string;
  type: CommandType;
  payload: Record<string, unknown>;
  actor: CommandActor;
  schemaVersion?: string;
};

/** מה שמוטציה מחזירה כשהצליחה. */
export type MutationOutcome = {
  message: string;
  entityType?: string;
  entityId?: string;
  data?: Record<string, unknown>;
  /** true כשהמוטציה זיהתה שהישות כבר קיימת ולא יצרה כפילות. */
  deduped?: boolean;
};

export type CommandResult = MutationOutcome & {
  ok: boolean;
  /** true כשהתוצאה הוחזרה מהרישום ולא בוצעה מחדש. */
  replayed: boolean;
  conflictRetries: number;
  commandId: string;
};

export type StoredCommand = {
  id: string;
  status: 'pending' | 'applied' | 'failed' | 'conflict';
  result_payload?: Record<string, unknown> | null;
  entity_type?: string | null;
  entity_id?: string | null;
};

/**
 * רישום הפקודות. מופשט כדי שהמוטציות יהיו ניתנות לבדיקה בלי מסד נתונים —
 * ואלה המוטציות שכותבות לתיקים של משרד עורכי דין.
 */
export interface CommandStore {
  find(idempotencyKey: string): Promise<StoredCommand | null>;
  begin(env: CommandEnvelope): Promise<StoredCommand | null>;
  complete(id: string, outcome: MutationOutcome, conflictRetries: number): Promise<void>;
  fail(id: string, error: string, status: 'failed' | 'conflict'): Promise<void>;
}

/** מוטציה ממוקדת. רצה **בתוך** saveOfficeDb, ולכן עשויה לרוץ שוב על
 *  נתונים טריים אם משתמש כתב במקביל. חייבת להיות כתיבה לפי מצב, לא
 *  השמה של מצב שנקרא קודם. */
export type CommandMutator = (db: CrmDb, payload: Record<string, unknown>) => MutationOutcome;

// ============================================================
// עזרים
// ============================================================

/** זהה ל-uid() ב-app.js וב-db.ts: base36. חייב להישאר תואם — המזהים
 *  האלה מתערבבים באותן קולקציות עם מזהים שנוצרו בדפדפן. */
export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

function clean(v: unknown, maxLen = 2000): string {
  return String(v == null ? '' : v)
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

const TIMEZONE = 'Asia/Jerusalem';

/** he-IL עם שעה — הפורמט של cases.diary[].date ב-app.js. */
function heStamp(): string {
  return new Date().toLocaleString('he-IL', { timeZone: TIMEZONE });
}

/** התיק הפעיל של הלקוח, כדי שמשימה לא תיפול מחוץ לכל תיק. */
function activeMatterFor(db: CrmDb, clientId: string): string {
  if (!clientId) return '';
  const c = db.cases.find((x) => x.client === clientId && x.status !== 'closed');
  return c ? String(c.id) : '';
}

// ============================================================
// המוטציות
// ============================================================
//
// ⚠ כל אחת מהן חייבת להיות בטוחה להרצה חוזרת על נתונים טריים. לכן כל
// בדיקת כפילות נעשית **כאן**, בתוך המוטציה — ולא לפניה. בדיקה שנעשית
// על עותק שנטען קודם עלולה לפספס שורה שנוצרה בשנייה שחלפה, וזה בדיוק
// המקרה שמייצר פגישה כפולה.

export const COMMAND_MUTATORS: Record<CommandType, CommandMutator> = {

  // ---------- ליד ----------
  create_lead: (db, p) => {
    const phoneInfo = normalizePhoneNumber(p.phone);
    const phone = phoneInfo.normalized || clean(p.phone, 40);
    const name = clean(p.name, 120);

    // ⚠ הצד שכנגד קודם לכל. מספר של חייב בתיק אינו לקוח פוטנציאלי:
    // רישום שלו כליד מזהם את צנרת המכירות ועלול להוביל לשליחת הודעה
    // שיווקית למי שעומד מול הלקוח.
    const debtor = phone
      ? db.cases.find((c) => c.debtorPhone && samePhoneNumber(String(c.debtorPhone), phone))
      : null;
    if (debtor) {
      throw new VoiceError('TOOL_NOT_ALLOWED',
        'caller number matches a debtor on an open matter', null,
        'המספר תואם לצד שכנגד בתיק קיים. לא נפתחה פנייה — ' +
        'יש לרשום את הנושא ולהעביר לעורך הדין.');
    }

    const existingClient = phone
      ? db.clients.find((c) =>
          (c.phone && samePhoneNumber(String(c.phone), phone)) ||
          (c.contactPhone && samePhoneNumber(String(c.contactPhone), phone)))
      : null;
    if (existingClient) {
      return {
        message: `המתקשר כבר רשום כלקוח (${existingClient.name}). לא נפתחה פנייה חדשה.`,
        entityType: 'client', entityId: String(existingClient.id),
        data: { created: false, client_id: existingClient.id },
        deduped: true,
      };
    }

    const existingLead = phone
      ? db.leads.find((l) => l.phone && samePhoneNumber(String(l.phone), phone))
      : null;
    if (existingLead) {
      const extra = clean(p.summary);
      if (extra) existingLead.summary = [existingLead.summary, extra].filter(Boolean).join('\n');
      existingLead.lastContactAt = new Date().toISOString();
      existingLead.updatedAt = new Date().toISOString();
      return {
        message: `הפנייה הקיימת עודכנה (${existingLead.name || phone}).`,
        entityType: 'lead', entityId: String(existingLead.id),
        data: { created: false, lead_id: existingLead.id },
        deduped: true,
      };
    }

    const lead = {
      id: uid(),
      name: name || phoneInfo.display || 'פנייה טלפונית',
      phone: phone || '',
      rawPhone: phoneInfo.raw || undefined,
      email: clean(p.email, 120) || undefined,
      source: clean(p.source, 40) || 'voice_ai',
      area: clean(p.category, 60) || undefined,
      summary: clean(p.summary),
      status: 'new',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdByCall: p.call_id ? String(p.call_id) : undefined,
    };
    db.leads.unshift(lead as never);

    // ⚠ השלמת השם בבקשת חזרה שנפתחה קודם.
    //
    // הסדר בשיחה דחופה הוא: קודם רושמים בקשת חזרה (הטלפון כבר בידינו),
    // רק אחר כך שואלים לשם. בלי ההשלמה הזו, רשימת "ממתינים לחזרה"
    // הייתה מציגה מספר טלפון בזמן שהשם כבר ידוע — ועורך הדין שמתקשר
    // חזרה לא היה יודע למי הוא פונה.
    if (name && phone) {
      for (const t of db.tasks as Array<Record<string, unknown>>) {
        const cb = t.callback as Record<string, unknown> | undefined;
        if (!cb || t.done) continue;
        if (!['waiting', 'no_answer', 'reschedule'].includes(String(cb.status || 'waiting'))) continue;
        if (!samePhoneNumber(String(cb.callerPhone || ''), phone)) continue;
        // מעדכנים רק כשהשם הקודם היה מציין מקום (מספר או ריק).
        const had = String(cb.callerName || '');
        if (had && !/^[\d\-+ ()]+$/.test(had)) continue;
        cb.callerName = name;
        t.text = `חזרה דחופה ללקוח — ${name} · ${phoneInfo.display || phone}`;
        t.leadId = lead.id;
      }
    }

    return {
      message: `נפתחה פנייה חדשה עבור ${lead.name}.`,
      entityType: 'lead', entityId: lead.id,
      data: { created: true, lead_id: lead.id },
    };
  },

  update_lead: (db, p) => {
    const leadId = clean(p.lead_id, 40);
    const lead = db.leads.find((l) => l.id === leadId);
    if (!lead) {
      throw new VoiceError('UNKNOWN_ERROR', `lead ${leadId} not found`, null,
        'הפנייה המבוקשת לא נמצאה במערכת.');
    }
    if (p.summary) lead.summary = [lead.summary, clean(p.summary)].filter(Boolean).join('\n');
    if (p.status) lead.status = clean(p.status, 30);
    lead.updatedAt = new Date().toISOString();
    return {
      message: 'הפנייה עודכנה.',
      entityType: 'lead', entityId: leadId, data: { lead_id: leadId },
    };
  },

  // ---------- משימה ----------
  create_task: (db, p) => {
    const text = clean(p.title, 200);
    if (!text) {
      throw new VoiceError('UNKNOWN_ERROR', 'empty task title', null,
        'לא נמסרה כותרת למשימה.');
    }

    const clientId = clean(p.client_id, 40);
    const leadId = clean(p.lead_id, 40);
    const matterId = clean(p.matter_id, 40) || activeMatterFor(db, clientId);

    // דדופליקציה ברמת הנתונים ולא רק ברמת האידמפוטנטיות: שני כלים שונים
    // (או שיחה שנייה מאותו מתקשר) עדיין היו יוצרים שתי משימות זהות
    // באותו תיק. משימות כפולות הן בדיוק מה שגורם לאדם להפסיק לסמוך על
    // רשימת המשימות שלו.
    const dupe = db.tasks.find((t) => !t.done && t.text === text && (t.caseId || '') === matterId);
    if (dupe) {
      return {
        message: 'משימה זהה כבר פתוחה — לא נוצרה כפילות.',
        entityType: 'task', entityId: String(dupe.id),
        data: { created: false, task_id: dupe.id },
        deduped: true,
      };
    }

    const notes = [
      clean(p.description),
      p.call_phone ? `נוצר משיחה טלפונית מהמספר ${clean(p.call_phone, 40)}.` : 'נוצר משיחה טלפונית.',
      leadId ? `פנייה: ${leadId}` : '',
      clean(p.assigned_to, 120) ? `הועבר ל: ${clean(p.assigned_to, 120)}` : '',
    ].filter(Boolean).join('\n');

    const task = {
      id: uid(),
      text,
      due: clean(p.due_date, 10) || '',
      caseId: matterId,
      priority: clean(p.priority, 20) || 'normal',
      notes,
      done: false,
      // שדות additive — קוד קיים שלא מכיר אותם פשוט מתעלם.
      createdByCall: p.call_id ? String(p.call_id) : undefined,
      clientId: clientId || undefined,
      leadId: leadId || undefined,
      assignedTo: clean(p.assigned_to, 120) || undefined,
    };
    db.tasks.unshift(task as never);
    return {
      message: `נוצרה משימה: ${text}.`,
      entityType: 'task', entityId: task.id,
      data: { created: true, task_id: task.id },
    };
  },

  // ---------- בקשת חזרה ----------
  //
  // ⚠ Callback הוא תכונת ליבה ולא מקרה קצה: החלטת המוצר היא שאין העברה
  // חיה לעורך הדין, ולכן **כל** בקשה לדבר איתו הופכת לבקשת חזרה. לכן יש
  // לה metadata מובנה, ולא רק כותרת משימה — בלי מבנה אי אפשר לדעת מי
  // ממתין, כמה זמן, וכמה פעמים כבר ניסו לחזור אליו.
  create_callback: (db, p) => {
    const phoneInfo = normalizePhoneNumber(p.phone);
    const phone = phoneInfo.normalized || clean(p.phone, 40);
    const name = clean(p.name, 120);
    // ⚠ בלי הכפלה. `who` כבר נופל למספר כשאין שם, והוספת המספר שוב
    // הייתה מייצרת "חזרה דחופה ללקוח — 050-123-4567 · 050-123-4567"
    // ברשימת המשימות של עורך הדין.
    const who = name || phoneInfo.display || 'מתקשר';
    const text = name && phoneInfo.display
      ? `חזרה דחופה ללקוח — ${name} · ${phoneInfo.display}`
      : `חזרה דחופה ללקוח — ${who}`;

    // בקשת חזרה פתוחה מאותו מספר = אותה בקשה. מתקשר שהתנתק וחייג שוב
    // לא צריך להופיע פעמיים ברשימת ההמתנה.
    const dupe = db.tasks.find((t) => {
      if (t.done) return false;
      const cb = (t as Record<string, unknown>).callback as Record<string, unknown> | undefined;
      if (!cb) return t.text === text;
      const open = ['waiting', 'no_answer', 'reschedule'].includes(String(cb.status || 'waiting'));
      return open && phone && samePhoneNumber(String(cb.callerPhone || ''), phone);
    });
    if (dupe) {
      // ⚠ **מעשירים ולא מתעלמים.** הבקשה נרשמת מוקדם — לפני שהסוכנת
      // שאלה לשם — כדי שמתקשר שינתק לא ייעלם. כשהשם והמועד המועדף
      // מגיעים בהמשך, הקריאה השנייה חייבת להשלים אותם; החזרה בלבד
      // הייתה משאירה ברשימת ההמתנה מספר טלפון במקום אדם.
      const t = dupe as Record<string, unknown>;
      const cb = (t.callback || {}) as Record<string, unknown>;
      const enriched: string[] = [];

      if (name && name !== cb.callerName) {
        cb.callerName = name;
        t.text = phoneInfo.display
          ? `חזרה דחופה ללקוח — ${name} · ${phoneInfo.display}`
          : `חזרה דחופה ללקוח — ${name}`;
        enriched.push('שם');
      }
      const preferred = clean(p.preferred_time, 120);
      if (preferred && preferred !== cb.preferredCallbackTime) {
        cb.preferredCallbackTime = preferred;
        enriched.push('מועד מועדף');
      }
      const reason = clean(p.reason, 500);
      if (reason && !String(cb.reason || '').includes(reason)) {
        cb.reason = [cb.reason, reason].filter(Boolean).join(' · ').slice(0, 500);
        enriched.push('פרטים');
      }
      // דחיפות עולה בלבד: מידע חדש יכול להחמיר הערכה, לא להרגיע אותה.
      const urg = String(p.urgency || '');
      const rank: Record<string, number> = { low: 0, normal: 1, high: 2, critical: 3 };
      if (rank[urg] != null && rank[urg] > (rank[String(cb.urgency)] ?? 1)) {
        cb.urgency = urg;
        t.priority = urg === 'low' || urg === 'normal' ? 'normal' : 'urgent';
        enriched.push('דחיפות');
      }
      t.callback = cb;

      return {
        message: enriched.length
          ? `בקשת החזרה הקיימת עודכנה (${enriched.join(', ')}).`
          : 'כבר קיימת בקשת חזרה פתוחה עבור המתקשר.',
        entityType: 'task', entityId: String(dupe.id),
        data: { created: false, task_id: dupe.id, enriched },
        deduped: true,
      };
    }

    const clientId = clean(p.client_id, 40);
    const matterId = clean(p.matter_id, 40) || activeMatterFor(db, clientId);
    const urgency = ['low', 'normal', 'high', 'critical'].includes(String(p.urgency))
      ? String(p.urgency) : 'high';

    const task = {
      id: uid(),
      text,
      due: todayISO(),
      caseId: matterId,
      priority: urgency === 'low' || urgency === 'normal' ? 'normal' : 'urgent',
      notes: `סיבה: ${clean(p.reason, 500)}\nנוצר משיחה טלפונית.`,
      done: false,
      createdByCall: p.call_id ? String(p.call_id) : undefined,
      clientId: clientId || undefined,
      leadId: clean(p.lead_id, 40) || undefined,
      callback: {
        sourceCallId: p.call_id ? String(p.call_id) : null,
        callerPhone: phone || null,
        callerName: who,
        preferredCallbackTime: clean(p.preferred_time, 120) || null,
        reason: clean(p.reason, 500),
        urgency,
        status: 'waiting',
        attemptCount: 0,
        lastAttemptAt: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
      },
    };
    db.tasks.unshift(task as never);
    return {
      message: 'נרשמה בקשת חזרה.',
      entityType: 'task', entityId: task.id,
      data: { created: true, task_id: task.id, callback: true },
    };
  },

  update_callback: (db, p) => {
    const taskId = clean(p.task_id, 40);
    const task = db.tasks.find((t) => t.id === taskId) as Record<string, unknown> | undefined;
    if (!task) {
      throw new VoiceError('UNKNOWN_ERROR', `task ${taskId} not found`, null,
        'המשימה המבוקשת לא נמצאה.');
    }
    const cb = (task.callback || {}) as Record<string, unknown>;

    const status = String(p.status || '');
    const allowed = ['waiting', 'contacted', 'no_answer', 'reschedule', 'completed', 'cancelled'];
    if (!allowed.includes(status)) {
      throw new VoiceError('UNKNOWN_ERROR', `unknown callback status: ${status}`, null,
        `סטטוס לא מוכר: ${status}`);
    }

    cb.status = status;
    // ניסיון נספר רק כשבאמת חייגו. "נדחה למועד אחר" אינו ניסיון, וספירתו
    // הייתה מציגה לקוח כמי שניסו להשיגו חמש פעמים כשלא ניסו כלל.
    if (status === 'contacted' || status === 'no_answer') {
      cb.attemptCount = (Number(cb.attemptCount) || 0) + 1;
      cb.lastAttemptAt = new Date().toISOString();
    }
    if (p.preferred_time !== undefined) {
      cb.preferredCallbackTime = clean(p.preferred_time, 120) || null;
    }
    if (p.note) cb.note = clean(p.note, 500);

    if (status === 'completed' || status === 'cancelled') {
      cb.completedAt = new Date().toISOString();
      // סגירת הבקשה סוגרת גם את המשימה — אחרת היא נשארת ברשימת
      // המשימות הפתוחות של עורך הדין לנצח.
      task.done = true;
      task.completedAt = new Date().toISOString();
    } else {
      task.done = false;
      task.completedAt = null;
    }
    task.callback = cb;

    return {
      message: 'בקשת החזרה עודכנה.',
      entityType: 'task', entityId: taskId,
      data: { task_id: taskId, status },
    };
  },

  // ---------- הערה ----------
  create_note: (db, p) => {
    const text = clean(p.text, 4000);
    if (!text) {
      throw new VoiceError('UNKNOWN_ERROR', 'empty note body', null,
        'לא נמסר תוכן להערה.');
    }

    const clientId = clean(p.client_id, 40);
    const leadId = clean(p.lead_id, 40);
    const matterId = clean(p.matter_id, 40) || activeMatterFor(db, clientId);
    const stamp = heStamp();
    const body = `[שיחה טלפונית] ${text}`;

    if (matterId) {
      const c = db.cases.find((x) => x.id === matterId);
      if (c) {
        if (!Array.isArray(c.diary)) c.diary = [];
        c.diary.unshift({ text: body, date: stamp });
        return {
          message: 'ההערה נרשמה ביומן התיק.',
          entityType: 'matter', entityId: matterId, data: { target: 'matter' },
        };
      }
    }

    if (leadId) {
      const l = db.leads.find((x) => x.id === leadId);
      if (l) {
        l.notes = [l.notes, `${stamp} — ${body}`].filter(Boolean).join('\n');
        l.updatedAt = new Date().toISOString();
        return {
          message: 'ההערה נרשמה בפנייה.',
          entityType: 'lead', entityId: leadId, data: { target: 'lead' },
        };
      }
    }

    if (clientId) {
      const c = db.clients.find((x) => x.id === clientId);
      if (c) {
        // הוספה בסוף ולא דריסה: notes הוא שדה שהמשתמש כותב בו בעצמו.
        c.notes = [c.notes, `${stamp} — ${body}`].filter(Boolean).join('\n');
        return {
          message: 'ההערה נרשמה בכרטיס הלקוח.',
          entityType: 'client', entityId: clientId, data: { target: 'client' },
        };
      }
    }

    throw new VoiceError('UNKNOWN_ERROR', 'note has no attachment target', null,
      'לא נמסר לקוח, פנייה או תיק לשייך אליו את ההערה.');
  },

  // ---------- פגישה ----------
  create_appointment: (db, p) => {
    const date = clean(p.date, 10);
    const time = clean(p.time, 5);
    const duration = Number(p.duration_minutes) || 60;
    const startMin = timeToMinutes(time);
    if (startMin === null) {
      throw new VoiceError('UNKNOWN_ERROR', `invalid time: ${time}`, null,
        'השעה שנמסרה אינה תקינה.');
    }
    const endMin = startMin + duration;

    // ⚠ מניעת Double Booking. הבדיקה כאן, בתוך המוטציה, ולא לפניה —
    // ולכן היא רצה מחדש על נתונים טריים בכל ניסיון של saveOfficeDb.
    // בדיקה שנעשית על עותק שנטען קודם מפספסת פגישה שנקבעה בשנייה
    // שחלפה, וזה בדיוק התרחיש של שתי שיחות מקבילות לאותה שעה.
    const clash = busyFromEvents(db.events, date).some(
      (b) => startMin < b.endMin && endMin > b.startMin);
    if (clash) {
      throw new VoiceError('CRM_CONFLICT', 'double booking detected in mutator', null,
        'המועד כבר תפוס ביומן. יש להציע מועד אחר.');
    }

    const clientId = clean(p.client_id, 40);
    const leadId = clean(p.lead_id, 40);
    const matterId = clean(p.matter_id, 40) || activeMatterFor(db, clientId);
    const who = clientId
      ? (db.clients.find((c) => c.id === clientId)?.name || '')
      : (db.leads.find((l) => l.id === leadId)?.name || '');

    const event = {
      id: uid(),
      title: clean(p.title, 200) || `פגישה${who ? ' — ' + who : ''}`,
      date, time,
      location: clean(p.location, 200),
      type: 'meeting',
      caseId: matterId,
      notes: [clean(p.notes), 'נקבע בשיחה טלפונית עם המזכירה הדיגיטלית.']
        .filter(Boolean).join('\n'),
      durationMinutes: duration,
      createdByCall: p.call_id ? String(p.call_id) : undefined,
      clientId: clientId || undefined,
      leadId: leadId || undefined,
    };
    db.events.push(event as never);
    return {
      message: `נקבעה פגישה ל-${date} בשעה ${time}.`,
      entityType: 'event', entityId: event.id,
      data: { created: true, event_id: event.id, date, time },
    };
  },
};

// ---- עזרי יומן (משותפים עם tools.ts) ----

export function timeToMinutes(t: string): number | null {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function busyFromEvents(
  events: Array<{ date?: string; time?: string; durationMinutes?: unknown }>,
  dateISO: string,
  defaultDurationMin = 60,
): Array<{ startMin: number; endMin: number }> {
  return events
    .filter((e) => String(e.date || '').slice(0, 10) === dateISO)
    .map((e) => {
      const start = timeToMinutes(String(e.time || ''));
      // אירוע ללא שעה תופס את כל היום. הנחה שמרנית במכוון: עדיף לא
      // להציע מועד מאשר לקבוע פגישה מעל דיון שנרשם בלי שעה.
      if (start === null) return { startMin: 0, endMin: 24 * 60 };
      const dur = Number(e.durationMinutes) > 0 ? Number(e.durationMinutes) : defaultDurationMin;
      return { startMin: start, endMin: start + dur };
    });
}

// ============================================================
// ההחלה
// ============================================================

export type ApplyDeps = {
  store: CommandStore;
  /** saveOfficeDb, או תחליף בזיכרון לבדיקות. */
  write: (mutate: (db: CrmDb) => void) => Promise<CrmDb>;
};

/**
 * מחיל פקודה אחת.
 *
 * הסדר קריטי ואינו שרירותי:
 *   1. חפש מפתח אידמפוטנטיות → אם הוחל, החזר את התוצאה השמורה.
 *   2. רשום פקודה (pending).
 *   3. הרץ את המוטציה דרך write, שמטפל בקונקורנטיות ובניסיונות חוזרים.
 *   4. שמור תוצאה.
 *
 * שלב 1 לפני שלב 3 הוא כל העניין: בלעדיו, retry אחרי timeout היה מריץ
 * את המוטציה שוב — והמוטציה, שהיא בטוחה מבחינת קונקורנטיות, אינה יודעת
 * שכבר ביקשו ממנה בדיוק את זה.
 */
export async function applyOfficeCommand(
  env: CommandEnvelope, deps: ApplyDeps,
): Promise<CommandResult> {
  const mutator = COMMAND_MUTATORS[env.type];
  if (!mutator) {
    throw new VoiceError('TOOL_NOT_ALLOWED', `unknown command type: ${env.type}`, null,
      `סוג פקודה לא מוכר: ${env.type}`);
  }

  // ---- 1. אידמפוטנטיות ----
  const existing = await deps.store.find(env.idempotencyKey);
  if (existing) {
    if (existing.status === 'applied') {
      const stored = (existing.result_payload || {}) as MutationOutcome;
      return {
        ok: true,
        replayed: true,
        conflictRetries: 0,
        commandId: env.commandId,
        message: stored.message || 'הפעולה כבר בוצעה בשיחה זו.',
        entityType: existing.entity_type || stored.entityType,
        entityId: existing.entity_id || stored.entityId,
        data: stored.data,
        deduped: stored.deduped,
      };
    }
    if (existing.status === 'pending') {
      // ⚠ בקשה מקבילה עם אותו מפתח כבר בטיפול. **לא** מריצים שוב: זה
      // בדיוק המרוץ שהאילוץ נועד למנוע. מדווחים שהיא בטיפול; הקורא
      // (שרת הקול) ינסה שוב מאוחר יותר ואז ימצא את התוצאה.
      throw new VoiceError('DUPLICATE_TOOL_CALL',
        'פקודה זהה נמצאת כרגע בביצוע', env.callId ?? null);
    }
    // failed / conflict → מותר לנסות שוב.
  }

  const record = existing && existing.status !== 'applied'
    ? existing
    : await deps.store.begin(env);

  // begin החזיר null = מירוץ; מישהו רשם את אותו מפתח בדיוק עכשיו.
  if (!record) {
    const raced = await deps.store.find(env.idempotencyKey);
    if (raced?.status === 'applied') {
      const stored = (raced.result_payload || {}) as MutationOutcome;
      return {
        ok: true, replayed: true, conflictRetries: 0, commandId: env.commandId,
        message: stored.message || 'הפעולה כבר בוצעה בשיחה זו.',
        entityType: raced.entity_type || stored.entityType,
        entityId: raced.entity_id || stored.entityId,
        data: stored.data, deduped: stored.deduped,
      };
    }
    throw new VoiceError('DUPLICATE_TOOL_CALL',
      'פקודה זהה נמצאת כרגע בביצוע', env.callId ?? null);
  }

  // ---- 2. החלה ----
  let outcome: MutationOutcome | null = null;
  let invocations = 0;
  // המוטציה מקבלת גם את מזהי ההקשר, כדי שהיא לא תצטרך לקרוא אותם מבחוץ.
  const payload = { ...env.payload, call_id: env.callId ?? null };

  try {
    await deps.write((db) => {
      // ⚠ נספר, לא נצבר: כל הרצה מתחילה מאפס על נתונים טריים. אילו
      // outcome היה נשמר מהרצה קודמת, תוצאה של ניסיון שנדחה הייתה
      // מדווחת כאילו הוחלה.
      invocations++;
      outcome = mutator(db, payload);
    });
  } catch (e) {
    const isConflict = e instanceof VoiceError && e.code === 'CRM_CONFLICT';
    const msg = e instanceof Error ? e.message : String(e);
    await deps.store.fail(record.id, msg, isConflict ? 'conflict' : 'failed');
    throw e;
  }

  if (!outcome) {
    await deps.store.fail(record.id, 'המוטציה לא החזירה תוצאה', 'failed');
    throw new VoiceError('UNKNOWN_ERROR', 'המוטציה לא החזירה תוצאה');
  }

  const conflictRetries = Math.max(0, invocations - 1);
  await deps.store.complete(record.id, outcome, conflictRetries);

  return {
    ok: true,
    replayed: false,
    conflictRetries,
    commandId: env.commandId,
    ...(outcome as MutationOutcome),
  };
}

// ============================================================
// מימוש הרישום מול Supabase
// ============================================================

export function supabaseCommandStore(
  sb: SupabaseClient, officeId: string,
): CommandStore {
  return {
    async find(idempotencyKey) {
      const { data } = await sb.from('office_commands')
        .select('id, status, result_payload, entity_type, entity_id')
        .eq('office_id', officeId).eq('idempotency_key', idempotencyKey).maybeSingle();
      return (data as StoredCommand) || null;
    },

    async begin(env) {
      const { data, error } = await sb.from('office_commands').insert({
        office_id: officeId,
        command_id: env.commandId,
        call_id: env.callId || null,
        tool_call_id: env.toolCallId || null,
        agent_id: env.agentId || null,
        idempotency_key: env.idempotencyKey,
        command_type: env.type,
        schema_version: env.schemaVersion || '1',
        payload: env.payload,
        actor_type: env.actor.type,
        actor_id: env.actor.id || null,
        status: 'pending',
      }).select('id, status, result_payload, entity_type, entity_id').single();

      // 23505 = unique_violation → מירוץ. הקורא יקרא שוב ויקבל את התוצאה.
      if (error) {
        if ((error as { code?: string }).code === '23505') return null;
        throw new VoiceError('CRM_UNAVAILABLE', error.message);
      }
      return data as StoredCommand;
    },

    async complete(id, outcome, conflictRetries) {
      await sb.from('office_commands').update({
        status: 'applied',
        result_payload: outcome,
        entity_type: outcome.entityType || null,
        entity_id: outcome.entityId || null,
        conflict_retries: conflictRetries,
        applied_at: new Date().toISOString(),
      }).eq('id', id);
    },

    async fail(id, error, status) {
      await sb.from('office_commands').update({
        status,
        error: String(error).slice(0, 1000),
      }).eq('id', id);
    },
  };
}

/**
 * רישום בזיכרון — לבדיקות ולנתיבים שאין להם מסד נתונים.
 *
 * ⚠ מממש את **אותה** סמנטיקה: אותו מפתח פעמיים מחזיר את התוצאה
 * הראשונה. אחרת הבדיקות היו בודקות התנהגות שאינה קיימת בייצור.
 */
export function memoryCommandStore(): CommandStore & { size(): number } {
  const rows = new Map<string, StoredCommand & { key: string }>();
  let seq = 0;
  return {
    size: () => rows.size,
    find(idempotencyKey) {
      return Promise.resolve(rows.get(idempotencyKey) || null);
    },
    begin(env) {
      if (rows.has(env.idempotencyKey)) return Promise.resolve(null);
      const row = { id: `mem_${++seq}`, key: env.idempotencyKey, status: 'pending' as const };
      rows.set(env.idempotencyKey, row);
      return Promise.resolve(row);
    },
    complete(id, outcome) {
      for (const row of rows.values()) {
        if (row.id === id) {
          row.status = 'applied';
          row.result_payload = outcome as Record<string, unknown>;
          row.entity_type = outcome.entityType || null;
          row.entity_id = outcome.entityId || null;
        }
      }
      return Promise.resolve();
    },
    fail(id, _error, status) {
      for (const row of rows.values()) {
        if (row.id === id) row.status = status;
      }
      return Promise.resolve();
    },
  };
}

// ============================================================
// מפתח אידמפוטנטיות
// ============================================================

/**
 * סידור מפתחות לפני גיבוב — {a:1,b:2} ו-{b:2,a:1} חייבים לתת אותו מפתח.
 *
 * ⚠ שדות ריקים מושמטים. המודל מחזיר לפעמים `""` ולפעמים משמיט את השדה
 * לגמרי, ושתי הצורות מתארות את אותה כוונה; בלי ההשמטה, retry עם ניסוח
 * מעט שונה היה מקבל מפתח חדש — כלומר פגישה שנייה.
 */
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
 * טביעת אצבע של ה-payload, לשימוש כשאין tool_call_id.
 *
 * סינכרוני במכוון: זהו מפתח דדופליקציה ולא אסימון אבטחה, ו-crypto.subtle
 * היה מכריח כל מוטציה להיות async רק בשביל מחרוזת. החיתוך מגן מפני
 * payload ענק בלי לפגוע בייחודיות בפועל.
 */
export function payloadFingerprint(payload: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(payload)).slice(0, 500);
}

/**
 * המפתח נגזר מהשיחה, מהכלי, ומזהה קריאת הכלי.
 *
 * ⚠ `tool_call_id` נכלל כי הוא מה שמבדיל בין "המודל ביקש שוב את אותו
 * דבר" (קריאה חדשה, מזהה חדש → פעולה חדשה, לגיטימי) לבין "אותה בקשה
 * נשלחה פעמיים ברשת" (אותו מזהה → אותה פעולה). בלעדיו, מתקשר שביקש
 * שתי פגישות באמת היה מקבל אחת.
 */
export function buildIdempotencyKey(parts: {
  callId?: string | null;
  toolCallId?: string | null;
  type: string;
  fingerprint?: string;
}): string {
  return [
    parts.callId || 'no-call',
    parts.type,
    parts.toolCallId || parts.fingerprint || 'no-id',
  ].join(':');
}
