# AI_CENTER_DEPLOYMENT — פריסה והפעלה

> סדר הפעולות חשוב. שלב 1 (migrations) חייב להיות ראשון, אחרת הפונקציות
> יעלו ויקרסו על טבלאות שלא קיימות.

---

## 0. לפני הכול — גיבוי

```bash
supabase db dump -f backup-before-ai-center.sql
```

ה-migrations כאן additive בלבד (אף טבלה קיימת לא משתנה, אף עמודה לא נמחקת),
אבל גיבוי לפני שינוי schema במערכת שמחזיקה תיקים משפטיים אינו נתון למשא ומתן.

---

## 1. Migrations

```bash
supabase db push
```

מריץ:
| קובץ | מה |
|---|---|
| `20260804000000_ai_center.sql` | 16 טבלאות, RLS, 6 פונקציות, טריגרים |
| `20260804000001_ai_center_seed.sql` | 37 כלים, 13 סוכנים, 8 אוטומציות (כבויות) |
| `20260804000002_ai_learning.sql` | `ai_learning_insights`, 4 פונקציות למידה, `learned_at` על `ai_approvals`/`ai_feedback`, 3 עמודות `learning_*` ב-`ai_settings` |

שניהם `if not exists` / `on conflict do nothing` — **הרצה חוזרת בטוחה**.

### בדיקה
```sql
select count(*) from ai_agents;        -- 12 לכל משרד
select count(*) from ai_tools;         -- 37 לכל משרד
select count(*) from automation_rules where is_active;  -- 0 — כולן כבויות בכוונה
select * from ai_settings;             -- שורה אחת לכל משרד, כולל learning_enabled = true
select count(*) from ai_learning_insights;              -- 0 — הלומד עוד לא רץ
```

---

