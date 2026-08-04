-- ============================================================================
-- מרכז האוטומציות — תשתית
-- ============================================================================
--
-- ## למה זו הרחבה ולא מערכת חדשה
-- `automation_rules` כבר קיימת (מיגרציה 20260804000000) ומנוע מריץ אותה
-- ב-ai-cron. יצירת טבלת כללים שנייה הייתה משאירה שני מנועים שרצים במקביל
-- על אותם נתונים ומייצרים פעולות כפולות — בדיוק מה שסעיף 24 במפרט אוסר.
-- לכן: מרחיבים את הטבלה הקיימת ומוסיפים לצדה את מה שחסר.
--
-- ## הפער שנסגר
-- היום אוטומציה יודעת לעשות דבר אחד: להעיר סוכן AI. כלומר כל אוטומציה
-- עולה כסף וכל תוצאה היא טקסט של מודל. רוב הפעולות במפרט — "צור משימה",
-- "שנה סטטוס", "שלח התראה" — אינן דורשות מודל כלל. הטבלאות כאן הן
-- התשתית למנוע פעולות דטרמיניסטי שרץ לצד הסוכנים, לא במקומם.
--
-- ## הישויות
-- אין טבלאות ל-cases/clients/tasks — הכל ב-app_data.data (jsonb). לכן
-- entity_id הוא **text** ולא uuid, ואין foreign keys לישויות. זה לא פשרה
-- אלא התאמה למבנה: המזהים הם base36 שנוצרים ב-uid() בדפדפן.
-- ============================================================================


-- ============================================================
-- 1. הרחבת automation_rules הקיימת
-- ============================================================
alter table public.automation_rules
  -- קישור לתבנית המערכת שממנה נוצר הכלל. מאפשר שדרוג תבניות בלי לדרוס
  -- התאמות של המשרד.
  add column if not exists template_key text,

  -- רמת ביצוע (סעיף 6 במפרט):
  --   notify  — מזהה ומתריע, לא נוגע בכלום
  --   prepare — מכין פעולה וממתין לאישור אנושי
  --   auto    — מבצע. חסום לפעולות רגישות, ראה is_sensitive_action()
  add column if not exists execution_level text not null default 'notify'
    check (execution_level in ('notify','prepare','auto')),

  add column if not exists severity text not null default 'normal'
    check (severity in ('low','normal','high','critical')),
  add column if not exists category text not null default 'general',

  -- מי מקבל התראה: [{"type":"role","value":"owner"},{"type":"user","value":"<uuid>"}]
  add column if not exists recipients jsonb not null default '[]'::jsonb,

  -- הסלמה: {"after_hours":72,"to":[{"type":"role","value":"owner"}]}
  add column if not exists escalation jsonb,

  -- ⚠ מונע הצפה: אותו נושא לא יטופל שוב לפני שעברו X דקות. ה-idempotency
  -- היומי הקיים מונע כפילות באותו יום; זה מונע התראה כל יום על אותו תיק
  -- תקוע במשך חודש.
  add column if not exists cooldown_minutes int not null default 1440,

  -- שעות שקטות: {"days":[5,6],"from":"20:00","to":"08:00"}
  add column if not exists quiet_hours jsonb,
  add column if not exists tags text[] not null default '{}',
  add column if not exists version int not null default 1,

  -- השהיה זמנית ללא כיבוי — נשמרת ההגדרה, נעצרת ההרצה.
  add column if not exists paused_until timestamptz,

  -- Kill switch אוטומטי: כלל שנכשל שוב ושוב מושבת מעצמו. בלי זה, כלל
  -- שבור מייצר שגיאה כל 5 דקות לנצח וממלא את הלוג עד שאי אפשר לראות בו
  -- שום דבר אחר.
  add column if not exists failure_count int not null default 0,
  add column if not exists disabled_reason text,

  -- ⚠ ההגנה החשובה ביותר בהדלקה (סעיף 35).
  --
  -- בלעדיה, הדלקת "תיק ללא פעילות 14 יום" על מסד עם היסטוריה של שנה
  -- הייתה מייצרת ברגע אחד עשרות הצעות על תיקים שנסגרו מזמן. המשתמש היה
  -- מוצף ביום הראשון, ומסיק שהמערכת שבורה. אירועים שקדמו לרגע ההדלקה
  -- פשוט לא נחשבים.
  add column if not exists activation_grace_at timestamptz,

  add column if not exists max_actions_per_run int not null default 10,
  add column if not exists estimated_minutes_saved int not null default 5;

