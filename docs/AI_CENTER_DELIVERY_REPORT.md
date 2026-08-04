# AI_CENTER_DELIVERY_REPORT — דוח מסירה

תאריך: 04/08/2026 · ענף: `master` · בסיס: `e688d86`

---

## 1. מה נבנה

| שכבה | קבצים | מצב |
|---|---|---|
| מסד נתונים | 2 migrations — 16 טבלאות, RLS, 7 פונקציות | ✅ נכתב · ⏳ **טרם הורץ** |
| שכבת שרת | `_shared/` — 13 מודולים | ✅ |
| Edge Functions | 7 חדשות | ✅ נכתב · ⏳ **טרם נפרס** |
| סוכנים | 13 | ✅ בזריעה |
| כלים | 37 | ✅ |
| אוטומציות | 8 | ✅ **כבויות בכוונה** |
| Frontend | `src/ai-center.js` (98KB) + פאנל + 12 טאבים | ✅ |
| שילוב ב-CRM | כרטיס תיק, כרטיס לקוח, מסמכים, לידים | ✅ |
| בדיקות | 62 עוברות | ✅ |
| תיעוד | 12 מסמכים + `.env.example` | ✅ |

### קבצים חדשים (33)
```
docs/AI_CENTER_*.md                    12 מסמכים
.env.example
src/ai-center.js
supabase/migrations/20260804000000_ai_center.sql
supabase/migrations/20260804000001_ai_center_seed.sql
supabase/functions/_shared/            13 מודולים
supabase/functions/{ai-gateway,ai-worker,ai-cron,ai-comms,
                    integrations-google,webhook-whatsapp,webhook-telephony}/
test/ai-center-unit.test.js
test/ai-center-apply.test.js
```

### קבצים ששונו (4) — שינויים מינימליים בכוונה
| קובץ | שינוי | שורות |
|---|---|---|
| `src/app.html` | CSS למרכז ה-AI · פריט ניווט (**בסוף**) · פאנל · 2 מודלים | +~200 |
| `src/app.js` | hook ב-`nav()` · `db.leads` · 2 נקודות הזרקה לכפתורי AI | +8 |
| `build.mjs` | `ai-center.js` לרשימת הסקריפטים ולהעתקה | +8 |
| `supabase/functions/_shared/schema.ts` | שדה מפורש במקום parameter property (כדי שיהיה ניתן לבדיקה ב-Node) | +4 |

**`app_data` לא נגעה. `ai-proxy` לא נגע. אף עמודה לא נמחקה או שינתה שם.**

---

## 2. מה עובד — ונבדק

✅ **62 בדיקות עוברות** (`npm test`)
✅ **הבנייה עוברת** (`node build.mjs`)
✅ **29 קבצי TS נבדקו תחבירית** (esbuild parse)
✅ **אין סודות ב-`dist/`** — נסרק; הדבר היחיד בצד לקוח הוא ה-anon key, שמיועד לכך
✅ **אין רגרסיה** — 11 הבדיקות הקיימות ממשיכות לעבור

הלוגיקה הבאה נבדקת אוטומטית מול **הקוד האמיתי שרץ בשרת** (Node מייבא את
מודולי ה-TS ישירות, לא העתק שלהם):

- מנוע האישורים, כולל שהרשימה הקשיחה גוברת על `policy='never'` + `autonomy=4`
- ולידציית סכימה, כולל דחיית שדות לא מוכרים
- חישוב עלות ומדרגות תקציב
- זיהוי prompt injection + ניטרול בריחה מהתיחום
- נרמול טלפון, המרות תאריך בשני הפורמטים של ה-CRM
- **נתיב הכתיבה של האישורים** — כל שם שדה מאומת מול מה ש-app.js באמת קורא

---

## 3. ⚠ מה **לא** נבדק בהרצה חיה — הצהרה כנה

| רכיב | למה |
|---|---|
| ה-migrations על DB אמיתי | לא הורצו. `supabase db push` טרם בוצע |
| Edge Functions בפועל | לא נפרסו. אין Deno מקומי, אין פרויקט מקושר |
| לולאת tool-use מול Claude | דורשת מפתח וכסף |
| RLS בפועל | דורש DB חי עם שני משרדים |
| Gmail / יומן / WhatsApp | אין credentials |
| רינדור ה-UI בדפדפן | לא נפתח בדפדפן |

**לכן איני מכריז ש"הכול עובד".** הקוד נכתב, נבדק תחבירית, והלוגיקה הטהורה
נבדקה ביחידה. האינטגרציה מקצה לקצה דורשת את הצעדים בסעיף 5, ואת רשימת
הבדיקות הידניות ב-`AI_CENTER_DEPLOYMENT.md` §7.

