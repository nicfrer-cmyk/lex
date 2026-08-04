-- ============================================================================
-- לולאת למידה — הסוכנים משתפרים מהתיקונים שלך ומדפוסי העבודה
-- ============================================================================
--
-- ## למה זה נחוץ
-- המערכת כבר **אוספת** את כל הסיגנלים: ai_approvals.edited_payload (מה
-- תיקנת לפני שאישרת), rejection_reason (למה דחית), return_instruction (מה
-- ביקשת לשנות), ai_feedback (👍/👎). אבל עד כה אף רכיב לא קרא אותם בחזרה —
-- כלומר המערכת תיעדה כל תיקון שלך ולא למדה ממנו כלום. הטבלה הזו והפונקציה
-- ai-learn סוגרות את הלולאה.
--
-- ## עקרון מנחה: לומד מציע, אדם מאשר
-- זו מערכת שמפיקה מסמכים משפטיים. סוכן ש"לומד" ומשנה את התנהגותו לבד הוא
-- סוכן שאי אפשר להסביר בדיעבד למה עשה מה שעשה. לכן כל תובנה נשמרת כ-
-- 'proposed', מוצגת עם הראיות שהובילו אליה, ונכנסת לתוקף רק אחרי אימוץ
-- מפורש. אימוץ מעתיק את הלקח ל-ai_memories, ומשם הוא נכנס ל-prompt של
-- הסוכן בהרצות הבאות.
--
-- ## שני מקורות למידה
-- 1. **תיקונים** — ערכת/דחית/החזרת הצעה. הסיגנל החזק ביותר.
-- 2. **דפוסים ללא תיקון** — אותה פעולה אושרה שוב ושוב **בלי** שנגעת בה.
--    זה בדיוק "עבודה שחוזרת על עצמה ללא תיקונים": עדות שהסוכן אמין בתחום
--    הזה, ושאפשר להעלות לו את רמת העצמאות או להפוך את זה לאוטומציה.
-- ============================================================================


