// איסוף הנושאים שאוטומציה חלה עליהם (סעיף 4 במפרט).
//
// ## למה זה קורה ב-JS ולא ב-SQL
// אין טבלאות ל-cases/tasks/clients — הכל ב-app_data.data (jsonb יחיד לכל
// משרד). אין `select ... where status='active'`. הדרך היחידה היא לטעון את
// ה-blob ולסנן בזיכרון. זו לא פשרה שנבחרה כאן, זו עובדה על המערכת.
//
// ## החוזה
// טריגר מחזיר **נושאים**, לא החלטות. מנוע התנאים מסנן, מנוע הפעולות מבצע.
// ההפרדה הזו היא מה שמאפשר להוסיף טריגר בלי לגעת בפעולות ולהפך.

// ⚠ import type ולא import רגיל.
//
// db.ts מייבא את supabase-js מ-https://esm.sh בזמן טעינה, ו-Node לא יודע
// לטעון URL כזה. ייבוא טיפוסים נמחק לגמרי בזמן ה-strip, ולכן הקובץ נשאר
// טהור וניתן לבדיקה אוטומטית — וזו כל הסיבה שהטריגרים נכתבו כפונקציות
// שמקבלות blob במקום לשלוף בעצמן.
import type { CrmDb, CrmCase } from '../db.ts';

export type Subject = {
  entityType: 'matter' | 'task' | 'client' | 'lead' | 'document' | 'event' | 'thread' | 'office';
  entityId: string;
  label: string;
  clientId?: string | null;
  matterId?: string | null;
  /** מה שמנוע התנאים בודק ומה שתבניות הטקסט קוראות. */
  data: Record<string, unknown>;
};

export type TriggerDef = {
  type: string;
  label: string;
  category: string;
  description: string;
  /** 'event' = מונע אירועים, 'schedule' = תקופתי, 'condition' = סריקת מצב */
  kind: 'event' | 'schedule' | 'condition';
  requires?: string[];
  collect: (db: CrmDb, cfg: Record<string, unknown>, now: Date, extra: TriggerExtra) => Subject[];
};

/** נתונים שאינם ב-blob ונטענים בנפרד רק כשצריך. */
export type TriggerExtra = {
  threads?: Array<Record<string, unknown>>;
};

const tz = 'Asia/Jerusalem';
const isoDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);

function daysBetween(a: string, b: string): number {
  const t1 = Date.parse(a + (a.length === 10 ? 'T00:00:00Z' : ''));
  const t2 = Date.parse(b + (b.length === 10 ? 'T00:00:00Z' : ''));
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return NaN;
  return Math.floor((t2 - t1) / 86400000);
}

/**
 * כמה ימים התיק "שקט".
 *
 * ⚠ הנפילה ל-`opened` היא מהותית. תיק חדש שנפתח אתמול אין לו יומן, ובלי
 * הנפילה `idleDays` היה מחזיר null → הקוד היה מתייחס אליו כאילו הוא תקוע
 * לנצח, וכל תיק חדש היה מייצר התראת "תיק ללא פעילות" ביום שנפתח.
 */
export function idleDays(c: CrmCase, today: string): number | null {
  const diary = Array.isArray(c.diary) ? c.diary : [];
  const last = diary.length ? String(diary[diary.length - 1].date || '') : String(c.opened || '');
  if (!last) return null;
  const d = daysBetween(last, today);
  return Number.isFinite(d) ? d : null;
}

const openCases = (db: CrmDb) => db.cases.filter((c) => c.status !== 'closed');
const clientOf = (db: CrmDb, c: CrmCase) => c.client || null;

/** הקשר משותף לכל נושא מסוג תיק — מה שהתנאים יכולים לבדוק. */
function matterData(db: CrmDb, c: CrmCase, today: string): Record<string, unknown> {
  const tasks = db.tasks.filter((t) => t.caseId === c.id && !t.done);
  const events = db.events.filter((e) => e.caseId === c.id && e.date >= today);
  const collected = db.payments
    .filter((p) => p.caseId === c.id && p.type === 'debt')
    .reduce((s, p) => s + (Number(p.amount) || 0), 0);

  return {
    ...c,
    idleDays: idleDays(c, today),
    openTaskCount: tasks.length,
    futureEventCount: events.length,
    docCount: db.docs.filter((d) => d.caseId === c.id).length,
    collected,
    balance: (Number(c.amount) || 0) - collected,
    hasNextAction: tasks.length > 0 || events.length > 0,
    clientName: db.clients.find((cl) => cl.id === c.client)?.name || '',
  };
}