---

## 4. מה במצב mock — ומוצג ככזה במסך

| רכיב | מצב | מה חסר |
|---|---|---|
| Anthropic | ✅ **פעיל** | — |
| Gmail | 🧪 mock | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` |
| Google Calendar | 🧪 mock | אותם |
| WhatsApp | 🧪 mock | `WHATSAPP_TOKEN`, `_PHONE_NUMBER_ID`, `_VERIFY_TOKEN`, `_APP_SECRET` |
| טלפוניה | 🧪 interface בלבד | 👤 **בחירת ספק — החלטה עסקית** |
| תזמון אוטומטי | ⛔ **לא פעיל** | pg_cron או cron חיצוני |

מסך "חיבורים" מציג את המצב האמיתי: "לא מוגדר" / "לא מחובר", **לא "פעיל"**.

**שליחה במצב mock נכשלת ב-503 מפורש** ואינה מסמנת את האישור כבוצע. גרסה
מוקדמת החזירה הצלחה כדי לאפשר בדיקת זרימה — וזו הייתה טעות: ההודעה נרשמה
כ"נשלחה", האישור ננעל, והמשתמש היה מאמין שהלקוח קיבל הודעה שמעולם לא נשלחה.
בדיקת הזרימה מתבצעת עד שלב האישור, שהוא ממילא החלק המעניין.
`listRecent()` מחזיר **ריק ולא נתונים פיקטיביים**.

---

## 5. מה צריך לעשות עכשיו — לפי סדר

```bash
# 1. גיבוי
supabase db dump -f backup-before-ai-center.sql

# 2. Migrations
supabase db push

# 3. Secrets
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...            # כנראה כבר קיים
supabase secrets set INTEGRATION_ENCRYPTION_KEY="$(openssl rand -base64 48)"
supabase secrets set CRON_SECRET="$(openssl rand -hex 32)"
supabase secrets set SITE_URL=https://zesty-marigold-0edcb2.netlify.app
supabase secrets set AI_PROVIDER_MODE=mock                   # ← להתחלה!

# 4. Functions
supabase functions deploy ai-gateway
supabase functions deploy ai-worker  --no-verify-jwt
supabase functions deploy ai-cron    --no-verify-jwt
supabase functions deploy ai-comms
supabase functions deploy integrations-google
supabase functions deploy webhook-whatsapp   --no-verify-jwt
supabase functions deploy webhook-telephony  --no-verify-jwt

# 5. Frontend
git add -A && git commit -m "AI Center" && git push
```

**המלצה חזקה:** להתחיל עם `AI_PROVIDER_MODE=mock`. כך אפשר לעבור על כל
הזרימה — הפעלת סוכן → job → הרצה → הצעה → אישור → החלה — בלי לשלוח בקשה
אמיתית אחת ובלי עלות. אחרי שהכול נראה תקין, `supabase secrets set AI_PROVIDER_MODE=live`.

ואז: `AI_CENTER_DEPLOYMENT.md` §7 — 10 בדיקות ידניות.

---

## 6. Webhooks להגדרה

| ספק | URL |
|---|---|
| Google OAuth | `https://<REF>.supabase.co/functions/v1/integrations-google?action=callback` |
| WhatsApp | `https://<REF>.supabase.co/functions/v1/webhook-whatsapp` |
| טלפוניה | `https://<REF>.supabase.co/functions/v1/webhook-telephony?office=<OFFICE_ID>` |

---

## 7. 👤 החלטות שנדרשות מבעל המשרד

| # | החלטה | ברירת מחדל |
|---|---|---|
| 1 | הפעלת pg_cron — **בלעדיה המערכת אינה אוטונומית** | לא פעיל |
| 2 | בחירת ספק טלפוניה | אין |
| 3 | תקציב AI | $5/יום, $50/חודש |
| 4 | אילו אוטומציות להדליק | כולן כבויות |
| 5 | חיבור Gmail — האם לתת למערכת גישה לתיבה | לא מחובר |
| 6 | האם רמה 4 (תזכורות) תפעל אוטומטית | לא |

---

## 8. בעיות ידועות

