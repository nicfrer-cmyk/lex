-- שלב א' — תיקוני אבטחה ושמירת נתונים דחופים.
--
-- בטוח להרצה חוזרת (idempotent), ואינו נכשל אם טבלאות מרכז השיחות עוד לא
-- הוחלו על הסביבה. אינו מוחק ואינו משנה שום נתון קיים — רק מדיניות RLS,
-- טריגרים, וטבלת היסטוריה חדשה.
--
-- 1. היסטוריית גרסאות ל-app_data       (אין היום שום גיבוי לבלוב של המשרד)
-- 2. RLS-1: השתלטות על משרד קיים כ-owner
-- 3. RLS-2: מוזמן משכתב את office_id / role / expires_at של ההזמנה
-- 4. RLS-6/7: מדיניות user_id ישנות על app_data ו-storage
-- 5. RLS-4: push_subscriptions עם office_id של משרד זר
-- 6. RLS-10: voice_rate_bump פתוחה ל-anon


-- ============================================================
-- 1. app_data_history — צילום של הבלוב לפני שינוי
-- ============================================================
-- נשמר צילום של הגרסה הקודמת:
--   • לכל היותר אחד לכל 10 דקות לכל משרד (פעילות רגילה), וגם
--   • תמיד, כשהבלוב החדש קטן ביותר מ-20% מהקודם — זו החתימה של דריסה
--     בבלוב ריק או חלקי, בדיוק המקרה שהיה צריך לשחזר ממנו, וגם
--   • תמיד, לפני מחיקה של השורה.
-- צילומים בני יותר מ-90 יום נמחקים.
create table if not exists public.app_data_history (
  id bigserial primary key,
  office_id uuid not null,
  data jsonb not null,
  data_updated_at timestamptz,
  saved_at timestamptz not null default now(),
  reason text not null check (reason in ('periodic','shrink','delete'))
);
create index if not exists app_data_history_office_saved_idx
  on public.app_data_history (office_id, saved_at desc);

alter table public.app_data_history enable row level security;

-- רק בעלי המשרד רואים את ההיסטוריה. אין מדיניות כתיבה: רק הטריגר כותב.
drop policy if exists "app_data_history_owner_select" on public.app_data_history;
create policy "app_data_history_owner_select" on public.app_data_history
  for select using (public.am_office_owner(office_id));

create or replace function public.app_data_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text;
begin
  if old.office_id is null then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    v_reason := 'delete';
  elsif length(new.data::text) < length(old.data::text) * 0.8 then
    v_reason := 'shrink';
  elsif not exists (
    select 1 from public.app_data_history h
    where h.office_id = old.office_id and h.saved_at > now() - interval '10 minutes'
  ) then
    v_reason := 'periodic';
  end if;

  if v_reason is not null then
    insert into public.app_data_history (office_id, data, data_updated_at, reason)
    values (old.office_id, old.data, old.updated_at, v_reason);
    delete from public.app_data_history
    where office_id = old.office_id and saved_at < now() - interval '90 days';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists app_data_snapshot_trg on public.app_data;
create trigger app_data_snapshot_trg
  before update or delete on public.app_data
  for each row execute function public.app_data_snapshot();

-- צילום ראשון מיידי לכל משרד קיים, כדי שתהיה נקודת שחזור כבר מהיום.
insert into public.app_data_history (office_id, data, data_updated_at, reason)
select ad.office_id, ad.data, ad.updated_at, 'periodic'
from public.app_data ad
where ad.office_id is not null
  and not exists (select 1 from public.app_data_history h where h.office_id = ad.office_id);


