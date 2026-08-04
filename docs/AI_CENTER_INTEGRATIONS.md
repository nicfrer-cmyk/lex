# AI_CENTER_INTEGRATIONS — אינטגרציות

כל ספק מאחורי interface + מימוש mock. ללא credentials, המערכת עוברת ל-mock
אוטומטית ומסך החיבורים מציג **"לא מחובר"** — לא "פעיל".

---

## מצב אמיתי

| ספק | קוד | credentials | סטטוס |
|---|---|---|---|
| Anthropic | ✅ | ✅ | **פעיל** |
| Gmail | ✅ | ❌ | mock |
| Google Calendar | ✅ | ❌ | mock |
| WhatsApp Cloud API | ✅ | ❌ | mock |
| טלפוניה | ✅ interface בלבד | — | **טרם נבחר ספק** |

---

## Gmail (`_shared/providers/email.ts`)

### ⚠ זהו OAuth שני, נפרד
המערכת כבר משתמשת ב-Google OAuth — אבל של **Supabase Auth**, להתחברות בלבד
(`platform.web.js` → `signInWithGoogle`). לזרימה ההיא אין scopes של Gmail
ואין refresh token מאוחסן, ולכן אי אפשר לעשות בה שימוש חוזר.

### scopes — מינימליים
```
gmail.modify         ← קריאה, טיוטה, שליחה, תיוג. לא מחיקה, לא הגדרות חשבון
calendar.events      ← אירועים בלבד
userinfo.email       ← להצגת החשבון המחובר
```
`gmail.modify` ולא `gmail.full` — הפרומט דורש לא לבקש הרשאות רחבות שלא נדרשות.

### הזרימה
```
connect  → URL הסכמה עם state חתום (נושא office_id + מגן מפני CSRF)
callback → code → tokens → הצפנה AES-GCM → שתי שורות ב-integration_connections
sync     → historyId כ-cursor → הודעות → שיוך ללקוח/תיק לפי כתובת שולח
send     → רק דרך ai-comms, ורק אחרי שהאישור נשמר בשרת
```

### שתי מלכודות שכבר טופלו
1. **`access_type=offline` + `prompt=consent`** — בלי `prompt=consent`, חיבור
   חוזר של אותו חשבון מחזיר access_token בלבד, והחיבור "נשבר" בשקט אחרי שעה.
2. **Google לא מחזיר `refresh_token` ברענון** — הקוד משמר את הישן במפורש.
   בלי זה, הרענון הראשון היה מוחק את אפשרות הרענון הבאה.

### שליחה בעברית
כותרת Subject עוברת encoded-word (RFC 2047, `=?UTF-8?B?...?=`), אחרת הנושא
מגיע כג'יבריש בחלק מלקוחות הדואר.

---

## Google Calendar (`_shared/providers/calendar.ts`)

- Timezone קבוע **`Asia/Jerusalem`** בכל אירוע. אירוע בלי timezone מפורש
  מתפרש לפי הגדרת היומן של המשתמש — ודיון בשעה שגויה הוא בדיוק מה שהמערכת
  אמורה למנוע.
- `findFreeSlots()` מחזיר רק חלונות בשעות עבודה (א׳-ה׳, 09:00-18:00).
  הצעת פגישה ל-03:00 היא רעש, לא אפשרות.
- `singleEvents=true` — מפרק אירועים חוזרים לתפוסה אמיתית.
- מחיקה: `410 Gone` נחשב הצלחה (האירוע כבר לא קיים).

---

## WhatsApp (`_shared/providers/whatsapp.ts`)

### אבטחת ה-webhook
`webhook-whatsapp` נפרס עם `--no-verify-jwt` (ל-Meta אין JWT שלנו), ולכן:
- **HMAC-SHA256** של גוף הבקשה מול `WHATSAPP_APP_SECRET`
- השוואה ב-`timingSafeEqual`
- **ללא הסוד — כל בקשה נדחית ב-503.** לא "מתקבלת בינתיים"

