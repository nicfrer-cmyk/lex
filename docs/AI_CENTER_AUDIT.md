# AI_CENTER_AUDIT — סריקת המערכת הקיימת

> שלב א' של פרויקט "מרכז שליטה לסוכני AI".
> נכתב **לפני** כתיבת שורת קוד אחת, על בסיס סריקה בפועל של הריפו.
> כל קביעה כאן נבדקה מול הקוד — לא הונחה.

תאריך: 04/08/2026 · ענף: `master` · commit בסיס: `e688d86`

---

## 1. Stack

| שכבה | מה בפועל |
|---|---|
| Frontend | **Vanilla JS. אין React/Vue/Svelte.** קבצי `<script>` רגילים, פונקציות גלובליות, `innerHTML` template literals |
| Bundler | `esbuild` — אבל **רק** עבור `src/platform.web.js`. `app.js`/`auth.js`/`template-manager.js`/`legal-content.js` מועתקים **verbatim** (`build.mjs:53-56`) |
| Build | `node build.mjs` → `dist/`. cache-busting `?v=<Date.now()>` על כל `<script>` |
| Hosting | Netlify (`netlify.toml`), SPA redirect `/* → /index.html 200` |
| **Netlify Functions** | **אין. תיקיית functions לא קיימת כלל.** כל הלוגיקה השרתית היא Supabase Edge Functions |
| Backend | Supabase — Postgres + Auth + Storage + Edge Functions (Deno) |
| Desktop/Mobile | Electron (`main.js`) ו-Capacitor (`capacitor.config.json`) — שניהם טוענים את האתר הפרוס (remote URL), לא בנייה נפרדת |
| Tests | `node --test test/*.test.js`. קובץ אחד: `test/pure-functions.test.js`, מריץ את `app.js` ב-`vm` context עם DOM stub |
| TypeScript | **אין** בצד הלקוח. רק Edge Functions הן `.ts` (Deno) |
| Lint | **אין** — אין eslint/prettier config, אין script `lint` |

### השלכה מחייבת
כל דרישות הפרומט שנוסחו במונחי framework (`routes`, `components`, `Netlify Functions`) חייבות להיתרגם:
- `routes` → **פאנלים** (`<div id="panel-X" class="panel">`) + הפונקציה `nav(id, el)`. **אין URL routing כלל** (אין hash, אין History API).
- `components` → פונקציות רינדור שמחזירות מחרוזת HTML.
- `Netlify Functions` → **Supabase Edge Functions**. אין טעם להקים תשתית Netlify Functions מקבילה כשכל השאר כבר שם (עיקרון 1.1: "אל תקים מערכת מקבילה כאשר כבר קיים רכיב מתאים").

---

## 2. Routes / ניווט

```js
// src/app.js:157
let currentPanel = 'dashboard';
function nav(id, el) { /* מסיר .active מכל .panel, מוסיף ל-panel-<id> */ }
```

פאנלים קיימים: `dashboard`, `cases`, `case-detail`, `clients`, `client-detail`, `tasks`, `calendar`, `finance`, `docs`, `analytics`, `templates`.

### 🚨 מלכודת קריטית — אינדקסים של פריטי ניווט
פריטי הסיידבר ממוענים לפי **מיקום מספרי** ב-15 מקומות שונים:
```js
document.querySelectorAll('.nav-item')[1].classList.add('active');  // app.js:1015
```
ובנוסף `app.html:508,576,617,799,803,807,811` ו-`app.js:1738,2364,2491,3071-3074`.

**הוספת פריט ניווט בכל מקום שאינו אחרי האחרון (`#nav-templates-item`) תשבור את כולם בשקט.**
→ פריט "מרכז AI" חייב להתווסף **אחרי** `#nav-templates-item`.

### מלכודת שנייה — הסתרת מסכים לפי תפקיד
```js
// app.js:4937 — התאמה לפי מחרוזת onclick מדויקת
if (onclick === "nav('finance',this)" || onclick === "nav('analytics',this)") n.style.display = 'none';
```
כל שינוי במחרוזת ה-onclick של פריטים אלה שובר את ההרשאות.

