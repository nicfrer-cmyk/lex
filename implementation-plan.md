# מרכז האוטומציות — תוכנית מימוש

> נכתב אחרי ביקורת בפועל על הקוד ועל מסד הנתונים החי
> (פרויקט `syxutnwbpjsvzlwfpvyc`), לא לפי הנחות. כל ממצא כאן נבדק.

---

## 1. מיפוי המערכת הקיימת

### 1.1 טכנולוגיות

| שכבה | מה בפועל |
|---|---|
| Frontend | **Vanilla JS**, ללא framework. `<script>` גלובליים, `onclick` inline |
| Build | `build.mjs` — משרשר קבצים ל-`dist/`, ללא bundler |
| Backend | **Supabase** — Postgres 17 + Edge Functions (Deno) |
| Hosting | **Netlify** (בונה מ-git, ענף `master`) |
| Desktop/Mobile | Electron + Capacitor (אותו `src/`) |
| בדיקות | `node --test test/*.test.js` — 75 בדיקות עוברות |

### 1.2 ⚠ הממצא המכריע: אין טבלאות לישויות

**זו העובדה שמעצבת את כל התוכנית.** במסד יש 30 טבלאות, ואף אחת מהן אינה
`clients`, `cases`, `tasks` או `invoices`. כל ה-CRM יושב בעמודה אחת:

```
app_data (office_id, data jsonb, updated_at)   ← שורה אחת לכל משרד
```

מה שיש בתוך ה-blob, לפי בדיקה בפועל על המשרד `332c2bc5…`:

| מפתח | כמות | שדות אמיתיים |
|---|---|---|
| `cases` | 4 | id, name, court, diary, notes, stage, amount, client, feePct, feeVat, number, opened, status, feeType |
| `clients` | 4 | id, name, type, color, email, idNum, notes, phone, address, contact, initials, textColor, clientNumber, contactPhone |
| `docs` | 22 | id, cat, ext, date, name, notes, caseId, filePath, origName |
| `tasks` | 2 | id, text, due, caseId, priority, notes, done, completedAt |
| `events` | 0 | id, title, date, time, location, type, caseId, notes |
| `payments` | 0 | caseId, amount, date, method, type, note |
| `timeEntries` | 0 | — |
| `trustTransactions` | 0 | — |
| `counters`, `settings`, `efilingBundles` | — | — |

**המשמעות:** אין `select` על תיקים. כל בדיקת תנאי מחייבת טעינת ה-blob כולו
לזיכרון וסינון ב-JS. זה כבר מה ש-`ai-cron` עושה (`loadOfficeDb`), וזה
עובד — אבל הוא קובע שהמנוע חייב לרוץ ב-Edge Function ולא ב-SQL.

### 1.3 ישויות שהמפרט מבקש ו**אינן קיימות כלל**

| ישות במפרט | מצב |
|---|---|
| `invoices` / חשבוניות | ❌ לא קיים בשום צורה |
| `expenses` / הוצאות | ❌ לא קיים |
| `employees` / עובדים | ❌ לא קיים (יש `office_members` = משתמשים) |
| ספקים | ❌ לא קיים |
| `hearings` / דיונים | ⚠ חלק מ-`events` דרך שדה `type` |
| `leads` | ⚠ קיים בקוד (`db.leads`), ריק במשרד הזה |
| `notifications` | ❌ אין טבלה (יש `push_subscriptions` + `sent_reminders`) |

### 1.4 ⚠ שדות שהמפרט מניח ואינם קיימים

**אין שום שדה "אחראי" בשום ישות.** לא במשימות, לא בתיקים, לא באירועים.

זה חוסם ישירות: "משימה ללא אחראי", "תיק ללא אחראי", "עובד עם יותר מדי
משימות", "חלוקת עומסים לא מאוזנת", "העברת משימות לעובד מחליף".

### 1.5 תפקידים

בפועל **שלושה** בלבד: `owner`, `lawyer`, `secretary`
(`office_members.role`, אכיפה ב-check constraint).
המפרט מבקש שבעה. `manager`, `intern`, `accounting`, `viewer` — לא קיימים.

### 1.6 מה כבר בנוי ואין לבנות מחדש

מרכז ה-AI (נפרס היום) כבר סיפק חלק מהמפרט הזה:

| דרישה במפרט | קיים | איפה |
|---|---|---|
| טבלת כללי אוטומציה | ✅ | `automation_rules` |
| היסטוריית הפעלות | ⚠ חלקי | `ai_runs` — קשור לסוכן, לא לפעולה גנרית |
| מרכז אישורים | ✅ | `ai_approvals` + טאב "אישורים" |
| Audit log | ✅ | `audit_logs` |
| Idempotency | ✅ | `ai_jobs.idempotency_key` + `stableHash` |
| Global pause | ✅ | `ai_settings.automations_paused` / `emergency_stop` |
| RLS + הפרדת משרדים | ✅ | `is_office_member` / `is_office_owner` |
| מנוע תנאים | ⚠ בסיסי | `matchesConditions` — 10 אופרטורים, בלי AND/OR מקונן |
| טריגרים | ⚠ 9 בלבד | `collectSubjects` ב-`ai-cron` |
| פעולות | ❌ | אין מנוע פעולות גנרי — רק "הזמן סוכן" |
| תור אירועים | ❌ | אין. הכל polling |
| Dry run | ❌ | לא קיים |
| מדידת חיסכון | ❌ | לא קיים |
| Rule Builder | ❌ | לא קיים |

