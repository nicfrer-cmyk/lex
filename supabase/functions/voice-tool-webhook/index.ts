// Webhook Tool לספק קול חיצוני (ElevenLabs וכל ספק אחר שמדבר HTTP).
//
// ## למה זו פונקציה נפרדת ולא עוד action ב-voice-gateway
// `voice-gateway` מאמת כל בקשה ב-HMAC-SHA256 מעל `${timestamp}.${nonce}.${body}`
// עם nonce חד-פעמי. ספק שמאפשר להגדיר **כותרות סטטיות בלבד** אינו יכול
// לחתום גוף בקשה, ולכן כל בקשה משם הייתה נדחית ב-401.
//
// הפתרון אינו להחליש את voice-gateway. הוא לפתוח דלת אחת צרה, עם סוד
// נפרד, רשימת כלים מצומצמת, ומגבלת קצב — כך שגם דליפה של האסימון הזה
// לא נותנת את מה שה-HMAC מגן עליו.
//
// ## ⚠ מה הדלת הזו **לא** מאפשרת, ולמה
// `lookup_client` ו-`lookup_lead` **חסומים כאן**. הם מחזירים האם מספר
// שייך ללקוח של המשרד ואת שמו — כלומר מי שמחזיק באסימון היה יכול
// לבדוק מספרים אחד-אחד ולגלות מי לקוח של עורך הדין. זו בדיוק הדליפה
// שכל שכבת הזהות נבנתה למנוע, והיא לא שווה את הנוחות. מי שצריך זיהוי
// לקוח — עובר ב-voice-gateway עם HMAC.
//
// מה שכן מותר הן פעולות **כתיבה** שהנזק המרבי מזיוף שלהן הוא רעש
// שנראה מיד (משימה מיותרת, ליד כפול), לא חשיפת מידע.
//
// ## מה נשמר מהמערכת הקיימת
// הכול. אותו Tool Gateway, אותה בדיקת agent_tools, אותה שכבת פקודות,
// אותה אידמפוטנטיות, אותו רישום ב-call_actions ובציר הזמן. הפונקציה
// הזו היא **דלת כניסה**, לא מנגנון שני.
//
// ## URL לכל כלי
//   POST /functions/v1/voice-tool-webhook/<tool_name>
//
// שם הכלי בנתיב ולא בגוף, במכוון: כך לכל כלי ב-ElevenLabs יש URL משלו,
// והמודל אינו יכול לבחור כלי אחר ממה שהוגדר לו.
//
// Deploy: supabase functions deploy voice-tool-webhook --no-verify-jwt

import { admin } from '../_shared/db.ts';
import { json, preflight, errorResponse, AppError } from '../_shared/http.ts';
import { timingSafeEqual } from '../_shared/crypto.ts';
import { audit } from '../_shared/audit.ts';
import { checkRateLimit } from '../_shared/voice/signing.ts';
import { normalizePhoneNumber } from '../_shared/voice/phone.ts';
import { normalizeUrgency } from '../_shared/voice/urgency.ts';
import { startCall } from '../_shared/voice/orchestrator.ts';
import { runStandaloneTool } from '../_shared/voice/gateway.ts';

const WEBHOOK_TOKEN = Deno.env.get('VOICE_WEBHOOK_TOKEN') || '';
const WEBHOOK_OFFICE_ID = Deno.env.get('VOICE_WEBHOOK_OFFICE_ID') || '';

/**
 * הכלים המותרים בדלת הזו.
 *
 * ⚠ רשימת היתר ולא רשימת חסימה. כלי חדש אינו זמין כאן עד שמישהו שוקל
 * במפורש מה קורה כשמזייפים אותו — וזו בדיוק המחשבה שרשימת חסימה
 * מדלגת עליה.
 */
const WEBHOOK_ALLOWED_TOOLS = new Set([
  'request_human_callback',
  'create_lead',
  'create_note',
  'check_calendar',
  'create_appointment',
]);