---

## 3. Auth והרשאות

- Supabase Auth. `createClient(..., { auth: { persistSession: false } })` — סשן **לא** נשמר כברירת מחדל; "זכור אותי" שומר refresh token ב-`localStorage['lextrack-remembered-session']`.
- `Platform.getRole()` → `'owner' | 'lawyer' | 'secretary'`.
- `window.supabaseClient` הוא הידית היחידה ל-client הגולמי (בשימוש `auth.js` בלבד).
- Google OAuth כבר **קיים להתחברות** (`signInWithGoogle`) — אבל זהו OAuth של Supabase Auth בלבד, **ללא** scopes של Gmail/Calendar ו**ללא** refresh token מאוחסן. לא ניתן לשימוש חוזר לאינטגרציית Gmail.

### מודל רב-דיירות (multi-tenancy)
```
offices (id, name, vat_rate)
  └── office_members (office_id, user_id, role owner|lawyer|secretary)
```
פונקציית עזר ל-RLS (`supabase-schema-phase1-fix.sql:29`):
```sql
create or replace function public.is_office_member(check_office_id uuid)
returns boolean language sql security definer stable set search_path = public
as $$ select exists (select 1 from public.office_members where user_id = auth.uid() and office_id = check_office_id); $$;
```
→ **זו הפונקציה שכל טבלה חדשה חייבת להשתמש בה.** לא להמציא מנגנון בידוד חדש.

---

## 4. Schema — הממצא המרכזי של ה-Audit

### ⛔ אין טבלאות `clients` / `cases` / `tasks` / `documents` / `payments`.

**כל ה-CRM הוא JSON יחיד:**
```sql
create table public.app_data (
  user_id uuid, office_id uuid unique, data jsonb not null default '{}', updated_at timestamptz
);
```
שורה אחת לכל משרד. `platform.web.js:468-480`:
```js
async loadDB() { supabase.from('app_data').select('data').eq('office_id', officeId).maybeSingle() }
async saveDB(dbObj) { supabase.from('app_data').upsert({ office_id, data: dbObj }, { onConflict: 'office_id' }) }
```

תוכן ה-blob (`app.js:26` + `loadDB()` 55-106):
```js
{ cases:[], clients:[], tasks:[], events:[], docs:[], payments:[],
  timeEntries:[], trustTransactions:[], efilingBundles:{}, counters:{}, settings:{} }
```

מזהים: `uid()` = `Date.now().toString(36)+Math.random().toString(36).substr(2,5)` → **מחרוזת base36, לא UUID**.

### טבלאות שכן קיימות
`offices`, `office_members`, `office_invites`, `app_data`, `ai_usage`, `subscriptions`, `push_subscriptions`, `sent_reminders`, `client_errors`, `webdav_credentials`, `webdav_locks`.

### השלכות מחייבות על עיצוב מסד הנתונים של מרכז ה-AI

