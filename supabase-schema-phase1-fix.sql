-- Fix for "infinite recursion detected in policy for relation office_members".
-- Cause: policies on office_members subqueried office_members itself to resolve
-- "which offices am I in" — evaluating that subquery re-triggers the same RLS
-- policy on office_members, forever. Standard Postgres fix: move the lookup into
-- a SECURITY DEFINER function, which runs with elevated privileges internally and
-- does not re-trigger RLS on the table it queries, breaking the cycle.
-- Run this AFTER supabase-schema-phase1.sql (which already ran).

create or replace function public.my_office_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  select office_id from public.office_members where user_id = auth.uid();
$$;

create or replace function public.my_owner_office_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  select office_id from public.office_members where user_id = auth.uid() and role = 'owner';
$$;

create or replace function public.is_office_member(check_office_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.office_members where user_id = auth.uid() and office_id = check_office_id
  );
$$;

create or replace function public.has_any_office()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.office_members where user_id = auth.uid());
$$;

-- ---- office_members: redefine using the functions above (no more self-subquery) ----
drop policy if exists "office_members_select_own_office" on public.office_members;
create policy "office_members_select_own_office" on public.office_members
  for select using (office_id in (select public.my_office_ids()));

drop policy if exists "office_members_owner_manages" on public.office_members;
create policy "office_members_owner_manages" on public.office_members
  for all using (office_id in (select public.my_owner_office_ids()));

drop policy if exists "office_members_insert_self_as_owner" on public.office_members;
create policy "office_members_insert_self_as_owner" on public.office_members
  for insert with check (
    user_id = auth.uid() and role = 'owner' and not public.has_any_office()
  );

drop policy if exists "office_members_insert_via_invite" on public.office_members;
create policy "office_members_insert_via_invite" on public.office_members
  for insert with check (
    user_id = auth.uid()
    and not public.has_any_office()
    and exists (
      select 1 from public.office_invites i
      where i.office_id = office_members.office_id
        and i.role = office_members.role
        and i.email = (select u.email from auth.users u where u.id = auth.uid())
        and i.redeemed_at is null
        and i.expires_at > now()
    )
  );

-- ---- offices ----
drop policy if exists "offices_select_member" on public.offices;
create policy "offices_select_member" on public.offices
  for select using (id in (select public.my_office_ids()));

drop policy if exists "offices_update_owner" on public.offices;
create policy "offices_update_owner" on public.offices
  for update using (id in (select public.my_owner_office_ids()));

-- ---- office_invites ----
drop policy if exists "office_invites_owner_creates" on public.office_invites;
create policy "office_invites_owner_creates" on public.office_invites
  for insert with check (office_id in (select public.my_owner_office_ids()));

drop policy if exists "office_invites_owner_views" on public.office_invites;
create policy "office_invites_owner_views" on public.office_invites
  for select using (
    office_id in (select public.my_owner_office_ids())
    or email = (select u.email from auth.users u where u.id = auth.uid())
  );

-- ---- ai_usage ----
drop policy if exists "ai_usage_select_own_office" on public.ai_usage;
create policy "ai_usage_select_own_office" on public.ai_usage
  for select using (office_id in (select public.my_office_ids()));

-- ---- app_data ----
drop policy if exists "app_data_select_office" on public.app_data;
create policy "app_data_select_office" on public.app_data
  for select using (office_id in (select public.my_office_ids()));

drop policy if exists "app_data_insert_office" on public.app_data;
create policy "app_data_insert_office" on public.app_data
  for insert with check (office_id in (select public.my_office_ids()));

drop policy if exists "app_data_update_office" on public.app_data;
create policy "app_data_update_office" on public.app_data
  for update using (office_id in (select public.my_office_ids()))
  with check (office_id in (select public.my_office_ids()));

-- ---- storage.objects (documents bucket, office-scoped policies) ----
drop policy if exists "documents_select_office" on storage.objects;
create policy "documents_select_office" on storage.objects
  for select using (
    bucket_id = 'documents' and public.is_office_member(((storage.foldername(name))[1])::uuid)
  );
drop policy if exists "documents_insert_office" on storage.objects;
create policy "documents_insert_office" on storage.objects
  for insert with check (
    bucket_id = 'documents' and public.is_office_member(((storage.foldername(name))[1])::uuid)
  );
drop policy if exists "documents_update_office" on storage.objects;
create policy "documents_update_office" on storage.objects
  for update using (
    bucket_id = 'documents' and public.is_office_member(((storage.foldername(name))[1])::uuid)
  );
drop policy if exists "documents_delete_office" on storage.objects;
create policy "documents_delete_office" on storage.objects
  for delete using (
    bucket_id = 'documents' and public.is_office_member(((storage.foldername(name))[1])::uuid)
  );
