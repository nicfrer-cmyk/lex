// שכבת טלפוניה (סעיף 12).
//
// הפרומט: "אל תניח ספק טלפוניה מסוים לפני שאתה בודק אם כבר קיים חיבור."
// נבדק — **אין ספק טלפוניה בפרויקט**. אין קוד, אין secret, אין webhook.
//
// לכן כאן יש interface מלא + מימוש mock + תיעוד למה שנדרש מספק, אבל
// **אין מימוש של ספק ספציפי**. בחירת הספק היא החלטה עסקית של בעל המשרד
// (מחיר, מספרים קיימים, הקלטות) — לא החלטה של מפתח. סעיף 12 מורה
// במפורש: אם אין ספק, לבנות interface, מסך הגדרה, מצב mock, ותיעוד,
// ו**לא להציג שהחיבור פעיל**.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { normalizePhone } from '../security.ts';

export type CallStatus = 'ringing' | 'answered' | 'missed' | 'busy' | 'failed' | 'completed';

export type CallRecord = {
  externalId: string;
  direction: 'in' | 'out';
  from: string; to: string;
  status: CallStatus;
  startedAt: string;
  durationSeconds: number;
  hasRecording: boolean;
  recordingUrl?: string;
};

export interface TelephonyProvider {
  readonly name: string;
  readonly isMock: boolean;
  initiateCall(from: string, to: string): Promise<{ ok: boolean; callId?: string; error?: string }>;
  getCallStatus(callId: string): Promise<{ status: CallStatus; durationSeconds?: number }>;
  getRecordingMetadata(callId: string): Promise<{ available: boolean; url?: string; durationSeconds?: number }>;
  sendSms(to: string, body: string): Promise<{ ok: boolean; externalId?: string; error?: string }>;
  supportsClickToCall(): boolean;
  supportsSms(): boolean;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}

/** ממיר payload של webhook לרשומת שיחה. ספק חדש מממש רק את זה. */
export type CallWebhookParser = (payload: Record<string, unknown>) => CallRecord | null;

export class MockTelephonyProvider implements TelephonyProvider {
  readonly name = 'mock_telephony';
  readonly isMock = true;

  initiateCall(from: string, to: string) {
    console.log('[mock-telephony] would call', { from, to });
    return Promise.resolve({
      ok: false,
      error: 'לא הוגדר ספק טלפוניה. יש לבחור ספק ולהגדירו במסך האינטגרציות.',
    });
  }
  getCallStatus() { return Promise.resolve({ status: 'failed' as CallStatus }); }
  getRecordingMetadata() { return Promise.resolve({ available: false }); }
  sendSms(to: string) {
    console.log('[mock-telephony] would SMS', { to });
    return Promise.resolve({ ok: false, error: 'לא הוגדר ספק טלפוניה/SMS.' });
  }
  supportsClickToCall() { return false; }
  supportsSms() { return false; }
  testConnection() {
    return Promise.resolve({ ok: false, error: 'נדרש חיבור ספק טלפוניה' });
  }
}

export async function getTelephonyProvider(
  _sb: SupabaseClient, _officeId: string,
): Promise<TelephonyProvider> {
  // כשייבחר ספק: להוסיף כאן מימוש שמממש TelephonyProvider ולנתב אליו לפי
  // integration_connections.config.vendor. שאר המערכת לא תשתנה — זו כל
  // הנקודה של ה-interface הזה.
  return new MockTelephonyProvider();
}

/**
 * מה נדרש מספק טלפוניה כדי להשתלב. מוצג במסך האינטגרציות, כדי שבעל
 * המשרד יוכל לבדוק מול הספק לפני שהוא חותם.
 */
export const TELEPHONY_REQUIREMENTS = {
  required: [
    'Webhook לשיחה נכנסת (מספר מתקשר, מספר יעד, מזהה שיחה, חותמת זמן)',
    'Webhook לשיחה שלא נענתה',
    'API לבדיקת סטטוס שיחה',
    'אימות webhook (חתימה או secret) — חובה, אחרת כל אחד יכול לזייף שיחות',
  ],
  optional: [
    'API ליזום שיחה (click-to-call)',
    'שליחת SMS',
    'מטא-דאטה של הקלטה (משך, URL חתום)',
  ],
  legalNote:
    'סיכום שיחה ע"י AI ייעשה **רק** כאשר קיימת הקלטה חוקית והרשאה מתאימה. ' +
    'הקלטת שיחה ללא הסכמה, ושימוש בה, כפופים לחוק האזנת סתר ולכללי האתיקה. ' +
    'המערכת לא תסכם שיחה אלא אם החיבור סומן במפורש כמקליט כדין.',
};

/** נרמול לפורמט בינלאומי — משמש בכל נתיבי הטלפוניה. */
export function normalizeCallerNumber(raw: string): string | null {
  return normalizePhone(raw);
}
