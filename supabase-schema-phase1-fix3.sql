-- Fix for "permission denied for table users": several policies queried auth.users
-- directly to get the caller's email ((select u.email from auth.users u where
-- u.id = auth.uid())) — the authenticated role doesn't have SELECT on auth.users.
-- Supabase's supported way to get the caller's email inside a policy is
-- auth.jwt() ->> 'email', which reads it straight from the request's JWT claims
-- with no table access needed at all.

drop policy if exists "office_invites_owner_views" on public.office_invites;
create policy "office_invites_owner_views" on public.office_invites
  for select using (
    office_id in (select public.my_owner_office_ids())
    or email = (auth.jwt() ->> 'email')
  );

drop policy if exists "office_invites_redeem_own" on public.office_invites;
create policy "office_invites_redeem_own" on public.office_invites
  for update using (
    email = (auth.jwt() ->> 'email')
    and redeemed_at is null
    and expires_at > now()
  ) with check (
    email = (auth.jwt() ->> 'email')
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
        and i.email = (auth.jwt() ->> 'email')
        and i.redeemed_at is null
        and i.expires_at > now()
    )
  );
