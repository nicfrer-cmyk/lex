// קודי שגיאה של מרכז השיחות.
//
// ## למה קוד ולא רק הודעה
// שלושה קוראים שונים צריכים דברים שונים מאותה תקלה:
//   • המשתמש — משפט בעברית שאומר מה קרה ומה לעשות.
//   • שרת הקול — האם לנסות שוב, ואם כן מתי.
//   • מי שמאבחן — מה בדיוק נכשל, בלי לנחש.
//
// הודעת מחרוזת אחת לא יכולה לשרת את שלושתם, ולכן כל שגיאה נושאת קוד
// יציב, שתי הודעות, ודגל retryable.
//
// ## ⚠ אין stack traces ב-UI
// `technical_message` נועד ללוגים ולמסך הפעולות שלא סונכרנו — לא
// לחלון שקופץ למזכירה. `toUserPayload()` מחזיר בדיוק את מה שמותר
// להציג.

export type VoiceErrorCode =
  // תשתית
  | 'VOICE_GATEWAY_OFFLINE'
  | 'SIP_NOT_CONFIGURED'
  | 'MEDIA_TRANSPORT_UNAVAILABLE'
  // ספקים
  | 'STT_UNAVAILABLE'
  | 'LLM_UNAVAILABLE'
  | 'TTS_UNAVAILABLE'
  | 'PROVIDER_NOT_PRODUCTION_READY'
  // כלים ו-CRM
  | 'TOOL_TIMEOUT'
  | 'TOOL_NOT_ALLOWED'
  | 'DUPLICATE_TOOL_CALL'
  | 'CRM_CONFLICT'
  | 'CRM_UNAVAILABLE'
  | 'CALLBACK_CREATION_FAILED'
  // מדיניות
  | 'IDENTITY_NOT_VERIFIED'
  | 'LIVE_CALLS_DISABLED'
  | 'NOT_PRODUCTION_READY'
  | 'EMERGENCY_STOP'
  | 'RATE_LIMITED'
  // אימות
  | 'SIGNATURE_INVALID'
  | 'REQUEST_EXPIRED'
  | 'REPLAY_DETECTED'
  | 'UNKNOWN_ERROR';

type Spec = { he: string; retryable: boolean; httpStatus: number };

/**
 * `retryable` הוא החלטה ולא תיאור. הכלל: נסה שוב רק כשהניסיון החוזר
 * יכול להצליח בלי שאיש יעשה דבר. חתימה שגויה או כלי חסום לא ישתנו
 * מעצמם — retry עליהם הוא לולאה שמייצרת רעש ולא מתקנת דבר.
 */
const SPECS: Record<VoiceErrorCode, Spec> = {
  VOICE_GATEWAY_OFFLINE: {
    he: 'שרת הטלפוניה אינו מחובר. שיחות אמיתיות אינן מתקבלות כרגע.',
    retryable: true, httpStatus: 503,
  },
  SIP_NOT_CONFIGURED: {
    he: 'לא הוגדר ספק טלפוניה. יש להשלים את ההגדרה לפני קבלת שיחות.',
    retryable: false, httpStatus: 503,
  },
  MEDIA_TRANSPORT_UNAVAILABLE: {
    he: 'ערוץ האודיו אינו זמין. השיחה לא תוכל להישמע.',
    retryable: true, httpStatus: 503,
  },
  STT_UNAVAILABLE: {
    he: 'מנוע התמלול אינו זמין.',
    retryable: true, httpStatus: 503,
  },
  LLM_UNAVAILABLE: {
    he: 'מנוע השפה אינו זמין.',
    retryable: true, httpStatus: 503,
  },
  TTS_UNAVAILABLE: {
    he: 'מנוע ההקראה אינו זמין. המתקשר לא ישמע את התשובה.',
    retryable: true, httpStatus: 503,
  },
  PROVIDER_NOT_PRODUCTION_READY: {
    he: 'אחד הספקים נמצא במצב הדגמה ואינו מתאים לשיחות אמיתיות.',
    retryable: false, httpStatus: 409,
  },
  TOOL_TIMEOUT: {
    he: 'הפעולה לא הושלמה בזמן. היא תבוצע ברקע ותירשם.',
    retryable: true, httpStatus: 504,
  },
  TOOL_NOT_ALLOWED: {
    he: 'הפעולה אינה מותרת לסוכן זה.',
    retryable: false, httpStatus: 403,
  },
  DUPLICATE_TOOL_CALL: {
    // ⚠ לא שגיאה אמיתית: זו ההגנה שעבדה. מוחזר 200 עם התוצאה המקורית.
    he: 'הפעולה כבר בוצעה בשיחה זו.',
    retryable: false, httpStatus: 200,
  },
  CRM_CONFLICT: {
    he: 'הנתונים שונו במקביל. הפעולה תבוצע שוב על הגרסה העדכנית.',
    retryable: true, httpStatus: 409,
  },
  CRM_UNAVAILABLE: {
    he: 'המערכת אינה זמינה כרגע. הפעולה נשמרה ותבוצע כשהחיבור יחזור.',
    retryable: true, httpStatus: 503,
  },
  CALLBACK_CREATION_FAILED: {
    he: 'לא ניתן היה לרשום את בקשת החזרה.',
    retryable: true, httpStatus: 500,
  },
  IDENTITY_NOT_VERIFIED: {
    he: 'לא ניתן למסור את המידע לפני אימות זהות.',
    retryable: false, httpStatus: 403,
  },
  LIVE_CALLS_DISABLED: {
    he: 'קבלת שיחות אמיתיות אינה מופעלת.',
    retryable: false, httpStatus: 423,
  },
  NOT_PRODUCTION_READY: {
    he: 'המערכת אינה מוכנה לשיחות אמיתיות.',
    retryable: false, httpStatus: 409,
  },
  EMERGENCY_STOP: {
    he: 'המזכירה הדיגיטלית מושבתת (עצירת חירום).',
    retryable: false, httpStatus: 423,
  },
  RATE_LIMITED: {
    he: 'חריגה ממגבלת הקצב.',
    retryable: true, httpStatus: 429,
  },
  SIGNATURE_INVALID: {
    he: 'אימות הבקשה נכשל.',
    retryable: false, httpStatus: 401,
  },
  REQUEST_EXPIRED: {
    he: 'הבקשה פגה או שהשעון אינו מסונכרן.',
    retryable: false, httpStatus: 401,
  },
  REPLAY_DETECTED: {
    he: 'הבקשה כבר עובדה.',
    retryable: false, httpStatus: 409,
  },
  UNKNOWN_ERROR: {
    he: 'שגיאה לא מזוהה.',
    retryable: false, httpStatus: 500,
  },
};