בלי זה, כל אחד ברשת יכול היה ליצור לידים מזויפים, לשייך הודעות ללקוחות
אמיתיים ולהפעיל סוכנים על חשבון המשרד.

### נרמול טלפון
כל מספר עובר `normalizePhone()` ל-E.164. אותו אדם מופיע ב-CRM כ-`050-1234567`,
בוואטסאפ כ-`972501234567` ובמייל כ-`+972-50-123-4567`. בלי נרמול, כל הודעה
מלקוח קיים הייתה פותחת ליד חדש כפול.

### opt-out ושעות פעילות
`canSendNow()` נבדק **בקוד** לפני כל שליחה, לא בהנחיה לסוכן — סוכן יכול
"לשכוח" הנחיה, קוד לא. ברירת מחדל: א׳-ה׳ 09:00-18:00.

### כפילויות
`unique(office_id, channel, external_message_id)` — Meta שולחת webhook פעמיים
לא פעם, וזה בדיוק מה שהאינדקס תופס.

---

## טלפוניה (`_shared/providers/telephony.ts`)

**נבדק: אין ספק טלפוניה בפרויקט.** אין קוד, אין secret, אין חיבור.

לכן יש כאן interface מלא + mock + תיעוד דרישות, אבל **אין מימוש ספק ספציפי**.
בחירת הספק היא החלטה עסקית (מחיר, מספרים קיימים, הקלטות) — לא של מפתח.

### מה נדרש מספק
**חובה:**
- Webhook לשיחה נכנסת (מתקשר, יעד, מזהה, חותמת זמן)
- Webhook לשיחה שלא נענתה
- API לסטטוס שיחה
- **אימות webhook** (חתימה או secret). ספק בלי זה — שיקול לא לבחור בו

**רשות:** click-to-call · SMS · מטא-דאטה של הקלטה

### הוספת ספק = הגדרה, לא קוד
`webhook-telephony` ממפה payload גנרי לפי `integration_connections.config`:

```sql
insert into integration_connections (office_id, provider, connection_type, status, config)
values ('<OFFICE>', 'telephony', 'webhook', 'connected', jsonb_build_object(
  'vendor', 'שם-הספק',
  'webhook_secret', '<סוד>',
  'signature_scheme', 'hmac_sha256',   -- או להשמיט לסוד משותף בכותרת
  'signature_header', 'x-signature',
  'field_map', jsonb_build_object(
    'from','caller_number', 'to','destination',
    'status','call_status', 'call_id','uuid', 'duration','billsec'
  )
));
```
Webhook URL: `.../functions/v1/webhook-telephony?office=<OFFICE_ID>`

### הערה משפטית
סיכום שיחה ע"י AI ייעשה **רק** כשקיימת הקלטה חוקית והרשאה מתאימה. הקלטה ללא
הסכמה כפופה לחוק האזנת סתר ולכללי האתיקה. המערכת לא תסכם שיחה אלא אם החיבור
סומן במפורש כמקליט כדין.

---

## מה קורה בלי credentials

```ts
export async function getEmailProvider(sb, officeId) {
  if (EMAIL_PROVIDER_MODE === 'mock') return new MockEmailProvider();
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return new MockEmailProvider();
  const conn = await ...;
  if (conn?.status !== 'connected') return new MockEmailProvider();
  return new GmailProvider(sb, officeId);
}
```

ה-mock:
- מסמן `isMock = true`, וה-UI מציג "לא מחובר"
- `send()` מחזיר `ok: true` — כדי שאפשר לבדוק את **כל** הזרימה (טיוטה →
  אישור → שליחה → תיעוד) בלי לשלוח כלום
- `listRecent()` מחזיר **ריק, לא נתונים פיקטיביים**. הודעות מומצאות שנראות
  אמיתיות בתיבה של משרד עורכי דין הן בדיוק מה שגורם למישהו להתייחס אליהן
  ברצינות
