-- Fix for "permission denied for table users" during Google sign-in / office
-- creation. This exact bug was already fixed once, in
-- supabase-schema-phase1-fix3.sql ("the authenticated role doesn't have SELECT on
-- auth.users — use auth.jwt() ->> 'email' instead, no table permission needed at
-- all"). fix6.sql (written later, without knowing fix3.sql existed) redefined the
-- same three policies using the ORIGINAL pre-fix3 pattern — (select u.email from
-- auth.users u where u.id = auth.uid()) — which silently undid fix3's fix while
-- keeping fix6's own lower()-wrapped case-insensitive comparison. This restores
-- fix3's approach while keeping fix6's case-insensitivity.

drop policy if exists "office_invites_owner_views" on public.office_invites;
create policy "office_invites_owner_views" on public.office_invites
  for select using (
    office_id in (select om.office_id from public.office_members om where om.user_id = auth.uid() and om.role = 'owner')
    or lower(email) = lower(auth.jwt() ->> 'email')
  );

drop policy if exists "office_invites_redeem_own" on public.office_invites;
create policy "office_invites_redeem_own" on public.office_invites
  for update using (
    lower(email) = lower(auth.jwt() ->> 'email')
    and redeemed_at is null
    and expires_at > now()
  ) with check (
    lower(email) = lower(auth.jwt() ->> 'email')
  );

drop policy if exists "office_members_insert_via_invite" on public.office_members;
create policy "office_members_insert_via_invite" on public.office_members
  for insert with check (
    user_id = auth.uid()
    and not public.already_a_member()
    and exists (
      select 1 from public.office_invites i
      where i.office_id = office_members.office_id
        and i.role = office_members.role
        and lower(i.email) = lower(auth.jwt() ->> 'email')
        and i.redeemed_at is null
        and i.expires_at > now()
    )
  );
