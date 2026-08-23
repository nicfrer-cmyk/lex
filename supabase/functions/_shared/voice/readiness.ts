// מנוע מוכנות לייצור.
//
// ## השאלה שהוא עונה עליה
// "האם מותר לחבר את המספר הזה לקו אמיתי." לא "האם המערכת רצה" — היא
// רצה מצוין במצב הדגמה, וזה בדיוק מה שהופך את השאלה למסוכנת.
//
// ## ההבחנה המרכזית: healthy ≠ production_ready
// ספק Mock **בריא**: הוא עונה, הוא מהיר, הוא לא זורק שגיאות.
// MockTTSProvider מחזיר שקט באורך הנכון בלי לקרוס. מערכת שבודקת
// healthy בלבד תדווח 🟢 על כל הרכיבים — ואז השיחה האמיתית הראשונה
// תתחבר, המתקשר לא ישמע דבר, וינתק.
//
// לכן כל רכיב נבדק בשני צירים נפרדים, ורק שניהם יחד פותחים את השער.
//
// ## הכשל הוא סגור
// חסר מידע → לא מוכן. `never_connected` אינו "כנראה בסדר". ההיפך —
// הוא הסימן הבטוח ביותר שאין שרת קול.
//
// טהור מ-Deno ומ-DB: מקבל תמונת מצב ומחזיר פסק. ראה test/call-center.test.js.

export type ReadinessSeverity = 'blocking' | 'warning' | 'ok';

export type ReadinessCheck = {
  key: string;
  label: string;
  state: 'ok' | 'mock' | 'not_configured' | 'degraded' | 'offline' | 'error';
  severity: ReadinessSeverity;
  detail: string;
};

export type ReadinessResult = {
  ready: boolean;
  blocking_reasons: string[];
  warnings: string[];
  checks: ReadinessCheck[];
  /** אחוז הרכיבים שעברו — לפס התקדמות במסך, לא להחלטה. */
  progress: number;
};

export type ProviderSnapshot = {
  name?: string;
  mode?: string;
  healthy?: boolean;
  production_ready?: boolean;
  supports_streaming?: boolean;
  supports_barge_in?: boolean;
  supports_hebrew?: boolean;
  average_latency_ms?: number;
  message?: string;
};

export type ReadinessInput = {
  /** מצב שרת הקול: online | degraded | offline | never_connected */
  gatewayState: string;
  gatewaySecretConfigured: boolean;
  /** מצב הרכיבים כפי שדווח ב-heartbeat. */
  components: Record<string, unknown>;
  providers: Record<string, ProviderSnapshot>;
  transport?: string | null;
  outboxPending: number;
  deadLetters: number;
  phoneLine: { public_number?: string; is_active?: boolean; sip_status?: string;
               provider_status?: string } | null;
  toolsEnabled: number;
  agentActive: boolean;
  crmReachable: boolean;
  liveCallsEnabled: boolean;
  emergencyStop: boolean;
};

const OK = (key: string, label: string, detail: string): ReadinessCheck =>
  ({ key, label, state: 'ok', severity: 'ok', detail });

/**
 * הפסק המלא.
 *
 * `blocking_reasons` הוא מה שחוסם הפעלה. `warnings` הוא מה ששווה לדעת
 * אך אינו מונע שיחה. ההפרדה חשובה: רשימה אחת ארוכה גורמת לאנשים
 * להתעלם ממנה, ואז גם החוסמים נבלעים.
 */
