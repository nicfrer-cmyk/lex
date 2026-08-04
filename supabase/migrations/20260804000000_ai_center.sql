-- ============================================================================
-- מרכז שליטה לסוכני AI — סכמה
-- ============================================================================
--
-- שני ממצאים מה-Audit (docs/AI_CENTER_AUDIT.md) מעצבים את כל הקובץ הזה:
--
-- 1. אין טבלאות clients/cases/tasks/documents. כל ה-CRM הוא ערך jsonb יחיד
--    ב-app_data.data, שורה אחת לכל משרד, ומזהי הישויות בתוכו נוצרים ע"י
--    uid() ב-app.js — מחרוזות base36 (למשל "mdq3f8x2k9a1b"), לא UUID.
--    לכן client_id/matter_id כאן הם text ללא foreign key. FK ל-clients(id)
--    פשוט לא ניתן לכתיבה — אין טבלה כזו, וגם uuid לא היה מתאים לפורמט.
--
-- 2. גבול הבידוד היחיד במערכת הוא office_id, ו-RLS נאכף דרך
--    is_office_member() (supabase-schema-phase1-fix.sql:29). כל טבלה כאן
--    נושאת office_id not null ומשתמשת באותה פונקציה — לא במנגנון חדש.
--
-- הכול additive: אף טבלה קיימת לא משתנה, אף עמודה לא נמחקת או משנה שם,
-- ואין פעולה הרסנית. כל אובייקט נוצר עם "if not exists" / "drop policy if
-- exists" לפניו, כך שהרצה חוזרת של הקובץ בטוחה (אותו דפוס כמו fix*.sql).
--
-- הרצה: supabase db push  (או הדבקה ב-SQL Editor)
-- ============================================================================


-- ============================================================
-- 0. עזרי הרשאה
-- ============================================================

-- is_office_member() כבר קיימת. מה שחסר הוא "האם המשתמש הוא הבעלים" —
-- נדרש כי אינטגרציות, תקציבים, ומחיקת סוכן הן פעולות של בעל המשרד בלבד
-- (סעיף 8.1 בפרומט: "אינטגרציות נגישות רק למנהל").
-- security definer + search_path קבוע, בדיוק כמו is_office_member.
create or replace function public.is_office_owner(check_office_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.office_members
    where user_id = auth.uid() and office_id = check_office_id and role = 'owner'
  );
$$;

-- המשרד של המשתמש הנוכחי. משמש כברירת מחדל לעמודת office_id כדי שה-INSERT
-- מהדפדפן לא יצטרך לשלוח אותה (ולכן גם לא יוכל לזייף אותה בטעות).
create or replace function public.current_office_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select office_id from public.office_members where user_id = auth.uid() limit 1;
$$;


