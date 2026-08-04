# AI_CENTER_DATABASE — מסד הנתונים

קבצים: `supabase/migrations/20260804000000_ai_center.sql` (מבנה),
`20260804000001_ai_center_seed.sql` (זריעה) ו-`20260804000002_ai_learning.sql`
(לולאת הלמידה). כולם idempotent.

---

## כללי יסוד

1. **כל טבלה:** `office_id uuid not null references offices(id) on delete cascade`
2. **כל טבלה:** RLS מופעל, גישה דרך `is_office_member(office_id)`
3. **`client_id` / `matter_id` הם `text` ללא FK** — הם מזהי `uid()` (base36)
   מתוך ה-blob של `app_data`, לא שורות בטבלה. אין ל-FK למה להצביע.
4. **`app_data` לא שונתה.** אף עמודה לא נמחקה, אף שם לא הוחלף. אפס סיכון לאובדן.
5. **אין `create extension`** — הפרויקט נמנע מכך בכוונה (ראה fix12-15).

---

## הטבלאות

### תשתית הסוכנים
| טבלה | תפקיד | הערה |
|---|---|---|
| `ai_agents` | רישום סוכנים | `unique(office_id, slug)` |
| `ai_agent_versions` | גרסאות prompt | אינדקס חלקי ייחודי → גרסה פעילה אחת |
| `ai_tools` | קטלוג כלים | `risk_level`: none→critical |
| `ai_agent_tools` | הרשאות סוכן↔כלי | **ה-worker בודק מולה לפני כל ביצוע** |

### ריצה
| טבלה | תפקיד |
|---|---|
| `ai_jobs` | תור. `unique(office_id, idempotency_key)`. **אין policy ל-UPDATE** — ביטול/הרצה חוזרת דרך `cancel_ai_job()` / `retry_ai_job()` |
| `ai_runs` | הרצה: מודל, tokens, עלות, `flags`, `context_summary` |
| `ai_run_steps` | כל צעד: `tool_input`, `tool_output`, `model_output` |
| `ai_approvals` | הצעות ממתינות. `proposed_payload` / `edited_payload`. `learned_at` = הסבב שכבר קרא אותה |
| `ai_feedback` | דירוג המשתמש. `learned_at` שמור לסבב הלמידה |

### נתונים
| טבלה | תפקיד |
|---|---|
| `ai_memories` | זיכרון office/client/matter/user/agent + מקור וביטחון |
| `ai_usage_daily` | אגרגציה יומית לעלויות |
| `ai_settings` | תקציב, מפסקים, `office_memory`, הגדרות למידה. שורה לכל משרד |
| `integration_connections` | credentials מוצפנים |
| `communication_threads` / `_messages` | תיבה אחודה |
| `automation_rules` | Trigger/Conditions/Actions |
| `audit_logs` | insert-only |

### למידה
| טבלה | תפקיד | הערה |
|---|---|---|
| `ai_learning_insights` | לקחים שהלומד **מציע** מתוך התיקונים והדפוסים | `unique(office_id, dedupe_key)` — אותה תובנה לא תיווצר פעמיים |

#### עמודות `ai_learning_insights`
| עמודה | טיפוס | תפקיד |
|---|---|---|
| `id` | uuid pk | |
| `office_id` | uuid not null → `offices` cascade | |
| `agent_id` | uuid → `ai_agents` cascade | הסוכן שאליו הלקח שייך. `null` = לקח ברמת המשרד |
| `kind` | text check | `correction` (עריכה/דחייה/החזרה) · `repetition` (אושר נקי שוב ושוב) · `recurring_task` (הרצה ידנית חוזרת) · `failure_pattern` (אותה שגיאה חוזרת) |
| `title` | text not null | הכותרת שמוצגת במסך הלמידה |
| `lesson` | text not null | **נוסח הלקח** — נכנס כמו שהוא ל-prompt של הסוכן אחרי אימוץ |
| `evidence` | jsonb not null default `{}` | מזהי אישורים, ספירות, diffs. מוצג למשתמש לפני האימוץ |
| `occurrences` | int not null default 1 | כמה מופעים עומדים מאחורי התובנה |
| `confidence` | numeric default 0.5, `between 0 and 1` | נגזר מכמות הראיות |
| `suggested_action` | jsonb | הצעה מבנית: `{"type":"raise_autonomy",...}` או `{"type":"create_automation",...}` |
| `status` | text default `proposed` | `proposed` · `accepted` · `dismissed` · `superseded` |
| `memory_id` | uuid → `ai_memories` on delete set null | הזיכרון שנוצר באימוץ — **זה מה שמאפשר לבטל אימוץ** |
| `reviewed_by` / `reviewed_at` | uuid → `auth.users` / timestamptz | מי אימץ או דחה, ומתי |
| `dismiss_reason` | text | למה נדחתה |
| `dedupe_key` | text | מונע יצירה חוזרת של אותה תובנה בכל סבב |
| `created_at` / `updated_at` | timestamptz | `updated_at` בטריגר `ai_touch_updated_at()` |