export function evaluateVoiceProductionReadiness(input: ReadinessInput): ReadinessResult {
  const checks: ReadinessCheck[] = [];

  // ---- CRM ----
  checks.push(input.crmReachable
    ? OK('crm', 'CRM', 'מסד הנתונים והפונקציות מגיבים')
    : { key: 'crm', label: 'CRM', state: 'error', severity: 'blocking',
        detail: 'ה-CRM אינו מגיב' });

  // ---- אבטחה ----
  checks.push(input.gatewaySecretConfigured
    ? OK('security', 'אבטחה', 'סוד החתימה מוגדר')
    : { key: 'security', label: 'אבטחה', state: 'not_configured', severity: 'blocking',
        detail: 'VOICE_GATEWAY_SECRET לא הוגדר — שרת הקול לא יוכל להתחבר' });

  // ---- שרת הקול ----
  const gwLabels: Record<string, [ReadinessCheck['state'], ReadinessSeverity, string]> = {
    online: ['ok', 'ok', 'מחובר ומדווח'],
    degraded: ['degraded', 'warning', 'heartbeat לא יציב'],
    offline: ['offline', 'blocking', 'לא התקבל heartbeat לאחרונה'],
    never_connected: ['not_configured', 'blocking', 'שרת הקול טרם הותקן'],
  };
  const [gwState, gwSeverity, gwDetail] =
    gwLabels[input.gatewayState] || ['error', 'blocking', 'מצב לא ידוע'];
  checks.push({ key: 'voice_gateway', label: 'שרת טלפוניה', state: gwState,
    severity: gwSeverity, detail: gwDetail });

  // ---- מרכזייה ----
  const asterisk = String(input.components.asterisk || 'not_configured');
  checks.push(asterisk === 'configured' || asterisk === 'connected'
    ? OK('asterisk', 'מרכזייה', 'Asterisk מחובר')
    : { key: 'asterisk', label: 'מרכזייה', state: 'not_configured', severity: 'blocking',
        detail: 'Asterisk אינו מוגדר או אינו מחובר' });

  // ---- SIP ----
  const sipState = String(input.phoneLine?.sip_status || input.components.sip || 'not_configured');
  checks.push(sipState === 'registered'
    ? OK('sip', 'קו SIP', 'רשום אצל הספק')
    : { key: 'sip', label: 'קו SIP', state: sipState === 'failed' ? 'error' : 'not_configured',
        severity: 'blocking',
        detail: sipState === 'failed'
          ? 'הרישום אצל ספק ה-SIP נכשל'
          : 'לא הוגדר ספק SIP' });

  // ---- ערוץ המדיה ----
  const transport = input.transport || String(input.components.transport || '');
  checks.push(transport
    ? OK('media', 'ערוץ אודיו', `פעיל (${transport})`)
    : { key: 'media', label: 'ערוץ אודיו', state: 'not_configured', severity: 'blocking',
        detail: 'לא דווח ערוץ מדיה פעיל' });

  // ---- ספקים ----
  //
  // ⚠ כאן ההבחנה עושה את כל ההבדל. ספק Mock הוא healthy — הוא עונה
  // ולא קורס. מה שהוא לא הוא production_ready. בדיקה על healthy בלבד
  // הייתה נותנת 🟢 לכל השורה הזו במערכת שאינה יכולה לענות לטלפון.
  for (const [key, label] of [['stt', 'תמלול (STT)'], ['llm', 'מנוע שפה (LLM)'],
                              ['tts', 'הקראה (TTS)']] as const) {
    checks.push(evaluateProvider(key, label, input.providers[key]));
  }

  // ---- שער הכלים ----
  checks.push(input.toolsEnabled > 0
    ? OK('tools', 'שער הכלים', `${input.toolsEnabled} כלים מאושרים`)
    : { key: 'tools', label: 'שער הכלים', state: 'not_configured', severity: 'blocking',
        detail: 'אין כלים מאושרים — הסוכן לא יוכל לעשות דבר' });

  // ---- סוכן ----
  checks.push(input.agentActive
    ? OK('agent', 'סוכן', 'המזכירה הדיגיטלית פעילה')
    : { key: 'agent', label: 'סוכן', state: 'not_configured', severity: 'blocking',
        detail: 'אין סוכן קולי פעיל' });

  // ---- קו טלפון ----
  const line = input.phoneLine;
  checks.push(line?.public_number && line.is_active
    ? OK('phone_line', 'קו טלפון', String(line.public_number))
    : { key: 'phone_line', label: 'קו טלפון', state: 'not_configured', severity: 'blocking',
        detail: 'לא הוגדר קו פעיל' });

  // ---- Outbox ----
  // ⚠ אזהרה ולא חסימה. פעולות שממתינות מעידות על תקלת סנכרון קודמת,
  // אבל הן אינן מונעות שיחה חדשה — והחסימה הייתה מונעת דווקא את
  // התאוששות המערכת.
  if (input.deadLetters > 0) {
    checks.push({ key: 'outbox', label: 'סנכרון פעולות', state: 'error', severity: 'warning',
      detail: `${input.deadLetters} פעולות לא סונכרנו ודורשות טיפול` });
  } else if (input.outboxPending > 0) {
    checks.push({ key: 'outbox', label: 'סנכרון פעולות', state: 'degraded', severity: 'warning',
      detail: `${input.outboxPending} פעולות ממתינות לסנכרון` });
  } else {
    checks.push(OK('outbox', 'סנכרון פעולות', 'אין פעולות ממתינות'));
  }

  // ---- עצירת חירום ----
  if (input.emergencyStop) {
    checks.push({ key: 'emergency', label: 'עצירת חירום', state: 'error', severity: 'blocking',
      detail: 'המזכירה הדיגיטלית מושבתת ידנית' });
  }

  const blocking = checks.filter((c) => c.severity === 'blocking');
  const warnings = checks.filter((c) => c.severity === 'warning');

  return {
    ready: blocking.length === 0,
    blocking_reasons: blocking.map((c) => `${c.label}: ${c.detail}`),
    warnings: warnings.map((c) => `${c.label}: ${c.detail}`),
    checks,
    progress: Math.round(
      (checks.filter((c) => c.severity === 'ok').length / Math.max(1, checks.length)) * 100),
  };
}

