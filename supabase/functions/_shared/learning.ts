// זיהוי סיגנלים ללמידה.
//
// כל הפונקציות כאן טהורות — בלי Deno, בלי רשת, בלי מסד נתונים. זה מכוון:
// זו הלוגיקה שקובעת מה הסוכן "לומד", ולכן היא חייבת להיות ניתנת לבדיקה
// אוטומטית. ai-learn/index.ts מביא את הנתונים וכותב את התוצאה; ההחלטות
// עצמן נמצאות כאן.

export type ApprovalRow = {
  id: string;
  agent_id: string | null;
  action_type: string;
  action_label: string | null;
  status: string;
  proposed_payload: Record<string, unknown> | null;
  edited_payload: Record<string, unknown> | null;
  proposed_content: string | null;
  rejection_reason: string | null;
  return_instruction: string | null;
  requested_at: string;
};

export type Signal = {
  kind: 'correction' | 'repetition' | 'recurring_task' | 'failure_pattern';
  agentId: string | null;
  actionType: string;
  /** מה קרה, בשפה שאפשר להגיש למודל כדי שיזקק ממנה לקח. */
  summary: string;
  evidence: Record<string, unknown>;
  occurrences: number;
  dedupeKey: string;
};

/** האם המשתמש באמת שינה משהו, או רק לחץ אישור. */
export function wasEdited(a: ApprovalRow): boolean {
  if (!a.edited_payload) return false;
  return JSON.stringify(a.edited_payload) !== JSON.stringify(a.proposed_payload || {});
}

/**
 * אילו שדות שונו, ומה היה לפני ואחרי.
 *
 * מוגבל ל-4000 תווים לשדה: תוכן של מסמך משפטי שלם מנפח את ה-prompt של
 * הזיקוק ומייקר כל סבב למידה, בלי לשפר את הלקח.
 */