1. **`client_id` / `matter_id` בטבלאות `ai_*` חייבים להיות `text`, לא `uuid`, וללא foreign key.** הישויות אינן שורות בטבלה — הן אובייקטים בתוך blob. FK ל-`clients(id)` פשוט לא ניתן לכתיבה.
2. **כל טבלה חייבת `office_id uuid not null references offices(id) on delete cascade`** — זהו גבול הבידוד היחיד שקיים.
3. **הסוכן לא יכול לקרוא "תיק" ב-SQL.** שכבת הכלים חייבת לטעון את ה-blob של המשרד, לחתוך ממנו את מה שרלוונטי, ולהחזיר רק אותו. זה למעשה **יתרון אבטחתי**: אין תרחיש שבו מזהה שגוי חושף נתוני משרד אחר, כי ה-blob נטען לפי `office_id` שנגזר מה-JWT.
4. **כתיבה ל-blob היא read-modify-write על שורה שלמה** → סכנת דריסה (lost update) בין ה-worker לבין המשתמש בדפדפן. חייב פתרון (ראה סעיף 9, סיכון #1).

### מגבלת גודל
`app_data.data` הוא jsonb יחיד. משרד גדול = blob גדול שנטען במלואו לכל פעולה. אין paging. זו מגבלה קיימת של המערכת, לא משהו שמרכז ה-AI מציג — אבל הוא **מגביר** אותה (כל הרצת סוכן טוענת את ה-blob). → ה-worker חייב cache לכל הרצה, לא טעינה חוזרת לכל כלי.

---

## 5. אינטגרציות קיימות

| ספק | סטטוס אמיתי |
|---|---|
| Anthropic Claude | ✅ **עובד**, דרך Edge Function `ai-proxy` |
| Google OAuth | ⚠️ להתחברות בלבד. אין scopes ל-Gmail/Calendar, אין refresh token |
| Gmail | ❌ לא קיים |
| Google Calendar | ❌ לא קיים |
| WhatsApp | ❌ לא קיים (יש רק `shareDocVia('whatsapp')` — קישור `wa.me`, לא API) |
| טלפוניה / SMS | ❌ לא קיים |
| Web Push | ✅ קיים (`check-and-send-reminders` + VAPID) |
| Grow (סליקה) | ✅ webhook קיים |
| WebDAV (Word) | ✅ קיים |
| Resend (מייל יוצא) | חלקי — `send-invite-email` |

### `ai-proxy` — ניתוח מפורט (זהו הרכיב שאסור לשבור)
`supabase/functions/ai-proxy/index.ts`, 146 שורות:
- מאמת JWT → `office_members` → `office_id`
- מכסה: `MONTHLY_QUOTA = 200` **שורות ai_usage לחודש**, מחזיר 429
- מעביר ל-Anthropic **רק** `{model, max_tokens, system, tools, messages}`
- `useCaching` (ברירת מחדל true) → header `anthropic-beta: prompt-caching-2024-07-31`
- `feature` → נרשם ב-`ai_usage.feature` (64 תווים), לא מועבר ל-Anthropic
- מחזיר את תשובת Anthropic **ללא שינוי**
- מפתח: `ANTHROPIC_API_KEY` — secret שרת, לעולם לא בדפדפן ✅

**מסקנה:** יש כבר Gateway חלקי. הפרומט דורש Gateway מלא (idempotency, runs, queue). הנכון: **להרחיב, לא להחליף** — `ai-proxy` נשאר בדיוק כפי שהוא עבור הצ'אט הקיים ו-`request-gen`, ומרכז ה-AI מקבל `ai-gateway` נפרד שמוסיף את השכבות החסרות ומשתמש באותו secret.

---

## 6. מה כבר קיים מתוך הדרישות (אסור לבנות מחדש!)

| דרישה בפרומט | קיים כבר | קובץ |
|---|---|---|
| קריאה למודל דרך שרת | ✅ מלא | `ai-proxy/index.ts` |
| רישום עלויות/tokens | ✅ חלקי (`ai_usage`) | `supabase-schema-phase1.sql:135` |
| מכסה חודשית | ✅ (flat 200) | `ai-proxy:18` |
| סוכן AI עם Tool Use | ✅ **23 כלים**, לולאת tool_use עם `depth>8` abort | `app.js:4000-4878` |
| ניתוח מסמכים (PDF/תמונה) | ✅ | `agentUploadFile()` `app.js:4880` |
| ניסוח משפטי מטמפלטים | ✅ מתקדם — spec.json + docxtemplater | `app.js:1990-2270` |
| בחירת מודל לפי משימה | ✅ `chooseModel()` | `app.js:4151` |
| תזכורות/מועדים + Push | ✅ | `check-and-send-reminders` |
| ספריית תבניות | ✅ | `template-manager.js` |
| RLS רב-דיירות | ✅ `is_office_member()` | `fix.sql:29` |

**23 הכלים הקיימים** (`AGENT_TOOLS`, `app.js:4000`): `createCase, createClient, generateATF, generatePOA, addTask, addPayment, addEvent, addDiaryEntry, searchCases, listCases, getCaseDetails, getClientDetails, listAllCases, summarizeCase, analyzeCaseload, getRecommendations, getFinancialReport, searchEverything, generateReport, listLibraryFolders, listDocumentsInFolder, readLibraryDocument, draftDocument`.

→ **הלוגיקה העסקית של הכלים האלה יקרה ומוכחת.** מרכז ה-AI לא כותב אותה מחדש — הוא בונה מקבילות שרתיות רק לכלים שסוכן אוטונומי (שרץ ללא דפדפן) חייב, ומשאיר את הצ'אט הקיים לעבוד כמו שהוא.

---

## 7. פערים מול הדרישות (missing pieces)

| # | חסר | חומרה |
|---|---|---|
| 1 | תור משימות (jobs) — אין. הכול סינכרוני בדפדפן | 🔴 חוסם "עובד כשהמחשב כבוי" |
| 2 | Worker רקע | 🔴 |
| 3 | `runs` / `run_steps` — אין תיעוד הרצה כלל | 🔴 |
| 4 | מערכת אישורים — אין | 🔴 קריטי משפטית |
| 5 | Audit log — אין (יש `client_errors` בלבד) | 🔴 |
| 6 | רישום סוכנים ב-DB (הסוכן היחיד הוא prompt קשיח בקוד) | 🔴 |
| 7 | גרסאות prompt | 🟠 |
| 8 | רישום כלים + רמות סיכון + הרשאות | 🔴 |
| 9 | אוטומציות / rules engine | 🟠 |
| 10 | תיבת תקשורת אחודה | 🟠 |
| 11 | Gmail / Calendar / WhatsApp / טלפוניה | 🟠 (חסרי credentials) |
| 12 | מסך עלויות | 🟠 (`ai_usage` קיים, אין UI) |
| 13 | כפתור עצירת חירום | 🔴 |
| 14 | זיכרון (office/client/matter) | 🟠 |
| 15 | חיפוש סמנטי / pgvector | 🟡 nice-to-have |
| 16 | Realtime | 🟡 |
| 17 | **pg_cron לא מופעל** — מתועד ב-`check-and-send-reminders:14` שלא ניתן היה להפעילו | 🔴 חוסם תזמון |

---

## 8. איכות קוד ורכיבים לשימוש חוזר

**חיובי:** ההערות בקוד מתעדות *למה*, לא *מה* — ברמה גבוהה מאוד (ראה `app.html:223-236`, `platform.web.js:486-493`, `build.mjs:26-36`). **יש להמשיך בסגנון הזה.**

**רכיבים לשימוש חוזר:** `notify(msg)` (3669) · `customConfirm(msg,{title,okText,danger})` (271) · `customAlert` (284) · `escapeHtml(s)` (122) · `openModal/closeModal` (196/242) · `uid()` (115) · `localDateISO(d)` (512) · `heToISO(s)` (502) · `daysSinceHE(s)` (494) · `formatDuration(s)` (3674) · `switchTab` (3661).

**עיצוב:** טוקנים ב-`app.html:9-23` בלבד. **אין dark mode** — ולכן, לפי הפרומט ("אפשר dark mode רק אם קיים במערכת"), **לא נוסיף**. RTL הוא `dir="rtl"` על `<html>` + כתיבה ידנית פיזית (`right:0`, `text-align:right`).

**באגים שנמצאו אגב הסריקה** (לא בטווח, אך מתועדים):
1. `app.js:661` קורא `c.legalDocs.atf` אבל היחיד שכותב (`1896`) כותב `atfDraft` → תגי ✓שכ"ט/✓י"כ בטבלת התיקים לעולם לא מוצגים.
2. `app.js:4843` (`draftDocument`) כותב `ext:'docx'` — ערך מחוץ ל-4 הדליים `pdf|doc|xls|img`, וללא `origName`.
3. `db.settings` / `db.counters` לא קיימים במשרד חדש (שורה 26 לא כוללת אותם, ו-59-65 רצים רק `if (data)`).
4. אין Escape-key handler למודלים למרות הערה ב-`app.js:256` שטוענת שיש.
5. מודל שנוסף ל-DOM דינמית לא מקבל backdrop-dismiss (`app.js:266` רץ פעם אחת).

---

## 9. סיכונים וקונפליקטים

| # | סיכון | חומרה | מענה מתוכנן |
|---|---|---|---|
| 1 | **Lost update על `app_data`** — worker ומשתמש כותבים את אותה שורה | 🔴 | ה-worker **לעולם לא כותב ישירות** ל-`app_data`. הוא כותב הצעה ל-`ai_approvals`; ההחלה מתבצעת בדפדפן (read-modify-write אטומי מקומי) או דרך RPC עם `for update` |
| 2 | אינדקסי `.nav-item` | 🔴 | פריט חדש **אחרי** `#nav-templates-item` בלבד |
| 3 | מכסת 200 של `ai-proxy` תיחסם ע"י הסוכנים | 🟠 | מרכז ה-AI סופר עלות בנפרד (`ai_runs.estimated_cost`) ואוכף תקציב משלו; לא עובר דרך `ai-proxy` |
| 4 | Prompt injection ממסמכי צד שכנגד | 🔴 | תוכן מסמך תמיד ב-`<untrusted_document>` + הוראת מערכת מפורשת; כלים לעולם לא נבחרים ע"י תוכן מסמך |
| 5 | pg_cron לא מופעל | 🔴 | Worker נתמך ב-3 מפעילים: pg_cron (SQL מסופק) / cron חיצוני / ניקוז מהדפדפן. **לא נכריז ש"עובד כשהמחשב כבוי" עד שאחד מהשניים הראשונים מופעל בפועל** |
| 6 | `app.js` הוא 297KB בקובץ אחד | 🟠 | קוד מרכז ה-AI ב**קובץ נפרד** `ai-center.js`, לא הרחבה של app.js |
| 7 | אין TypeScript בלקוח | 🟡 | typecheck יחול על Edge Functions בלבד; ולידציה בזמן ריצה (schema) בכל כלי |
| 8 | סודות | ✅ | `ANTHROPIC_API_KEY` כבר בשרת בלבד. אותה מדיניות לכל credential חדש |

---

## 10. החלטות ארכיטקטוניות שנגזרות מה-Audit

1. **Supabase Edge Functions, לא Netlify Functions** — אין תשתית Netlify Functions בפרויקט.
2. **טבלאות `ai_*` חדשות, `app_data` לא נגעה** — אפס סיכון לאובדן נתונים.
3. **`client_id`/`matter_id` = `text`** (מזהי `uid()`), ללא FK.
4. **הסוכן אף פעם לא כותב ל-CRM ישירות** — רק הצעות דרך מערכת האישורים.
5. **`ai-proxy` נשאר ללא שינוי**; `ai-gateway` חדש ונפרד.
6. **קובץ frontend נפרד** `src/ai-center.js` + פאנל אחד `#panel-ai-center` עם טאבים פנימיים (אין URL routing במערכת).
7. **אין dark mode** (לא קיים במערכת).
8. **mock mode כברירת מחדל** לכל אינטגרציה חסרת credentials, מסומן במפורש ב-UI כ"לא מחובר".

---

## 11. מוכנות לשלב ב'

- [x] Stack מזוהה
- [x] Routes ומנגנון ניווט מזוהים
- [x] Auth + הרשאות + RLS מזוהים
- [x] Schema אמיתי ממופה (כולל הממצא הקריטי של ה-blob)
- [x] אינטגרציות קיימות מופו
- [x] רכיבים לשימוש חוזר זוהו
- [x] קונפליקטים וסיכונים תועדו

→ ממשיכים ל-`AI_CENTER_ARCHITECTURE.md` ו-`AI_CENTER_IMPLEMENTATION_PLAN.md`.