/** כלים שנחסמים כאן במפורש, עם הסבר — כדי שהדחייה תהיה מובנת. */
const WEBHOOK_BLOCKED_TOOLS: Record<string, string> = {
  lookup_client:
    'זיהוי לקוח אינו זמין בערוץ זה: הוא חושף האם מספר שייך ללקוח של המשרד. ' +
    'נדרש חיבור חתום (voice-gateway).',
  lookup_lead:
    'איתור פנייה אינו זמין בערוץ זה מאותה סיבה. נדרש חיבור חתום.',
  transfer_call:
    'העברת שיחה אינה נתמכת — המזכירה אינה מעבירה שיחות. יש להשתמש ב-request_human_callback.',
  send_message:
    'שליחת הודעות יוצאת אינה זמינה בערוץ זה.',
};

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed', code: 'method_not_allowed' }, 405);
  }

  // ---- הגדרה ----
  if (!WEBHOOK_TOKEN) {
    // 503 ולא 401: זו תקלת הגדרה בצד שלנו, וההבחנה חוסכת שעה של חיפוש
    // אצל מי שמנסה להבין למה הכלי לא עובד.
    return json({
      error: 'VOICE_WEBHOOK_TOKEN לא הוגדר בשרת. הערוץ אינו מקבל בקשות.',
      code: 'webhook_not_configured',
    }, 503);
  }

  const sb = admin();

  // ---- אימות ----
  //
  // ⚠ השוואה בזמן קבוע. השוואת מחרוזות רגילה יוצאת מוקדם בבייט הראשון
  // שנבדל, ומדליפה דרך זמן התגובה כמה תווים ניחשו נכון — מול endpoint
  // פומבי זה תוקף אמיתי.
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token || !timingSafeEqual(token, WEBHOOK_TOKEN)) {
    await audit(sb, {
      officeId: WEBHOOK_OFFICE_ID || '00000000-0000-0000-0000-000000000000',
      actorType: 'webhook', action: 'voice_webhook_bad_token',
      severity: 'security', req,
    });
    return json({ error: 'אימות נכשל', code: 'unauthorized' }, 401);
  }

  // ---- הכלי מהנתיב ----
  const segments = new URL(req.url).pathname.split('/').filter(Boolean);
  const toolName = segments[segments.length - 1] || '';

  if (WEBHOOK_BLOCKED_TOOLS[toolName]) {
    return json({
      error: WEBHOOK_BLOCKED_TOOLS[toolName], code: 'tool_not_available_here',
    }, 403);
  }
  if (!WEBHOOK_ALLOWED_TOOLS.has(toolName)) {
    return json({
      error: `כלי לא מוכר או לא מותר בערוץ זה: ${toolName || '(ריק)'}`,
      code: 'unknown_tool',
      allowed: [...WEBHOOK_ALLOWED_TOOLS],
    }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'גוף הבקשה אינו JSON תקין', code: 'bad_json' }, 400);
  }

  try {
    return await handle(sb, toolName, body, req);
  } catch (e) {
    return errorResponse(e);
  }
});

// ============================================================