**RLS:** SELECT דרך `is_office_member()`; UPDATE דרך `is_office_owner()` בלבד.
**אין policy ל-INSERT** — רק `ai-learn` (service_role) יוצר תובנות.

**האינדקס הייחודי על `dedupe_key` מלא, לא חלקי.** `ai-learn` כותב עם
`on conflict (office_id, dedupe_key) do nothing`, ו-Postgres אינו יכול להסיק
אינדקס חלקי מרשימת עמודות בלבד — הוא נופל ב-42P10 על **כל** הכנסה, גם בלי
התנגשות. כלומר `where status='proposed'` היה מפיל כל סבב למידה. זו גם הסמנטיקה
הנכונה: `ai-learn` מסנן ממילא מפתחות שקיימים ב-`proposed`, `accepted` **או**
`dismissed` — תובנה שנדחתה לא אמורה לחזור בכל סבב.

#### עמודות שנוספו לטבלאות קיימות
| טבלה | עמודה | תפקיד |
|---|---|---|
| `ai_approvals` | `learned_at timestamptz` | מסמן שהשורה כבר נקראה בסבב למידה. בלעדיה כל סבב היה קורא את כל ההיסטוריה ומייצר שוב את אותן תובנות, בתשלום. אינדקס חלקי `where learned_at is null` |
| `ai_feedback` | `learned_at timestamptz` | אותו תפקיד. **הסבב הנוכחי אינו קורא `ai_feedback`** — העמודה קיימת לקראת הוספת הדירוגים לסיגנלים |
| `ai_settings` | `learning_enabled boolean not null default true` | מפסק הלמידה למשרד. `ai-learn` שולף רק משרדים שבהם `true` |
| `ai_settings` | `learning_repetition_threshold int not null default 5` | כמה אישורים נקיים ברצף לפני שתוצע העלאת עצמאות (משמש גם כסף למשימות חוזרות) |
| `ai_settings` | `learning_last_run_at timestamptz` | מועד הסבב האחרון. עליו נשענים גם מרווח 6 השעות בין סבבי cron וגם חסימת ההרצה הידנית לפעם בשעה |

---

## פונקציות

| פונקציה | תפקיד |
|---|---|
| `is_office_owner(uuid)` | בעלים? (נדרש לאינטגרציות והגדרות) |
| `claim_ai_job(text)` | **לב התור** — `FOR UPDATE SKIP LOCKED` |
| `release_ai_job(...)` | סיום/כישלון עם backoff אקספוננציאלי |
| `reap_stale_ai_jobs(int)` | מחזיר לתור jobs שננעלו ע"י worker שמת |
| `cancel_ai_job(uuid)` | ביטול מהדפדפן — עמודות סטטוס בלבד |
| `retry_ai_job(uuid)` | הרצה חוזרת מהדפדפן — עמודות סטטוס בלבד |
| `ai_usage_daily_upsert(...)` | צבירת עלות |
| `ai_spend_window(uuid)` | הוצאה היום/החודש בזמן ישראל |
| `seed_ai_center_for_office(uuid)` | זריעה, idempotent |
| `ai_learning_stats(uuid, int)` | לכל סוכן: סה"כ / תיקנת / דחית / החזרת / עבר נקי / **שיעור תיקון**. `stable`, חסום ל-`is_office_member()` |
| `accept_learning_insight(uuid)` | אימוץ אטומי — מחזיר `memory_id` |
| `dismiss_learning_insight(uuid, text)` | דחייה עם סיבה. מחזיר `false` למי שאינו בעלים |
| `revert_learning_insight(uuid)` | ביטול אימוץ — **מוחק את הזיכרון שנוצר** |

