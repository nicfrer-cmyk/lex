// ai-learn — לולאת הלמידה.
//
// רץ מה-cron. קורא את הסיגנלים שהמערכת כבר אוספת (עריכות, דחיות, החזרות,
// דפוסים חוזרים, שגיאות), מזקק מהם לקחים, וכותב אותם כתובנות **מוצעות**.
//
// ## מה הוא לא עושה, בכוונה
// הוא לא משנה שום הגדרה של שום סוכן. לא את ה-prompt, לא את רמת העצמאות,
// לא את מדיניות האישור. הוא רק מציע — והצעה נכנסת לתוקף רק אחרי אימוץ
// מפורש של בעל המשרד במסך הלמידה. במערכת שמפיקה מסמכים משפטיים, סוכן
// שמשנה את התנהגותו לבד הוא סוכן שאי אפשר להסביר בדיעבד למה כתב מה שכתב.
//
// Deploy: supabase functions deploy ai-learn --no-verify-jwt

import { admin } from '../_shared/db.ts';
import { json, preflight, errorResponse } from '../_shared/http.ts';
import { timingSafeEqual } from '../_shared/crypto.ts';
import { getProvider } from '../_shared/provider.ts';
import { audit } from '../_shared/audit.ts';
import { ALWAYS_APPROVE } from '../_shared/approvals.ts';
import {
  ApprovalRow, Signal, correctionSignals, repetitionSignals,
  recurringTaskSignals, failureSignals, groupSignals, confidenceFor,
  DISTILL_SYSTEM, DISTILL_SCHEMA,
} from '../_shared/learning.ts';

const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';

/** מרווח מינימלי בין סבבי למידה אוטומטיים. דפוסי עבודה נצברים בימים, לא בדקות. */
const MIN_INTERVAL_MS = 6 * 3600_000;

function authorized(req: Request): boolean {
  const auth = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (auth && timingSafeEqual(auth, SERVICE_ROLE_KEY)) return true;
  const secret = req.headers.get('x-cron-secret') || '';
  return !!CRON_SECRET && timingSafeEqual(secret, CRON_SECRET);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (!authorized(req)) return json({ error: 'לא מורשה' }, 401);

  const sb = admin();
  try {
    const body = await req.json().catch(() => ({}));
    const officeFilter = body.office_id ? String(body.office_id) : null;
    // force מגיע רק מהנתיב הידני ב-gateway, שכבר אוכף חסימה של שעה משלו.
    const force = body.force === true || !!officeFilter;

    const { data: offices } = await sb.from('ai_settings')
      .select('office_id, learning_enabled, learning_repetition_threshold, learning_last_run_at, ai_provider_mode')
      .eq('learning_enabled', true);

    const results: unknown[] = [];
    for (const o of offices || []) {
      if (officeFilter && o.office_id !== officeFilter) continue;

      // ⚠ ה-cron רץ בתדירות גבוהה (דקות), הלמידה לא צריכה. בלי החסימה
      // הזו כל תיקון בודד היה מזוקק בקריאת מודל נפרדת במקום להצטבר
      // לאצווה — יותר כסף, ולקחים גרועים יותר, כי המזקק לא רואה את
      // התיקונים האחרים כדי לזהות בהם דפוס.
      const last = o.learning_last_run_at ? Date.parse(o.learning_last_run_at) : 0;
      if (!force && last && Date.now() - last < MIN_INTERVAL_MS) {
        results.push({ office: o.office_id, skipped: 'too_soon' });
        continue;
      }
      results.push(await learnForOffice(sb, o));
    }
    return json({ ok: true, offices: results.length, results });
  } catch (e) {
    return errorResponse(e);
  }
});

// ============================================================