### נוגעות למרכז ה-AI
| # | בעיה | חומרה | מצב |
|---|---|---|---|
| 1 | **תזמון לא פעיל** — סוכנים רצים רק כשהאפליקציה פתוחה | 🔴 | מוצג במפורש ב-UI; SQL מסופק |
| 2 | חילוץ טקסט מ-PDF/DOCX בשרת לא ממומש | 🟠 | `read_document` מחזיר הסבר; הניתוח בדפדפן שומר `aiExtractedText` וממנו והלאה הכלי עובד |
| 3 | אין חיפוש סמנטי (pgvector) | 🟡 | דורש `create extension` שהפרויקט נמנע ממנו. `search_documents` עובד על keyword+metadata; מעבר ל-embeddings לא ידרוש שינוי בסוכנים |
| 4 | סוכן המחקר לא מצטט פסיקה | 🟡 | **מכוון.** אין מאגר; המצאת אסמכתה גרועה מ"לא ידוע" |
| 5 | `webhook-telephony` ללא ספק | 🟡 | מחזיר 503 בכוונה |

### נמצאו אגב ה-Audit — קיימות מלפני, לא בטווח
| # | בעיה | קובץ |
|---|---|---|
| 6 | `app.js:661` קורא `legalDocs.atf`, אבל הכותב (`1896`) כותב `atfDraft` → תגי ✓שכ"ט/✓י"כ בטבלת התיקים לעולם לא מוצגים | `app.js` |
| 7 | `draftDocument` כותב `ext:'docx'` — מחוץ ל-4 הדליים `pdf\|doc\|xls\|img`, ובלי `origName` | `app.js:4843` |
| 8 | אין Escape-key למודלים למרות הערה שטוענת שיש | `app.js:256` |
| 9 | מודל שנוסף ל-DOM דינמית לא מקבל backdrop-dismiss | `app.js:266` |

(#6 ו-#7 באגים אמיתיים שכדאי לתקן; מרכז ה-AI **הימנע** מהם — `aiSaveDraftDocx`
כותב `ext:'doc'` ו-`origName` תקינים.)

---

## 9. באג שנמצא ותוקן במהלך העבודה

`aiIdleDays` ב-`ai-center.js` השתמשה ב-`Math.round`, בעוד `daysSinceHE`
ב-`app.js:507` משתמשת ב-`Math.floor`. תיק שלא נגעו בו 13 ימים ו-16 שעות היה
נספר כ-14 — מסומן "תקוע" יום שלם מוקדם מדי, ומציג מספר שונה מזה שאותו מסך
מציג במקום אחר. **נתפס ע"י `test/ai-center-apply.test.js`, לא ע"י קריאה.**

---

## 9b. סבב סקירה שני — 20 באגים נוספים שנמצאו ותוקנו

לאחר המסירה הראשונית בוצעה סקירת קוד ייעודית לאיתור באגים (Edge Functions,
frontend ו-SQL בנפרד). להלן הממצאים המהותיים, כולם **תוקנו**:

### 🔴 קריטיים
| # | באג | למה זה מסוכן |
|---|---|---|
| 1 | **RLS שחוסם UPDATE לא מחזיר שגיאה** — PostgREST מחזיר הצלחה עם אפס שורות | עורך דין/מזכיר לוחץ "עצור את כל הסוכנים", רואה **"⛔ כל הסוכנים נעצרו"**, והסוכנים ממשיכים לרוץ. אותו דבר ב-8 מסכי כתיבה. תוקן ע"י `aiUpdateChecked()` שמאמת שהשורה נכתבה |
| 2 | **XSS דרך הצעת סוכן** — `Object.assign({id:uid()}, p)` נתן ל-payload לדרוס את המזהה, והמזהה מוזרק ל-onclick | מסמך של הצד שכנגד עם prompt injection יכול היה להריץ קוד אצל כל מי שיפתח את התיבה. תוקן ע"י היפוך הסדר + `aiJsAttr()` (escapeHtml לבדו **אינו** מספיק בתוך onclick) |
| 3 | **הסלמת סיכון בכלי נעלמה מהחלטת האישור** | `draft_email` לצד שכנגד מייצר הצעה קריטית, אבל ההחלטה חושבה לפי הכלי (medium) — מכתב לצד שכנגד יכול היה להתבצע אוטומטית |
| 4 | **mock דיווח "ההודעה נשלחה"** | האישור סומן `applied` והלקוח מעולם לא קיבל הודעה. mock עכשיו נכשל ב-503 מפורש |
| 5 | **`matter-summary` נותב אך לא נזרע** | "סכם לי את תיק כהן" — הדוגמה הראשונה במפרט — נכשלה ב-404 |