-- ההדלקה מסמנת את הרגע. טריגר ולא קוד אפליקציה, כדי שגם עדכון ישיר
-- ב-SQL או מה-API יקבל את ההגנה.
create or replace function public.automation_rules_mark_activation()
returns trigger language plpgsql as $$
begin
  if new.is_active and (old.is_active is distinct from new.is_active) then
    new.activation_grace_at := now();
    new.failure_count := 0;
    new.disabled_reason := null;
  end if;
  return new;
end;
$$;

drop trigger if exists automation_rules_activation on public.automation_rules;
create trigger automation_rules_activation before update on public.automation_rules
  for each row execute function public.automation_rules_mark_activation();


-- ============================================================
-- 2. automation_templates — קטלוג התבניות
-- ============================================================
-- התבניות הן **קוד בתחפושת נתונים**: המנוע יודע לבצע רק טריגרים ופעולות
-- שממומשים בו. הקטלוג קובע אילו צירופים מוצעים למשתמש ומה ברירות המחדל.
create table if not exists public.automation_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text not null,
  category text not null,
  trigger_type text not null,
  default_trigger_config jsonb not null default '{}'::jsonb,
  default_conditions jsonb not null default '[]'::jsonb,
  default_actions jsonb not null default '[]'::jsonb,
  default_severity text not null default 'normal',
  default_execution_level text not null default 'notify',
  default_cooldown_minutes int not null default 1440,
  estimated_minutes_saved int not null default 5,

  -- ⚠ מה הישות דורשת כדי לעבוד בכלל.
  --
  -- למשל ['invoices'] או ['task.assignee']. תבנית שהדרישות שלה אינן
  -- מתקיימות מוצגת במסך כ"דורש הרחבה" ו**לא ניתנת להדלקה**. זו החלופה
  -- הישרה למתג שנראה פעיל ולא עושה כלום — המפרט אוסר את זה בסעיף 35,
  -- ומחיקת התבנית הייתה מאבדת את הידע שהיא קיימת.
  requires text[] not null default '{}',

  is_system_template boolean not null default true,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.automation_templates enable row level security;

-- קטלוג גלובלי, זהה לכל המשרדים. קריאה לכל מחובר, כתיבה ל-service_role בלבד.
drop policy if exists "automation_templates_select" on public.automation_templates;
create policy "automation_templates_select" on public.automation_templates
  for select using (auth.uid() is not null);


-- ============================================================
-- 3. automation_event_queue — Outbox
-- ============================================================
-- סעיף 24: "יש ליצור Event בתור האירועים ולא לבצע פעולות מורכבות ישירות
-- מתוך טריגר בסיס נתונים".
--
-- הסיבה מעשית: פעולה שרצה בתוך טריגר של Postgres מחזיקה את הטרנזקציה של
-- המשתמש. שליחת מייל איטית הייתה מקפיאה את שמירת התיק בדפדפן, וכשל
-- בשליחה היה מגלגל אחורה את השמירה עצמה.
create table if not exists public.automation_event_queue (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  event_type text not null,
  entity_type text not null,
  entity_id text,                       -- text: מזהי base36 מה-blob
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending','processing','done','failed','dead')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  processed_at timestamptz,
  error text,
  -- מונע הכנסת אותו אירוע פעמיים (למשל webhook שנשלח שוב).
  dedupe_key text,
  created_at timestamptz not null default now()
);

create unique index if not exists automation_event_dedupe
  on public.automation_event_queue(office_id, dedupe_key)
  where dedupe_key is not null;
create index if not exists automation_event_pending
  on public.automation_event_queue(status, available_at)
  where status = 'pending';

alter table public.automation_event_queue enable row level security;

-- קריאה לחברי משרד (לצורך מסך האבחון), כתיבה ל-service_role בלבד.
drop policy if exists "automation_event_queue_select" on public.automation_event_queue;
create policy "automation_event_queue_select" on public.automation_event_queue
  for select using (is_office_member(office_id));


