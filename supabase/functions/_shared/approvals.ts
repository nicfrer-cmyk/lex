// מנוע האישורים ורמות העצמאות (סעיף 18).
//
// ההחלטה המרכזית כאן: ALWAYS_APPROVE היא רשימה **קשיחה בקוד**, ואף
// הגדרה של סוכן לא יכולה לעקוף אותה. גם approval_policy='never', גם
// autonomy_level=4, גם auto_apply_level=3 — כולם נבדקים *אחרי* הרשימה
// הזו, לא לפניה.
//
// זה מכוון. הפרומט מגדיר בסעיף 18 רשימת "פעולות שתמיד דורשות אישור", וכל
// אחת מהן היא פעולה שאי אפשר לבטל אחריה: מסמך שהוגש לבית משפט, כסף
// שהועבר מחשבון נאמנות, מכתב שנשלח לצד שכנגד. הדרך היחידה להבטיח שהגדרה
// שגויה במסך לא תגרום לזה היא לא לתת להגדרה סמכות על השאלה.

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type ApprovalPolicy = 'always' | 'sensitive' | 'never';

/**
 * פעולות שתמיד דורשות אישור אנושי — לא ניתן לביטול בשום הגדרה.
 * המפתחות הם slugים של כלים או action_type.
 */
export const ALWAYS_APPROVE = new Set<string>([
  'draft_legal_document',      // מסמך משפטי
  'send_letter_opposing',      // מכתב לצד שכנגד
  'change_fee',                // שינוי מחיר
  'commit_on_behalf',          // התחייבות בשם המשרד
  'accept_representation',     // קבלת ייצוג
  'change_legal_deadline',     // שינוי מועד משפטי
  'delete_record',             // מחיקת נתון
  'send_legal_notice',         // הודעה משפטית מהותית
  'send_confidential',         // שליחת חומר חסוי
  'transfer_funds',            // העברת כספים
  'trust_account_action',      // פעולה בחשבון נאמנות
  'file_to_court',             // הגשה לבית משפט / הוצאה לפועל
]);

/** תיאור בעברית — מוצג במסך האישורים בשדה "למה נדרש אישור". */
export const ALWAYS_APPROVE_REASON: Record<string, string> = {
  draft_legal_document: 'מסמך משפטי — דורש בדיקת עורך דין לפני כל שימוש',
  send_letter_opposing: 'מכתב לצד שכנגד — מחייב את המשרד',
  change_fee: 'שינוי מחיר או תנאי שכר טרחה',
  commit_on_behalf: 'התחייבות בשם המשרד',
  accept_representation: 'קבלת ייצוג — יוצרת יחסי עו״ד–לקוח',
  change_legal_deadline: 'שינוי מועד משפטי — טעות עלולה לגרום לאיחור בהליך',
  delete_record: 'מחיקת נתון — פעולה בלתי הפיכה',
  send_legal_notice: 'הודעה משפטית מהותית ללקוח',
  send_confidential: 'שליחת חומר חסוי',
  transfer_funds: 'העברת כספים',
  trust_account_action: 'פעולה בחשבון נאמנות — כפופה לכללי לשכת עורכי הדין',
  file_to_court: 'הגשה לבית משפט או להוצאה לפועל',
};

/** רמת עצמאות → רמת הסיכון המקסימלית שמותר לבצע ללא אישור. */
const AUTONOMY_MAX_RISK: Record<number, RiskLevel> = {
  1: 'none',     // קריאה בלבד
  2: 'low',      // + טיוטות
  3: 'medium',   // + פעולה פנימית מוגבלת
  4: 'high',     // + פעולה חיצונית מוגדרת
};

const RISK_ORDER: RiskLevel[] = ['none', 'low', 'medium', 'high', 'critical'];

function riskExceeds(a: RiskLevel, b: RiskLevel): boolean {
  return RISK_ORDER.indexOf(a) > RISK_ORDER.indexOf(b);
}

/**
 * הגבוה מבין שתי רמות סיכון.
 *
 * משמש כדי שרמת הסיכון שהוגדרה ב-ai_tools תשמש **רצפה** ולא תחליף לרמה
 * שהכלי קבע בזמן ריצה. שני הכיוונים נחוצים:
 *  • הכלי מסלים לפי הקלט (מכתב לצד שכנגד → critical) — הקוד יודע דברים
 *    שהתצורה לא.
 *  • המשרד מחמיר בתצורה (סימון כלי כ-high) — צריך להיות מכובד בלי לשנות קוד.
 * לקיחת המקסימום מכבדת את שניהם; לקיחת אחד מהם הייתה מבטלת את השני.
 */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

export type ApprovalDecision = {
  required: boolean;
  reason: string;
  /** true = חסום מוחלט, ההגדרות לא יכולות לעקוף */
  hardBlock: boolean;
};

