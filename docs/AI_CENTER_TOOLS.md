# AI_CENTER_TOOLS — הכלים

מימוש: `supabase/functions/_shared/tools.ts`. רישום: `ai_tools` + `ai_agent_tools`.

---

## מה **לא** קיים, בכוונה

❌ `run_sql` ❌ `execute_query` ❌ `delete_any_record` ❌ `update_any_record`

כלי גנרי אחד מבטל את כל מערכת ההרשאות שמעליו. הפרומט אוסר עליהם, והאיסור
מיושם בכך שהם פשוט לא נכתבו.

---

## רמות סיכון

| רמה | משמעות | אישור |
|---|---|---|
| `none` | קריאה, בלי תופעת לוואי | ❌ |
| `low` | כתיבה פנימית לא מהותית | לפי רמת עצמאות |
| `medium` | טיוטה או משימה שאדם יראה | לפי מדיניות |
| `high` | פעולה חיצונית | ✅ בד"כ |
| `critical` | משפטי/כספי | ✅ **תמיד, לא ניתן לביטול** |

---

## 37 הכלים

### קריאה — סקירה (7)
`get_daily_overview` · `get_open_tasks` · `get_upcoming_deadlines` ·
`get_inactive_matters` · `get_overdue_payments` · `get_unhandled_leads` ·
`get_clients_waiting_for_reply`

### קריאה — תיק ולקוח (8)
`get_matter_summary` · `get_matter_documents` · `get_matter_timeline` ·
`get_matter_finance` · `list_matters` · `search_matters` ·
`get_client_summary` · `find_client_by_contact`

### קריאה — כללי (4)
`search_everything` · `read_document` · `search_documents` · `get_office_stats`

### קריאה — תקשורת (2)
`get_communications` · `get_thread`

### זיכרון (2)
`get_memory` (none) · `save_memory` (low)

### כתיבה — הצעות
| כלי | סיכון |
|---|---|
| `tag_document` | low |
| `update_lead_score` | low |
| `create_task` | medium |
| `add_diary_entry` | medium |
| `create_client` | medium |
| `create_lead` | medium |
| `draft_message` | medium (high אם משפטי) |
| `draft_email` | medium (**critical** אם לצד שכנגד) |
| `request_approval` | medium |
| `create_event` | high |
| `create_deadline` | high |
| `create_matter` | high |
| `send_email` | high |
| `draft_legal_document` | **critical** |

---

## כלי "כתיבה" לא כותב

כל כלי משנה-נתונים מחזיר **הצעה**:
```ts
propose(ctx, 'create_task', 'medium', { text, due, caseId, ... });
return ok(`הצעה למשימה "${text}" נוצרה. ${PENDING_NOTE}`);
```
ההודעה למודל אומרת במפורש "הפעולה טרם בוצעה — אל תדווח שהושלמה", כדי שהוא
לא יאמר ללקוח שמשהו נעשה.

ההצעה הופכת לשורה ב-`ai_approvals`, וההחלה בפועל נעשית ב-
`aiApplyApproval()` בדפדפן. הסיבה הכפולה (משפטית + lost-update על ה-blob)
מוסברת בראש `tools.ts`.

---

## שני כלים עם אכיפה קשיחה

### `create_deadline` — דורש מקור
```ts
if (!i.source_quote && !i.source_document_id) {
  return fail('מועד חייב לכלול מקור... אין לקבוע מועד ללא אסמכתה.');
}
```
נשמר עם `deadlineStatus: 'suggested'`; המעבר ל-confirmed קורה רק ברגע האישור.

### `draft_legal_document` — דורש את המילה "טיוטה"
```ts
if (!/טיוטה/.test(content)) {
  return fail('כל מסמך משפטי חייב לשאת את הסימון "טיוטה".');
}
```
הנחיה אפשר לשכוח; בדיקה בקוד לא.

---

## צינור הביצוע

```
1. TOOL_MAP.has(slug)?              — הכלי קיים
2. allowedSlugs.has(slug)?          — מותר לסוכן (מ-ai_agent_tools ב-DB)
3. validate(input, schema)          — ולידציה, דוחה שדות לא מוכרים
4. needsApproval(...)               — החלטת אישור
5. handler(input, ctx)              — ביצוע
6. ai_run_steps + audit_logs        — תיעוד
```

שלב 2 קורא מה-DB, **לא** מרשימת הכלים שנשלחה למודל. זו ההבחנה שמונעת הרחבת
סמכות: גם אם מודל שהושפע ממסמך זדוני "ימציא" קריאה לכלי — הבדיקה חוסמת.

---

## הוספת כלי

1. הוסף `ToolDef` ל-`TOOLS` ב-`_shared/tools.ts`
2. הוסף שורה ל-`ai_tools` (או לרשימה ב-seed)
3. שייך לסוכנים ב-`ai_agent_tools`

כלי שקיים ב-DB אך לא ב-`TOOLS` פשוט לא ייבחר (`TOOL_MAP.has` מסנן) —
כך שהוספה חלקית לא שוברת דבר.