async function learnForOffice(
  sb: ReturnType<typeof admin>,
  settings: Record<string, any>,
) {
  const officeId = settings.office_id as string;
  const threshold = Number(settings.learning_repetition_threshold) || 5;

  // ---- 1. איסוף הסיגנלים ----
  //
  // learned_at מסמן מה כבר עובד. בלעדיו כל סבב היה קורא את כל ההיסטוריה
  // ומייצר שוב את אותן תובנות, בתשלום.
  const { data: approvals } = await sb.from('ai_approvals')
    .select('id, agent_id, action_type, action_label, status, proposed_payload, ' +
            'edited_payload, proposed_content, rejection_reason, return_instruction, requested_at')
    .eq('office_id', officeId)
    .is('learned_at', null)
    .in('status', ['approved', 'applied', 'rejected', 'returned'])
    .order('requested_at', { ascending: false })
    .limit(200);

  // לזיהוי חזרתיות צריך גם את מה שכבר נלמד — הדפוס הוא מצטבר מטבעו.
  const { data: recentAll } = await sb.from('ai_approvals')
    .select('id, agent_id, action_type, action_label, status, proposed_payload, ' +
            'edited_payload, proposed_content, rejection_reason, return_instruction, requested_at')
    .eq('office_id', officeId)
    .gte('requested_at', new Date(Date.now() - 90 * 86400000).toISOString())
    .limit(500);

  const { data: runs } = await sb.from('ai_runs')
    .select('agent_id, goal, trigger_type, status, error_code, error_message')
    .eq('office_id', officeId)
    .gte('created_at', new Date(Date.now() - 60 * 86400000).toISOString())
    .limit(500);

  const { data: agents } = await sb.from('ai_agents')
    .select('id, slug, name, autonomy_level').eq('office_id', officeId);
  const autonomy = new Map<string, number>(
    (agents || []).map((a) => [a.id as string, Number(a.autonomy_level) || 2]));
  const agentName = new Map<string, string>(
    (agents || []).map((a) => [a.id as string, String(a.name)]));

  const fresh = (approvals || []) as ApprovalRow[];
  const all = (recentAll || []) as ApprovalRow[];

  let signals: Signal[] = [
    ...correctionSignals(fresh),
    ...repetitionSignals(all, threshold, autonomy, ALWAYS_APPROVE),
    ...recurringTaskSignals(runs || [], threshold),
    ...failureSignals(runs || [], 3),
  ];
  signals = groupSignals(signals);

  // ---- 2. סינון כפילויות מול תובנות קיימות ----
  //
  // כולל 'dismissed': אם בעל המשרד כבר דחה תובנה, אין טעם להציע אותה שוב
  // בכל סבב — זו הטרדה, לא למידה.
  const { data: existing } = await sb.from('ai_learning_insights')
    .select('dedupe_key, status').eq('office_id', officeId)
    .in('status', ['proposed', 'accepted', 'dismissed']);
  const taken = new Set((existing || []).map((e) => e.dedupe_key).filter(Boolean));
  signals = signals.filter((s) => !taken.has(s.dedupeKey));

  const markLearned = async () => {
    const ids = fresh.map((a) => a.id);
    if (ids.length) {
      await sb.from('ai_approvals')
        .update({ learned_at: new Date().toISOString() }).in('id', ids);
    }
    await sb.from('ai_settings')
      .update({ learning_last_run_at: new Date().toISOString() })
      .eq('office_id', officeId);
  };

  if (!signals.length) {
    await markLearned();
    return { office: officeId, signals: 0, insights: 0 };
  }

  // ---- 3. זיקוק ----
  //
  // חזרתיות ומשימות חוזרות אינן דורשות מודל: הן עובדה מדידה, והניסוח שלהן
  // קבוע. רק תיקונים ושגיאות עוברים זיקוק — שם צריך שיפוט לשוני.
  const structural = signals.filter((s) => s.kind === 'repetition' || s.kind === 'recurring_task');
  const needDistill = signals.filter((s) => s.kind === 'correction' || s.kind === 'failure_pattern');

  const rows: Record<string, unknown>[] = [];

  for (const s of structural) {
    rows.push(buildStructuralInsight(officeId, s, autonomy, agentName));
  }

  if (needDistill.length) {
    try {
      const provider = getProvider(settings.ai_provider_mode);
      const observations = needDistill.map((s, i) =>
        `### תצפית ${i}\nסוג: ${s.kind}\nפעולה: ${s.actionType}\n` +
        `מספר מופעים: ${s.occurrences}\n${s.summary}`).join('\n\n');

      const { data } = await provider.generateStructured<{ lessons: Array<Record<string, any>> }>({
        model: 'claude-sonnet-4-6',
        system: DISTILL_SYSTEM,
        messages: [{ role: 'user', content: observations }],
        maxTokens: 3000,
      }, DISTILL_SCHEMA);

      for (const l of data.lessons || []) {
        // המודל רשאי לדחות תצפית. דחייה שלו = לא נוצרת תובנה, וזה תקין:
        // עדיף לפספס לקח מאשר להטמיע כלל שגוי ב-prompt של סוכן מנסח.
        if (l.verdict !== 'accepted' || !l.lesson) continue;
        const s = needDistill[Number(l.index)];
        if (!s) continue;
        rows.push({
          office_id: officeId, agent_id: s.agentId, kind: s.kind,
          title: String(l.title).slice(0, 200),
          lesson: String(l.lesson).slice(0, 2000),
          evidence: s.evidence, occurrences: s.occurrences,
          confidence: confidenceFor(s), dedupe_key: s.dedupeKey,
        });
      }
    } catch (e) {
      // כישלון זיקוק לא מפיל את הסבב — התובנות המבניות עדיין נשמרות.
      console.error('[ai-learn] distill failed', e);
    }
  }

  if (rows.length) {
    // ignoreDuplicates: הסינון מול `taken` נעשה לפני הזיקוק, וסבב מקביל
    // (cron + הרצה ידנית) יכול להספיק לכתוב באמצע. ההתנגשות היא מצב תקין
    // ולא שגיאה — הרי שתי הפעמים מדובר באותה תובנה בדיוק.
    //
    // דורש אינדקס ייחודי **מלא** על (office_id, dedupe_key) — ראה ההערה
    // באינדקס עצמו במיגרציה.
    const { error } = await sb.from('ai_learning_insights')
      .upsert(rows, { onConflict: 'office_id,dedupe_key', ignoreDuplicates: true });
    if (error) console.error('[ai-learn] insert failed', error.message);
  }

  await markLearned();
  await audit(sb, {
    officeId, actorType: 'system', action: 'learning_cycle',
    after: { signals: signals.length, insights: rows.length },
  });

  return { office: officeId, signals: signals.length, insights: rows.length };
}