### 🟠 חמורים
- **`createCalendarEvent` — בדיקת האישור הייתה `if (approvalId)`**: השמטת הפרמטר עקפה אותה לגמרי. עכשיו חובה + בדיקת תפקיד + עצירת חירום + תפיסה אטומית.
- **שליחה כפולה**: read-then-act ללא claim → לחיצה כפולה שלחה ללקוח פעמיים. תוקן ב-compare-and-swap.
- **`ai_agent_tools` קיבל טריגר `updated_at` בלי שהעמודה קיימת** → כל UPDATE היה נופל.
- **`ai_usage_daily`**: `agent_id` nullable + NULLS DISTINCT → ה-upsert לא התאים אף פעם וצבר שורות ללא גבול.
- **`ai_jobs` UPDATE פתוח לכל חבר משרד** — כולל `payload`, כלומר מה שייאמר לסוכן. הוסר; ביטול/הרצה חוזרת עברו ל-RPC ממוקדות.
- **`getProvider` נפל בשקט ל-mock כשהמפתח חסר** → הרצות "מוצלחות" עם טקסט מומצא במערכת שמפיקה מסמכים משפטיים.
- **webhook של WhatsApp**: כשל בהודעה אחת הפיל את כל המנה, ו-200 מנע מ-Meta לשלוח שוב — ההודעות אבדו.
- **אוטומציה עם שתי פעולות הריצה רק את הראשונה** (מפתח idempotency לא כלל את מספר הפעולה).
- **`ai_run_steps`**: מספור הצעדים התאפס בהרצה חוזרת → ציר הפעולה של כל ניסיון חוזר נמחק בשקט על 23505.
- **null deref ב-worker** מחוץ ל-try → ה-job נשאר נעול 10 דקות ושאר האצווה ננטשה.
- **כישלון כתיבת אישור נבלע** → הרצה "ממתינה לאישור" בלי שום אישור לאשר.

### 🟡 בינוניים
- `reap_stale_ai_jobs` לא יכול היה לשחרר הרצה `pending` (`started_at` NULL) → תקועה לנצח.
- לחיצה על רקע `modal-ai-prompt` השאירה Promise תלוי → דחיית אישור/החזרה/משוב לא חזרו כלל.
- `aiIdleDays` החזירה null לתיק חדש, והקורא ספר null כ"תקוע" → **כל תיק שנפתח היום** דווח כ"ללא פעילות 14 יום".
- אינדקס התור היה בסדר עמודות הפוך מה-`ORDER BY`.
- `maybeSingle()` על `office_members` → 500 למשתמש שחבר בשני משרדים.
- `audit()` — ה-catch לא היה ניתן להגעה (supabase-js מחזיר `{error}` ולא זורק) → כשלי ביקורת בלתי נראים.
- חריגת עלות/צעדים דווחה כ-`completed` ואף ניסתה שוב עם backoff — כלומר שרפה עוד כסף.
- webhook טלפוניה: `uid()` אקראי לכל מסירה ביטל את הדדופליקציה.

### 📊 תיקון עובדתי
תעריף Opus 5 בטבלת העלויות היה **$15/$75** — הנתון הנכון הוא **$5/$25**. תוקן,
נוספו כל מודלי הדור הנוכחי, ונוספה בדיקה שנועלת את המחירון.
בנוסף: `temperature` נשלח מעתה **רק** למודלים שמקבלים אותו — הוא הוסר מדור
4.7 ואילך ומוחזר כשגיאת 400, ו-`default_model` ניתן לעריכה מהמסך.

---

## 10. שלוש בעיות אבטחה שנמצאו בסקירה עצמית ותוקנו

### א. `ai_spend_window` — דליפה חוצת-משרדים
הפונקציה `SECURITY DEFINER` ומקבלת `office_id` **כפרמטר**, עם
`grant execute to authenticated`. משמעות: כל משתמש מאומת יכול היה להעביר
מזהה של משרד אחר ולקרוא את נתוני ההוצאה שלו — `security definer` עוקף RLS
מעצם הגדרתו.

**תוקן:** אימות חברות בתוך הפונקציה עצמה.
```sql
where office_id = p_office_id
  and (auth.uid() is null or public.is_office_member(p_office_id));
```

### ב. `seed_ai_center_for_office` — יצירה במשרד זר
אותה תבנית. `revoke ... from authenticated` — שני הנתיבים שצריכים אותה
(ה-DO block והטריגר) רצים בהקשר definer ולא דרך ה-grant.

### ג. `encrypted_credentials` — RLS לבדו לא הספיק
RLS הוא מנגנון **שורות**, לא עמודות. בעל משרד היה יכול לקרוא את ה-refresh
token של Gmail של עצמו ולחלץ גישה לתיבת המייל.