## 2. Secrets

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set INTEGRATION_ENCRYPTION_KEY="$(openssl rand -base64 48)"
supabase secrets set CRON_SECRET="$(openssl rand -hex 32)"
supabase secrets set SITE_URL=https://zesty-marigold-0edcb2.netlify.app
supabase secrets set AI_PROVIDER_MODE=live
```

`ANTHROPIC_API_KEY` כנראה כבר מוגדר (ai-proxy משתמש בו). אותו מפתח משרת גם את מרכז ה-AI.

> **המלצה להרצה ראשונה:** `AI_PROVIDER_MODE=mock`. כך אפשר לעבור על כל
> הזרימה — הפעלת סוכן, יצירת job, הרצה, אישור, החלה — בלי לשלוח בקשה
> אמיתית אחת ובלי עלות. אחרי שהכול נראה תקין, מעבירים ל-`live`.

---

## 3. Edge Functions

```bash
supabase functions deploy ai-gateway
supabase functions deploy ai-worker  --no-verify-jwt
supabase functions deploy ai-cron    --no-verify-jwt
supabase functions deploy ai-learn   --no-verify-jwt
supabase functions deploy ai-comms
supabase functions deploy integrations-google
supabase functions deploy webhook-whatsapp   --no-verify-jwt
supabase functions deploy webhook-telephony  --no-verify-jwt
```

### למה `--no-verify-jwt` על חמש מהן, וזה לא פרצה

לפונקציות האלה אין משתמש מחובר: ה-cron קורא ל-`ai-worker` ול-`ai-learn`, Meta
קוראת ל-`webhook-whatsapp`. אימות JWT היה חוסם אותן לחלוטין. במקום זה, **כל
אחת מהן מאמתת את עצמה בקוד**:

| פונקציה | מנגנון האימות |
|---|---|
| `ai-worker` | `assertServiceRole()` — רק service_role key מתקבל |
| `ai-cron` | `CRON_SECRET` בכותרת `x-cron-secret`, בהשוואה בזמן קבוע |
| `ai-learn` | service_role key או `CRON_SECRET`, בהשוואה בזמן קבוע. הרצה ידנית של בעל משרד עוברת דרך `ai-gateway` (`action:'learn'`), שמאמת אותו ומעביר הלאה את המשרד שלו בלבד |
| `webhook-whatsapp` | HMAC-SHA256 של גוף הבקשה מול `WHATSAPP_APP_SECRET`. **ללא הסוד — כל בקשה נדחית ב-503**, לא "מתקבלת בינתיים" |
| `webhook-telephony` | `webhook_secret` מ-`integration_connections.config`; ללא הגדרה — 503 |

---

## 4. תזמון — ⚠ הצעד שבלעדיו המערכת אינה אוטונומית

### המצב כרגע, ביושר
**pg_cron אינו מופעל בפרויקט.** זה מתועד מראש ב-
`supabase/functions/check-and-send-reminders/index.ts:14` — הרחבה זו לא
הופעלה, ותזכורות ה-Push הקיימות סובלות מאותה מגבלה.

**עד שמבצעים את הצעד הזה:** הסוכנים רצים רק כשמישהו מפעיל אותם, או כשהאפליקציה
פתוחה. מסך החיבורים מציג **"תזמון: לא פעיל"** במפורש. זו לא תקלה — זו הצגה
כנה של המצב.

### אפשרות א' — pg_cron (מומלץ)

Dashboard → Database → Extensions → הפעל `pg_cron` ו-`pg_net`. ואז:

```sql
select cron.schedule(
  'ai-center-tick', '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT-REF>.supabase.co/functions/v1/ai-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<CRON_SECRET שהגדרת>'
    ),
    body := jsonb_build_object('tasks', array['reap','drain','automations','learn'])
  );
  $$
);
```

בדיקה: `select * from cron.job;` · היסטוריה: `select * from cron.job_run_details order by start_time desc limit 10;`

#### `learn` בטיק של 5 דקות — למה זה בסדר
**הטיק אינו מריץ זיקוק כל 5 דקות.** `ai-learn` אוכף לכל משרד מרווח
מינימלי של **6 שעות** מ-`learning_last_run_at`, ומחזיר `skipped: 'too_soon'`
לפני שהוא נוגע בכלום. הסיבה אינה רק עלות: תיקון בודד שמזוקק לבדו מייצר לקח
גרוע יותר, כי המזקק לא רואה את התיקונים האחרים כדי לזהות בהם דפוס.

הרצה ידנית מטאב "למידה" עוקפת את מרווח 6 השעות — היא מוגבלת בנפרד לפעם בשעה,
ב-`ai-gateway`.

### אפשרות ב' — מתזמן חיצוני
כל שירות cron (cron-job.org, GitHub Actions, Netlify scheduled function) שקורא כל 5 דקות:
```
POST https://<PROJECT-REF>.supabase.co/functions/v1/ai-cron
x-cron-secret: <CRON_SECRET>
{"tasks":["reap","drain","automations","learn"]}
```

### אפשרות ג' — כלום
המערכת עובדת, אבל רק כשהאפליקציה פתוחה. מתאים להתחלה זהירה.

---

## 5. אינטגרציות (רשות)

### Google — Gmail + יומן
1. `console.cloud.google.com` → פרויקט חדש
2. Enable APIs: **Gmail API**, **Google Calendar API**
3. OAuth consent screen → External → הוסף את עצמך כ-Test user
4. Credentials → OAuth client ID → Web application
5. Authorized redirect URI — **בדיוק** זה:
   ```
   https://<PROJECT-REF>.supabase.co/functions/v1/integrations-google?action=callback
   ```
6. ```bash
   supabase secrets set GOOGLE_CLIENT_ID=...
   supabase secrets set GOOGLE_CLIENT_SECRET=...
   supabase secrets set EMAIL_PROVIDER_MODE=live
   ```
7. באפליקציה: מרכז AI → חיבורים → "חבר חשבון Google"

### WhatsApp
1. `developers.facebook.com` → אפליקציה → WhatsApp
2. Webhook URL: `https://<PROJECT-REF>.supabase.co/functions/v1/webhook-whatsapp`
3. Verify token: אותו ערך כמו `WHATSAPP_VERIFY_TOKEN`
4. Subscribe ל-fields: `messages`
5. secrets: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_PROVIDER_MODE=live`
6. **חובה** — לקשור את המספר למשרד, אחרת כל webhook נכנס יידחה:
   ```sql
   insert into integration_connections (office_id, provider, connection_type,
     account_identifier, account_name, status)
   values ('<OFFICE_ID>', 'whatsapp', 'api_key', '<PHONE_NUMBER_ID>', '<המספר>', 'connected')
   on conflict (office_id, provider) do update
     set account_identifier = excluded.account_identifier, status = 'connected';
   ```

### טלפוניה
טרם נבחר ספק. ראה `AI_CENTER_INTEGRATIONS.md` — הוספת ספק היא **הגדרה, לא קוד**.

---

## 6. Frontend

```bash
node build.mjs      # מוסיף ai-center.js ל-dist
git add -A && git commit -m "AI Center" && git push
```
Netlify בונה אוטומטית (`npm install && node build.mjs`).

---

## 7. בדיקות לפני הכרזה על סיום

```bash
npm test          # 75 בדיקות
node build.mjs    # חייב לעבור
```

| בדיקה | ידני | תקין כאשר |
|---|---|---|
| מרכז AI נגיש | סיידבר → "מרכז AI" | 13 טאבים נטענים |
| סוכנים נטענו | טאב סוכנים | 13 סוכנים ב-5 קטגוריות |
| הפעלת סוכן | סקירה → "הפעל את סוכן מנהל המשרד" | run נוצר, סטטוס מתקדם |
| ציר הפעולה | טאב הרצות → לחיצה | כל צעד עם קלט/פלט הכלי |
| מסלול האישור | הרץ סוכן שמציע משימה → אישורים → "אשר ובצע" | המשימה מופיעה במסך המשימות |
| **אישור חובה** | הפעל סוכן ניסוח | הטיוטה **לא** נשמרת עד לאישור |
| עצירת חירום | הגדרות → "עצור את כל הסוכנים" | הפעלה חדשה נחסמת ב-423 |
| תקציב | הורד תקציב יומי ל-$0.01 והפעל סוכן | נחסם ב-429 |
| סבב למידה | טאב למידה → "הרץ סבב למידה עכשיו" | `learning_last_run_at` מתעדכן; לחיצה שנייה נחסמת ב-429 |
| אימוץ לקח | אמץ תובנה → הרץ את אותו סוכן | שורה חדשה ב-`ai_memories` עם `memory_type='lesson'`, והלקח מופיע ב-`ai_runs.context_summary` של ההרצה הבאה |
| בידוד משרדים | משתמש ממשרד אחר | לא רואה שום `ai_*` |
| חיבורים | טאב חיבורים | מציג "לא מוגדר"/"לא מחובר" — לא "פעיל" |

### בדיקת RLS ידנית
```sql
-- כמשתמש מחובר (לא service_role):
select count(*) from ai_runs;                  -- רק של המשרד שלי
select encrypted_credentials from integration_connections;  -- חייב להיכשל בשגיאת הרשאה
```

---

## 8. Rollback

כל שינוי ניתן לביטול, לפי סדר עולה של חומרה:

```sql
-- 1. עצירה מיידית, בלי לגעת בכלום (מומלץ ראשון)
update ai_settings set emergency_stop = true;

