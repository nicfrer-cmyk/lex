-- Defense-in-depth for email-case mismatches on team invites: the app now lowercases
-- the invite email before it's stored (see createTeamInvite() in app.js), but these
-- policies compared office_invites.email against auth.users.email with a raw `=`,
-- which is case-sensitive. Wrapping both sides in lower() means an invite still
-- redeems correctly even for rows created before that client-side fix, or if a future
-- caller forgets to lowercase.
drop policy if exists "office_invites_owner_views" on public.office_invites;
create policy "office_invites_owner_views" on public.office_invites
  for select using (
    office_id in (select om.office_id from public.office_members om where om.user_id = auth.uid() and om.role = 'owner')
    or lower(email) = (select lower(u.email) from auth.users u where u.id = auth.uid())
  );

drop policy if exists "office_invites_redeem_own" on public.office_invites;
create policy "office_invites_redeem_own" on public.office_invites
  for update using (
    lower(email) = (select lower(u.email) from auth.users u where u.id = auth.uid())
    and redeemed_at is null
    and expires_at > now()
  ) with check (
    lower(email) = (select lower(u.email) from auth.users u where u.id = auth.uid())
  );

drop policy if exists "office_members_insert_via_invite" on public.office_members;
create policy "office_members_insert_via_invite" on public.office_members
  for insert with check (
    user_id = auth.uid()
    and not exists (select 1 from public.office_members existing where existing.user_id = auth.uid())
    and exists (
      select 1 from public.office_invites i
      where i.office_id = office_members.office_id
        and i.role = office_members.role
        and lower(i.email) = (select lower(u.email) from auth.users u where u.id = auth.uid())
        and i.redeemed_at is null
        and i.expires_at > now()
    )
  );