-- ============================================================
-- 1. ai_agents — רישום הסוכנים
-- ============================================================
-- סוכן = שורה, לא קוד. זו הדרישה המרכזית של סעיף 5 בפרומט ("בנה תשתית
-- גמישה שמאפשרת הוספה ועריכה של סוכנים ללא שינוי מהותי בקוד") ושל קריטריון
-- ההשלמה #30. הוספת סוכן חדש היא INSERT לכאן + INSERT ל-ai_agent_tools.
create table if not exists public.ai_agents (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  category text,
  status text not null default 'active' check (status in ('active','paused','disabled')),
  default_model text not null default 'claude-haiku-4-5-20251001',
  default_temperature numeric not null default 0.3,
  system_prompt text not null default '',
  -- 'always'  — כל פעולה של הסוכן דורשת אישור
  -- 'sensitive' — רק פעולות שסומנו רגישות (ברירת המחדל, ההתנהגות הבטוחה)
  -- 'never'   — פעולות רמה 1-2 בלבד רצות חופשי; הרשימה הקשיחה של פעולות
  --             שתמיד דורשות אישור גוברת גם כאן (ראה ai_approvals למטה)
  approval_policy text not null default 'sensitive' check (approval_policy in ('always','sensitive','never')),
  autonomy_level int not null default 2 check (autonomy_level between 1 and 4),
  max_steps int not null default 8,
  max_cost_per_run numeric not null default 0.50,
  timeout_seconds int not null default 120,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (office_id, slug)
);
create index if not exists ai_agents_office_idx on public.ai_agents(office_id);
alter table public.ai_agents enable row level security;

drop policy if exists "ai_agents_select" on public.ai_agents;
create policy "ai_agents_select" on public.ai_agents
  for select using (is_office_member(office_id));
-- שינוי הגדרות סוכן (prompt, מודל, תקציב) הוא שינוי בעל השלכות כספיות
-- ומשפטיות — בעלים בלבד.
drop policy if exists "ai_agents_insert" on public.ai_agents;
create policy "ai_agents_insert" on public.ai_agents
  for insert with check (is_office_owner(office_id));
drop policy if exists "ai_agents_update" on public.ai_agents;
create policy "ai_agents_update" on public.ai_agents
  for update using (is_office_owner(office_id)) with check (is_office_owner(office_id));
drop policy if exists "ai_agents_delete" on public.ai_agents;
create policy "ai_agents_delete" on public.ai_agents
  for delete using (is_office_owner(office_id));


-- ============================================================
-- 2. ai_agent_versions — גרסאות prompt
-- ============================================================
-- כל הרצה נשמרת עם agent_version_id, כך שאפשר להסביר בדיעבד למה סוכן
-- ענה מה שענה — גם אחרי שה-prompt שונה מאז. זו דרישה של מסך ההרצה
-- (סעיף 4.4: "גרסת prompt") ותנאי לשיפור מבוסס משוב.
create table if not exists public.ai_agent_versions (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  version_number int not null,
  system_prompt text not null,
  model_config jsonb not null default '{}'::jsonb,   -- {model,temperature,max_tokens,fallback_model}
  tools_config jsonb not null default '[]'::jsonb,   -- רשימת slugים של כלים מותרים
  output_schema jsonb,                                -- JSON Schema לפלט מובנה
  change_notes text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (agent_id, version_number)
);
create index if not exists ai_agent_versions_agent_idx on public.ai_agent_versions(agent_id, is_active);
alter table public.ai_agent_versions enable row level security;

drop policy if exists "ai_agent_versions_select" on public.ai_agent_versions;
create policy "ai_agent_versions_select" on public.ai_agent_versions
  for select using (is_office_member(office_id));
drop policy if exists "ai_agent_versions_write" on public.ai_agent_versions;
create policy "ai_agent_versions_write" on public.ai_agent_versions
  for all using (is_office_owner(office_id)) with check (is_office_owner(office_id));

-- רק גרסה אחת פעילה לכל סוכן. אינדקס חלקי ייחודי במקום trigger — זול,
-- ואי אפשר לעקוף אותו בטעות מקוד יישום.
create unique index if not exists ai_agent_versions_one_active
  on public.ai_agent_versions(agent_id) where is_active;


-- ============================================================
-- 3. ai_tools — קטלוג הכלים
-- ============================================================
-- risk_level הוא הציר שמנוע האישורים עובד לפיו. הוא לא קישוט:
--   none     — קריאה בלבד, אין תופעת לוואי
--   low      — כתיבה פנימית לא מהותית (תיוג, ציון ליד)
--   medium   — יוצר טיוטה או משימה שאדם יראה
--   high     — פעולה חיצונית (שליחת הודעה, יצירת אירוע)
--   critical — משפטי/כספי. תמיד אישור, לא ניתן לביטול בשום הגדרה
create table if not exists public.ai_tools (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  input_schema jsonb not null default '{}'::jsonb,
  output_schema jsonb,
  risk_level text not null default 'none' check (risk_level in ('none','low','medium','high','critical')),
  handler_name text not null,
  category text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (office_id, slug)
);
create index if not exists ai_tools_office_idx on public.ai_tools(office_id);
alter table public.ai_tools enable row level security;

drop policy if exists "ai_tools_select" on public.ai_tools;
create policy "ai_tools_select" on public.ai_tools
  for select using (is_office_member(office_id));
drop policy if exists "ai_tools_write" on public.ai_tools;
create policy "ai_tools_write" on public.ai_tools
  for all using (is_office_owner(office_id)) with check (is_office_owner(office_id));


-- ============================================================
-- 4. ai_agent_tools — אילו כלים מותרים לאיזה סוכן
-- ============================================================
-- זהו קו ההגנה האמיתי מפני prompt injection: גם אם מסמך זדוני "משכנע" את
-- המודל, הוא לא יכול להפעיל כלי שלא נמצא בטבלה הזו עבור הסוכן הרץ.
-- ה-worker בודק את הרשימה לפני כל ביצוע, ולא סומך על ה-tools שנשלחו למודל.
create table if not exists public.ai_agent_tools (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  tool_id uuid not null references public.ai_tools(id) on delete cascade,
  permission_level text not null default 'allow' check (permission_level in ('allow','deny')),
  requires_approval boolean not null default false,
  created_at timestamptz not null default now(),
  -- updated_at נדרש כי הטבלה נמצאת ברשימת הטריגרים בסוף הקובץ.
  -- ai_touch_updated_at() מבצע `new.updated_at = now()`, וגוף plpgsql אינו
  -- נבדק מול הטבלה בזמן יצירת הטריגר — כך שבלי העמודה הזו הטריגר נוצר
  -- בהצלחה, ורק ה-UPDATE הראשון (למשל שינוי requires_approval) נופל על
  -- שגיאת 42703. הזריעה משתמשת ב-do nothing ולכן לא הייתה חושפת זאת.
  updated_at timestamptz not null default now(),
  unique (agent_id, tool_id)
);
create index if not exists ai_agent_tools_agent_idx on public.ai_agent_tools(agent_id);
alter table public.ai_agent_tools enable row level security;

drop policy if exists "ai_agent_tools_select" on public.ai_agent_tools;
create policy "ai_agent_tools_select" on public.ai_agent_tools
  for select using (is_office_member(office_id));
drop policy if exists "ai_agent_tools_write" on public.ai_agent_tools;
create policy "ai_agent_tools_write" on public.ai_agent_tools
  for all using (is_office_owner(office_id)) with check (is_office_owner(office_id));


-- ============================================================
-- 5. ai_jobs — התור
-- ============================================================
-- pgmq/Supabase Queues אינו מותקן בפרויקט, ו-`create extension` הוא בדיוק
-- סוג השינוי שהפרויקט הזה נמנע ממנו בכוונה (ראה ההערות ב-fix12-15 וב-
-- check-and-send-reminders/index.ts:14 לגבי pg_cron). סעיף 3.4 בפרומט מאשר
-- במפורש את החלופה: "אחרת טבלת jobs עם locking בטוח" — וזו היא, עם
-- claim_ai_job() שמשתמש ב-FOR UPDATE SKIP LOCKED (ראה סעיף 17 למטה).
create table if not exists public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  agent_id uuid references public.ai_agents(id) on delete set null,
  job_type text not null,
  -- text ולא uuid, וללא FK: אלה מזהי uid() מתוך ה-blob של app_data. ראה
  -- ההערה בראש הקובץ.
  client_id text,
  matter_id text,
  user_id uuid references auth.users(id),
  priority int not null default 5 check (priority between 1 and 9),  -- 1 = דחוף ביותר
  status text not null default 'queued'
    check (status in ('queued','running','completed','failed','cancelled','dead_letter','waiting_approval')),
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  scheduled_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  attempts int not null default 0,
  max_attempts int not null default 3,
  -- ייחודי לכל משרד: אותו מפתח מהמשרד מחזיר את ה-job הקיים במקום ליצור
  -- שני. זה מה שמונע ניתוח כפול של מסמך, ליד כפול, ושליחה כפולה
  -- (סעיף 22 בפרומט). מפתחות שונים בין משרדים לא מתנגשים.
  idempotency_key text,
  trigger_type text not null default 'manual'
    check (trigger_type in ('manual','automation','webhook','schedule','chained')),
  last_error text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ai_jobs_idempotency
  on public.ai_jobs(office_id, idempotency_key) where idempotency_key is not null;
-- אינדקס הבחירה של ה-worker. הסדר תואם בדיוק את ה-ORDER BY ב-claim_ai_job.
-- סדר העמודות תואם בדיוק את ה-ORDER BY של claim_ai_job (priority, scheduled_at).
-- אינדקס בסדר הפוך אינו יכול לספק את המיון, ו-Postgres היה נאלץ למיין את כל
-- התור בכל תפיסת job.
create index if not exists ai_jobs_claim_idx
  on public.ai_jobs(priority, scheduled_at) where status = 'queued';
create index if not exists ai_jobs_office_idx on public.ai_jobs(office_id, created_at desc);
alter table public.ai_jobs enable row level security;

drop policy if exists "ai_jobs_select" on public.ai_jobs;
create policy "ai_jobs_select" on public.ai_jobs
  for select using (is_office_member(office_id));
-- הדפדפן לא יוצר jobs ישירות — ai-gateway עושה זאת עם service_role.
-- אין כאן policy ל-UPDATE בכוונה.
--
-- מדיניות UPDATE רחבה הייתה מאפשרת לכל חבר משרד לשכתב **כל עמודה** של כל
-- job בתור — כולל payload, שנושא את ה-goal, כלומר את מה שייאמר לסוכן.
-- משמעות: מזכיר/ה שחסום/ה מלהפעיל סוכן ניסוח משפטי (AGENT_ROLE_RESTRICTIONS
-- ב-ai-gateway) ומלאשר פעולות (המדיניות על ai_approvals) עדיין יכול/ה היה
-- לערוך את המשימה של סוכן כזה שכבר ממתינה בתור. ביטול והרצה חוזרת עוברים
-- דרך RPC ייעודיות למטה, שמגבילות בדיוק את מה שמותר לשנות.
drop policy if exists "ai_jobs_update_cancel" on public.ai_jobs;


-- ============================================================
-- 6. ai_runs — הרצה
-- ============================================================
create table if not exists public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  job_id uuid references public.ai_jobs(id) on delete cascade,
  agent_id uuid references public.ai_agents(id) on delete set null,
  agent_version_id uuid references public.ai_agent_versions(id) on delete set null,
  client_id text,
  matter_id text,
  user_id uuid references auth.users(id),
  trigger_type text not null default 'manual',
  status text not null default 'pending'
    check (status in ('pending','running','waiting_approval','completed','failed','cancelled','stopped')),
  goal text,
  input_data jsonb,
  context_summary text,        -- מה בדיוק נשלח למודל, לשקיפות ולביקורת
  output_data jsonb,
  model_provider text,
  model_name text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  estimated_cost numeric not null default 0,
  steps_used int not null default 0,
  -- דגלים תפעוליים: injection_suspected, budget_hit, max_steps_hit, timeout
  flags jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms int,
  error_code text,
  error_message text,
  created_at timestamptz not null default now()
);
create index if not exists ai_runs_office_idx on public.ai_runs(office_id, created_at desc);
create index if not exists ai_runs_matter_idx on public.ai_runs(office_id, matter_id) where matter_id is not null;
create index if not exists ai_runs_job_idx on public.ai_runs(job_id);
alter table public.ai_runs enable row level security;

