# מה נשאר להעלות לאוויר — מדריך הפעלה (30.10.2026)

כל הקוד של שלבים א'–ו' נמצא ב-`master`, ונטליפיי כבר מפרסם את צד הדפדפן.
שני דברים נשארו, כי מצב ההרשאות האוטומטי חסם אותי מלהריץ אותם מול המערכת החיה:
**מיגרציות SQL** ו**פריסת Edge Functions**. אלה הצעדים, לפי הסדר.

---

## 1. מיגרציות SQL (חובה, ובהקדם)

> ⚠ **מיגרציית שלב א' לא רצה על המערכת החיה.** בדקתי: הטבלה `app_data_history`
> לא קיימת, ומדיניות ה-`_own` הישנות עדיין שם. כלומר הפרצה שמאפשרת להשתלט על משרד
> (RLS-1) עדיין פתוחה בייצור.

**לפני הכל: גיבוי** (Supabase ← Database ← Backups).

ב-Supabase ← SQL Editor, יש להריץ את שני הקבצים **לפי הסדר**. מעתיקים את תוכן הקובץ, מדביקים ולוחצים Run:

1. `supabase/migrations/20261030000000_stage_a_security.sql`
2. `supabase/migrations/20261030000001_stage_b_restore.sql`

שני הקבצים בטוחים להרצה חוזרת, ואינם משנים או מוחקים נתונים קיימים.
**לא להשתמש ב-`supabase db push`**: הוא עלול להחיל גם מיגרציות של מרכז השיחות.

**בדיקה אחרי ההרצה** (קריאה בלבד):
```sql
select
  (select count(*) from public.app_data_history) as snapshots,
  (select count(*) from pg_trigger where tgname in ('app_data_snapshot_trg','office_invites_guard_update_trg')) as triggers,
  (select count(*) from pg_policies where policyname like '%\_own' escape '\' and tablename in ('app_data','objects')) as legacy_policies_left,
  (select count(*) from pg_proc where proname in ('list_app_data_versions','restore_app_data_version')) as restore_fns;
```
מה אמור לחזור:
- `snapshots` שווה למספר המשרדים
- `triggers` = 2
- `legacy_policies_left` = 0
- `restore_fns` = 2

## 2. פריסת Edge Functions (מתוך `master`)

מריצים מתיקיית הפרויקט, על `master`:

```bash
git switch master
```
```bash
npx supabase functions deploy webdav --no-verify-jwt --project-ref syxutnwbpjsvzlwfpvyc
```
```bash
npx supabase functions deploy ai-gateway --project-ref syxutnwbpjsvzlwfpvyc
```
```bash
npx supabase functions deploy ai-comms --project-ref syxutnwbpjsvzlwfpvyc
```
```bash
npx supabase functions deploy ai-cron --no-verify-jwt --project-ref syxutnwbpjsvzlwfpvyc
```
```bash
npx supabase functions deploy ai-worker --no-verify-jwt --project-ref syxutnwbpjsvzlwfpvyc
```
```bash
npx supabase functions deploy ai-learn --no-verify-jwt --project-ref syxutnwbpjsvzlwfpvyc
```
```bash
npx supabase functions deploy webhook-whatsapp --no-verify-jwt --project-ref syxutnwbpjsvzlwfpvyc
```
```bash
npx supabase functions deploy automation-engine --no-verify-jwt --project-ref syxutnwbpjsvzlwfpvyc
```

מה כל פריסה מביאה:
- **webdav:** הגנה מפני קובץ ריק, ותקרה של 50MB.
- **ai-gateway, ai-comms, ai-worker, ai-cron, ai-learn, webhook-whatsapp, automation-engine:**
  - תיקון הדליפה בין משרדים ב-`normalizeDb`.
  - עטיפת תוכן חיצוני כ"לא מהימן" לפני שהוא מגיע ל-AI.
  - ב-ai-comms: כל הבדיקות רצות לפני שהאישור נתפס.
  - ב-ai-cron: מנוע האוטומציות הישן כבוי.

`ai-proxy` כבר נפרס (v13) ולא השתנה מאז.

## 3. ענף מרכז השיחות

הפונקציות `call-center`, `voice-gateway` ו-`voice-tool-webhook` רצות בייצור מתוך
`feature/ai-call-center`, ענף שלא מוזג. הענף גובה ל-GitHub. לפני שממזגים אותו:
- **בסיס:** יש לבסס אותו מחדש על `master`. צפויות התנגשויות ב-`src/platform.web.js`,
  `src/db-merge.js` ו-`src/app.js`, כי `master` כבר כולל גרסה מתקדמת יותר של מנגנון השמירה.
- **תיקוני שלב א':** יש להחיל עליו את תיקוני שלב א' ממרכז השיחות (הענף `fix/stage-a-security`).
- **בעיות שעדיין פתוחות בו:**
  - SEC-2: חתימת ה-HMAC של שער הקול לא כוללת את מזהה המשרד.
  - שער הקול חושף את ה-API הניהולי שלו (פורט 8080) בלי אימות.

## 4. מדיניות CSP

כרגע ה-CSP במצב Report-Only. אחרי כמה ימי עבודה רגילה, בודקים בקונסול הדפדפן (F12) שאין
אזהרות "Content-Security-Policy". אם אין, משנים ב-`build.mjs` את
`Content-Security-Policy-Report-Only` ל-`Content-Security-Policy`.

## 5. פרטי המשרד

- **החשבון שלך** (nicfrer@gmail.com) מקבל אוטומטית את פרטי המשרד שהיו קודם בקוד.
- **כל משרד אחר** צריך למלא אותם ב"הגדרות ← פרטי המשרד במסמכים". בלי הפרטים האלה,
  הסוכן לא יפיק מסמך משפטי.
