-- שלב ב' — שחזור גרסה של נתוני המשרד מתוך app_data_history.
--
-- בטוח להרצה חוזרת. אינו משנה נתונים קיימים: מוסיף ערך 'restore' לרשימת
-- הסיבות, ושתי פונקציות.

alter table public.app_data_history drop constraint if exists app_data_history_reason_check;
alter table public.app_data_history add constraint app_data_history_reason_check
  check (reason in ('periodic','shrink','delete','restore'));

-- רשימת הגרסאות — סיכום בלבד (בלי להוריד את הבלוב המלא של כל גרסה לדפדפן).
-- security invoker: ה-RLS של app_data_history (בעלים בלבד) חל כרגיל.
create or replace function public.list_app_data_versions()
returns table (
  id bigint, saved_at timestamptz, reason text,
  cases int, clients int, tasks int, payments int, trust int, docs int
)
language sql stable security invoker set search_path = public
as $$
  select h.id, h.saved_at, h.reason,
    coalesce(jsonb_array_length(case when jsonb_typeof(h.data->'cases') = 'array' then h.data->'cases' end), 0),
    coalesce(jsonb_array_length(case when jsonb_typeof(h.data->'clients') = 'array' then h.data->'clients' end), 0),
    coalesce(jsonb_array_length(case when jsonb_typeof(h.data->'tasks') = 'array' then h.data->'tasks' end), 0),
    coalesce(jsonb_array_length(case when jsonb_typeof(h.data->'payments') = 'array' then h.data->'payments' end), 0),
    coalesce(jsonb_array_length(case when jsonb_typeof(h.data->'trustTransactions') = 'array' then h.data->'trustTransactions' end), 0),
    coalesce(jsonb_array_length(case when jsonb_typeof(h.data->'docs') = 'array' then h.data->'docs' end), 0)
  from public.app_data_history h
  where h.office_id = public.my_office_id()
  order by h.saved_at desc
  limit 300;
$$;
grant execute on function public.list_app_data_versions() to authenticated;

-- שחזור: רק בעלי המשרד. לפני השחזור נשמר המצב הנוכחי כגרסה ('restore'),
-- כך שגם שחזור אפשר לבטל.
create or replace function public.restore_app_data_version(p_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_office uuid;
  v_data jsonb;
begin
  select office_id, data into v_office, v_data from public.app_data_history where id = p_id;
  if v_office is null then
    raise exception 'הגרסה לא נמצאה';
  end if;
  if not public.am_office_owner(v_office) then
    raise exception 'רק בעלי המשרד יכולים לשחזר גרסה';
  end if;

  insert into public.app_data_history (office_id, data, data_updated_at, reason)
  select office_id, data, updated_at, 'restore' from public.app_data where office_id = v_office;

  update public.app_data set data = v_data where office_id = v_office;
end;
$$;
revoke execute on function public.restore_app_data_version(bigint) from public, anon;
grant execute on function public.restore_app_data_version(bigint) to authenticated;