-- קריאה בלבד. ai_runs הוא רשומת הביקורת של מה שסוכן עשה, כמה זה עלה
-- ומה הוא החזיר — והוא נכתב אך ורק ע"י ai-worker עם service_role.
-- מדיניות UPDATE כאן הייתה מאפשרת לחבר משרד לשכתב היסטוריית הרצות
-- (סטטוס, עלות, פלט) בלי שום עקבות, וזה מרוקן מתוכן גם את מסך העלויות
-- וגם את יומן הביקורת. אין נתיב בצד הלקוח שצריך זאת.
drop policy if exists "ai_runs_select" on public.ai_runs;
create policy "ai_runs_select" on public.ai_runs
  for select using (is_office_member(office_id));
drop policy if exists "ai_runs_update" on public.ai_runs;


-- ============================================================
-- 7. ai_run_steps — כל צעד בהרצה
-- ============================================================
-- "כל פעולה של סוכן חייבת להיות מתועדת" (סעיף 29). כאן נשמר מה המודל אמר,
-- איזה כלי הופעל, עם איזה קלט, ומה חזר — כך שמסך ההרצה יכול להציג ציר זמן
-- מלא ולא רק תוצאה סופית.
create table if not exists public.ai_run_steps (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  run_id uuid not null references public.ai_runs(id) on delete cascade,
  step_number int not null,
  step_type text not null check (step_type in ('model','tool','approval','error','system','context')),
  tool_id uuid references public.ai_tools(id) on delete set null,
  tool_slug text,
  tool_input jsonb,
  tool_output jsonb,
  model_output text,
  status text not null default 'completed' check (status in ('running','completed','failed','blocked')),
  input_tokens int,
  output_tokens int,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms int,
  error text,
  created_at timestamptz not null default now(),
  unique (run_id, step_number)
);
create index if not exists ai_run_steps_run_idx on public.ai_run_steps(run_id, step_number);
alter table public.ai_run_steps enable row level security;

drop policy if exists "ai_run_steps_select" on public.ai_run_steps;
create policy "ai_run_steps_select" on public.ai_run_steps
  for select using (is_office_member(office_id));


