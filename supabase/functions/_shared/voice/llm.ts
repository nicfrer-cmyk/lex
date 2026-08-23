// שכבת ה-LLM של הסוכן הקולי — Provider/Adapter.
//
// ## הפרדה שחשוב להבין
// ה-orchestrator לא יודע איזה מודל מדבר. הוא מקבל VoiceLlm ומבקש "תור".
// שני מימושים כאן:
//
//   AnthropicVoiceLlm — עוטף את AIProvider הקיים (provider.ts), כולל
//                       tool calling ותמחור. זה המצב החי.
//   MockVoiceLlm      — מתכנן דטרמיניסטי, בלי רשת ובלי עלות.
//
// ## למה ה-Mock אינו "לוגיקה עסקית מקבילה"
// המפרט אוסר במפורש לבנות סימולטור עם לוגיקה נפרדת, ובצדק. וזה בדיוק
// מה שלא קורה כאן: ה-Mock מחליף **רק את המודל**. אותו orchestrator, אותו
// Tool Gateway, אותה בדיקת הרשאות, אותה כתיבה ל-CRM, אותן טבלאות. הוא
// תופס בדיוק את המקום שמודל תופס — מקבל היסטוריה, מחזיר טקסט או קריאת
// כלי — ולכן שיחת סימולציה עוברת את אותו נתיב קוד בדיוק כמו שיחה אמיתית.
// כשמוגדר ANTHROPIC_API_KEY והמשרד במצב live, המודל האמיתי נכנס במקומו
// בלי שינוי שורה אחת ב-orchestrator.
//
// טהור מ-Deno: המתכנן הוא מה שקובע אילו פעולות יבוצעו על תיקים במצב
// בדיקה, והוא חייב להיבדק ב-`node --test`.

// `type` מפורש על Urgency — טיפוס בלבד. ראה ההערה ב-tools.ts.
import { guessCategory, type Urgency } from './urgency.ts';

// ---------- פורמט הודעות, ניטרלי לספק ----------

export type VoiceMsg =
  | { role: 'caller'; text: string }
  | { role: 'agent'; text: string }
  | { role: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { role: 'tool_result'; id: string; name: string; ok: boolean; message: string; data?: Record<string, unknown> };

export type VoiceToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type VoiceTurnRequest = {
  systemPrompt: string;
  history: VoiceMsg[];
  tools: VoiceToolSpec[];
  model: string;
  temperature: number;
  callerPhone: string | null;
};

export type VoiceClassification = {
  category?: string;
  subcategory?: string;
  urgency?: Urgency;
  sentiment?: 'positive' | 'neutral' | 'negative' | 'distressed';
  deadlineISO?: string | null;
};

export type VoiceTurnResponse = {
  /** מה שהסוכן אומר. ריק כשהתור כולו קריאות כלי. */
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  /** true כשהסוכן סיים את השיחה מצידו. */
  done: boolean;
  classification?: VoiceClassification;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
};

export interface VoiceLlm {
  readonly name: string;
  readonly isMock: boolean;
  turn(req: VoiceTurnRequest): Promise<VoiceTurnResponse>;
}

// ============================================================
// עזרי קריאה בהיסטוריה — משותפים לשני המימושים
// ============================================================

export function callerText(history: VoiceMsg[]): string {
  return history.filter((m) => m.role === 'caller').map((m) => (m as { text: string }).text).join(' ');
}

export function lastCallerText(history: VoiceMsg[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'caller') return (history[i] as { text: string }).text;
  }
  return '';
}

export function toolResults(history: VoiceMsg[]): Map<string, Extract<VoiceMsg, { role: 'tool_result' }>> {
  const out = new Map<string, Extract<VoiceMsg, { role: 'tool_result' }>>();
  for (const m of history) if (m.role === 'tool_result') out.set(m.name, m);
  return out;
}

// ============================================================
// זיהוי כוונות — משמש את ה-Mock, ואת סיווג ברירת המחדל בשני המצבים
// ============================================================