-- ============================================================
-- 4. automation_runs — היסטוריה מלאה (סעיף 21)
-- ============================================================
create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  automation_rule_id uuid references public.automation_rules(id) on delete cascade,
  rule_version int,
  trigger_type text not null,
  trigger_entity_type text,
  trigger_entity_id text,

  status text not null default 'running'
    check (status in ('running','completed','partial','failed','skipped','dry_run')),

  -- ⚠ ההסבר בשפה אנושית. סעיף 21 מבקש אותו במפורש, ובצדק: "האוטומציה
  -- הופעלה" בלי "משום ש..." הוא מידע חסר ערך למשתמש שמנסה להחליט אם
  -- הכלל מכויל נכון. נבנה בקוד מהתנאים שנבדקו בפועל.
  reason text,

  conditions_checked jsonb not null default '[]'::jsonb,
  conditions_result boolean,
  actions_requested int not null default 0,
  actions_completed int not null default 0,
  actions_failed int not null default 0,

  input_snapshot jsonb,
  output_snapshot jsonb,
  error_message text,
  retry_count int not null default 0,

  approval_status text
    check (approval_status in ('not_required','pending','approved','rejected','expired')),
  approved_by uuid references auth.users(id),

  estimated_minutes_saved numeric not null default 0,
  estimated_cost_saved numeric not null default 0,
  deduplication_key text,

  started_at timestamptz not null default now(),
  completed_at timestamptz,
  duration_ms int
);

-- ⚠ אינדקס מלא ולא חלקי, ובכוונה.
--
-- זו הפעם השלישית שהדפוס הזה עולה בפרויקט (ai_learning_insights_dedupe,
-- comm_messages_external_uniq). המנוע כותב עם ON CONFLICT DO NOTHING,
-- ו-Postgres אינו יכול להסיק אינדקס חלקי מרשימת עמודות — כל הכנסה הייתה
-- נכשלת ב-42P10, גם בלי התנגשות.
create unique index if not exists automation_runs_dedupe
  on public.automation_runs(office_id, deduplication_key);
create index if not exists automation_runs_rule_idx
  on public.automation_runs(automation_rule_id, started_at desc);
create index if not exists automation_runs_office_idx
  on public.automation_runs(office_id, started_at desc);

alter table public.automation_runs enable row level security;

drop policy if exists "automation_runs_select" on public.automation_runs;
create policy "automation_runs_select" on public.automation_runs
  for select using (is_office_member(office_id));
-- אין policy ל-update/delete: סעיף 26 — "משתמש רגיל אינו יכול למחוק
-- היסטוריית אוטומציה".