-- ============================================================
-- 1. ai_learning_insights — תובנות שממתינות לאימוץ
-- ============================================================
create table if not exists public.ai_learning_insights (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  agent_id uuid references public.ai_agents(id) on delete cascade,

  -- correction        — למדנו מעריכה/דחייה/החזרה שלך
  -- repetition        — אותה פעולה אושרה שוב ושוב בלי תיקון
  -- recurring_task    — אותה משימה מופעלת ידנית שוב ושוב → מועמדת לאוטומציה
  -- failure_pattern   — אותה שגיאה חוזרת בהרצות
  kind text not null check (kind in ('correction','repetition','recurring_task','failure_pattern')),

  title text not null,
  -- הלקח עצמו, בניסוח שאפשר להזריק כמו שהוא ל-prompt של הסוכן.
  lesson text not null,
  -- על מה זה מבוסס: מזהי אישורים, ספירות, ציטוטים. מוצג למשתמש לפני אימוץ,
  -- כי "הסוכן למד משהו" בלי להראות ממה זה חסר ערך ובלתי ניתן לביקורת.
  evidence jsonb not null default '{}'::jsonb,
  occurrences int not null default 1,
  confidence numeric not null default 0.5 check (confidence between 0 and 1),

  -- הצעת פעולה מבנית, כשיש. למשל:
  --   {"type":"raise_autonomy","from":2,"to":3,"action_type":"create_task"}
  --   {"type":"create_automation","trigger_type":"...","agent":"..."}
  suggested_action jsonb,

  status text not null default 'proposed'
    check (status in ('proposed','accepted','dismissed','superseded')),
  -- הזיכרון שנוצר באימוץ — מאפשר לבטל אימוץ ולמחוק את הלקח שנוצר ממנו.
  memory_id uuid references public.ai_memories(id) on delete set null,

  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  dismiss_reason text,
  -- מונע יצירת אותה תובנה שוב ושוב בכל סבב למידה.
  dedupe_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ⚠ האינדקס הזה **חייב** להיות מלא ולא חלקי (`where ... status='proposed'`).
-- ai-learn כותב עם ON CONFLICT (office_id, dedupe_key) DO NOTHING, ו-Postgres
-- אינו יכול להסיק אינדקס חלקי מרשימת עמודות בלבד — הוא נופל ב-42P10 על כל
-- הכנסה, גם כשאין כלל התנגשות. כלומר אינדקס חלקי היה מפיל **כל** סבב למידה,
-- ולא רק את מקרה הכפילות.
--
-- מלא הוא גם הסמנטיקה הנכונה: ai-learn ממילא מסנן מפתחות שכבר קיימים
-- בסטטוס proposed, accepted **או** dismissed. תובנה שנדחתה לא אמורה לחזור
-- בכל סבב — זו הטרדה, לא למידה.
drop index if exists public.ai_learning_insights_dedupe;
create unique index if not exists ai_learning_insights_dedupe
  on public.ai_learning_insights(office_id, dedupe_key);
create index if not exists ai_learning_insights_office_idx
  on public.ai_learning_insights(office_id, status, created_at desc);

alter table public.ai_learning_insights enable row level security;

drop policy if exists "ai_learning_insights_select" on public.ai_learning_insights;
create policy "ai_learning_insights_select" on public.ai_learning_insights
  for select using (is_office_member(office_id));

-- אימוץ/דחייה = בעל המשרד בלבד. תובנה שמאומצת נכנסת ל-prompt של הסוכן
-- ומשפיעה על כל טיוטה עתידית — זו החלטה ברמת מדיניות המשרד.
drop policy if exists "ai_learning_insights_update" on public.ai_learning_insights;
create policy "ai_learning_insights_update" on public.ai_learning_insights
  for update using (is_office_owner(office_id)) with check (is_office_owner(office_id));


-- ============================================================
-- 2. סימון מה כבר נלמד
-- ============================================================
-- בלי זה כל סבב למידה היה קורא שוב את כל ההיסטוריה ומייצר את אותן תובנות.
alter table public.ai_approvals
  add column if not exists learned_at timestamptz;
create index if not exists ai_approvals_unlearned_idx
  on public.ai_approvals(office_id, status)
  where learned_at is null;

alter table public.ai_feedback
  add column if not exists learned_at timestamptz;


-- ============================================================
-- 3. ai_learning_stats — מדדים לכל סוכן
-- ============================================================
-- "כמה פעמים תיקנתי את הסוכן הזה" הוא המדד היחיד שבאמת אומר אם הוא משתפר.
-- שיעור עריכה יורד לאורך זמן = הלמידה עובדת.
create or replace function public.ai_learning_stats(p_office_id uuid, p_days int default 90)
returns table (
  agent_id uuid,
  total int,
  edited int,
  rejected int,
  returned int,
  clean int,
  edit_rate numeric
)
language sql
security definer
stable
set search_path = public
as $$
  select
    a.agent_id,
    count(*)::int,
    count(*) filter (where a.edited_payload is not null
                       and a.edited_payload is distinct from a.proposed_payload)::int,
    count(*) filter (where a.status = 'rejected')::int,
    count(*) filter (where a.status = 'returned')::int,
    -- "נקי" = אושר או הוחל בלי שנגעת בו בכלל. זה המונה של הדפוס
    -- "עבודה שחוזרת על עצמה ללא תיקונים".
    count(*) filter (
      where a.status in ('approved','applied')
        and (a.edited_payload is null
             or a.edited_payload is not distinct from a.proposed_payload)
    )::int,
    round(
      count(*) filter (where a.edited_payload is not null
                         and a.edited_payload is distinct from a.proposed_payload)::numeric
      / greatest(count(*), 1), 3)
  from public.ai_approvals a
  where a.office_id = p_office_id
    and a.requested_at > now() - make_interval(days => p_days)
    and (auth.uid() is null or public.is_office_member(p_office_id))
  group by a.agent_id;
$$;

revoke all on function public.ai_learning_stats(uuid, int) from public, anon;
grant execute on function public.ai_learning_stats(uuid, int) to authenticated, service_role;


-- ============================================================
-- 4. accept_learning_insight — אימוץ אטומי
-- ============================================================
-- יוצר את הזיכרון וקושר אותו לתובנה בפעולה אחת. security definer עם בדיקת
-- בעלות מפורשת, כי הוא כותב ל-ai_memories שהיא owner-only.
create or replace function public.accept_learning_insight(p_insight_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  ins public.ai_learning_insights;
  new_memory uuid;
begin
  select * into ins from public.ai_learning_insights where id = p_insight_id;
  if ins.id is null then
    raise exception 'התובנה לא נמצאה';
  end if;
  if not public.is_office_owner(ins.office_id) then
    raise exception 'אימוץ תובנה מותר לבעל המשרד בלבד';
  end if;
  if ins.status <> 'proposed' then
    raise exception 'התובנה כבר טופלה';
  end if;

  -- scope_type='agent' כדי שהלקח ייכנס ל-prompt של אותו סוכן בלבד.
  -- verified=true: אדם אישר אותו במפורש, בניגוד לזיכרון שסוכן כתב לעצמו.
  --
  -- ⚠ כשאין agent_id (תובנה שלא נקשרה לסוכן מסוים) חובה ליפול ל-scope
  -- 'office'. שמירה כ-('agent', null) הייתה יוצרת זיכרון שאיש לא קורא:
  -- buildContext מסנן scope='agent' לפי scope_id של סוכן קיים, ולכן הלקח
  -- היה מאומץ, מוצג כ"פעיל" במסך — ולא משפיע על כלום.
  insert into public.ai_memories (
    office_id, scope_type, scope_id, memory_type, title, content,
    source_type, source_id, confidence_score, verified, created_by
  ) values (
    ins.office_id,
    case when ins.agent_id is null then 'office' else 'agent' end,
    ins.agent_id::text, 'lesson', ins.title, ins.lesson,
    'user', ins.id::text, 1.0, true, auth.uid()
  ) returning id into new_memory;

  update public.ai_learning_insights
  set status = 'accepted', memory_id = new_memory,
      reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
  where id = p_insight_id;

  return new_memory;
end;
$$;

revoke all on function public.accept_learning_insight(uuid) from public, anon;
grant execute on function public.accept_learning_insight(uuid) to authenticated;


-- ============================================================
-- 5. dismiss_learning_insight
-- ============================================================
create or replace function public.dismiss_learning_insight(p_insight_id uuid, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_office uuid;
begin
  select office_id into v_office from public.ai_learning_insights where id = p_insight_id;
  if v_office is null or not public.is_office_owner(v_office) then
    return false;
  end if;
  update public.ai_learning_insights
  set status = 'dismissed', dismiss_reason = p_reason,
      reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
  where id = p_insight_id and status = 'proposed';
  return found;
end;
$$;

revoke all on function public.dismiss_learning_insight(uuid, text) from public, anon;
grant execute on function public.dismiss_learning_insight(uuid, text) to authenticated;


-- ============================================================
-- 6. ביטול אימוץ — מוחק את הזיכרון שנוצר
-- ============================================================
-- לקח שהתברר כשגוי חייב להיות ניתן להסרה, אחרת הוא ממשיך להשפיע על כל
-- טיוטה עתידית בלי שאיש זוכר מאיפה הוא הגיע.
create or replace function public.revert_learning_insight(p_insight_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare ins public.ai_learning_insights;
begin
  select * into ins from public.ai_learning_insights where id = p_insight_id;
  if ins.id is null or not public.is_office_owner(ins.office_id) then
    return false;
  end if;
  if ins.memory_id is not null then
    delete from public.ai_memories where id = ins.memory_id;
  end if;
  update public.ai_learning_insights
  set status = 'dismissed', memory_id = null,
      dismiss_reason = 'האימוץ בוטל', reviewed_by = auth.uid(),
      reviewed_at = now(), updated_at = now()
  where id = p_insight_id;
  return true;
end;
$$;

revoke all on function public.revert_learning_insight(uuid) from public, anon;
grant execute on function public.revert_learning_insight(uuid) to authenticated;


-- ============================================================
-- 7. הגדרות למידה
-- ============================================================
alter table public.ai_settings
  add column if not exists learning_enabled boolean not null default true,
  -- כמה פעמים אותה פעולה צריכה לעבור נקייה לפני שמוצע להעלות עצמאות
  add column if not exists learning_repetition_threshold int not null default 5,
  add column if not exists learning_last_run_at timestamptz;


-- ============================================================
-- 8. טריגר updated_at
-- ============================================================
drop trigger if exists ai_learning_insights_touch on public.ai_learning_insights;
create trigger ai_learning_insights_touch before update on public.ai_learning_insights
  for each row execute function public.ai_touch_updated_at();


-- ============================================================
-- 9. Realtime
-- ============================================================
do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.ai_learning_insights';
  exception when duplicate_object then null;
            when undefined_object then null;
  end;
end $$;