const WANTS_APPOINTMENT = /(פגיש|להיפגש|להפגש|לקבוע\s+(תור|מועד|זמן)|תור\b|מתי\s+אפשר\s+לבוא|לבוא\s+למשרד)/;
// ⚠ הצורה הנפוצה ביותר בטלפון היא "שעורך הדין יחזור אליי" — כלומר הפועל
// מוטה, ולעיתים עם תחילית. הביטוי אינו מעוגן, ולכן "שיחזור" מכיל "יחזור"
// ונתפס גם הוא. תבנית שדרשה תחילית ש' פספסה את הניסוח הנפוץ ביותר, וכל
// בקשת חזרה הייתה הופכת למשימה כללית במקום למשימת "חזרה דחופה ללקוח".
const WANTS_CALLBACK = /(?:יחזור|יחזרו|תחזור|תחזרו|לחזור|יתקשר|יתקשרו|שיחזיר)\s+אל[יו]|לדבר\s+עם\s+(?:עורך|עו"?ד|העורך|נציג|מישהו)|נציג\s+אנושי|תעביר[יי]?\s+אות[יי]/;
const CONFIRMS = /^\s*(כן|בטח|מעולה|מצוין|בסדר|אוקיי?|אישור|מאשר|מתאים|יופי|טוב|נשמע\s+טוב|סבבה)/;
const DECLINES = /(לא\s+מתאים|לא\s+נוח|אולי\s+מועד\s+אחר|משהו\s+אחר|לא\s+יכול)/;
const ENDS_CALL = /(תודה\s+רבה|להתראות|יום\s+טוב|זהו|סיימנו|ביי)/;

/** "קוראים לי X" / "שמי X" / "אני X". */
export function extractName(text: string): string | null {
  const t = String(text || '');
  const patterns = [
    /קוראים\s+לי\s+([֐-׿][֐-׿'"-]*(?:\s+[֐-׿][֐-׿'"-]*)?)/,
    /שמי\s+([֐-׿][֐-׿'"-]*(?:\s+[֐-׿][֐-׿'"-]*)?)/,
    /(?:זה|מדבר|מדברת)\s+([֐-׿][֐-׿'"-]*(?:\s+[֐-׿][֐-׿'"-]*)?)/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) {
      const name = m[1].trim();
      // ⚠ "אני רוצה", "אני צריך" — התבנית תופסת פועל ולא שם. רשימת
      // עצירה קצרה עדיפה על ליד בשם "רוצה" שמישהו יצטרך לנקות ידנית.
      if (/^(רוצה|צריך|צריכה|מבקש|מבקשת|חושב|חושבת|לא|כן|פה|כאן|עם|של)/.test(name)) continue;
      return name;
    }
  }
  return null;
}

/** שעה שנאמרה בשיחה — "בעשר וחצי", "ב-10:30", "בשעה 14:00". */
export function extractTime(text: string): string | null {
  const m = String(text || '').match(/(\d{1,2})[:.](\d{2})/);
  if (m) {
    const h = Number(m[1]), min = Number(m[2]);
    if (h <= 23 && min <= 59) return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  return null;
}

export function detectIntents(text: string) {
  return {
    appointment: WANTS_APPOINTMENT.test(text),
    callback: WANTS_CALLBACK.test(text),
    confirms: CONFIRMS.test(text),
    declines: DECLINES.test(text),
    ends: ENDS_CALL.test(text),
  };
}

// ============================================================
// MockVoiceLlm — מתכנן דטרמיניסטי
// ============================================================

let mockIdSeq = 0;
function mockId(): string { return `mock_tool_${++mockIdSeq}`; }
/** לבדיקות: מאפס את מונה המזהים כדי שהפלט יהיה יציב בין הרצות. */
export function resetMockIds(): void { mockIdSeq = 0; }

export class MockVoiceLlm implements VoiceLlm {
  readonly name = 'mock_voice_llm';
  readonly isMock = true;

  // שדה מפורש ולא parameter property (`constructor(private opts: ...)`):
  // Deno תומך בזה, אבל type-stripping של Node לא — וזה היה מונע מ-
  // test/call-center.test.js לייבא את הקובץ ולבדוק את המתכנן כלל.
  // אותה מלכודת בדיוק כבר מתועדת ב-schema.ts (ValidationError).
  opts: { urgency?: Urgency; todayISO?: string };
  constructor(opts: { urgency?: Urgency; todayISO?: string } = {}) { this.opts = opts; }

  turn(req: VoiceTurnRequest): Promise<VoiceTurnResponse> {
    return Promise.resolve(this.plan(req));
  }

  private plan(req: VoiceTurnRequest): VoiceTurnResponse {
    const allowed = new Set(req.tools.map((t) => t.name));
    const results = toolResults(req.history);
    const full = callerText(req.history);
    const last = lastCallerText(req.history);
    const intents = detectIntents(full);
    const lastIntents = detectIntents(last);

    const category = guessCategory(full);
    const classification: VoiceClassification = {
      category,
      urgency: this.opts.urgency,
      sentiment: /(מפחד|נלחץ|בהלה|לא\s+יודע\s+מה\s+לעשות|נורא|אסון)/.test(full)
        ? 'distressed' : 'neutral',
    };

    const say = (text: string, done = false): VoiceTurnResponse =>
      ({ text, toolCalls: [], done, classification, costUsd: 0 });
    const call = (name: string, input: Record<string, unknown>): VoiceTurnResponse =>
      ({ text: '', toolCalls: [{ id: mockId(), name, input }], done: false, classification, costUsd: 0 });

    // ---- 1. מי מתקשר ----
    if (allowed.has('lookup_client') && !results.has('lookup_client')) {
      return call('lookup_client', { phone: req.callerPhone || '' });
    }
    const clientRes = results.get('lookup_client');
    const clientFound = Boolean(clientRes?.data?.found);
    const isOpposing = Boolean(clientRes?.data?.is_opposing_party);
    const clientId = clientRes?.data?.client_id as string | undefined;
    const clientName = clientRes?.data?.name as string | undefined;

    // הצד שכנגד: לא ליד, לא פרטים. משימה לעורך הדין וסיום מנומס.
    if (isOpposing) {
      if (allowed.has('create_task') && !results.has('create_task')) {
        return call('create_task', {
          title: `פנייה טלפונית מהצד שכנגד — ${req.callerPhone || ''}`,
          description: `תוכן הפנייה: ${full}`,
          priority: 'urgent',
        });
      }
      return say('רשמתי את הפנייה והיא תועבר לעורך הדין. אינני רשאית למסור פרטים בטלפון. תודה.', true);
    }

    if (!clientFound && allowed.has('lookup_lead') && !results.has('lookup_lead')) {
      return call('lookup_lead', { phone: req.callerPhone || '' });
    }
    const leadRes = results.get('lookup_lead');
    const leadCreateRes = results.get('create_lead');
    const leadId = (leadCreateRes?.data?.lead_id || leadRes?.data?.lead_id) as string | undefined;
    const leadKnown = Boolean(leadRes?.data?.found) || Boolean(leadCreateRes?.ok);

    const name = extractName(full);

    // ---- 2. דחיפות ובקשת חזרה — לפני כל השאר ----
    //
    // ⚠ הסדר כאן אינו שרירותי. פנייה דחופה נרשמת **לפני** שהסוכנת שואלת
    // לשם: מספר הטלפון כבר בידינו, וזה כל מה שדרוש כדי לחזור. אם היינו
    // שואלים קודם ובן אדם מתוח היה מנתק באמצע, הפנייה הדחופה הייתה
    // נעלמת בלי זכר. זו בדיוק ההתנהגות של מזכירה טובה: קודם לוודא
    // שחוזרים אליך, אחר כך למלא פרטים.
    const urgent = classification.urgency === 'high' || classification.urgency === 'critical';
    if ((urgent || intents.callback) && !results.has('create_task')
        && !results.has('request_human_callback')) {
      if (intents.callback && allowed.has('request_human_callback')) {
        return call('request_human_callback', {
          reason: full.slice(0, 400),
          name: clientName || name || '',
          phone: req.callerPhone || '',
          priority: urgent ? 'urgent' : 'normal',
        });
      }
      if (allowed.has('create_task')) {
        return call('create_task', {
          title: `${category} — פנייה טלפונית${clientName || name ? ' מ' + (clientName || name) : ''}`,
          description: full.slice(0, 1500),
          priority: urgent ? 'urgent' : 'normal',
          client_id: clientId || '',
          lead_id: leadId || '',
        });
      }
    }

    // ---- 3. פנייה חדשה ----
    if (!clientFound && !leadKnown && allowed.has('create_lead')) {
      if (!name) {
        // שואלים פעם אחת בלבד. חזרה על אותה שאלה היא מה שגורם לאנשים
        // לנתק שיחה עם מענה אוטומטי.
        const alreadyAsked = req.history.some(
          (m) => m.role === 'agent' && /איך\s+קוראים\s+לך/.test((m as { text: string }).text));
        if (!alreadyAsked) {
          return say(results.has('request_human_callback') || results.has('create_task')
            ? 'רשמתי את הפנייה ועורך הדין יחזור אליך. איך קוראים לך?'
            : 'בשמחה אעזור. איך קוראים לך?');
        }
      }
      return call('create_lead', {
        name: name || `פנייה מ-${req.callerPhone || 'מספר לא ידוע'}`,
        phone: req.callerPhone || '',
        source: 'voice_ai',
        category,
        summary: full.slice(0, 1500),
      });
    }

    // ---- 4. פגישה ----
    if (intents.appointment && allowed.has('check_calendar') && !results.has('check_calendar')) {
      return call('check_calendar', { duration_minutes: 60, days: 7, max_slots: 3 });
    }
    const calRes = results.get('check_calendar');
    const slots = (calRes?.data?.slots as Array<{ date: string; time: string }> | undefined) || [];
    const apptRes = results.get('create_appointment');

    if (intents.appointment && slots.length && !apptRes) {
      const spokenTime = extractTime(last);
      const chosen = spokenTime
        ? slots.find((s) => s.time === spokenTime) || null
        : (lastIntents.confirms ? slots[0] : null);

      if (chosen && allowed.has('create_appointment')) {
        return call('create_appointment', {
          date: chosen.date, time: chosen.time, duration_minutes: 60,
          title: `פגישה — ${clientName || name || req.callerPhone || 'פנייה טלפונית'}`,
          client_id: clientId || '', lead_id: leadId || '',
          notes: full.slice(0, 1000),
        });
      }
      if (lastIntents.declines) {
        return say('אין בעיה. אעביר לעורך הדין שתיצרו קשר לתיאום מועד שנוח לך.');
      }
      const offer = slots.slice(0, 2)
        .map((s) => `${formatHeDate(s.date)} בשעה ${s.time}`).join(', או ');
      return say(`יש מועדים פנויים ב${offer}. איזה מהם מתאים לך?`);
    }

    // ---- 5. תיעוד ----
    if (allowed.has('create_note') && !results.has('create_note') &&
        (results.has('create_task') || results.has('create_appointment') ||
         results.has('request_human_callback') || results.has('create_lead'))) {
      return call('create_note', {
        text: buildMockSummary(full, category, {
          taskCreated: results.get('create_task')?.ok || results.get('request_human_callback')?.ok,
          appointment: apptRes?.data as { date?: string; time?: string } | undefined,
        }),
        client_id: clientId || '', lead_id: leadId || '',
      });
    }

    // ---- 6. סגירה ----
    const parts: string[] = [];
    if (clientFound && clientName) parts.push(`${clientName}, רשמתי את הפנייה`);
    else parts.push('רשמתי את הפנייה');
    if (apptRes?.ok && apptRes.data) {
      const d = apptRes.data as { date?: string; time?: string };
      parts.push(`נקבעה פגישה ל-${formatHeDate(String(d.date || ''))} בשעה ${d.time}`);
    }
    if (results.get('create_task')?.ok || results.get('request_human_callback')?.ok) {
      parts.push('ופתחתי משימה לעורך הדין שיחזור אליך');
    }
    return say(parts.join(', ') + '. תודה שפנית אלינו, יום טוב.', true);
  }
}

function formatHeDate(iso: string): string {
  const m = String(iso).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[3])}.${Number(m[2])}` : iso;
}

function buildMockSummary(
  full: string, category: string,
  extras: { taskCreated?: boolean; appointment?: { date?: string; time?: string } },
): string {
  const bits = [`פנייה טלפונית בנושא ${category}.`, `תוכן: ${full.slice(0, 800)}`];
  if (extras.appointment?.date) {
    bits.push(`נקבעה פגישה ל-${formatHeDate(String(extras.appointment.date))} בשעה ${extras.appointment.time}.`);
  }
  if (extras.taskCreated) bits.push('נפתחה משימה לעורך הדין.');
  return bits.join(' ');
}

// ============================================================
// AnthropicVoiceLlm — המצב החי
// ============================================================

/**
 * עוטף את AIProvider הקיים. אין כאן מפתח API ואין קריאת רשת ישירה —
 * הכול עובר דרך provider.ts, כדי שתמחור, cache_control וטיפול במודלים
 * שלא מקבלים temperature יישארו במקום אחד.
 */
export class AnthropicVoiceLlm implements VoiceLlm {
  readonly name = 'anthropic';
  readonly isMock = false;

  // deno-lint-ignore no-explicit-any
  provider: any;
  // deno-lint-ignore no-explicit-any
  constructor(provider: any) { this.provider = provider; }

  async turn(req: VoiceTurnRequest): Promise<VoiceTurnResponse> {
    const messages = toAnthropicMessages(req.history);
    const resp = await this.provider.generate({
      model: req.model,
      system: req.systemPrompt + '\n\n' + VOICE_OUTPUT_RULES,
      messages,
      tools: req.tools,
      maxTokens: 900,
      temperature: req.temperature,
    });

    const parsed = extractClassification(resp.text);
    return {
      text: parsed.text,
      toolCalls: resp.toolCalls || [],
      done: resp.stopReason !== 'tool_use' && parsed.done,
      classification: parsed.classification,
      costUsd: resp.cost,
      inputTokens: resp.inputTokens,
      outputTokens: resp.outputTokens,
    };
  }
}

/**
 * ההנחיה שמייצרת סיווג בלי להשחית את מה שנאמר בטלפון.
 *
 * הסיווג עטוף בתגית ולא ב-JSON: כשהמודל מחזיר JSON שלם, כל טעות פורמט
 * מוחקת גם את מה שהוא רצה להגיד למתקשר. כאן, אם התגית חסרה או שבורה —
 * הטקסט עדיין נאמר, ורק הסיווג נופל לברירת מחדל.
 */
export const VOICE_OUTPUT_RULES = `
## פורמט התשובה
כתבי את מה שאת אומרת למתקשר כטקסט רגיל, בלי סימון.
בסוף התשובה בלבד, הוסיפי שורה אחת בפורמט הבא (היא לא תיאמר בטלפון):
<meta category="תחום" urgency="low|normal|high|critical" sentiment="positive|neutral|negative|distressed" deadline="YYYY-MM-DD או ריק" end="true|false" />
end="true" רק כשהשיחה הסתיימה מבחינתך.
`.trim();

export function extractClassification(raw: string): {
  text: string; classification: VoiceClassification; done: boolean;
} {
  const text = String(raw || '');
  const m = text.match(/<meta\b([^>]*)\/?>/i);
  if (!m) return { text: text.trim(), classification: {}, done: false };

  const attrs = m[1];
  const get = (k: string) => {
    const a = attrs.match(new RegExp(`${k}\\s*=\\s*"([^"]*)"`, 'i'));
    return a ? a[1].trim() : '';
  };
  const urgency = get('urgency') as Urgency;
  const sentiment = get('sentiment');
  return {
    text: text.replace(m[0], '').trim(),
    classification: {
      category: get('category') || undefined,
      urgency: ['low', 'normal', 'high', 'critical'].includes(urgency) ? urgency : undefined,
      sentiment: ['positive', 'neutral', 'negative', 'distressed'].includes(sentiment)
        ? sentiment as VoiceClassification['sentiment'] : undefined,
      deadlineISO: /^\d{4}-\d{2}-\d{2}$/.test(get('deadline')) ? get('deadline') : null,
    },
    done: get('end').toLowerCase() === 'true',
  };
}

/** ההיסטוריה הניטרלית → פורמט ההודעות של Anthropic. */
export function toAnthropicMessages(history: VoiceMsg[]): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];

  for (const m of history) {
    if (m.role === 'caller') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.text }] });
    } else if (m.role === 'agent') {
      if (m.text) out.push({ role: 'assistant', content: [{ type: 'text', text: m.text }] });
    } else if (m.role === 'tool_call') {
      // בלוקים של tool_use חייבים להתמזג להודעת assistant אחת כשהם עוקבים
      // זה לזה — ה-API דוחה הודעות assistant רצופות.
      const prev = out[out.length - 1];
      const block = { type: 'tool_use', id: m.id, name: m.name, input: m.input };
      if (prev && prev.role === 'assistant' && Array.isArray(prev.content)) {
        (prev.content as unknown[]).push(block);
      } else {
        out.push({ role: 'assistant', content: [block] });
      }
    } else if (m.role === 'tool_result') {
      const prev = out[out.length - 1];
      const block = {
        type: 'tool_result', tool_use_id: m.id,
        content: m.message, is_error: !m.ok,
      };
      if (prev && prev.role === 'user' && Array.isArray(prev.content) &&
          (prev.content as Array<{ type?: string }>)[0]?.type === 'tool_result') {
        (prev.content as unknown[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return out;
}