-- ============================================================
-- 5. automation_action_logs — פעולה בודדת
-- ============================================================
create table if not exists public.automation_action_logs (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  automation_run_id uuid not null references public.automation_runs(id) on delete cascade,
  action_index int not null default 0,
  action_type text not null,
  action_payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending','skipped','awaiting_approval','executed','failed','dry_run')),
  result jsonb,
  error text,
  executed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists automation_action_logs_run_idx
  on public.automation_action_logs(automation_run_id, action_index);

alter table public.automation_action_logs enable row level security;
drop policy if exists "automation_action_logs_select" on public.automation_action_logs;
create policy "automation_action_logs_select" on public.automation_action_logs
  for select using (is_office_member(office_id));


-- ============================================================
-- 6. automation_notifications — מרכז התראות (סעיפים 29-30)
-- ============================================================
create table if not exists public.automation_notifications (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  automation_run_id uuid references public.automation_runs(id) on delete set null,
  rule_id uuid references public.automation_rules(id) on delete set null,

  level text not null default 'info' check (level in ('info','warning','urgent','escalation')),
  title text not null,
  body text,
  -- לאן לקפוץ בלחיצה: {"type":"case","id":"abc123"}
  link jsonb,

  -- למי. null = כל המשרד.
  target_user_id uuid references auth.users(id) on delete cascade,
  target_role text,

  read_at timestamptz,
  read_by uuid references auth.users(id),
  muted boolean not null default false,
  dedupe_key text,
  created_at timestamptz not null default now()
);

create unique index if not exists automation_notifications_dedupe
  on public.automation_notifications(office_id, dedupe_key);
create index if not exists automation_notifications_inbox
  on public.automation_notifications(office_id, created_at desc);

alter table public.automation_notifications enable row level security;

-- הצגה: התראות המשרד, ומסוננות לפי נמען כשהוגדר.
drop policy if exists "automation_notifications_select" on public.automation_notifications;
create policy "automation_notifications_select" on public.automation_notifications
  for select using (
    is_office_member(office_id)
    and (target_user_id is null or target_user_id = auth.uid())
  );

-- סימון כנקרא / השתקה — כל חבר משרד, על התראות שהוא רואה.
drop policy if exists "automation_notifications_update" on public.automation_notifications;
create policy "automation_notifications_update" on public.automation_notifications
  for update using (
    is_office_member(office_id)
    and (target_user_id is null or target_user_id = auth.uid())
  ) with check (
    is_office_member(office_id)
    and (target_user_id is null or target_user_id = auth.uid())
  );


-- ============================================================
-- 7. automation_metrics — חיסכון (סעיף 22)
-- ============================================================
create table if not exists public.automation_metrics (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  automation_rule_id uuid references public.automation_rules(id) on delete cascade,
  period date not null,
  run_count int not null default 0,
  success_count int not null default 0,
  failure_count int not null default 0,
  actions_executed int not null default 0,
  approvals_requested int not null default 0,
  minutes_saved numeric not null default 0,
  estimated_cost_saved numeric not null default 0,
  updated_at timestamptz not null default now()
);

-- nulls not distinct: כלל שנמחק משאיר automation_rule_id = null, ובלי זה
-- כל יום היה מייצר שורה חדשה במקום לצבור.
create unique index if not exists automation_metrics_uniq
  on public.automation_metrics(office_id, automation_rule_id, period) nulls not distinct;

alter table public.automation_metrics enable row level security;
drop policy if exists "automation_metrics_select" on public.automation_metrics;
create policy "automation_metrics_select" on public.automation_metrics
  for select using (is_office_member(office_id));


-- ============================================================
-- 8. תעריפי החיסכון — הגדרות המשרד (סעיף 22)
-- ============================================================
alter table public.ai_settings
  add column if not exists hourly_cost_secretary numeric not null default 60,
  add column if not exists hourly_cost_intern numeric not null default 90,
  add column if not exists hourly_cost_lawyer numeric not null default 350,
  -- Global pause לאוטומציות הדטרמיניסטיות, בנפרד מ-automations_paused
  -- שעוצר את הסוכנים. הפרדה מכוונת: אפשר לרצות שהתראות ימשיכו בזמן
  -- שהסוכנים מושבתים בגלל עלות.
  add column if not exists automation_engine_paused boolean not null default false,
  add column if not exists timezone text not null default 'Asia/Jerusalem';


-- ============================================================
-- 8b. חיבור ai_approvals למרכז האוטומציות
-- ============================================================
-- מרכז אישורים אחד ולא שניים. שני מסכי אישור מקבילים היו מפצלים את
-- תשומת הלב של עורך הדין — וכל דבר שמפצל תשומת לב במערכת אישורים הופך
-- אותה בסופו של דבר לחותמת גומי.
alter table public.ai_approvals
  add column if not exists source text not null default 'agent'
    check (source in ('agent','automation','manual')),
  add column if not exists automation_run_id uuid
    references public.automation_runs(id) on delete set null;

create index if not exists ai_approvals_source_idx
  on public.ai_approvals(office_id, source, status);


-- ============================================================
-- 9. RPC: תפיסת אירועים מהתור
-- ============================================================
-- FOR UPDATE SKIP LOCKED — אותו דפוס של claim_ai_job. pgmq לא מותקן
-- והוספת extension נמנעת בפרויקט הזה במכוון.
create or replace function public.claim_automation_events(p_limit int default 20)
returns setof public.automation_event_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select id from public.automation_event_queue
    where status = 'pending' and available_at <= now()
    order by available_at
    limit p_limit
    for update skip locked
  )
  update public.automation_event_queue q
  set status = 'processing', locked_at = now(), attempts = q.attempts + 1
  from picked
  where q.id = picked.id
  returning q.*;
end;
$$;

revoke all on function public.claim_automation_events(int) from public, anon, authenticated;
grant execute on function public.claim_automation_events(int) to service_role;