async function handle(
  sb: ReturnType<typeof admin>, toolName: string,
  body: Record<string, unknown>, req: Request,
) {
  // ---- המשרד ----
  //
  // ⚠ מגיע מהסביבה ולא מגוף הבקשה. אילו הוא היה נקרא מה-payload, מי
  // שמחזיק באסימון היה יכול לכוון פעולות למשרד אחר — והאסימון הזה
  // מוגדר אצל ספק חיצוני.
  let officeId: string = WEBHOOK_OFFICE_ID;
  if (!officeId) {
    const offices = await listOffices(sb);
    if (offices.length === 1) {
      officeId = String(offices[0].id);
    } else {
      // ⚠ הרשימה מוחזרת רק למי שכבר עבר אימות אסימון — כלומר לבעל
      // ההתקנה. זו נקודת הכשל הראשונה בהתקנה, והחזרת "לא ניתן לקבוע"
      // בלי לומר מבין מה הייתה שולחת אותו לחפש מזהה במסך אחר.
      return json({
        error: offices.length
          ? 'קיים יותר ממשרד אחד. יש להגדיר VOICE_WEBHOOK_OFFICE_ID.'
          : 'לא נמצא אף משרד בהתקנה.',
        code: 'office_not_resolved',
        candidates: offices,
        hint: 'supabase secrets set VOICE_WEBHOOK_OFFICE_ID=<id>',
      }, 503);
    }
  }

  // ---- מפסקי חירום ----
  //
  // ⚠ נבדק `emergency_stop` ו-`ai_enabled`, ו**לא** `live_calls_enabled`.
  // האחרון מתאר את צינור ה-Asterisk העצמאי (SIP, מדיה, TTS מקומי);
  // בערוץ הזה הטלפוניה וההקראה הן של הספק החיצוני, ובדיקת המוכנות של
  // הצינור שלנו לעולם לא תעבור. שני הראשונים אומרים "המזכירה כבויה",
  // וזה נכון בכל ערוץ.
  const { data: settings } = await sb.from('call_center_settings')
    .select('emergency_stop, ai_enabled, max_calls_per_hour_per_number')
    .eq('office_id', officeId).maybeSingle();

  if (settings?.emergency_stop) {
    return json({
      success: false,
      message: 'המזכירה הדיגיטלית מושבתת כרגע. יש לרשום את הפנייה ידנית.',
      code: 'EMERGENCY_STOP',
    }, 200);   // 200 בכוונה — ראה ההערה על תשובות למודל למטה
  }
  if (settings?.ai_enabled === false) {
    return json({
      success: false,
      message: 'המזכירה הדיגיטלית אינה פעילה. הפנייה לא נרשמה.',
      code: 'AGENT_DISABLED',
    }, 200);
  }

  // ---- זיהוי המתקשר והשיחה ----
  const phoneInfo = normalizePhoneNumber(
    body.caller_phone ?? body.caller_id ?? body.from ?? body.phone);
  const callerPhone = phoneInfo.normalized || String(body.caller_phone ?? '').trim();

  // conversation_id של הספק הוא מה שהופך קריאות מרובות באותה שיחה
  // לשיחה אחת אצלנו — ו-retry של אותה קריאה לאותה פעולה.
  const conversationId = String(
    body.conversation_id ?? body.call_sid ?? body.session_id ?? '').trim();

  if (!callerPhone && !conversationId) {
    return json({
      success: false,
      message: 'לא נמסר מספר מתקשר ולא מזהה שיחה — לא ניתן לרשום את הפנייה.',
      code: 'MISSING_CALLER',
    }, 200);
  }

  // ---- מגבלת קצב ----
  //
  // ⚠ ההגנה המרכזית בערוץ הזה. בלי חתימה על הגוף ובלי nonce, מגבלת
  // הקצב היא מה שמונע ממי שהשיג את האסימון להציף את המשרד במשימות.
  const limit = Number(settings?.max_calls_per_hour_per_number ?? 12);
  const bucket = 'webhook:' + (callerPhone || conversationId);
  const rl = await checkRateLimit(sb, officeId, bucket, limit);
  if (!rl.allowed) {
    await audit(sb, {
      officeId, actorType: 'webhook', action: 'voice_webhook_rate_limited',
      severity: 'warning', after: { bucket, count: rl.count }, req,
    });
    return json({
      success: false,
      message: 'התקבלו יותר מדי פניות מהמספר הזה בשעה האחרונה.',
      code: 'RATE_LIMITED',
    }, 200);
  }

  // ---- שיחה ----
  //
  // אידמפוטנטי: אותו conversation_id → אותה שורת שיחה. קריאה שנייה
  // לכלי באותה שיחה לא פותחת שיחה חדשה, וכל הפעולות מצטברות לציר זמן
  // אחד שאפשר לפתוח במרכז השיחות.
  const externalCallId = conversationId
    ? `ext-${conversationId}`
    : `ext-${callerPhone}-${Math.floor(Date.now() / 3_600_000)}`;

  // ⚠ מחרוזת ריקה ולא 'unknown'. נמדד בייצור: הספק לא שלח מספר, והערך
  // הספרותי-לכאורה 'unknown' זלג לכותרת המשימה — "חזרה דחופה ללקוח —
  // unknown". ריק גורם למוטציה ליפול ל"מתקשר", וזה קריא.
  const started = await startCall(sb, officeId, {
    externalCallId,
    callerPhone: callerPhone,
    direction: 'inbound',
    isSimulation: false,
  });
  const callId = started.session.id;

  // ---- ביצוע ----
  //
  // ⚠ עובר ב-runStandaloneTool, כלומר באותו שער בדיוק: בדיקת
  // agent_tools, ולידציית סכימה, שכבת הפקודות, אידמפוטנטיות, ורישום
  // ב-call_actions ובציר הזמן. אין כאן נתיב כתיבה שני.
  // ⚠ **לא** ממציאים tool_call_id כשהספק לא שלח אחד.
  //
  // מפתח האידמפוטנטיות הוא `callId:type:(toolCallId || fingerprint)` —
  // כלומר כשקיים toolCallId, תוכן הבקשה **יוצא מהמפתח**. זה נכון כשהוא
  // מזהה אמיתי של קריאת כלי (ייחודי לכל הפעלה), ושגוי כשהוא מזהה קבוע
  // שהמצאנו לכל השיחה: אז כל קריאה שנייה באותה שיחה נחשבת שכפול,
  // וניסיון שני שמביא את השם או את המועד המועדף נבלע בשקט.
  //
  // בלעדיו, המפתח נגזר מהתוכן: קלט זהה → שכפול; קלט שהשתנה → פעולה
  // חדשה שמעשירה את בקשת החזרה הקיימת.
  const providerToolCallId = String(body.tool_call_id ?? body.tool_use_id ?? '').trim();
  const toolCallId = providerToolCallId || null;

  const outcome = await runStandaloneTool(
    sb, officeId, callId, toolName, buildInput(toolName, body, callerPhone),
    { toolCallId, schemaVersion: '1' });


  await audit(sb, {
    officeId, actorType: 'webhook', action: 'voice_webhook_tool',
    entityType: 'call', entityId: callId,
    after: { tool: toolName, status: outcome.status, phone: callerPhone }, req,
  });

  // ⚠ תמיד 200, גם בכישלון עסקי.
  //
  // התשובה הזו מוזנת בחזרה למודל שמדבר עם המתקשר. סטטוס 4xx/5xx גורם
  // לספקי קול לזרוק שגיאה גנרית או לנתק, במקום לתת למודל משפט שהוא
  // יכול לומר. `success` בגוף הוא מה שהמודל קורא.
  // ⚠ בקשת חזרה בלי מספר טלפון היא בקשה שאי אפשר למלא. המודל חייב
  // לשמוע את זה כדי לשאול — אחרת הבקשה נרשמת, נראית תקינה במסך,
  // ומתגלה כחסרת ערך רק כשמישהו מנסה לחייג.
  const needsPhone = !callerPhone && outcome.result.ok &&
    toolName === 'request_human_callback';
  const message = needsPhone
    ? `${outcome.result.message} חשוב לבקש מהמתקשר מספר טלפון לחזרה ולשלוח אותו שוב.`
    : outcome.result.message;

  return json({
    success: outcome.result.ok,
    message,
    status: outcome.status,
    call_id: callId,
    entity_id: outcome.result.entityId ?? null,
    missing_caller_phone: needsPhone,
    replayed: Boolean(
      (outcome.result.data as Record<string, unknown> | undefined)?.replayed),
  });
}