/**
 * תובנה מבנית — חזרתיות או משימה חוזרת. הניסוח קבוע ולא עובר מודל, כי
 * העובדה עצמה היא הלקח.
 */
function buildStructuralInsight(
  officeId: string, s: Signal,
  autonomy: Map<string, number>, agentName: Map<string, string>,
): Record<string, unknown> {
  const name = s.agentId ? agentName.get(s.agentId) || 'הסוכן' : 'הסוכן';

  if (s.kind === 'repetition') {
    const cur = s.agentId ? autonomy.get(s.agentId) ?? 2 : 2;
    return {
      office_id: officeId, agent_id: s.agentId, kind: 'repetition',
      title: `${name}: הפעולה "${s.actionType}" עוברת נקייה ${s.occurrences} פעמים ברצף`,
      lesson:
        `אישרת ${s.occurrences} פעמים ברציפות פעולות מסוג "${s.actionType}" של ${name}, ` +
        `בלי עריכה, בלי דחייה ובלי החזרה. ניתן להעלות את רמת העצמאות של הסוכן ` +
        `מ-${cur} ל-${cur + 1} עבור פעולות ברמת סיכון זו, כדי שתתפנה לבדוק ` +
        `דווקא את המקומות שבהם אתה כן מתקן.\n\n` +
        `שים לב: פעולות משפטיות, כספיות ותקשורת חיצונית ימשיכו לדרוש אישור ` +
        `בכל מקרה — הרשימה הקשיחה אינה מושפעת מרמת העצמאות.`,
      evidence: s.evidence, occurrences: s.occurrences,
      confidence: confidenceFor(s), dedupe_key: s.dedupeKey,
      suggested_action: {
        type: 'raise_autonomy', agent_id: s.agentId,
        from: cur, to: Math.min(4, cur + 1), action_type: s.actionType,
      },
    };
  }

  // recurring_task
  return {
    office_id: officeId, agent_id: s.agentId, kind: 'recurring_task',
    title: `משימה חוזרת: הופעלה ידנית ${s.occurrences} פעמים`,
    lesson:
      `הפעלת את אותה משימה ידנית ${s.occurrences} פעמים בחודשיים האחרונים. ` +
      `אפשר להפוך אותה לאוטומציה כדי שתרוץ מעצמה — התוצאה עדיין תגיע ` +
      `למסך האישורים כרגיל.\n\nדוגמה למשימה: "${String((s.evidence as any).sample || '').slice(0, 200)}"`,
    evidence: s.evidence, occurrences: s.occurrences,
    confidence: confidenceFor(s), dedupe_key: s.dedupeKey,
    suggested_action: { type: 'create_automation', agent_id: s.agentId },
  };
}