export function needsApproval(opts: {
  toolSlug: string;
  riskLevel: RiskLevel;
  agentPolicy: ApprovalPolicy;
  autonomyLevel: number;
  toolRequiresApproval: boolean;
  outboundPaused?: boolean;
  readOnlyMode?: boolean;
}): ApprovalDecision {
  // 1. הרשימה הקשיחה — קודם לכל השאר, בכוונה.
  if (ALWAYS_APPROVE.has(opts.toolSlug)) {
    return {
      required: true, hardBlock: true,
      reason: ALWAYS_APPROVE_REASON[opts.toolSlug] || 'פעולה רגישה — אישור חובה',
    };
  }
  // critical הוא תמיד חובה גם אם הכלי לא ברשימה השמית.
  if (opts.riskLevel === 'critical') {
    return { required: true, hardBlock: true, reason: 'פעולה ברמת סיכון קריטית' };
  }

  // 2. מפסקי חירום.
  if (opts.readOnlyMode && opts.riskLevel !== 'none') {
    return { required: true, hardBlock: true, reason: 'המערכת במצב קריאה בלבד' };
  }
  if (opts.outboundPaused && riskExceeds(opts.riskLevel, 'medium')) {
    return { required: true, hardBlock: true, reason: 'שליחת הודעות יוצאות מושהית' };
  }

  // 3. סימון מפורש ברמת הקישור סוכן↔כלי.
  if (opts.toolRequiresApproval) {
    return { required: true, hardBlock: false, reason: 'הכלי הוגדר כדורש אישור עבור סוכן זה' };
  }

  // 4. מדיניות הסוכן.
  if (opts.agentPolicy === 'always' && opts.riskLevel !== 'none') {
    return { required: true, hardBlock: false, reason: 'מדיניות הסוכן: אישור לכל פעולה' };
  }

  // 5. רמת העצמאות.
  const maxRisk = AUTONOMY_MAX_RISK[opts.autonomyLevel] ?? 'low';
  if (riskExceeds(opts.riskLevel, maxRisk)) {
    return {
      required: true, hardBlock: false,
      reason: `רמת הסיכון (${riskHe(opts.riskLevel)}) גבוהה מרמת העצמאות של הסוכן (${opts.autonomyLevel})`,
    };
  }

  if (opts.agentPolicy === 'never') return { required: false, hardBlock: false, reason: '' };
  if (opts.agentPolicy === 'sensitive' && riskExceeds(opts.riskLevel, 'low')) {
    return { required: true, hardBlock: false, reason: 'מדיניות הסוכן: אישור לפעולות רגישות' };
  }
  return { required: false, hardBlock: false, reason: '' };
}

export function riskHe(r: RiskLevel): string {
  return { none: 'ללא', low: 'נמוך', medium: 'בינוני', high: 'גבוה', critical: 'קריטי' }[r] || r;
}

/**
 * החלטה איזה "סוג פעולה" נשמר ב-ai_approvals.action_type. נשמר slug של
 * הכלי — כדי שההחלה בצד הלקוח תדע בדיוק מה לבצע, בלי לנחש מטקסט.
 */
export function approvalLabel(toolSlug: string, input: Record<string, unknown>): string {
  // כל slug שאפשר להציע חייב להופיע כאן: הערך נשמר ב-ai_approvals.action_label
  // וזה מה שהמשתמש רואה במסך האישורים. slug חסר היה מוצג לו כמחרוזת אנגלית
  // גולמית ("send_letter_opposing") במערכת שכולה עברית.
  // test/ai-center-unit.test.js אוכף שהמפה הזו מכסה את כל ההצעות ש-tools.ts יוצר.
  const labels: Record<string, string> = {
    create_task: 'יצירת משימה',
    create_event: 'יצירת אירוע ביומן',
    create_deadline: 'קביעת מועד',
    draft_message: 'טיוטת הודעה ללקוח',
    draft_email: 'טיוטת מייל',
    draft_legal_document: 'טיוטת מסמך משפטי',
    send_message: 'שליחת הודעה',
    send_email: 'שליחת מייל',
    send_whatsapp: 'שליחת הודעת WhatsApp',
    send_legal_notice: 'הודעה משפטית מהותית ללקוח',
    send_letter_opposing: 'מכתב לצד שכנגד',
    send_confidential: 'שליחת חומר חסוי',
    create_lead: 'יצירת ליד',
    update_lead_score: 'עדכון ציון ליד',
    create_client: 'יצירת לקוח',
    create_matter: 'פתיחת תיק',
    add_diary_entry: 'רישום ביומן התיק',
    create_payment_reminder: 'תזכורת תשלום',
    tag_document: 'תיוג מסמך',
    request_approval: 'בקשת אישור לפעולה',
    change_fee: 'שינוי שכר טרחה',
    commit_on_behalf: 'התחייבות בשם המשרד',
    accept_representation: 'קבלת ייצוג',
    change_legal_deadline: 'שינוי מועד משפטי',
    delete_record: 'מחיקת נתון',
    transfer_funds: 'העברת כספים',
    trust_account_action: 'פעולה בחשבון נאמנות',
    file_to_court: 'הגשה לבית משפט או להוצאה לפועל',
  };
  const base = labels[toolSlug] || toolSlug;
  const subject = (input.title || input.text || input.subject || input.name) as string | undefined;
  return subject ? `${base}: ${String(subject).slice(0, 60)}` : base;
}