**תוקן:** הרשאה ברמת העמודה.
```sql
revoke select on integration_connections from anon, authenticated;
grant select (id, office_id, provider, ...) on integration_connections to authenticated;
```
ניסיון `select encrypted_credentials` נכשל עכשיו בשגיאת הרשאה.

---

## 11. קריטריוני ההשלמה מהמפרט (30)

| # | קריטריון | מצב |
|---|---|---|
| 1 | מרכז שליטה נגיש מה-CRM | ✅ |
| 2 | עיצוב תואם | ✅ טוקנים קיימים בלבד, RTL, ללא dark mode (לא קיים במערכת) |
| 3 | מערכת סוכנים גמישה | ✅ סוכן = שורה |
| 4 | גרסאות prompts | ✅ |
| 5 | כלים והרשאות | ✅ 37 כלים, 5 רמות סיכון |
| 6 | jobs | ✅ `FOR UPDATE SKIP LOCKED` |
| 7 | runs | ✅ + `run_steps` |
| 8 | אישורים | ✅ 12 בחסימה קשיחה |
| 9 | audit log | ✅ insert-only |
| 10 | עלויות | ✅ תקציב $ + מסך |
| 11 | אוטומציות | ✅ 8, כבויות |
| 12 | תיבת תקשורת אחודה | ✅ |
| 13 | Gmail | ⏳ **מוכן לחיבור** — קוד מלא, חסר credential |
| 14 | Calendar | ⏳ אותו דבר |
| 15 | WhatsApp | ⏳ אותו דבר |
| 16 | שכבת טלפוניה | ✅ interface + mock + דרישות מתועדות |
| 17 | סוכנים בכרטיסי לקוח ותיק | ✅ |
| 18 | אין secrets ב-Frontend | ✅ נסרק |
| 19 | RLS נבדק | ⏳ **נכתב, לא הורץ מול DB חי** |
| 20 | הבנייה עוברת | ✅ |
| 21 | TypeScript ללא שגיאות | ⚠️ **נבדק תחבירית (esbuild); typecheck מלא דורש Deno שאינו מותקן** |
| 22 | lint עובר | ➖ **אין lint בפרויקט** (אין eslint/prettier — ראה Audit §1) |
| 23 | הבדיקות עוברות | ✅ 51 |
| 24 | אין regression | ✅ 11 הקיימות עוברות |
| 25 | תיעוד מלא | ✅ 12 מסמכים |
| 26 | מצב mock | ✅ לכל ספק |
| 27 | עצירת חירום | ✅ נבדק ב-3 מקומות |
| 28 | פעולות רגישות דורשות אישור | ✅ + בדיקה אוטומטית |
| 29 | עובד כשהמחשב כבוי | ⏳ **דורש הפעלת pg_cron** — הקוד מוכן |
| 30 | הוספת סוכן ללא שינוי ארכיטקטוני | ✅ INSERT בלבד |

**סיכום:** 24 ✅ · 5 ⏳ (תלויים בפריסה/credentials) · 1 ➖ (לא רלוונטי לפרויקט)

---

## 12. הצעות לשלב הבא

1. **להפעיל pg_cron** — הפער היחיד בין "עובד" ל"אוטונומי"
2. **לחבר Gmail** — פותח את סוכני קליטת הלידים ושירות הלקוחות באמת
3. לתקן את באגים #6/#7 מסעיף 8 (קיימים מלפני, קלים)
4. חילוץ טקסט מ-PDF בשרת — יאפשר ניתוח מסמכים אוטומטי בלי דפדפן פתוח
5. pgvector לחיפוש סמנטי — דורש החלטה על `create extension`
6. חיבור מאגר פסיקה — יסיר את מגבלת סוכן המחקר
7. אחרי חודש שימוש: לקרוא את `ai_feedback` ולכוונן prompts לפי מה שנדחה

---

## 13. שורה תחתונה

המערכת **נכתבה במלואה, נבדקה ביחידה, ובנויה להיפרס**. היא לא הופעלה מול
מסד נתונים חי או מול ספקים חיצוניים — זה דורש `supabase db push`,
`functions deploy` ו-credentials, שאינם בידי.

מה שכן ניתן לומר בביטחון: הבנייה עוברת, 51 הבדיקות עוברות, אין רגרסיה
בפונקציונליות הקיימת, `app_data` לא נגעה, אין סודות בצד הלקוח, ושלוש
בעיות אבטחה נמצאו ותוקנו בסקירה עצמית לפני המסירה.