/**
 * ממפה את הגוף שהספק שולח לקלט שהכלי מצפה לו.
 *
 * ⚠ המיפוי סלחני בשמות (`reason`/`summary`/`notes`) אבל **לא** בשדות:
 * מה שלא ממופה כאן פשוט לא מגיע לכלי, וסכימת הכלי דוחה שדות לא מוכרים.
 * כך ניסוח חופשי של מי שמגדיר את הכלי אצל הספק לא הופך לשדה מוברח.
 */
function buildInput(
  tool: string, body: Record<string, unknown>, callerPhone: string,
): Record<string, unknown> {
  const str = (...keys: string[]): string => {
    for (const k of keys) {
      const v = body[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
    return '';
  };

  switch (tool) {
    case 'request_human_callback':
      return {
        reason: str('reason', 'summary', 'message', 'notes', 'description'),
        name: str('name', 'caller_name', 'full_name'),
        phone: callerPhone,
        preferred_time: str('preferred_time', 'callback_time', 'when'),
        urgency: normalizeUrgency(str('urgency', 'priority')),
      };

    case 'create_lead':
      return {
        name: str('name', 'caller_name', 'full_name'),
        phone: callerPhone,
        source: 'voice_ai',
        category: str('category', 'area', 'topic'),
        summary: str('summary', 'reason', 'message', 'notes'),
        email: str('email'),
      };

    case 'create_note':
      return {
        text: str('text', 'note', 'summary', 'message'),
        client_id: str('client_id'),
        lead_id: str('lead_id'),
        matter_id: str('matter_id', 'case_id'),
      };

    case 'check_calendar':
      return {
        from_date: str('from_date', 'date') || undefined,
        days: body.days != null ? Number(body.days) : undefined,
        duration_minutes: body.duration_minutes != null
          ? Number(body.duration_minutes) : undefined,
        max_slots: body.max_slots != null ? Number(body.max_slots) : undefined,
      };

    case 'create_appointment':
      return {
        date: str('date', 'appointment_date'),
        time: str('time', 'appointment_time'),
        duration_minutes: body.duration_minutes != null
          ? Number(body.duration_minutes) : undefined,
        title: str('title', 'subject'),
        location: str('location'),
        notes: str('notes', 'summary', 'reason'),
      };

    default:
      return {};
  }
}

/**
 * המשרדים בהתקנה, מדורגים לפי כמות הנתונים בפועל.
 *
 * ⚠ כשיש יותר מאחד — **לא מנחשים**. ניחוש כאן היה מנתב פניות של לקוחות
 * למשרד הלא נכון, והפניות היו נערמות במקום שאיש לא פותח.
 *
 * הדירוג קיים כי בהתקנה אמיתית נערמים משרדי בדיקה מהרשמות ישנות, וכולם
 * נקראים אותו דבר. מספר הלקוחות והתיקים הוא מה שמבדיל את המשרד הפעיל
 * מהשאר — ובלעדיו הבחירה היא ניחוש בין עשרים שורות זהות.
 */
async function listOffices(
  sb: ReturnType<typeof admin>,
): Promise<Array<Record<string, unknown>>> {
  const { data: offices } = await sb.from('offices').select('id, name').limit(50);
  if (!offices?.length) return [];

  const { data: blobs } = await sb.from('app_data').select('office_id, data');
  const volume = new Map<string, { clients: number; cases: number; tasks: number }>();
  for (const row of blobs || []) {
    const d = (row.data || {}) as Record<string, unknown[]>;
    volume.set(String(row.office_id), {
      clients: Array.isArray(d.clients) ? d.clients.length : 0,
      cases: Array.isArray(d.cases) ? d.cases.length : 0,
      tasks: Array.isArray(d.tasks) ? d.tasks.length : 0,
    });
  }

  type Row = { id: string; name: string; clients: number; cases: number; tasks: number };
  const rows: Row[] = (offices as Array<Record<string, unknown>>).map((o) => {
    const v = volume.get(String(o.id)) || { clients: 0, cases: 0, tasks: 0 };
    return { id: String(o.id), name: String(o.name || ''), ...v };
  });
  return rows
    .sort((a: Row, b: Row) =>
      (b.clients + b.cases + b.tasks) - (a.clients + a.cases + a.tasks))
    .slice(0, 10);
}
