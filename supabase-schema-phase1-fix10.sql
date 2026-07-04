-- Fix for "infinite recursion detected in policy for relation office_members".
-- Every policy ON office_members that also QUERIES office_members from within its
-- own USING/WITH CHECK clause (all 4 of them, since Phase 1) is the classic Postgres
-- RLS self-reference trap: evaluating the policy for one row requires re-running the
-- same policy to compute the subquery, which requires re-running it again, etc.
-- Confirmed live in this project during a real sign-in attempt, not just theoretical.
--
-- Fix: three SECURITY DEFINER helper functions. A SECURITY DEFINER function runs as
-- its OWNER (the role that ran this migration, which owns the tables) instead of the
-- calling user, which bypasses office_members' RLS entirely for the query INSIDE the
-- function — breaking the cycle. Every policy below is rewritten to call a helper
-- instead of embedding a raw self-referencing subquery; nothing about WHO can see or
-- insert what actually changes, only how it's computed.

create or replace function public.my_office_id()
returns uuid
language sql security definer stable set search_path = public
as $$
  select office_id from public.office_members where user_id = auth.uid() limit 1;
$$;

create or replace function public.am_office_owner(check_office_id uuid)
returns boolean
language sql security definer stable set search_path = public
as $$
  select exists(
    select 1 from public.office_members
    where user_id = auth.uid() and office_id = check_office_id and role = 'owner'
  );
$$;

create or replace function public.already_a_member()
returns boolean
language sql security definer stable set search_path = public
as $$
  select exists(select 1 from public.office_members where user_id = auth.uid());
$$;

drop policy if exists "office_members_select_own_office" on public.office_members;
create policy "office_members_select_own_office" on public.office_members
  for select using (office_id = public.my_office_id());

drop policy if exists "office_members_owner_manages" on public.office_members;
create policy "office_members_owner_manages" on public.office_members
  for all using (public.am_office_owner(office_id));

drop policy if exists "office_members_insert_self_as_owner" on public.office_members;
create policy "office_members_insert_self_as_owner" on public.office_members
  for insert with check (
    user_id = auth.uid() and role = 'owner'
    and not public.already_a_member()
  );

-- Keeps fix6.sql's case-insensitive email match (lower() on both sides) — only the
-- self-referencing "not exists" clause changes here.
drop policy if exists "office_members_insert_via_invite" on public.office_members;
create policy "office_members_insert_via_invite" on public.office_members
  for insert with check (
    user_id = auth.uid()
    and not public.already_a_member()
    and exists (
      select 1 from public.office_invites i
      where i.office_id = office_members.office_id
        and i.role = office_members.role
        and lower(i.email) = (select lower(u.email) from auth.users u where u.id = auth.uid())
        and i.redeemed_at is null
        and i.expires_at > now()
    )
  );
