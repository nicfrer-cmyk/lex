# AI_CENTER_AUTOMATIONS — מנוע האוטומציות

מימוש: `supabase/functions/ai-cron/index.ts`. טבלה: `automation_rules`.

---

## מבנה

```
Trigger  →  אוסף "נושאים" (תיק / לקוח / ליד / משרד)
   ↓
Conditions  →  מסננת (AND בין כולם)
   ↓
Actions  →  כל נושא ששרד הופך ל-job בתור
   ↓
Approval Policy  →  כל פעולה שנוצרת עוברת דרך מסך האישורים
```

---

## ⚠ כולן כבויות כברירת מחדל

`is_active = false` בזריעה. אוטומציה שמתחילה לרוץ מעצמה — ומתחילה להכין
הודעות — ברגע שהמערכת עולה, היא בדיוק ההפתעה שאסור לעשות לבעל משרד.
הוא מדליק אותן מהמסך, אחת-אחת, כשהוא מוכן.

---

## הגנת idempotency — למה המנוע בטוח להרצה כל 5 דקות

```ts
const key = await stableHash('automation', rule.id, subject.kind, subject.id, todayISO());
```

המפתח כולל את **היום**. אותו תיק, באותה אוטומציה, ייצור job אחד ביום —
לא 288. בלי זה, כל טעות בתזמון הייתה הופכת להצפה של הרצות בתשלום.

בנוסף `max_per_run` (ברירת מחדל 10) חוסם גל ראשון: משרד עם 200 תיקים
תקועים לא יפתח 200 הרצות בבת אחת בהפעלה הראשונה.

---

## Triggers

| trigger | נושאים | config |
|---|---|---|
| `daily_digest` | המשרד | `hour` (ברירת מחדל 8) |
| `new_lead` | לידים ללא ניקוד | `max_per_run` |
| `document_unanalyzed` | מסמכים עם קובץ ובלי `aiAnalyzedAt` | `max_per_run` |
| `client_no_update` | לקוחות עם תיק פעיל | `days` (30) |
| `payment_overdue` | תיקים עם יתרה | `min_balance` (1000) |
| `matter_inactive` | תיקים ללא יומן | `days` (14) |
| `deadline_approaching` | אירועים קרובים | `days` (7) |
| `task_overdue` | משימות באיחור | `max_per_run` |

---

## Conditions

`[{field, op, value}]` — AND בין כולם.

**Fields:** `matter.*` · `client.*` · `lead.*` · או מפתח מ-`subject.meta`
**Ops:** `eq` `neq` `gt` `gte` `lt` `lte` `in` `contains` `exists` `empty`

```json
[
  {"field": "matter.status", "op": "neq", "value": "closed"},
  {"field": "balance", "op": "gte", "value": 5000},
  {"field": "matter.caseType", "op": "eq", "value": "debt"}
]
```

---

## Actions

```json
[{"agent": "office-manager", "job_type": "daily_digest",
  "goal": "הכן את סיכום הבוקר", "priority": 3}]
```

`priority`: 1 = דחוף ביותר, 9 = הכי פחות. ה-worker מושך לפי עדיפות ואז לפי זמן.

---

## 8 האוטומציות המזורעות

| שם | trigger | סוכן |
|---|---|---|
| סיכום בוקר | `daily_digest` 08:00 | מנהל המשרד |
| ליד חדש — סיווג וניקוד | `new_lead` | קליטת לידים |
| מסמך חדש — ניתוח | `document_unanalyzed` | ניתוח מסמכים |
| לקוח ללא עדכון | `client_no_update` 30 יום | שירות לקוחות |
| תשלום באיחור | `payment_overdue` ₪1,000+ | כספים וגבייה |
| תיק ללא פעילות | `matter_inactive` 14 יום | מנהל המשרד |
| מועד מתקרב | `deadline_approaching` 7 ימים | מועדים וסיכונים |
| משימה באיחור | `task_overdue` | מנהל המשרד |

בנוסף, שני טריגרים מבוססי-אירוע שלא עוברים דרך ה-cron אלא דרך webhook:
- **הודעת WhatsApp ממספר לא מוכר** → ליד + סוכן קליטת לידים
- **שיחה שלא נענתה** → משימת חזרה + הודעת המשך מוצעת

---

## מפסקים

| מפסק | השפעה |
|---|---|
| `automation_rules.is_active` | כלל בודד |
| `ai_settings.automations_paused` | כל האוטומציות במשרד |
| `ai_settings.emergency_stop` | הכול, כולל הרצות שכבר באוויר |

שני האחרונים נבדקים ב-`runAutomations()` **לפני** טעינת ה-blob, וגם
ב-`claim_ai_job()` ברמת ה-SQL.

---

## הוספת אוטומציה

```sql
insert into automation_rules (office_id, name, description, trigger_type,
  trigger_config, conditions, actions, is_active, requires_approval)
values ('<OFFICE>', 'תיקי חוב גדולים תקועים',
  'תיק חוב מעל ₪50,000 ללא פעילות 7 ימים',
  'matter_inactive', '{"days":7,"max_per_run":5}',
  '[{"field":"matter.caseType","op":"eq","value":"debt"},
    {"field":"matter.amount","op":"gte","value":50000}]',
  '[{"agent":"office-manager","job_type":"stuck_matter",
     "goal":"בדוק מדוע התיק תקוע והצע פעולת המשך","priority":2}]',
  false, true);
```

trigger חדש דורש ענף ב-`collectSubjects()`; שאר ההרכבות הן נתונים בלבד.

---

## אבחון

```sql
select name, is_active, last_run_at, last_run_status, run_count
from automation_rules order by last_run_at desc nulls last;

select job_type, status, count(*) from ai_jobs
where trigger_type = 'automation' group by 1, 2;
```

**"נמצאו 0 פריטים" חוזר?** התנאים מסננים הכול, או שהנושאים באמת לא קיימים.
**jobs נוצרים אך נשארים ב-queued?** אין מתזמן — ראה `AI_CENTER_DEPLOYMENT.md` §4.