export type VoiceErrorPayload = {
  code: VoiceErrorCode;
  human_message: string;
  technical_message: string;
  retryable: boolean;
  call_id: string | null;
  timestamp: string;
};

export class VoiceError extends Error {
  code: VoiceErrorCode;
  technical: string;
  callId: string | null;
  retryable: boolean;
  httpStatus: number;
  timestamp: string;

  /**
   * `userMessage` דורס את ההודעה הגנרית של הקוד.
   *
   * ⚠ נדרש כי אותו קוד משרת מצבים שונים. CRM_CONFLICT מתאר גם התנגשות
   * כתיבה אופטימית ("הנתונים שונו במקביל") וגם מועד תפוס ביומן — ולמודל
   * שמדבר עם המתקשר צריך להיאמר "המועד תפוס, הצע אחר", לא הסבר על
   * גרסאות. הקוד נשאר יציב ללוגים; הניסוח מתאים למי ששומע אותו.
   */
  constructor(code: VoiceErrorCode, technical?: string, callId?: string | null,
              userMessage?: string) {
    const spec = SPECS[code] || SPECS.UNKNOWN_ERROR;
    super(userMessage || spec.he);
    this.code = code;
    this.technical = technical || spec.he;
    this.callId = callId ?? null;
    this.retryable = spec.retryable;
    this.httpStatus = spec.httpStatus;
    this.timestamp = new Date().toISOString();
  }

  toPayload(): VoiceErrorPayload {
    return {
      code: this.code,
      human_message: this.message,
      technical_message: this.technical,
      retryable: this.retryable,
      call_id: this.callId,
      timestamp: this.timestamp,
    };
  }

  /** מה שמותר להציג במסך — בלי הפרטים הטכניים. */
  toUserPayload(): Pick<VoiceErrorPayload, 'code' | 'human_message' | 'retryable'> {
    return { code: this.code, human_message: this.message, retryable: this.retryable };
  }
}

export function isRetryable(code: VoiceErrorCode): boolean {
  return (SPECS[code] || SPECS.UNKNOWN_ERROR).retryable;
}

export function humanMessage(code: VoiceErrorCode): string {
  return (SPECS[code] || SPECS.UNKNOWN_ERROR).he;
}

/**
 * ממפה שגיאה שנתפסה לקוד. הסדר חשוב: הבדיקות הספציפיות קודם, כי
 * הודעת "conflict" מכילה גם את המילה "unavailable" בחלק מהניסוחים.
 */
export function classifyError(e: unknown): VoiceErrorCode {
  if (e instanceof VoiceError) return e.code;
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (msg.includes('write_conflict') || msg.includes('שונו במקביל')) return 'CRM_CONFLICT';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'TOOL_TIMEOUT';
  if (msg.includes('unauthorized') || msg.includes('signature')) return 'SIGNATURE_INVALID';
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('econn')) {
    return 'CRM_UNAVAILABLE';
  }
  return 'UNKNOWN_ERROR';
}