-- ============================================================
-- 2. RLS-1 — יצירת owner מותרת רק למשרד חדש וריק
-- ============================================================
-- קודם נבדק רק "המשתמש אינו חבר באף משרד", בלי לבדוק *לאיזה* משרד הוא
-- מכניס את עצמו. עובד שהוסר, או מוזמן, יכלו להכניס את עצמם כבעלים של
-- כל משרד קיים. עכשיו: המשרד חייב להיות בלי חברים ונוצר בשעה האחרונה
-- (ensureSoloOffice יוצר את המשרד ואת ה-owner מיד אחד אחרי השני).
create or replace function public.office_claimable(check_office_id uuid)
returns boolean
language sql security definer stable set search_path = public
as $$
  select exists (
    select 1 from public.offices o
    where o.id = check_office_id
      and o.created_at > now() - interval '1 hour'
  )
  and not exists (
    select 1 from public.office_members m where m.office_id = check_office_id
  );
$$;

drop policy if exists "office_members_insert_self_as_owner" on public.office_members;
create policy "office_members_insert_self_as_owner" on public.office_members
  for insert with check (
    user_id = auth.uid() and role = 'owner'
    and not public.already_a_member()
    and public.office_claimable(office_id)
  );


-- ============================================================
-- 3. RLS-2 — מוזמן יכול רק לסמן את ההזמנה שלו כמומשה
-- ============================================================
-- ה-WITH CHECK של office_invites_redeem_own בדק רק email, ולכן office_id,
-- role ו-expires_at היו ניתנים לשכתוב — מוזמן הפנה את ההזמנה למשרד אחר
-- והצטרף אליו. טריגר (ולא רק policy) כדי שגם policy עתידית לא תפתח זאת.
create or replace function public.office_invites_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.am_office_owner(old.office_id) then
    return new;
  end if;
  if new.office_id is distinct from old.office_id
     or new.role is distinct from old.role
     or new.email is distinct from old.email
     or new.expires_at is distinct from old.expires_at
     or new.created_by is distinct from old.created_by
     or new.token is distinct from old.token then
    raise exception 'מותר רק לממש את ההזמנה (redeemed_at), לא לשנות אותה';
  end if;
  return new;
end;
$$;

drop trigger if exists office_invites_guard_update_trg on public.office_invites;
create trigger office_invites_guard_update_trg
  before update on public.office_invites
  for each row execute function public.office_invites_guard_update();


-- ============================================================
-- 4. RLS-6/7 — הסרת מדיניות ה-user_id מהשלב שלפני המשרדים
-- ============================================================
-- נשארו מ-supabase-schema.sql "עד שהקוד מבוסס-המשרד יאושר בייצור" ולא
-- הוסרו מעולם. הן נותנות גישה לפי user_id/תיקיית user_id ולא לפי חברות
-- במשרד — כלומר בעלים שהוסר ממשרד שהומר ממשיך לגשת. משרדים שהומרו קיבלו
-- office_id = user_id והבעלים חבר בהם, ולכן מדיניות המשרד מכסה אותם.
drop policy if exists "app_data_select_own" on public.app_data;
drop policy if exists "app_data_insert_own" on public.app_data;
drop policy if exists "app_data_update_own" on public.app_data;

drop policy if exists "documents_select_own" on storage.objects;
drop policy if exists "documents_insert_own" on storage.objects;
drop policy if exists "documents_update_own" on storage.objects;
drop policy if exists "documents_delete_own" on storage.objects;


-- ============================================================
-- 5. RLS-4 — מנוי push רק למשרד שהמשתמש חבר בו
-- ============================================================
drop policy if exists "push_subscriptions_own" on public.push_subscriptions;
create policy "push_subscriptions_own" on public.push_subscriptions
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid() and office_id in (select public.my_office_ids()));


-- ============================================================
-- 6. RLS-10 — voice_rate_bump רק ל-service_role
-- ============================================================
-- SECURITY DEFINER בלי REVOKE: ברירת המחדל של Postgres נותנת EXECUTE ל-PUBLIC,
-- ולכן anon יכול היה לנפח את מוני הקצב של כל משרד ולחסום לו שיחות.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'voice_rate_bump'
  ) then
    revoke execute on function public.voice_rate_bump(uuid, text, timestamptz) from public, anon, authenticated;
    grant execute on function public.voice_rate_bump(uuid, text, timestamptz) to service_role;
  end if;
end;
$$;
