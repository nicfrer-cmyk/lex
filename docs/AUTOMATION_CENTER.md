# מרכז האוטומציות

מנוע אוטומציות דטרמיניסטי שרץ לצד סוכני ה-AI, לא במקומם.
רוב האוטומציות אינן דורשות מודל: "יש לך משימה באיחור 9 ימים" היא שאילתה,
לא הסקה. המודל נשמר למקום היחיד שבו הוא באמת מוסיף — יצירת טקסט.

---

## ארכיטקטורה

```
טריגר (triggers.ts)      → מחזיר "נושאים" מתוך app_data.data
    ↓
תנאים (conditions.ts)     → AND/OR/NONE מקונן, עם trace להסבר
    ↓
מנוע (engine.ts)          → grace · cooldown · dedupe · kill-switch
    ↓
פעולות (actions.ts)       → 10 פעולות, 3 מהן רגישות
    ↓
automation_runs + action_logs + metrics + notifications
```

**למה הכל ב-JS ולא ב-SQL:** אין טבלאות ל-cases/tasks/clients. כל ה-CRM
יושב ב-`app_data.data` (jsonb יחיד לכל משרד), ולכן אין `select ... where
status='active'`. הדרך היחידה היא לטעון את ה-blob ולסנן בזיכרון.

---

## שלוש רמות ביצוע

| רמה | מה קורה |
|---|---|
| `notify` | מזהה ומתריע. לא נוגע בכלום |
| `prepare` | יוצר רשומה ב-`ai_approvals` וממתין לאדם |
| `auto` | מבצע מיד |

**המחסום:** פעולה עם `sensitive: true` יורדת מ-`auto` ל-`prepare`
**תמיד**, ללא קשר להגדרה. `effectiveLevel()` ב-`actions.ts` אוכף את זה,
ובדיקה נועלת את הרשימה. הגדרה שגויה במסך אינה יכולה להיות מרחק של קליק
מפעולה בלתי הפיכה על תיק משפטי.

הפעולות הרגישות: `set_case_status`, `draft_message`, `webhook`.

---

## ארבעת המנגנונים שמונעים מטרד

מערכת אוטומציות שמציפה הופכת תוך שבוע למקור רעש שמתעלמים ממנו — וזה גרוע
יותר מלא להתקין אותה. כל אחד מהמנגנונים קיים בגלל כשל ספציפי:

| מנגנון | הכשל שהוא מונע |
|---|---|
| `activation_grace_at` | הדלקת "תיק ללא פעילות" על מסד עם היסטוריה מייצרת עשרות הצעות ברגע אחד |
| `cooldown_minutes` | תיק שתקוע חודש מייצר התראה כל יום במשך חודש |
| `deduplication_key` | אותה פעולה מבוצעת פעמיים |
| `failure_count` | כלל שבור צורח בלוג כל 5 דקות לנצח. אחרי 5 כשלים הוא מכבה את עצמו ומסביר למה |

---

## טבלאות

| טבלה | תפקיד |
|---|---|
| `automation_rules` | הכללים. **הורחבה**, לא הוחלפה |
| `automation_templates` | קטלוג. `requires` מסמן תבנית שלא ניתן להפעיל |
| `automation_runs` | הפעלה. `reason` בעברית — למה זה קרה |
| `automation_action_logs` | פעולה בודדת בתוך הפעלה |
| `automation_notifications` | מרכז ההתראות |
| `automation_metrics` | חיסכון מצטבר |
| `automation_event_queue` | outbox לעתיד (event-driven) |

האישורים נשארים ב-`ai_approvals` עם `source='automation'` — מרכז אישורים
אחד ולא שניים.

---

## איך מוסיפים

**טריגר חדש** — `triggers.ts`, אובייקט ל-`TRIGGERS`:

```ts
{
  type: 'my_trigger', label: '…', category: 'תיקים', kind: 'condition',
  description: '…',
  collect: (db, cfg, now, extra) => [ /* Subject[] */ ],
}
```

**פעולה חדשה** — `actions.ts`, אובייקט ל-`ACTIONS`. חובה גם `describe`
(מה היה קורה) וגם `run`. `describe` **אסור** שיגע בנתונים — הוא מה שמוצג
במצב הבדיקה.

**תבנית חדשה** — שורה ב-`automation_templates`. אם היא דורשת ישות שלא
קיימת, `requires: '{invoices}'` — היא תוצג כ"דורש הרחבה" ולא ניתנת להדלקה.

---

## מה לא נבנה, ולמה

נבדק בפועל מול `app_data.data`: קיימים `cases`, `clients`, `tasks`,
`events`, `docs`, `payments`, `timeEntries`, `trustTransactions`.

| מה שהמפרט ביקש | מצב |
|---|---|
| חשבוניות, גבייה, אבני דרך | ❌ אין ישות `invoices` |
| הוצאות | ❌ אין ישות `expenses` |
| "ללא אחראי", עומסי עובדים | ❌ אין שדה אחראי באף ישות |
| הוצאה לפועל (אזהרה, מסירה, עיקול) | ❌ הישויות לא קיימות |
| אוטומציות אבטחה | ❌ דורשות אירועי auth שאינם נחשפים |
| התאמות בנק לנאמנות | ❌ `trustTransactions` ריקה |
| 4 תפקידים נוספים | ❌ `office_members.role` תומך ב-3 בלבד |

התבניות **קיימות בקטלוג** עם `requires` ויעבדו בלי שינוי קוד ברגע
שהישות תיווצר.

---

## פריסה

```bash
supabase db push
supabase functions deploy automation-engine --no-verify-jwt
bash scripts/setup-cron.sh      # מתזמן — בלעדיו שום דבר לא רץ
```

מיגרציות: `20260804000005` (תשתית), `…006` (תבניות), `…007` (המרת פורמט).

---

## בדיקות

`test/automation-conditions.test.js` — 18 · `test/automation-triggers.test.js` — 17

מכסות במפורש: חלון שעות שקטות שחוצה חצות, `empty` שאינו כולל 0/false,
אופרטור לא מוכר שנכשל סגור, קבוצת `any` ריקה שאינה פוסלת, נפילה ל-`opened`
כשאין יומן, ונעילת רשימת הפעולות הרגישות.