**החלטה: מרחיבים את `automation_rules` הקיימת, לא יוצרים `automation_rules`
שנייה.** יצירת טבלה מקבילה הייתה משאירה שני מנועים שרצים במקביל על אותם
נתונים ומייצרים פעולות כפולות — בדיוק מה שהמפרט אוסר בסעיף 24.

---

## 2. הפער המרכזי: מנוע פעולות

היום אוטומציה יודעת לעשות **דבר אחד**: ליצור `ai_job` שמעיר סוכן. כלומר כל
אוטומציה עולה כסף וכל תוצאה היא טקסט של מודל.

המפרט מבקש 30+ פעולות שרובן אינן דורשות מודל כלל — "צור משימה", "שנה סטטוס",
"הוסף תגית", "שלח התראה". זה הפער האמיתי, וזו גם התשובה לתחושה שה-AI לא תורם:
**רוב האוטומציות לא צריכות AI, ולכן צריך מנוע פעולות דטרמיניסטי לצדו.**

הארכיטקטורה החדשה:

```
טריגר (אירוע או תזמון)
   ↓
automation_event_queue      ← outbox אמין, retry, idempotency
   ↓
מנוע תנאים (AND/OR מקונן)
   ↓
מנוע פעולות
   ├── פעולות דטרמיניסטיות  → מבוצעות ישירות (עלות: 0)
   └── פעולת "הזמן סוכן"     → ai_jobs (הנתיב הקיים)
   ↓
רמת ביצוע
   ├── רמה 1: התראה בלבד
   ├── רמה 2: automation_approvals   ← הכנה לאישור
   └── רמה 3: ביצוע אוטומטי (חסום לפעולות רגישות)
   ↓
automation_action_logs + automation_metrics
```

---

## 3. טבלאות חדשות

מוסיפות, לא מחליפות. שמות במרחב `automation_*` כדי להיבדל מ-`ai_*`.

| טבלה | תפקיד |
|---|---|
| `automation_templates` | קטלוג תבניות מערכת. `is_system_template` |
| `automation_event_queue` | Outbox. `event_type`, `entity_type`, `entity_id`, `status`, `attempts`, `available_at` |
| `automation_runs` | הפעלה אחת. `reason` בשפה אנושית, `input_snapshot`, `output_snapshot` |
| `automation_action_logs` | פעולה בודדת בתוך הפעלה |
| `automation_approvals` | ממתין לאישור — **מאוחד עם `ai_approvals` דרך view**, לא כפילות |
| `automation_metrics` | צבירה תקופתית: דקות ועלות שנחסכו |
| `automation_notifications` | מרכז התראות במערכת |

עמודות שנוספות ל-`automation_rules` הקיימת: `template_key`, `execution_level`,
`severity`, `category`, `recipients`, `escalation`, `cooldown_minutes`,
`quiet_hours`, `tags`, `version`, `paused_until`, `failure_count`.

---

## 4. סדר ביצוע

| שלב | תוכן | מצב |
|---|---|---|
| 1 | מיגרציה: טבלאות, RLS, אינדקסים, הרחבת `automation_rules` | |
| 2 | `_shared/automation/conditions.ts` — מנוע תנאים AND/OR + טסטים | |
| 3 | `_shared/automation/actions.ts` — רישום פעולות + ביצוע | |
| 4 | `_shared/automation/triggers.ts` — הרחבת הטריגרים | |
| 5 | `automation-engine` Edge Function — תור, retry, dry-run | |
| 6 | זריעת תבניות שעובדות על נתונים אמיתיים | |
| 7 | UI: `src/automations.js` — dashboard, כרטיסים, הגדרות, היסטוריה | |
| 8 | מדדי חיסכון + מרכז התראות | |
| 9 | בדיקות | |
| 10 | תיעוד + פריסה | |

---

## 5. מה **לא** ייבנה, ולמה

מסומן במפורש כדי שלא ייראה כמו שכחה.

| מה | סיבה |
|---|---|
| כל אוטומציות החשבוניות (סעיף 13) | אין ישות `invoices`. לבנות אותה = מודול חשבונאות שלם, מחוץ לגבולות הבקשה |
| אוטומציות הוצאות | אין ישות `expenses` |
| "ללא אחראי" / עומסי עובדים (סעיף 16) | אין שדה אחראי באף ישות |
| הוצאה לפועל (סעיף 15) | הישויות (אזהרה, מסירה, עיקול, הסדר) לא קיימות |
| אוטומציות אבטחה (סעיף 18) | דורשות אירועי auth שאינם נחשפים ל-app |
| התאמות בנק לנאמנות | `trustTransactions` ריקה, אין אינטגרציה בנקאית |
| 4 התפקידים החסרים | שינוי `office_members.role` שובר מסכים קיימים |

**התבניות יהיו קיימות בקטלוג ומסומנות `requires: [...]`** — כשהישות תיווצר
בעתיד, האוטומציה תעבוד בלי שינוי קוד. זה מה שסעיף 36.15 מבקש.

---

## 6. סיכונים

| סיכון | מענה |
|---|---|
| **הצפת פעולות על נתונים ישנים** בהפעלה ראשונה | `activation_grace_at` — אוטומציה מתעלמת מאירועים שקדמו להדלקתה. סעיף 35 |
| **פעולה כפולה** | `deduplication_key` ייחודי + `cooldown_minutes` |
| **כתיבה מקבילה ל-blob** | כל כתיבה דרך `saveOfficeDb` עם optimistic concurrency הקיים |
| **הצפת אישורים** | תקרת הצעות לכלל להרצה, digest במקום התראה בודדת |
| **43 משרדים על אותו מפתח AI** | פעולות דטרמיניסטיות לא עולות כלום; רק פעולת "הזמן סוכן" |