-- ============================================================
-- 8. ai_approvals — מערכת האישורים
-- ============================================================
-- זו הטבלה הכי חשובה במערכת. שתי סיבות, ושתיהן נובעות מה-Audit:
--
-- (א) משפטית — "אין לבצע פעולה חיצונית לפני שהאישור נשמר בשרת" (סעיף 4.5).
-- (ב) טכנית — ה-CRM הוא blob יחיד ב-app_data. אם ה-worker היה כותב אליו
--     במקביל למשתמש שעובד בדפדפן, אחד מהם היה דורס את השני בשקט (lost
--     update על read-modify-write של שורה שלמה). לכן ה-worker לעולם לא
--     כותב ל-app_data — הוא כותב הצעה לכאן, וההחלה נעשית בדפדפן דרך אותו
--     נתיב שמירה שכל פעולת משתמש עוברת בו.
--
-- proposed_payload = מה שהסוכן מבקש לעשות. edited_payload = מה שהמשתמש
-- תיקן לפני האישור; אם קיים, הוא זה שמוחל (סעיף 4.5 "עריכה ואישור").
create table if not exists public.ai_approvals (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  run_id uuid references public.ai_runs(id) on delete cascade,
  job_id uuid references public.ai_jobs(id) on delete cascade,
  agent_id uuid references public.ai_agents(id) on delete set null,
  client_id text,
  matter_id text,
  action_type text not null,          -- slug של הכלי / סוג הפעולה
  action_label text,                  -- תיאור בעברית למסך האישורים
  risk_level text not null default 'medium' check (risk_level in ('none','low','medium','high','critical')),
  proposed_payload jsonb not null default '{}'::jsonb,
  proposed_content text,              -- הטקסט/המסמך עצמו, לתצוגה והשוואה
  source_refs jsonb not null default '[]'::jsonb,  -- citations: על מה הפעולה מתבססת
  reason_required text,               -- למה נדרש אישור — מוצג למשתמש
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','applied','failed','expired','returned')),
  requested_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  rejected_at timestamptz,
  applied_at timestamptz,
  rejection_reason text,
  return_instruction text,            -- "החזרה לסוכן עם הנחיה" (סעיף 4.5)
  edited_payload jsonb,
  apply_error text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_approvals_pending_idx
  on public.ai_approvals(office_id, status, requested_at desc);
create index if not exists ai_approvals_run_idx on public.ai_approvals(run_id);
alter table public.ai_approvals enable row level security;

drop policy if exists "ai_approvals_select" on public.ai_approvals;
create policy "ai_approvals_select" on public.ai_approvals
  for select using (is_office_member(office_id));
-- מזכיר/ה לא מאשר/ת פעולות משפטיות או כספיות. אישור = owner או lawyer.
-- (סעיף 8.1: "אישורים נגישים רק לבעלי תפקיד מורשים")
drop policy if exists "ai_approvals_update" on public.ai_approvals;
create policy "ai_approvals_update" on public.ai_approvals
  for update using (
    exists (select 1 from public.office_members om
            where om.user_id = auth.uid() and om.office_id = ai_approvals.office_id
              and om.role in ('owner','lawyer'))
  ) with check (
    exists (select 1 from public.office_members om
            where om.user_id = auth.uid() and om.office_id = ai_approvals.office_id
              and om.role in ('owner','lawyer'))
  );


-- ============================================================
-- 9. ai_feedback — משוב המשתמש
-- ============================================================
create table if not exists public.ai_feedback (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  run_id uuid not null references public.ai_runs(id) on delete cascade,
  rating text check (rating in ('up','down')),
  accuracy_score int check (accuracy_score between 1 and 5),
  usefulness_score int check (usefulness_score between 1 and 5),
  was_edited boolean not null default false,
  original_output text,
  final_output text,
  feedback_text text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists ai_feedback_run_idx on public.ai_feedback(run_id);
alter table public.ai_feedback enable row level security;

drop policy if exists "ai_feedback_select" on public.ai_feedback;
create policy "ai_feedback_select" on public.ai_feedback
  for select using (is_office_member(office_id));
drop policy if exists "ai_feedback_insert" on public.ai_feedback;
create policy "ai_feedback_insert" on public.ai_feedback
  for insert with check (is_office_member(office_id) and created_by = auth.uid());


-- ============================================================
-- 10. ai_memories — זיכרון
-- ============================================================
-- כל פריט זיכרון נושא מקור, מי יצר, ורמת ביטחון (סעיף 15.5). בלי זה אי
-- אפשר להבדיל בין "בעל המשרד אמר לי" לבין "המודל הסיק" — הבחנה קריטית
-- כשהזיכרון מוזרק ל-prompt של סוכן מנסח.
create table if not exists public.ai_memories (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  scope_type text not null check (scope_type in ('office','client','matter','user','agent')),
  scope_id text,                       -- text: מזהי blob (client/matter) או uuid כטקסט
  memory_type text not null default 'fact',
  title text,
  content text not null,
  source_type text check (source_type in ('user','agent','document','email','call','system')),
  source_id text,
  confidence_score numeric default 1.0 check (confidence_score between 0 and 1),
  verified boolean not null default false,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_memories_scope_idx on public.ai_memories(office_id, scope_type, scope_id);
alter table public.ai_memories enable row level security;

-- קריאה לכל חבר משרד; כתיבה לבעלים בלבד. הזיכרון מוזרק ל-prompt של **כל**
-- סוכן, ולכן מי שיכול לכתוב אליו יכול להשפיע על כל טיוטה שהמערכת תפיק
-- מכאן והלאה. הכלי save_memory רץ ב-worker עם service_role ולא מושפע מכאן.
drop policy if exists "ai_memories_select" on public.ai_memories;
create policy "ai_memories_select" on public.ai_memories
  for select using (is_office_member(office_id));
drop policy if exists "ai_memories_write" on public.ai_memories;
create policy "ai_memories_write" on public.ai_memories
  for all using (is_office_owner(office_id)) with check (is_office_owner(office_id));


-- ============================================================
-- 11. ai_usage_daily — אגרגציה יומית
-- ============================================================
-- ai_usage הקיימת נשארת בדיוק כפי שהיא (ai-proxy ממשיך לכתוב אליה).
-- הטבלה הזו היא אגרגציה נפרדת עבור מסך העלויות של מרכז ה-AI, כדי שגרף
-- חודשי לא יסרוק שורה-שורה.
create table if not exists public.ai_usage_daily (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  usage_date date not null,
  agent_id uuid references public.ai_agents(id) on delete set null,
  model_provider text not null default 'anthropic',
  model_name text not null,
  runs_count int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  estimated_cost numeric not null default 0,
  success_count int not null default 0,
  failure_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- nulls not distinct הכרחי: agent_id הוא nullable, וברירת המחדל של
  -- Postgres היא ששני NULL אינם שווים. בלי זה, on conflict לא יכול להתאים
  -- שורה קיימת עבור קריאות ללא סוכן — כל קריאה הייתה מוסיפה שורה חדשה
  -- במקום לצבור, והטבלה הייתה גדלה ללא גבול.
  unique nulls not distinct (office_id, usage_date, agent_id, model_name)
);
create index if not exists ai_usage_daily_office_idx on public.ai_usage_daily(office_id, usage_date desc);
alter table public.ai_usage_daily enable row level security;

drop policy if exists "ai_usage_daily_select" on public.ai_usage_daily;
create policy "ai_usage_daily_select" on public.ai_usage_daily
  for select using (is_office_member(office_id));


-- ============================================================
-- 12. ai_settings — תקציבים, מפסקים, עצירת חירום
-- ============================================================
-- שורה אחת לכל משרד. emergency_stop נבדק ב-gateway (לפני יצירת job) וגם
-- בכל איטרציה של לולאת ה-worker — כך שלחיצה על "עצור הכול" עוצרת גם
-- הרצות שכבר באוויר, לא רק חדשות (סעיף 8.5).
create table if not exists public.ai_settings (
  office_id uuid primary key references public.offices(id) on delete cascade,
  emergency_stop boolean not null default false,
  emergency_stop_reason text,
  emergency_stop_at timestamptz,
  outbound_messages_paused boolean not null default false,
  automations_paused boolean not null default false,
  read_only_mode boolean not null default false,
  daily_budget_usd numeric not null default 5,
  monthly_budget_usd numeric not null default 50,
  -- ב-100% מהתקציב: 'stop' עוצר, 'downgrade' עובר למודל זול (סעיף 21)
  on_budget_exceeded text not null default 'stop' check (on_budget_exceeded in ('stop','downgrade')),
  cheap_model text not null default 'claude-haiku-4-5-20251001',
  alert_at_70 boolean not null default true,
  alert_at_90 boolean not null default true,
  ai_provider_mode text not null default 'live' check (ai_provider_mode in ('mock','live')),
  auto_apply_level int not null default 0 check (auto_apply_level between 0 and 3),
  office_memory jsonb not null default '{}'::jsonb,  -- סגנון, חתימה, נהלים (סעיף 15.1)
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
alter table public.ai_settings enable row level security;

drop policy if exists "ai_settings_select" on public.ai_settings;
create policy "ai_settings_select" on public.ai_settings
  for select using (is_office_member(office_id));
drop policy if exists "ai_settings_write" on public.ai_settings;
create policy "ai_settings_write" on public.ai_settings
  for all using (is_office_owner(office_id)) with check (is_office_owner(office_id));


-- ============================================================
-- 13. integration_connections — חיבורים חיצוניים
-- ============================================================
-- encrypted_credentials מכיל refresh tokens מוצפנים AES-GCM עם מפתח
-- שנמצא רק ב-secrets של Supabase (INTEGRATION_ENCRYPTION_KEY). אין מדיניות
-- SELECT למשתמשים רגילים על הטבלה הזו בכלל — הדפדפן קורא את הסטטוס דרך
-- ה-view integration_status למטה, שלא כולל את העמודה. גם דליפת JWT של
-- בעלים לא חושפת token.
create table if not exists public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  provider text not null,              -- google_gmail | google_calendar | whatsapp | telephony
  connection_type text not null default 'oauth' check (connection_type in ('oauth','api_key','webhook','mock')),
  account_name text,
  account_identifier text,
  status text not null default 'disconnected'
    check (status in ('connected','disconnected','error','expired','mock')),
  scopes text[],
  encrypted_credentials text,
  token_expires_at timestamptz,
  last_sync_at timestamptz,
  sync_cursor text,                    -- historyId של Gmail / syncToken של Calendar
  last_error text,
  config jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (office_id, provider)
);
alter table public.integration_connections enable row level security;

-- ההגנה כאן דו-שכבתית, ובכוונה:
--
-- (1) RLS ברמת השורה — חבר משרד רואה רק את החיבורים של המשרד שלו.
-- (2) **הרשאות ברמת העמודה** — encrypted_credentials מוסר מ-authenticated
--     לחלוטין. RLS הוא מנגנון שורות ולא עמודות, ולכן הוא לבדו לא היה מונע
--     מבעל משרד לקרוא `select encrypted_credentials` על החיבור שלו עצמו
--     ולחלץ refresh token של Gmail. עם ה-GRANT הממוקד למטה, ניסיון כזה
--     נכשל בשגיאת הרשאה — לא מחזיר את הערך "בלי כוונה".
--
-- כתיבה נעשית אך ורק ע"י Edge Functions עם service_role (שעוקף RLS), ולכן
-- אין כאן policy ל-insert/update/delete — גם לא לבעלים.
drop policy if exists "integration_connections_select" on public.integration_connections;
create policy "integration_connections_select" on public.integration_connections
  for select using (is_office_member(office_id));
drop policy if exists "integration_connections_write" on public.integration_connections;

revoke select on public.integration_connections from anon, authenticated;
grant select (
  id, office_id, provider, connection_type, account_name, account_identifier,
  status, scopes, token_expires_at, last_sync_at, last_error, config,
  created_at, updated_at
) on public.integration_connections to authenticated;

-- View נוחה לסטטוס. security_invoker=true כדי שה-RLS וההרשאות של הקורא
-- יחולו גם דרכה — בלעדיו ה-view הייתה רצה בהרשאות הבעלים ומדלגת על שתי
-- השכבות שהוגדרו הרגע, וזו הפרצה הקלאסית של views מעל טבלאות עם RLS.
create or replace view public.integration_status
with (security_invoker = true) as
  select id, office_id, provider, connection_type, account_name, account_identifier,
         status, scopes, token_expires_at, last_sync_at, last_error, config,
         created_at, updated_at
  from public.integration_connections;

grant select on public.integration_status to authenticated;


-- ============================================================
-- 14. communication_threads / communication_messages
-- ============================================================
create table if not exists public.communication_threads (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  client_id text,
  matter_id text,
  lead_id text,
  channel text not null check (channel in ('email','whatsapp','sms','call','web','system')),
  external_thread_id text,
  subject text,
  participant_name text,
  participant_identifier text,        -- מייל או טלפון מנורמל (+972...)
  status text not null default 'open' check (status in ('open','waiting_reply','closed','archived')),
  urgency text not null default 'normal' check (urgency in ('low','normal','high','urgent')),
  unread_count int not null default 0,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (office_id, channel, external_thread_id)
);
create index if not exists comm_threads_office_idx
  on public.communication_threads(office_id, last_message_at desc);
alter table public.communication_threads enable row level security;

-- קריאה בלבד: כל הכתיבה לתיבה האחודה מגיעה מ-webhooks ומסנכרון, שרצים
-- עם service_role. הודעה נכנסת שמישהו יכול לערוך מהדפדפן אינה ראיה.
drop policy if exists "comm_threads_select" on public.communication_threads;
create policy "comm_threads_select" on public.communication_threads
  for select using (is_office_member(office_id));
drop policy if exists "comm_threads_write" on public.communication_threads;

create table if not exists public.communication_messages (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  thread_id uuid not null references public.communication_threads(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  channel text not null,
  external_message_id text,
  sender text,
  recipient text,
  subject text,
  body_text text,
  body_html text,
  -- draft → pending_approval → approved → sent. הודעה יוצאת לא עוברת ל-sent
  -- אלא דרך ai-worker אחרי שהאישור נשמר בשרת.
  status text not null default 'received'
    check (status in ('received','draft','pending_approval','approved','sending','sent','delivered','read','failed','rejected')),
  sent_at timestamptz,
  received_at timestamptz,
  requires_approval boolean not null default false,
  approval_id uuid references public.ai_approvals(id) on delete set null,
  generated_by_agent_id uuid references public.ai_agents(id) on delete set null,
  attachments jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists comm_messages_thread_idx
  on public.communication_messages(thread_id, created_at);
-- מונע הודעה נכנסת כפולה כשספק שולח webhook פעמיים (Gmail/WhatsApp עושים זאת).
create unique index if not exists comm_messages_external_uniq
  on public.communication_messages(office_id, channel, external_message_id)
  where external_message_id is not null;
alter table public.communication_messages enable row level security;

drop policy if exists "comm_messages_select" on public.communication_messages;
create policy "comm_messages_select" on public.communication_messages
  for select using (is_office_member(office_id));
drop policy if exists "comm_messages_write" on public.communication_messages;


-- ============================================================
-- 15. automation_rules
-- ============================================================
create table if not exists public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  name text not null,
  description text,
  trigger_type text not null,
  trigger_config jsonb not null default '{}'::jsonb,
  conditions jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  is_active boolean not null default false,   -- כבוי כברירת מחדל, בכוונה
  requires_approval boolean not null default true,
  failure_policy text not null default 'notify' check (failure_policy in ('notify','retry','ignore')),
  last_run_at timestamptz,
  last_run_status text,
  run_count int not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists automation_rules_office_idx
  on public.automation_rules(office_id, is_active);
alter table public.automation_rules enable row level security;

drop policy if exists "automation_rules_select" on public.automation_rules;
create policy "automation_rules_select" on public.automation_rules
  for select using (is_office_member(office_id));
drop policy if exists "automation_rules_write" on public.automation_rules;
create policy "automation_rules_write" on public.automation_rules
  for all using (is_office_owner(office_id)) with check (is_office_owner(office_id));


-- ============================================================
-- 16. audit_logs
-- ============================================================
-- לא קיימת טבלת audit במערכת (רק client_errors לשגיאות JS), אז זו טבלה
-- חדשה ולא הרחבה. actor_type מבדיל בין פעולת אדם לפעולת סוכן — בלי זה
-- אי אפשר לענות על "מי עשה את זה" כשגם אנשים וגם סוכנים כותבים.
--
-- insert-only מבחינת המשתמש: אין policy ל-update או delete. לוג ביקורת
-- שניתן לערוך אינו לוג ביקורת.
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  office_id uuid not null references public.offices(id) on delete cascade,
  actor_type text not null check (actor_type in ('user','agent','system','automation','webhook')),
  actor_id text,
  user_id uuid references auth.users(id),
  agent_id uuid references public.ai_agents(id) on delete set null,
  run_id uuid references public.ai_runs(id) on delete set null,
  client_id text,
  matter_id text,
  action text not null,
  entity_type text,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  severity text not null default 'info' check (severity in ('info','warning','security','error')),
  ip_address text,
  user_agent text,
  correlation_id text,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_office_idx on public.audit_logs(office_id, created_at desc);
create index if not exists audit_logs_correlation_idx on public.audit_logs(correlation_id);
create index if not exists audit_logs_security_idx
  on public.audit_logs(office_id, created_at desc) where severity = 'security';
alter table public.audit_logs enable row level security;

drop policy if exists "audit_logs_select" on public.audit_logs;
create policy "audit_logs_select" on public.audit_logs
  for select using (is_office_member(office_id));


-- ============================================================
-- 17. claim_ai_job — לב התור
-- ============================================================
-- FOR UPDATE SKIP LOCKED הוא מה שהופך טבלה רגילה לתור בטוח: שני workers
-- שרצים בו-זמנית לא יכולים לתפוס את אותה שורה — השני פשוט מדלג עליה
-- במקום לחכות. בלי SKIP LOCKED היינו מקבלים או עבודה כפולה (בלי נעילה)
-- או תור סדרתי חנוק (עם נעילה רגילה).
--
-- security definer כי ה-worker רץ עם service_role ואין לו auth.uid();
-- הפונקציה לא מקבלת office_id מבחוץ אלא מחזירה את מה שבתור, ולכן היא
-- לא יכולה לשמש לחציית משרדים.
create or replace function public.claim_ai_job(worker_id text default 'worker')
returns public.ai_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.ai_jobs;
begin
  select * into claimed
  from public.ai_jobs j
  where j.status = 'queued'
    and j.scheduled_at <= now()
    -- אל תיקח jobs של משרד בעצירת חירום. הבדיקה כאן ולא רק ב-gateway
    -- כי jobs עשויים להיות כבר בתור כשהכפתור נלחץ.
    and not exists (
      select 1 from public.ai_settings s
      where s.office_id = j.office_id and s.emergency_stop
    )
  order by j.priority asc, j.scheduled_at asc
  limit 1
  for update skip locked;

  if claimed.id is null then
    return null;
  end if;

  update public.ai_jobs
  set status = 'running',
      attempts = attempts + 1,
      started_at = coalesce(started_at, now()),
      locked_at = now(),
      last_error = null,
      updated_at = now()
  where id = claimed.id
  returning * into claimed;

  return claimed;
end;
$$;

-- ה-grant ל-service_role מפורש ולא נסמך על ALTER DEFAULT PRIVILEGES של
-- Supabase. `revoke ... from public` מסיר את הרשאת ה-EXECUTE שכל role יורש
-- מ-PUBLIC; service_role אינו superuser, ולכן בלי השורה הבאה ai-worker היה
-- מקבל "permission denied for function claim_ai_job" — והתור פשוט לא היה
-- מתנקז, בלי שום שגיאה גלויה במסך.
revoke all on function public.claim_ai_job(text) from public, anon, authenticated;
grant execute on function public.claim_ai_job(text) to service_role;


-- ============================================================
-- 18. release_ai_job — סיום/כישלון עם backoff
-- ============================================================
-- backoff אקספוננציאלי: 30s, 60s, 120s... אחרי max_attempts השורה עוברת
-- ל-dead_letter ולא נוגעים בה יותר אוטומטית (סעיף 22: dead-letter status).
create or replace function public.release_ai_job(
  p_job_id uuid,
  p_status text,
  p_error text default null,
  p_result jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.ai_jobs;
  backoff_seconds int;
begin
  select * into j from public.ai_jobs where id = p_job_id;
  if j.id is null then return; end if;

  if p_status = 'failed' and j.attempts < j.max_attempts then
    backoff_seconds := 30 * power(2, greatest(j.attempts - 1, 0))::int;
    update public.ai_jobs
    set status = 'queued',
        scheduled_at = now() + make_interval(secs => backoff_seconds),
        last_error = p_error,
        locked_at = null,
        updated_at = now()
    where id = p_job_id;
  elsif p_status = 'failed' then
    update public.ai_jobs
    set status = 'dead_letter', last_error = p_error,
        completed_at = now(), locked_at = null, updated_at = now()
    where id = p_job_id;
  else
    update public.ai_jobs
    set status = p_status,
        result = coalesce(p_result, result),
        last_error = p_error,
        completed_at = case when p_status in ('completed','cancelled') then now() else completed_at end,
        locked_at = null,
        updated_at = now()
    where id = p_job_id;
  end if;
end;
$$;

revoke all on function public.release_ai_job(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.release_ai_job(uuid, text, text, jsonb) to service_role;


-- ============================================================
-- 19. reap_stale_ai_jobs — התאוששות מ-worker שמת
-- ============================================================
-- Edge Function שנהרג באמצע (timeout, deploy) משאיר job ב-'running' לנצח.
-- ה-cron קורא לזה כדי להחזיר לתור כל מה שננעל לפני יותר מ-10 דקות.
create or replace function public.reap_stale_ai_jobs(stale_minutes int default 10)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  with reaped as (
    update public.ai_jobs
    set status = case when attempts >= max_attempts then 'dead_letter' else 'queued' end,
        last_error = 'ההרצה נקטעה (worker לא הגיב) — הוחזר לתור',
        locked_at = null,
        scheduled_at = now(),
        updated_at = now()
    where status = 'running'
      and locked_at is not null
      and locked_at < now() - make_interval(mins => stale_minutes)
    returning 1
  )
  select count(*) into n from reaped;

  -- coalesce חיוני: הרצה נוצרת ע"י ה-gateway עם status='pending' ו-
  -- started_at NULL (ה-worker ממלא אותו רק במעבר ל-running). השוואה של NULL
  -- מחזירה NULL, כלומר 'pending' היה נשאר מחוץ לתנאי לנצח — והרצה שה-job
  -- שלה מת לפני שנתפס הייתה תקועה על "ממתין" במסך לעולמים.
  update public.ai_runs
  set status = 'failed',
      error_code = 'worker_timeout',
      error_message = 'ההרצה נקטעה ולא הושלמה',
      completed_at = now()
  where status in ('running','pending')
    and coalesce(started_at, created_at) < now() - make_interval(mins => stale_minutes * 2);

  return n;
end;
$$;

revoke all on function public.reap_stale_ai_jobs(int) from public, anon, authenticated;
grant execute on function public.reap_stale_ai_jobs(int) to service_role;


-- ============================================================
-- 19b. ביטול והרצה חוזרת של job — מהדפדפן, בהיקף מוגבל
-- ============================================================
-- מחליפות את מדיניות ה-UPDATE הרחבה שהוסרה למעלה. כל אחת נוגעת רק
-- בעמודות הסטטוס, מאמתת חברות במשרד בעצמה (security definer עוקף RLS),
-- ולעולם לא נותנת לקורא לשנות payload, agent_id או priority.

create or replace function public.cancel_ai_job(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_office uuid;
begin
  select office_id into v_office from public.ai_jobs where id = p_job_id;
  if v_office is null or not public.is_office_member(v_office) then
    return false;
  end if;

  update public.ai_jobs
  set status = 'cancelled', completed_at = now(), locked_at = null, updated_at = now()
  where id = p_job_id and status in ('queued','running','waiting_approval');

  update public.ai_runs
  set status = 'cancelled', completed_at = now()
  where job_id = p_job_id and status in ('pending','running','waiting_approval');

  return true;
end;
$$;

create or replace function public.retry_ai_job(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_office uuid;
begin
  select office_id into v_office from public.ai_jobs where id = p_job_id;
  if v_office is null or not public.is_office_member(v_office) then
    return false;
  end if;

  -- רק משימה שנכשלה סופית או בוטלה. idempotency_key נשאר — זו אותה
  -- משימה, לא כפילות.
  update public.ai_jobs
  set status = 'queued', attempts = 0, last_error = null,
      scheduled_at = now(), locked_at = null, updated_at = now()
  where id = p_job_id and status in ('dead_letter','cancelled','failed');

  return found;
end;
$$;

revoke all on function public.cancel_ai_job(uuid) from public, anon;
revoke all on function public.retry_ai_job(uuid) from public, anon;
grant execute on function public.cancel_ai_job(uuid) to authenticated, service_role;
grant execute on function public.retry_ai_job(uuid) to authenticated, service_role;


-- ============================================================
-- 20. ai_usage_daily_upsert — צבירת עלות
-- ============================================================
create or replace function public.ai_usage_daily_upsert(
  p_office_id uuid, p_agent_id uuid, p_model text, p_provider text,
  p_in_tokens int, p_out_tokens int, p_cost numeric, p_success boolean
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.ai_usage_daily (
    office_id, usage_date, agent_id, model_provider, model_name,
    runs_count, input_tokens, output_tokens, estimated_cost, success_count, failure_count
  ) values (
    p_office_id, (now() at time zone 'Asia/Jerusalem')::date, p_agent_id,
    coalesce(p_provider,'anthropic'), p_model,
    1, p_in_tokens, p_out_tokens, p_cost,
    case when p_success then 1 else 0 end,
    case when p_success then 0 else 1 end
  )
  on conflict (office_id, usage_date, agent_id, model_name) do update set
    runs_count     = public.ai_usage_daily.runs_count + 1,
    input_tokens   = public.ai_usage_daily.input_tokens + excluded.input_tokens,
    output_tokens  = public.ai_usage_daily.output_tokens + excluded.output_tokens,
    estimated_cost = public.ai_usage_daily.estimated_cost + excluded.estimated_cost,
    success_count  = public.ai_usage_daily.success_count + excluded.success_count,
    failure_count  = public.ai_usage_daily.failure_count + excluded.failure_count,
    updated_at     = now();
$$;

revoke all on function public.ai_usage_daily_upsert(uuid, uuid, text, text, int, int, numeric, boolean)
  from public, anon, authenticated;
grant execute on function public.ai_usage_daily_upsert(uuid, uuid, text, text, int, int, numeric, boolean)
  to service_role;


-- ============================================================
-- 21. ai_spend_window — כמה הוצא היום/החודש
-- ============================================================
-- אזור זמן ישראל במפורש: "היום" חייב להיות היום של בעל המשרד, אחרת
-- התקציב היומי מתאפס בשעה שרירותית. אותה סיבה בדיוק ש-app.js משתמש
-- ב-localDateISO ולא ב-toISOString.
--
-- ⚠ הפונקציה security definer ומקבלת office_id כפרמטר, ולכן היא **חייבת**
-- לאמת חברות בעצמה. בלי הבדיקה למטה, כל משתמש מאומת היה יכול להעביר מזהה
-- של משרד אחר ולקרוא את נתוני ההוצאה שלו — security definer עוקף RLS
-- מעצם הגדרתו, וה-grant ל-authenticated פותח את הדלת.
--
-- auth.uid() is null = הקריאה הגיעה מ-service_role (ה-worker וה-gateway),
-- שאין לו משתמש. anon לא יכול להגיע לכאן כלל כי ה-grant הוא ל-authenticated.
create or replace function public.ai_spend_window(p_office_id uuid)
returns table (today_cost numeric, month_cost numeric, today_runs int, month_runs int)
language sql
security definer
stable
set search_path = public
as $$
  select
    coalesce(sum(estimated_cost) filter (
      where usage_date = (now() at time zone 'Asia/Jerusalem')::date), 0),
    coalesce(sum(estimated_cost) filter (
      where usage_date >= date_trunc('month', (now() at time zone 'Asia/Jerusalem')::date)), 0),
    coalesce(sum(runs_count) filter (
      where usage_date = (now() at time zone 'Asia/Jerusalem')::date), 0)::int,
    coalesce(sum(runs_count) filter (
      where usage_date >= date_trunc('month', (now() at time zone 'Asia/Jerusalem')::date)), 0)::int
  from public.ai_usage_daily
  where office_id = p_office_id
    and (auth.uid() is null or public.is_office_member(p_office_id));
$$;

revoke all on function public.ai_spend_window(uuid) from public, anon;
grant execute on function public.ai_spend_window(uuid) to authenticated, service_role;


-- ============================================================
-- 22. updated_at triggers
-- ============================================================
create or replace function public.ai_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'ai_agents','ai_tools','ai_agent_tools','ai_jobs','ai_approvals','ai_memories',
    'ai_usage_daily','ai_settings','integration_connections','communication_threads',
    'automation_rules'
  ] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format(
      'create trigger %I_touch before update on public.%I
       for each row execute function public.ai_touch_updated_at()', t, t);
  end loop;
end $$;


-- ============================================================
-- 23. Realtime
-- ============================================================
-- כדי שהמשתמש יראה "משימה התחילה / דורשת אישור / הושלמה" בלי לרענן
-- (סעיף 20). RLS ממשיך לחול על ערוצי Realtime, אז אין כאן חשיפה.
-- ה-DO block נדרש כי add table נכשל אם הטבלה כבר בפרסום.
do $$
declare t text;
begin
  foreach t in array array['ai_runs','ai_jobs','ai_approvals','communication_messages'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
              when undefined_object then null;  -- הפרסום לא קיים בפרויקט הזה
    end;
  end loop;
end $$;


-- ============================================================
-- 24. ברירת מחדל ל-ai_settings לכל משרד קיים
-- ============================================================
insert into public.ai_settings (office_id)
select id from public.offices
on conflict (office_id) do nothing;

-- ומשרד חדש מקבל שורה אוטומטית
create or replace function public.ai_settings_for_new_office()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.ai_settings (office_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists offices_ai_settings on public.offices;
create trigger offices_ai_settings after insert on public.offices
  for each row execute function public.ai_settings_for_new_office();