export function diffPayload(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Array<{ field: string; before: string; after: string }> {
  const b = before || {};
  const a = after || {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const out: Array<{ field: string; before: string; after: string }> = [];
  for (const k of keys) {
    const bv = typeof b[k] === 'string' ? b[k] as string : JSON.stringify(b[k] ?? null);
    const av = typeof a[k] === 'string' ? a[k] as string : JSON.stringify(a[k] ?? null);
    if (bv === av) continue;
    out.push({ field: k, before: String(bv).slice(0, 4000), after: String(av).slice(0, 4000) });
  }
  return out;
}

/**
 * סיגנלים מתיקונים אנושיים — עריכה, דחייה, החזרה.
 * זהו הסיגנל החזק ביותר: המשתמש טרח והתערב.
 */
export function correctionSignals(approvals: ApprovalRow[]): Signal[] {
  const signals: Signal[] = [];
  for (const a of approvals) {
    if (a.status === 'rejected' && a.rejection_reason) {
      signals.push({
        kind: 'correction', agentId: a.agent_id, actionType: a.action_type,
        summary: `הצעה מסוג "${a.action_label || a.action_type}" נדחתה. סיבת הדחייה: ${a.rejection_reason}`,
        evidence: { approvalId: a.id, reason: a.rejection_reason, kind: 'rejected' },
        occurrences: 1,
        dedupeKey: `rejected:${a.agent_id}:${a.action_type}`,
      });
      continue;
    }
    if (a.status === 'returned' && a.return_instruction) {
      signals.push({
        kind: 'correction', agentId: a.agent_id, actionType: a.action_type,
        summary: `הצעה מסוג "${a.action_label || a.action_type}" הוחזרה לתיקון עם ההנחיה: ${a.return_instruction}`,
        evidence: { approvalId: a.id, instruction: a.return_instruction, kind: 'returned' },
        occurrences: 1,
        dedupeKey: `returned:${a.agent_id}:${a.action_type}`,
      });
      continue;
    }
    if (wasEdited(a)) {
      const diffs = diffPayload(a.proposed_payload, a.edited_payload);
      if (!diffs.length) continue;
      // `_content` הוא מפתח מוסכם שה-UI מוסיף כשהעריכה הייתה בתוכן החופשי
      // (טיוטה, מכתב) ואין לו שדה מקביל ב-payload. בלי ההשלמה הזו ה"לפני"
      // היה null, והמזקק היה רואה טקסט חדש בלי מה שהוחלף — כלומר בדיוק
      // התיקון החשוב ביותר היה מגיע אליו כרעש.
      for (const d of diffs) {
        if (d.field === '_content') {
          d.field = 'תוכן';
          d.before = String(a.proposed_content || '').slice(0, 4000);
        }
      }
      signals.push({
        kind: 'correction', agentId: a.agent_id, actionType: a.action_type,
        summary: `בהצעה מסוג "${a.action_label || a.action_type}" המשתמש תיקן לפני האישור:\n` +
          diffs.map((d) => `שדה "${d.field}":\nלפני: ${d.before}\nאחרי: ${d.after}`).join('\n---\n'),
        evidence: { approvalId: a.id, diffs, kind: 'edited' },
        occurrences: 1,
        dedupeKey: `edited:${a.agent_id}:${a.action_type}`,
      });
    }
  }
  return signals;
}

/**
 * דפוס "עבודה שחוזרת על עצמה ללא תיקונים".
 *
 * אותה פעולה, אותו סוכן, אושרה נקייה N פעמים ברצף — בלי עריכה, בלי דחייה,
 * בלי החזרה. זו עדות מדידה לכך שהסוכן אמין בתחום הצר הזה, וההצעה היא
 * להעלות לו את רמת העצמאות — לא כדי לחסוך קליקים, אלא כדי שתפנה את תשומת
 * הלב שלך למקומות שבהם אתה כן מתקן.
 *
 * דורש **אפס** תיקונים בחלון: תיקון אחד מבטל את ההצעה. במערכת שמפיקה
 * מסמכים משפטיים, "כמעט תמיד נכון" אינו בסיס להסרת אישור.
 */
export function repetitionSignals(
  approvals: ApprovalRow[],
  threshold: number,
  currentAutonomy: Map<string, number>,
  alwaysApprove: Set<string>,
): Signal[] {
  const groups = new Map<string, ApprovalRow[]>();
  for (const a of approvals) {
    if (!a.agent_id) continue;
    const key = `${a.agent_id}:${a.action_type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }

  const out: Signal[] = [];
  for (const [key, rows] of groups) {
    const [agentId, actionType] = key.split(':');

    // פעולות ברשימה הקשיחה לעולם לא מועמדות. אין "למדנו שאפשר לסמוך"
    // כשמדובר במסמך משפטי או בהעברת כספים — האישור שם אינו נגזרת של אמון.
    if (alwaysApprove.has(actionType)) continue;

    const clean = rows.filter((r) =>
      ['approved', 'applied'].includes(r.status) && !wasEdited(r));
    const touched = rows.filter((r) =>
      wasEdited(r) || r.status === 'rejected' || r.status === 'returned');

    if (touched.length > 0) continue;      // תיקון אחד מספיק כדי לפסול
    if (clean.length < threshold) continue;

    const autonomy = currentAutonomy.get(agentId) ?? 2;
    if (autonomy >= 4) continue;           // כבר בתקרה

    out.push({
      kind: 'repetition', agentId, actionType,
      summary: `הפעולה "${actionType}" של הסוכן הזה אושרה ${clean.length} פעמים ברציפות ` +
        `בלי שנדרש בה שום תיקון, ובלי אף דחייה או החזרה.`,
      evidence: {
        cleanCount: clean.length,
        approvalIds: clean.slice(0, 20).map((r) => r.id),
        currentAutonomy: autonomy,
      },
      occurrences: clean.length,
      dedupeKey: `repetition:${agentId}:${actionType}`,
    });
  }
  return out;
}

/**
 * משימות שמופעלות ידנית שוב ושוב → מועמדות לאוטומציה.
 * זה הצד השני של "עבודה שחוזרת על עצמה": לא הסוכן שחוזר על עצמו, אלא אתה.
 */
export function recurringTaskSignals(
  runs: Array<{ agent_id: string | null; goal: string | null; trigger_type: string }>,
  threshold: number,
): Signal[] {
  const groups = new Map<string, { count: number; agentId: string | null; sample: string }>();
  for (const r of runs) {
    if (r.trigger_type !== 'manual' || !r.goal) continue;
    // נרמול גס: מסיר מספרים ומזהים כדי ש"סכם תיק 123" ו-"סכם תיק 456"
    // ייחשבו לאותה משימה חוזרת.
    const norm = r.goal.toLowerCase()
      .replace(/[0-9]+/g, '#')
      .replace(/[a-z0-9]{10,}/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    if (norm.length < 8) continue;
    const key = `${r.agent_id}:${norm}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { count: 1, agentId: r.agent_id, sample: r.goal });
  }

  const out: Signal[] = [];
  for (const [key, g] of groups) {
    if (g.count < threshold) continue;
    out.push({
      kind: 'recurring_task', agentId: g.agentId, actionType: 'manual_run',
      summary: `הפעלת ידנית את אותה משימה ${g.count} פעמים. דוגמה: "${g.sample.slice(0, 200)}"`,
      evidence: { count: g.count, sample: g.sample, normalized: key.split(':').slice(1).join(':') },
      occurrences: g.count,
      dedupeKey: `recurring:${key}`,
    });
  }
  return out;
}

/** שגיאות חוזרות — הסוכן נכשל שוב ושוב באותו מקום. */
export function failureSignals(
  runs: Array<{ agent_id: string | null; status: string; error_code: string | null; error_message: string | null }>,
  threshold: number,
): Signal[] {
  const groups = new Map<string, { count: number; agentId: string | null; msg: string }>();
  for (const r of runs) {
    if (r.status !== 'failed' || !r.error_code) continue;
    const key = `${r.agent_id}:${r.error_code}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { count: 1, agentId: r.agent_id, msg: r.error_message || r.error_code });
  }
  const out: Signal[] = [];
  for (const [key, g] of groups) {
    if (g.count < threshold) continue;
    const [agentId, code] = key.split(':');
    out.push({
      kind: 'failure_pattern', agentId, actionType: code,
      summary: `הסוכן נכשל ${g.count} פעמים עם אותה שגיאה (${code}): ${g.msg}`,
      evidence: { count: g.count, errorCode: code, message: g.msg },
      occurrences: g.count,
      dedupeKey: `failure:${key}`,
    });
  }
  return out;
}

/** מקבץ סיגנלים זהים, כדי שלא נזקק אותו לקח פעמיים. */
export function groupSignals(signals: Signal[]): Signal[] {
  const byKey = new Map<string, Signal>();
  for (const s of signals) {
    const existing = byKey.get(s.dedupeKey);
    // ...s הוא העתק רדוד — evidence עדיין מצביע על אותו אובייקט. בלי
    // ההעתקה המפורשת, הוספת items הייתה משנה את הראיות של הסיגנל המקורי,
    // וה-evidence שנשמר ב-DB (ההסבר היחיד למה התובנה נוצרה) היה תלוי
    // בסדר הקיבוץ.
    if (!existing) { byKey.set(s.dedupeKey, { ...s, evidence: { ...s.evidence } }); continue; }
    existing.occurrences += s.occurrences;
    existing.summary += '\n\n' + s.summary;
    const ev = existing.evidence as Record<string, unknown>;
    const items = Array.isArray(ev.items) ? ev.items as unknown[] : [];
    ev.items = [...items, s.evidence];
  }
  return [...byKey.values()];
}

/**
 * ביטחון לפי כמות הראיות. תובנה שנשענת על מקרה בודד מוצגת ככזו, ולא
 * מתחזה לדפוס.
 */
export function confidenceFor(s: Signal): number {
  if (s.kind === 'repetition') return Math.min(0.95, 0.5 + s.occurrences * 0.08);
  if (s.kind === 'correction') return Math.min(0.9, 0.35 + s.occurrences * 0.18);
  return Math.min(0.85, 0.4 + s.occurrences * 0.1);
}

/** ה-prompt שמזקק סיגנלים ללקחים. */
export const DISTILL_SYSTEM = `
אתה מנתח את דפוסי העבודה של סוכן AI במשרד עורכי דין, ומזקק מהם לקחים
מעשיים שישפרו את התנהגותו בעתיד.

## הקלט
תקבל רשימת תצפיות: תיקונים שעורך הדין ביצע בהצעות הסוכן, דחיות, החזרות
לתיקון, ודפוסי עבודה חוזרים.

## מה להפיק
לכל תצפית — לקח אחד, קצר, **בניסוח שאפשר להוסיף כמו שהוא להנחיות הסוכן**.

## כללים מחייבים
- כתוב הנחיה חיובית ("נסח בגוף שלישי"), לא תיאור של מה שקרה ("המשתמש שינה
  את הגוף"). ההנחיה נכנסת ל-prompt, לא ליומן.
- לקח אחד = כלל אחד. אל תאחד שני עקרונות בלתי קשורים.
- **הכלל: אם התצפית היא מקרה בודד שאפשר להסבירו כהעדפה נקודתית של תיק
  מסוים — אל תפיק ממנה לקח.** החזר rejected עם הסבר. לקח שגוי שנכנס
  ל-prompt פוגע בכל טיוטה עתידית, ועדיף לפספס לקח מאשר להטמיע כלל שגוי.
- אל תסיק כללים משפטיים מהותיים מתיקוני ניסוח. "הוסף סעיף התיישנות תמיד"
  אינו לקח לגיטימי מתיקון אחד.
- אל תמציא הקשר שלא נמסר לך.
- עברית בלבד.

## פורמט
החזר עבור כל תצפית: accepted (יש לקח) או rejected (אין), כותרת קצרה,
ונוסח הלקח.
`.trim();

export const DISTILL_SCHEMA = {
  type: 'object',
  properties: {
    lessons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'מספר התצפית בקלט' },
          verdict: { type: 'string', enum: ['accepted', 'rejected'] },
          title: { type: 'string', description: 'כותרת קצרה בעברית' },
          lesson: { type: 'string', description: 'נוסח הלקח להוספה להנחיות הסוכן' },
          reason: { type: 'string', description: 'למה נדחה, אם נדחה' },
        },
        required: ['index', 'verdict', 'title'],
      },
    },
  },
  required: ['lessons'],
};