// ============================================================

export const TRIGGERS: TriggerDef[] = [

  // ---------- תיקים ----------
  {
    type: 'matter_inactive',
    label: 'תיק ללא פעילות',
    category: 'תיקים',
    kind: 'condition',
    description: 'תיק פעיל שלא נרשמה בו פעילות ביומן מעל מספר ימים שנקבע.',
    collect: (db, cfg, now) => {
      const today = isoDate(now);
      const days = Number(cfg.days ?? 14);
      return openCases(db)
        .filter((c) => (idleDays(c, today) ?? -1) > days)
        .map((c) => ({
          entityType: 'matter' as const, entityId: c.id,
          label: `תיק ללא פעילות: ${c.name}`,
          matterId: c.id, clientId: clientOf(db, c),
          data: matterData(db, c, today),
        }));
    },
  },

  {
    type: 'matter_no_next_action',
    label: 'תיק ללא פעולה עתידית',
    category: 'תיקים',
    kind: 'condition',
    description: 'תיק פעיל שאין בו אף משימה פתוחה ואף מועד עתידי — אף אחד לא יודע מה הצעד הבא.',
    collect: (db, _cfg, now) => {
      const today = isoDate(now);
      return openCases(db)
        .map((c) => ({ c, d: matterData(db, c, today) }))
        .filter((x) => !x.d.hasNextAction)
        .map(({ c, d }) => ({
          entityType: 'matter' as const, entityId: c.id,
          label: `אין פעולה הבאה: ${c.name}`,
          matterId: c.id, clientId: clientOf(db, c), data: d,
        }));
    },
  },

  {
    type: 'matter_incomplete',
    label: 'תיק חדש עם פרטים חסרים',
    category: 'תיקים',
    kind: 'condition',
    description: 'תיק שנפתח לאחרונה וחסרים בו פרטים מהותיים.',
    collect: (db, cfg, now) => {
      const today = isoDate(now);
      const withinDays = Number(cfg.opened_within_days ?? 30);
      // ⚠ מוגבל לתיקים חדשים בכוונה. בלי החסם, הדלקת הכלל הייתה מייצרת
      // התראה על כל תיק ישן במשרד שחסר בו שדה — עשרות התראות ברגע אחד
      // על תיקים שכבר רצים שנה ואיש לא מתכוון להשלים בהם כלום.
      return openCases(db)
        .filter((c) => c.opened && (daysBetween(String(c.opened), today) <= withinDays))
        .map((c) => {
          const missing: string[] = [];
          if (!c.client) missing.push('לקוח');
          if (!c.number) missing.push('מספר תיק');
          if (!c.court) missing.push('ערכאה');
          if (!c.feeType) missing.push('הסכם שכר טרחה');
          if (!c.stage) missing.push('שלב');
          if (!db.docs.some((d) => d.caseId === c.id)) missing.push('מסמכי פתיחה');
          return { c, missing };
        })
        .filter((x) => x.missing.length > 0)
        .map(({ c, missing }) => ({
          entityType: 'matter' as const, entityId: c.id,
          label: `תיק לא הושלם: ${c.name}`,
          matterId: c.id, clientId: clientOf(db, c),
          data: { ...matterData(db, c, today), missingFields: missing, missingCount: missing.length,
                  missingList: missing.join(', ') },
        }));
    },
  },

  {
    type: 'matter_stuck_in_stage',
    label: 'תיק תקוע באותו שלב',
    category: 'תיקים',
    kind: 'condition',
    description: 'תיק שנשאר באותו שלב מעבר לזמן שהוגדר.',
    requires: ['case.stageChangedAt'],
    collect: (db, cfg, now) => {
      const today = isoDate(now);
      const days = Number(cfg.days ?? 30);
      // stageChangedAt לא נכתב היום ע"י ה-UI. הטריגר קיים ויעבוד ברגע
      // שהשדה יתחיל להיכתב — עד אז הוא פשוט לא מחזיר נושאים, ולא מתחזה.
      return openCases(db)
        .filter((c) => c.stageChangedAt && daysBetween(String(c.stageChangedAt), today) > days)
        .map((c) => ({
          entityType: 'matter' as const, entityId: c.id,
          label: `תקוע בשלב "${c.stage}": ${c.name}`,
          matterId: c.id, clientId: clientOf(db, c),
          data: { ...matterData(db, c, today),
                  daysInStage: daysBetween(String(c.stageChangedAt), today) },
        }));
    },
  },

  // ---------- משימות ----------
  {
    type: 'task_overdue',
    label: 'משימה באיחור',
    category: 'משימות',
    kind: 'condition',
    description: 'משימה שעבר מועד היעד שלה ולא סומנה כהושלמה.',
    collect: (db, cfg, now) => {
      const today = isoDate(now);
      const minDays = Number(cfg.min_days_late ?? 0);
      return db.tasks
        .filter((t) => !t.done && t.due && t.due < today)
        .filter((t) => daysBetween(String(t.due), today) >= minDays)
        .map((t) => {
          const c = db.cases.find((x) => x.id === t.caseId);
          return {
            entityType: 'task' as const, entityId: t.id,
            label: `משימה באיחור: ${t.text}`,
            matterId: t.caseId || null, clientId: c?.client || null,
            data: { ...t, daysLate: daysBetween(String(t.due), today),
                    caseName: c?.name || '', clientName: db.clients.find((cl) => cl.id === c?.client)?.name || '' },
          };
        });
    },
  },

  {
    type: 'task_due_soon',
    label: 'משימה שמתקרבת למועד',
    category: 'משימות',
    kind: 'condition',
    description: 'משימה שמועד היעד שלה בתוך מספר הימים שנקבע.',
    collect: (db, cfg, now) => {
      const today = isoDate(now);
      const days = Number(cfg.days ?? 2);
      return db.tasks
        .filter((t) => !t.done && t.due && t.due >= today)
        .filter((t) => daysBetween(today, String(t.due)) <= days)
        .map((t) => {
          const c = db.cases.find((x) => x.id === t.caseId);
          return {
            entityType: 'task' as const, entityId: t.id,
            label: `מתקרב: ${t.text}`,
            matterId: t.caseId || null, clientId: c?.client || null,
            data: { ...t, daysUntil: daysBetween(today, String(t.due)), caseName: c?.name || '' },
          };
        });
    },
  },

  {
    type: 'task_no_due_date',
    label: 'משימה ללא תאריך יעד',
    category: 'משימות',
    kind: 'condition',
    description: 'משימה פתוחה שלא נקבע לה מועד — כלומר לא תופיע בשום תזכורת.',
    collect: (db, _cfg, now) => {
      const today = isoDate(now);
      return db.tasks
        .filter((t) => !t.done && !t.due)
        .map((t) => {
          const c = db.cases.find((x) => x.id === t.caseId);
          return {
            entityType: 'task' as const, entityId: t.id,
            label: `ללא מועד: ${t.text}`,
            matterId: t.caseId || null, clientId: c?.client || null,
            data: { ...t, caseName: c?.name || '', today },
          };
        });
    },
  },

  // ---------- מועדים ודיונים ----------
  {
    type: 'event_approaching',
    label: 'מועד או דיון מתקרב',
    category: 'מועדים',
    kind: 'condition',
    description: 'אירוע ביומן בתוך מספר הימים שנקבע.',
    collect: (db, cfg, now) => {
      const today = isoDate(now);
      const days = Number(cfg.days ?? 7);
      return db.events
        .filter((e) => e.date >= today && daysBetween(today, e.date) <= days)
        .map((e) => {
          const c = db.cases.find((x) => x.id === e.caseId);
          const prepTasks = db.tasks.filter((t) => t.caseId === e.caseId && !t.done);
          return {
            entityType: 'event' as const, entityId: e.id,
            label: `${e.type || 'מועד'} בעוד ${daysBetween(today, e.date)} ימים: ${e.title}`,
            matterId: e.caseId || null, clientId: c?.client || null,
            data: { ...e, daysUntil: daysBetween(today, e.date),
                    caseName: c?.name || '', hasPrepTask: prepTasks.length > 0,
                    prepTaskCount: prepTasks.length,
                    docCount: db.docs.filter((d) => d.caseId === e.caseId).length },
          };
        });
    },
  },

  {
    type: 'event_passed_unmarked',
    label: 'מועד שעבר',
    category: 'מועדים',
    kind: 'condition',
    description: 'אירוע שתאריכו עבר ולא נרשמה אחריו פעילות ביומן התיק.',
    collect: (db, cfg, now) => {
      const today = isoDate(now);
      const grace = Number(cfg.grace_days ?? 1);
      return db.events
        .filter((e) => e.date < today && daysBetween(e.date, today) >= grace)
        .filter((e) => {
          // ⚠ "לא טופל" = אין רישום ביומן **אחרי** תאריך הדיון. בלי
          // התנאי הזה כל דיון היסטורי במשרד היה נחשב לא מטופל לנצח.
          const c = db.cases.find((x) => x.id === e.caseId);
          const diary = Array.isArray(c?.diary) ? c!.diary : [];
          return !diary.some((d) => String(d.date) >= e.date);
        })
        .map((e) => {
          const c = db.cases.find((x) => x.id === e.caseId);
          return {
            entityType: 'event' as const, entityId: e.id,
            label: `מועד שעבר ללא תיעוד: ${e.title}`,
            matterId: e.caseId || null, clientId: c?.client || null,
            data: { ...e, daysSince: daysBetween(e.date, today), caseName: c?.name || '' },
          };
        });
    },
  },

  {
    type: 'event_without_prep_task',
    label: 'דיון ללא משימת הכנה',
    category: 'מועדים',
    kind: 'condition',
    description: 'דיון מתקרב שאין בתיק שלו אף משימה פתוחה.',
    collect: (db, cfg, now) => {
      const today = isoDate(now);
      const days = Number(cfg.days ?? 14);
      return db.events
        .filter((e) => e.date >= today && daysBetween(today, e.date) <= days)
        .filter((e) => !db.tasks.some((t) => t.caseId === e.caseId && !t.done))
        .map((e) => {
          const c = db.cases.find((x) => x.id === e.caseId);
          return {
            entityType: 'event' as const, entityId: e.id,
            label: `${e.title} — אין משימת הכנה`,
            matterId: e.caseId || null, clientId: c?.client || null,
            data: { ...e, daysUntil: daysBetween(today, e.date), caseName: c?.name || '' },
          };
        });
    },
  },

  {
    type: 'event_conflict',
    label: 'התנגשות ביומן',
    category: 'מועדים',
    kind: 'condition',
    description: 'שני אירועים או יותר באותו יום ובאותה שעה.',
    collect: (db, _cfg, now) => {
      const today = isoDate(now);
      const future = db.events.filter((e) => e.date >= today && e.time);
      const bySlot = new Map<string, typeof future>();
      for (const e of future) {
        const k = `${e.date} ${e.time}`;
        if (!bySlot.has(k)) bySlot.set(k, []);
        bySlot.get(k)!.push(e);
      }
      const out: Subject[] = [];
      for (const [slot, evs] of bySlot) {
        if (evs.length < 2) continue;
        // נושא אחד לכל התנגשות ולא אחד לכל אירוע — אחרת אותה התנגשות
        // מייצרת שתי התראות זהות.
        out.push({
          entityType: 'event', entityId: evs.map((e) => e.id).sort().join('+'),
          label: `התנגשות ב-${slot}: ${evs.map((e) => e.title).join(' / ')}`,
          matterId: evs[0].caseId || null, clientId: null,
          data: { slot, date: evs[0].date, time: evs[0].time, count: evs.length,
                  titles: evs.map((e) => e.title).join(', ') },
        });
      }
      return out;
    },
  },

  // ---------- מסמכים ----------
  {
    type: 'document_unlinked',
    label: 'מסמך שלא שויך לתיק',
    category: 'מסמכים',
    kind: 'condition',
    description: 'מסמך שהועלה ולא נקשר לאף תיק.',
    collect: (db) => db.docs
      .filter((d) => !d.caseId)
      .map((d) => ({
        entityType: 'document' as const, entityId: d.id,
        label: `מסמך ללא תיק: ${d.name}`,
        matterId: null, clientId: null, data: { ...d },
      })),
  },

  {
    type: 'document_unanalyzed',
    label: 'מסמך שטרם נותח',
    category: 'מסמכים',
    kind: 'condition',
    description: 'מסמך עם קובץ מצורף שלא עבר ניתוח.',
    collect: (db) => db.docs
      .filter((d) => d.filePath && !d.aiAnalyzedAt)
      .map((d) => {
        const c = db.cases.find((x) => x.id === d.caseId);
        return {
          entityType: 'document' as const, entityId: d.id,
          label: `לניתוח: ${d.name}`,
          matterId: d.caseId || null, clientId: c?.client || null,
          data: { ...d, caseName: c?.name || '' },
        };
      }),
  },

  // ---------- לקוחות ותקשורת ----------
  {
    type: 'client_no_update',
    label: 'לקוח שלא קיבל עדכון',
    category: 'לקוחות',
    kind: 'condition',
    description: 'לקוח עם תיק פעיל שלא נרשמה בו פעילות מעל מספר ימים.',
    collect: (db, cfg, now) => {
      const today = isoDate(now);
      const days = Number(cfg.days ?? 30);
      return db.clients
        .map((cl) => ({ cl, cases: db.cases.filter((c) => c.client === cl.id && c.status !== 'closed') }))
        .filter((x) => x.cases.length > 0)
        .map((x) => ({ ...x, minIdle: Math.min(...x.cases.map((c) => idleDays(c, today) ?? 0)) }))
        .filter((x) => x.minIdle > days)
        .map(({ cl, cases, minIdle }) => ({
          entityType: 'client' as const, entityId: cl.id,
          label: `לקוח ללא עדכון: ${cl.name}`,
          clientId: cl.id, matterId: cases[0]?.id || null,
          data: { ...cl, idleDays: minIdle, activeCases: cases.length,
                  caseNames: cases.map((c) => c.name).join(', ') },
        }));
    },
  },

  {
    type: 'thread_no_reply',
    label: 'הודעה ללא מענה',
    category: 'תקשורת',
    kind: 'condition',
    description: 'שרשור שההודעה האחרונה בו נכנסת ולא נענתה בתוך הזמן שנקבע.',
    collect: (_db, cfg, now, extra) => {
      const hours = Number(cfg.hours ?? 4);
      const cutoff = now.getTime() - hours * 3600_000;
      const channels = Array.isArray(cfg.channels) && cfg.channels.length
        ? (cfg.channels as string[]) : null;

      return (extra.threads || [])
        .filter((t) => t.lastDirection === 'in')
        .filter((t) => !channels || channels.includes(String(t.channel)))
        .filter((t) => t.last_message_at && Date.parse(String(t.last_message_at)) < cutoff)
        .map((t) => {
          const waited = Math.floor((now.getTime() - Date.parse(String(t.last_message_at))) / 3600_000);
          return {
            entityType: 'thread' as const, entityId: String(t.id),
            label: `ללא מענה ${waited} שעות: ${t.participant_name || t.participant_identifier}`,
            clientId: (t.client_id as string) || null, matterId: (t.matter_id as string) || null,
            data: { ...t, waitedHours: waited, isKnownClient: !!t.client_id },
          };
        });
    },
  },

  // ---------- כללי ----------
  {
    type: 'daily_digest',
    label: 'סיכום יומי',
    category: 'ניהול',
    kind: 'schedule',
    description: 'רץ פעם ביום בשעה שנקבעה. נושא אחד: המשרד.',
    collect: (db, cfg, now) => {
      const hour = Number(cfg.hour ?? 8);
      const nowHour = Number(new Intl.DateTimeFormat('en-US',
        { timeZone: tz, hour: '2-digit', hour12: false }).format(now));
      // חלון של שעה — ה-cron רץ כל 5 דקות וה-dedupe היומי מונע כפילות.
      if (nowHour < hour || nowHour > hour + 1) return [];
      const today = isoDate(now);
      return [{
        entityType: 'office', entityId: 'office', label: 'סיכום יומי',
        data: {
          date: today,
          openCases: openCases(db).length,
          overdueTasks: db.tasks.filter((t) => !t.done && t.due && t.due < today).length,
          todayTasks: db.tasks.filter((t) => !t.done && t.due === today).length,
          todayEvents: db.events.filter((e) => e.date === today).length,
          stuckCases: openCases(db).filter((c) => (idleDays(c, today) ?? 0) > 14).length,
        },
      }];
    },
  },
];

export const TRIGGER_MAP = new Map(TRIGGERS.map((t) => [t.type, t]));
