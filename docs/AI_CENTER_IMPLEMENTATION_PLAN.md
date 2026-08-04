# AI_CENTER_IMPLEMENTATION_PLAN — תוכנית יישום

> מסמך חי. מתעדכן בסוף כל milestone.
> מקרא: ✅ הושלם · 🔄 בתהליך · ⛔ חסום · 🔑 דורש פרטי התחברות · 👤 דורש החלטת בעל המשרד

---

## סטטוס כללי

| # | Milestone | סטטוס |
|---|---|---|
| M0 | Audit + Architecture | ✅ |
| M1 | Migration — 16 טבלאות + RLS + RPC | ✅ |
| M2 | שכבת שרת משותפת (`_shared/`) | ✅ |
| M3 | Gateway · Worker · Cron | ✅ |
| M4 | זריעת 13 סוכנים + 37 כלים | ✅ |
| M5 | UI מרכז השליטה | ✅ |
| M6 | שילוב במסכי CRM + AiCommandBar | ✅ |
| M7 | אינטגרציות (Google/WhatsApp/טלפוניה) | ✅ קוד · 🔑 credentials |
| M8 | אוטומציות | ✅ |
| M9 | בדיקות | ✅ 62 עוברות |
| M10 | תיעוד + דוח מסירה | ✅ 12 מסמכים |
| M11 | **פריסה** — `db push` + `functions deploy` | ⛔ **טרם בוצע** (ראה DELIVERY_REPORT §5) |

---

## M1 — Migration
**נוסף:** `supabase/migrations/20260804000000_ai_center.sql`
**שונה:** אין. `app_data` לא נגעה.
**migrations:** 16 טבלאות, RLS על כולן, `is_office_owner()`, `claim_ai_job()`, `next_ai_job_backoff()`, `ai_usage_daily_upsert()`.
**סיכונים:** `create extension` נמנע לחלוטין. הכול `if not exists` → הרצה חוזרת בטוחה.
**תנאי השלמה:** הרצת ה-migration פעמיים ברצף ללא שגיאה; RLS מונע גישה בין משרדים.

## M2 — שכבת שרת משותפת
**נוסף:** `supabase/functions/_shared/`: `db.ts`, `provider.ts`, `tools.ts`, `context.ts`, `approvals.ts`, `cost.ts`, `audit.ts`, `security.ts`, `schema.ts`, `crypto.ts`, `providers/{email,whatsapp,telephony,calendar}.ts`
**סיכונים:** Deno imports דרך `esm.sh` — מוצמד לגרסה.
**תנאי השלמה:** כל כלי עובר ולידציית schema; `MockProvider` מריץ לולאת tool-use מלאה.

## M3 — Gateway · Worker · Cron
**נוסף:** `functions/ai-gateway/`, `functions/ai-worker/`, `functions/ai-cron/`
**סיכונים:** ⛔ pg_cron לא מופעל → מפעיל B לא פעיל עד הרצת ה-SQL שסופק. עד אז ניקוז מהדפדפן.
**תנאי השלמה:** job עובר queued→running→completed; idempotency חוסם כפילות; `max_steps`/`max_cost` נאכפים.

## M4 — סוכנים וכלים
**נוסף:** `20260804000001_ai_center_seed.sql`
13 סוכנים: מנהל משרד · קליטת לידים · מכירות · פתיחת תיק · ניתוח מסמכים · סיכום תיק · ניסוח משפטי · ביקורת משפטית · מחקר · מועדים וסיכונים · שירות לקוחות · כספים · שיווק.
38 כלים עם `risk_level` ו-`requires_approval`.
**תנאי השלמה:** הוספת סוכן = INSERT בלבד, ללא שינוי קוד.

## M5 — UI
**נוסף:** `src/ai-center.js`, `src/ai-center.css` (מוטמע ב-app.html)
**שונה:** `app.html` (פאנל + פריט ניווט **אחרי** `#nav-templates-item` + מודלים), `app.js` (`nav()` hook בלבד), `build.mjs` (script חדש)
**סיכונים:** 🔴 אינדקסי `.nav-item` — נפתר ע"י הוספה בסוף בלבד.
**תנאי השלמה:** 12 טאבים עובדים; אין כפתור שאינו מחובר ל-backend.

## M6 — שילוב ב-CRM
**שונה:** `app.js` — כרטיס תיק (`openCaseDetail`), כרטיס לקוח, מסמך, ליד.
**סיכונים:** שינוי בפונקציות ענק קיימות → נקודות הזרקה מינימליות בלבד (`AiActionButton`).

## M7 — אינטגרציות
**נוסף:** `functions/integrations-google/`, `functions/webhook-whatsapp/`, `functions/webhook-telephony/`
**🔑 חסר:** `GOOGLE_CLIENT_ID/SECRET`, `WHATSAPP_TOKEN/PHONE_ID/VERIFY_TOKEN`, ספק טלפוניה (👤 החלטת בעל המשרד).
**תנאי השלמה:** מסך integrations מציג **"לא מחובר"** באמת, לא בהעמדת פנים.

## M8 — אוטומציות
5 אוטומציות התחלתיות: סיכום בוקר · ליד חדש · מסמך חדש · לקוח ללא עדכון · תשלום באיחור · שיחה שלא נענתה.

## M9 — בדיקות
`test/ai-center-*.test.js` — unit (schema, cost, lead scoring, phone, dates, idempotency, routing, approvals, injection) + integration (job→worker→run→approval, mock providers) + security (RLS, tampering, forged webhook, secrets).

## M10 — תיעוד
11 מסמכי `docs/AI_CENTER_*.md` + `.env.example` + `AI_CENTER_DELIVERY_REPORT.md`.

---

## פריטים חסומים / דורשים החלטה

| # | פריט | סוג |
|---|---|---|
| 1 | הפעלת pg_cron (SQL מסופק ב-`AI_CENTER_DEPLOYMENT.md`) | 👤 |
| 2 | Google Cloud project + OAuth credentials | 🔑 |
| 3 | WhatsApp Business Cloud API | 🔑 |
| 4 | בחירת ספק טלפוניה | 👤 |
| 5 | תקציב AI חודשי (ברירת מחדל $50) | 👤 |
| 6 | האם רמה 4 (תזכורות) תפעל אוטומטית — ברירת מחדל: **לא** | 👤 |