-- 2. כיבוי כל האוטומציות
update automation_rules set is_active = false;

-- 3. השבתת כל הסוכנים
update ai_agents set status = 'disabled';

-- 3א. כיבוי הלמידה בלבד (לא עוצר סוכנים).
-- לקחים שכבר אומצו ממשיכים להשפיע — להסרתם: "בטל לקח" במסך הלמידה.
update ai_settings set learning_enabled = false;
```

```bash
# 4. הסרת הפונקציות
supabase functions delete ai-gateway ai-worker ai-cron ai-learn ai-comms
```

```html
<!-- 5. הסתרת ה-UI — שורה אחת ב-app.html -->
<div class="nav-item" id="nav-ai-center-item" style="display:none" ...>
```

```sql
-- 6. מחיקה מלאה (אחרון, ובלתי הפיך).
-- app_data — כל ה-CRM — לא מושפעת ולא נוגעים בה.
drop table if exists ai_run_steps, ai_runs, ai_approvals, ai_feedback, ai_jobs,
  ai_agent_tools, ai_agent_versions, ai_agents, ai_tools, ai_memories,
  ai_learning_insights, ai_usage_daily, ai_settings, integration_connections,
  communication_messages, communication_threads, automation_rules, audit_logs cascade;
drop view if exists integration_status;
```

---

## 9. תקלות נפוצות

| תסמין | סיבה | פתרון |
|---|---|---|
| "הסוכן לא נמצא" | ה-seed לא רץ | `supabase db push` |
| jobs נתקעים ב-queued | אין מתזמן | סעיף 4 |
| jobs נתקעים ב-running | worker נהרג באמצע | `select reap_stale_ai_jobs(10);` — ה-cron עושה זאת אוטומטית |
| "Failed to send a request" | CORS | הפונקציה חייבת להחזיר `CORS_HEADERS` על **כל** תשובה כולל OPTIONS (ראה `_shared/http.ts`) |
| "לא ניתן להצפין credentials" | `INTEGRATION_ENCRYPTION_KEY` חסר | סעיף 2 |
| webhook של WhatsApp מחזיר 503 | `WHATSAPP_APP_SECRET` חסר | מכוון — הגדר אותו |
| כל webhook נדחה (401) | חתימה לא תואמת | ודא שה-App Secret שייך לאותה אפליקציה |
| שינוי הגדרות נכשל | אינך owner | הגדרות/סוכנים/אוטומציות = בעל המשרד בלבד |
| "הלמידה כבויה" (400) | `learning_enabled = false` | הגדרות → "למד מהתיקונים שלי" |
| "סבב למידה רץ לאחרונה" (429) | חסימת שעה על הרצה ידנית | מכוון — המתן, או חכה לסבב מהמתזמן |
| אין תובנות אחרי סבב | אין עדיין מספיק סיגנלים, או שכולן כבר הוצעו/נדחו | תקין. תובנה שנדחתה לא תוצע שוב (`dedupe_key`) |
| אימוץ נכשל: "מותר לבעל המשרד בלבד" | `accept_learning_insight` בודק `is_office_owner()` | מכוון |
