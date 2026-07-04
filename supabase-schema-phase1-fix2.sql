-- Fix for "new row violates row-level security policy for table offices" during signup.
-- The INSERT policy that should allow a brand-new user to create their own office
-- (offices_insert_self) isn't taking effect — re-asserting it here idempotently,
-- along with the office_members insert policies it pairs with, in case those were
-- also missed by whatever caused the first one to not apply.

drop policy if exists "offices_insert_self" on public.offices;
create policy "offices_insert_self" on public.offices
  for insert with check (true);

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

-- Diagnostic: list every policy actually registered on these three tables right now,
-- so if this still fails we can see exactly what's missing instead of guessing again.
select schemaname, tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename in ('offices', 'office_members', 'office_invites')
order by tablename, policyname;