### אימוץ תובנה — מה קורה בפועל
`accept_learning_insight()` הוא `security definer` עם בדיקת `is_office_owner()`
**מפורשת** בגוף הפונקציה, כי הוא כותב ל-`ai_memories` שהיא owner-only. הוא
יוצר בפעולה אחת שורת `ai_memories` עם `memory_type='lesson'`,
`source_type='user'`, `confidence_score=1.0`, `verified=true`, וקושר אותה
לתובנה דרך `memory_id`:

| `agent_id` בתובנה | `scope_type` בזיכרון | `scope_id` |
|---|---|---|
| קיים | `agent` | `agent_id` |
| `null` | `office` | `null` |

**הנפילה ל-`office` אינה קוסמטיקה:** `buildContext()` מסנן `scope='agent'`
לפי `scope_id` של סוכן קיים. זיכרון שנשמר כ-`('agent', null)` היה מוצג כ"פעיל"
במסך ולא נקרא אף פעם.

זו **הנקודה היחידה** שבה למידה משפיעה על התנהגות: מרגע האימוץ הלקח נכנס
לשכבת הזיכרון של ה-prompt בכל הרצה הבאה של אותו סוכן. `revert_learning_insight()`
מוחק את אותה שורה ומחזיר את המצב לקדמותו.

### למה `FOR UPDATE SKIP LOCKED`
זה מה שהופך טבלה רגילה לתור בטוח: שני workers לא יכולים לתפוס את אותה שורה —
השני מדלג במקום להמתין. בלי `SKIP LOCKED` היינו מקבלים או עבודה כפולה
(בלי נעילה) או תור סדרתי חנוק (עם נעילה רגילה).

### backoff
`30 × 2^(attempts-1)` שניות → 30s, 60s, 120s. אחרי `max_attempts` → `dead_letter`,
ולא נוגעים בו יותר אוטומטית.

---

## הרשאות מיוחדות

### `integration_connections` — הגנה בשתי רמות
```sql
create policy "integration_connections_select" ... using (is_office_member(office_id));
revoke select on integration_connections from anon, authenticated;
grant select (id, office_id, provider, ...) on integration_connections to authenticated;
```
RLS מגביל **שורות**; ה-GRANT הממוקד מגביל **עמודות**. בלי השני, בעל משרד היה
יכול לקרוא `encrypted_credentials` של עצמו ולחלץ refresh token של Gmail.

### `audit_logs`
SELECT בלבד. אין policy ל-UPDATE/DELETE — לוג שניתן לערוך אינו לוג.

### `ai_approvals`
UPDATE מוגבל ל-`owner` ו-`lawyer`. מזכיר/ה לא מאשר/ת פעולות משפטיות.

### `ai_learning_insights`
SELECT לכל חבר משרד, UPDATE ל-`is_office_owner()` בלבד — **גם ב-SQL, לא רק
ב-UI**. לקח שאומץ נכנס ל-prompt של הסוכן ומשפיע על כל טיוטה עתידית; זו החלטת
מדיניות ברמת המשרד, לא פעולה תפעולית.

---

## Realtime
`ai_runs`, `ai_jobs`, `ai_approvals`, `communication_messages` ו-
`ai_learning_insights` נוספו ל-`supabase_realtime`. RLS חל גם על Realtime —
אין חשיפה בין משרדים.

---

## אימות ההתקנה
```sql
select count(*) from ai_agents;   -- 13 לכל משרד
select count(*) from ai_tools;    -- 37
select count(*) from ai_settings; -- שורה לכל משרד
select count(*) from automation_rules where is_active;  -- 0 בכוונה
```