-- ============================================================
-- 10. RPC: שחרור אירוע (הצלחה או נסיון חוזר)
-- ============================================================
create or replace function public.release_automation_event(
  p_event_id uuid, p_status text, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_attempts int; v_max int;
begin
  select attempts, max_attempts into v_attempts, v_max
  from public.automation_event_queue where id = p_event_id;

  if p_status = 'done' then
    update public.automation_event_queue
    set status = 'done', processed_at = now(), locked_at = null, error = null
    where id = p_event_id;

  elsif v_attempts >= v_max then
    -- מיצה את הניסיונות. 'dead' ולא 'failed': מפריד בין "נכשל הפעם"
    -- לבין "לא ננסה יותר", כדי שמסך האבחון יוכל להראות רק את האמיתיים.
    update public.automation_event_queue
    set status = 'dead', processed_at = now(), locked_at = null, error = p_error
    where id = p_event_id;

  else
    -- backoff מעריכי: 1, 2, 4, 8 דקות.
    update public.automation_event_queue
    set status = 'pending', locked_at = null, error = p_error,
        available_at = now() + make_interval(mins => power(2, v_attempts)::int)
    where id = p_event_id;
  end if;
end;
$$;

revoke all on function public.release_automation_event(uuid, text, text) from public, anon, authenticated;
grant execute on function public.release_automation_event(uuid, text, text) to service_role;


-- ============================================================
-- 11. RPC: צבירת מדדים
-- ============================================================
create or replace function public.automation_metrics_upsert(
  p_office uuid, p_rule uuid, p_period date,
  p_success int, p_failure int, p_actions int, p_approvals int,
  p_minutes numeric, p_cost numeric)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.automation_metrics as m (
    office_id, automation_rule_id, period, run_count,
    success_count, failure_count, actions_executed, approvals_requested,
    minutes_saved, estimated_cost_saved, updated_at)
  values (p_office, p_rule, p_period, 1,
    p_success, p_failure, p_actions, p_approvals, p_minutes, p_cost, now())
  on conflict (office_id, automation_rule_id, period) do update set
    run_count = m.run_count + 1,
    success_count = m.success_count + excluded.success_count,
    failure_count = m.failure_count + excluded.failure_count,
    actions_executed = m.actions_executed + excluded.actions_executed,
    approvals_requested = m.approvals_requested + excluded.approvals_requested,
    minutes_saved = m.minutes_saved + excluded.minutes_saved,
    estimated_cost_saved = m.estimated_cost_saved + excluded.estimated_cost_saved,
    updated_at = now();
$$;

revoke all on function public.automation_metrics_upsert(uuid, uuid, date, int, int, int, int, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.automation_metrics_upsert(uuid, uuid, date, int, int, int, int, numeric, numeric)
  to service_role;


-- ============================================================
-- 12. RPC: סיכום ל-Dashboard (סעיף 2)
-- ============================================================
create or replace function public.automation_dashboard(p_office uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select case when not public.is_office_member(p_office) then '{}'::jsonb else
    jsonb_build_object(
      'active',        (select count(*) from automation_rules where office_id = p_office and is_active),
      'inactive',      (select count(*) from automation_rules where office_id = p_office and not is_active),
      'runs_today',    (select count(*) from automation_runs where office_id = p_office
                          and started_at >= date_trunc('day', now() at time zone 'Asia/Jerusalem')),
      'actions_today', (select coalesce(sum(actions_completed),0) from automation_runs where office_id = p_office
                          and started_at >= date_trunc('day', now() at time zone 'Asia/Jerusalem')),
      'pending_approval', (select count(*) from ai_approvals where office_id = p_office and status = 'pending'),
      'failed_7d',     (select count(*) from automation_runs where office_id = p_office
                          and status = 'failed' and started_at > now() - interval '7 days'),
      'unread_notifications', (select count(*) from automation_notifications
                          where office_id = p_office and read_at is null and not muted),
      'minutes_saved_month', (select coalesce(sum(minutes_saved),0) from automation_metrics
                          where office_id = p_office and period >= date_trunc('month', current_date)),
      'cost_saved_month',    (select coalesce(sum(estimated_cost_saved),0) from automation_metrics
                          where office_id = p_office and period >= date_trunc('month', current_date)),
      'success_rate', (select case when count(*) = 0 then null
                          else round(count(*) filter (where status = 'completed')::numeric / count(*), 3) end
                        from automation_runs where office_id = p_office
                          and started_at > now() - interval '30 days'),
      'queue_pending', (select count(*) from automation_event_queue
                          where office_id = p_office and status = 'pending'),
      'queue_dead',    (select count(*) from automation_event_queue
                          where office_id = p_office and status = 'dead')
    )
  end;
$$;

revoke all on function public.automation_dashboard(uuid) from public, anon;
grant execute on function public.automation_dashboard(uuid) to authenticated, service_role;


-- ============================================================
-- 13. טריגרים ל-updated_at
-- ============================================================
drop trigger if exists automation_templates_touch on public.automation_templates;
create trigger automation_templates_touch before update on public.automation_templates
  for each row execute function public.ai_touch_updated_at();


-- ============================================================
-- 14. Realtime
-- ============================================================
do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.automation_notifications';
  exception when duplicate_object then null; when undefined_object then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table public.automation_runs';
  exception when duplicate_object then null; when undefined_object then null;
  end;
end $$;