function evaluateProvider(
  key: string, label: string, p: ProviderSnapshot | undefined,
): ReadinessCheck {
  if (!p) {
    return { key, label, state: 'not_configured', severity: 'blocking',
      detail: 'לא דווח ספק' };
  }
  if (p.production_ready === true && p.healthy !== false) {
    return { key, label, state: 'ok', severity: 'ok',
      detail: `${p.name || 'ספק'} פעיל${p.average_latency_ms ? ` · ${p.average_latency_ms}ms` : ''}` };
  }
  if (p.healthy === false) {
    return { key, label, state: 'error', severity: 'blocking',
      detail: p.message || `${p.name || 'הספק'} אינו מגיב` };
  }
  // בריא אך אינו מוכן לייצור — כלומר Mock, או ספק אמיתי שהצהיר שאינו
  // מתאים עדיין. זו השורה שמונעת את "🟢 הכול תקין" על מערכת אילמת.
  return { key, label, state: 'mock', severity: 'blocking',
    detail: p.mode === 'mock'
      ? `${p.name || 'ספק'} במצב הדגמה — אינו מתאים לשיחות אמיתיות`
      : p.message || 'הספק אינו מוכן לייצור' };
}

/**
 * האם מותר להדליק את מתג השיחות האמיתיות.
 *
 * ⚠ נפרד מ-`ready` בכוונה: `ready` מתאר את המערכת, וזו מתארת **פעולה**.
 * גם כשהכול ירוק, ההדלקה היא החלטה של אדם מורשה — לא תוצאה של תשתית
 * שהתחברה.
 */
export function canEnableLiveCalls(result: ReadinessResult): { allowed: boolean; reason: string } {
  if (result.ready) return { allowed: true, reason: '' };
  return {
    allowed: false,
    reason: 'לא ניתן להפעיל שיחות אמיתיות כל עוד קיימים חסמים: ' +
      result.blocking_reasons.join('; '),
  };
}
