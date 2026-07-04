-- LexTrack Phase 1: multi-tenant offices + roles + AI usage metering.
-- Run in Supabase SQL Editor AFTER supabase-schema.sql (Phase 0/2's original schema).
-- Additive/backward-compatible: app_data keeps its old `user_id` column (and old RLS
-- policies) until the new office_id-based code is confirmed working in production —
-- see the migration section at the bottom and the deploy-order note in the plan.

-- ============================================================
-- 1. offices — one row per law firm / tenant.
-- ============================================================
create table if not exists public.offices (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'המשרד שלי',
  vat_rate numeric not null default 18,
  created_at timestamptz not null default now()
);
alter table public.offices enable row level security;

-- ============================================================
-- 2. office_members — who belongs to which office, and their role.
-- ============================================================
create table if not exists public.office_members (
  office_id uuid not null references public.offices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','lawyer','secretary')),
  joined_at timestamptz not null default now(),
  primary key (office_id, user_id)
);
alter table public.office_members enable row level security;

-- A user can see membership rows for offices they belong to (needed to resolve
-- "which office am I in, what's my role" and to list teammates).
drop policy if exists "office_members_select_own_office" on public.office_members;
create policy "office_members_select_own_office" on public.office_members
  for select using (
    office_id in (select om.office_id from public.office_members om where om.user_id = auth.uid())
  );

-- Only an existing owner can add members directly (invite redemption uses a
-- separate, narrower policy below — this one is for owner-driven management later).
drop policy if exists "office_members_owner_manages" on public.office_members;
create policy "office_members_owner_manages" on public.office_members
  for all using (
    office_id in (select om.office_id from public.office_members om where om.user_id = auth.uid() and om.role = 'owner')
  );

-- offices: a member can see their own office's row (name, vat_rate).
drop policy if exists "offices_select_member" on public.offices;
create policy "offices_select_member" on public.offices
  for select using (
    id in (select om.office_id from public.office_members om where om.user_id = auth.uid())
  );
drop policy if exists "offices_update_owner" on public.offices;
create policy "offices_update_owner" on public.offices
  for update using (
    id in (select om.office_id from public.office_members om where om.user_id = auth.uid() and om.role = 'owner')
  );
-- Signup creates one office per new user (see platform.web.js) — must be allowed by RLS.
drop policy if exists "offices_insert_self" on public.offices;
create policy "offices_insert_self" on public.offices
  for insert with check (true); -- narrowed implicitly: only useful paired with an office_members insert below

drop policy if exists "office_members_insert_self_as_owner" on public.office_members;
create policy "office_members_insert_self_as_owner" on public.office_members
  for insert with check (
    user_id = auth.uid() and role = 'owner'
    and not exists (select 1 from public.office_members existing where existing.user_id = auth.uid())
  );

-- ============================================================
-- 3. office_invites — shareable-link invites (no service_role key needed).
-- ============================================================
create table if not exists public.office_invites (
  token uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  email text not null,
  role text not null check (role in ('lawyer','secretary')),
  created_by uuid references auth.users(id),
  expires_at timestamptz not null default (now() + interval '7 days'),
  redeemed_at timestamptz
);
alter table public.office_invites enable row level security;

drop policy if exists "office_invites_owner_creates" on public.office_invites;
create policy "office_invites_owner_creates" on public.office_invites
  for insert with check (
    office_id in (select om.office_id from public.office_members om where om.user_id = auth.uid() and om.role = 'owner')
  );
drop policy if exists "office_invites_owner_views" on public.office_invites;
create policy "office_invites_owner_views" on public.office_invites
  for select using (
    office_id in (select om.office_id from public.office_members om where om.user_id = auth.uid() and om.role = 'owner')
    -- also let an invited (not-yet-member) user read their own invite by token via a
    -- separate narrow lookup path in the app — handled client-side by querying with
    -- the token itself (primary key), which this policy still permits since the
    -- office_id subquery is only one way in; add a second clause for that lookup:
    or email = (select u.email from auth.users u where u.id = auth.uid())
  );

-- Let the invited person mark their own invite redeemed after joining (narrow: only
-- their own not-yet-redeemed, not-yet-expired invite, and only the redeemed_at field
-- meaningfully changes since the check re-validates the same match conditions).
drop policy if exists "office_invites_redeem_own" on public.office_invites;
create policy "office_invites_redeem_own" on public.office_invites
  for update using (
    email = (select u.email from auth.users u where u.id = auth.uid())
    and redeemed_at is null
    and expires_at > now()
  ) with check (
    email = (select u.email from auth.users u where u.id = auth.uid())
  );

-- Redeeming an invite = the invited user inserting their OWN office_members row,
-- allowed only if a valid unredeemed invite for their email/office exists.
-- v1 keeps the model simple — one user belongs to exactly one office (no office
-- switcher UI exists), so joining via invite is only allowed while not already a
-- member of any office, same constraint the self-signup path enforces below.
drop policy if exists "office_members_insert_via_invite" on public.office_members;
create policy "office_members_insert_via_invite" on public.office_members
  for insert with check (
    user_id = auth.uid()
    and not exists (select 1 from public.office_members existing where existing.user_id = auth.uid())
    and exists (
      select 1 from public.office_invites i
      where i.office_id = office_members.office_id
        and i.role = office_members.role
        and i.email = (select u.email from auth.users u where u.id = auth.uid())
        and i.redeemed_at is null
        and i.expires_at > now()
    )
  );

-- ============================================================
-- 4. ai_usage — per-request metering for the server-side AI proxy.
-- ============================================================
create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  office_id uuid not null references public.offices(id) on delete cascade,
  user_id uuid references auth.users(id),
  model text,
  input_tokens int,
  output_tokens int,
  cost_usd numeric,
  created_at timestamptz not null default now()
);
alter table public.ai_usage enable row level security;
drop policy if exists "ai_usage_select_own_office" on public.ai_usage;
create policy "ai_usage_select_own_office" on public.ai_usage
  for select using (
    office_id in (select om.office_id from public.office_members om where om.user_id = auth.uid())
  );
-- Inserts to ai_usage happen from the Edge Function using the service_role key
-- (bypasses RLS by design — it's the one trusted server-side writer), so no insert
-- policy is needed here for the anon/authenticated roles.

-- ============================================================
-- 5. app_data: add office_id alongside the existing user_id (additive, no data loss).
--    New office-scoped RLS policies are added WITHOUT removing the old user_id ones yet —
--    both can coexist during the deploy window described in the migration runbook.
-- ============================================================
alter table public.app_data add column if not exists office_id uuid references public.offices(id);

drop policy if exists "app_data_select_office" on public.app_data;
create policy "app_data_select_office" on public.app_data
  for select using (
    office_id in (select om.office_id from public.office_members om where om.user_id = auth.uid())
  );
drop policy if exists "app_data_insert_office" on public.app_data;
create policy "app_data_insert_office" on public.app_data
  for insert with check (
    office_id in (select om.office_id from public.office_members om where om.user_id = auth.uid())
  );
drop policy if exists "app_data_update_office" on public.app_data;
create policy "app_data_update_office" on public.app_data
  for update using (
    office_id in (select om.office_id from public.office_members om where om.user_id = auth.uid())
  ) with check (
    office_id in (select om.office_id from public.office_members om where om.user_id = auth.uid())
  );

-- ============================================================
-- 6. Storage: office-scoped policies alongside the existing user-scoped ones.
--    New path convention going forward: <office_id>/documents/... and <office_id>/templates/...
-- ============================================================
drop policy if exists "documents_select_office" on storage.objects;
create policy "documents_select_office" on storage.objects
  for select using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1]::uuid in (
      select om.office_id from public.office_members om where om.user_id = auth.uid()
    )
  );
drop policy if exists "documents_insert_office" on storage.objects;
create policy "documents_insert_office" on storage.objects
  for insert with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1]::uuid in (
      select om.office_id from public.office_members om where om.user_id = auth.uid()
    )
  );
drop policy if exists "documents_update_office" on storage.objects;
create policy "documents_update_office" on storage.objects
  for update using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1]::uuid in (
      select om.office_id from public.office_members om where om.user_id = auth.uid()
    )
  );
drop policy if exists "documents_delete_office" on storage.objects;
create policy "documents_delete_office" on storage.objects
  for delete using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1]::uuid in (
      select om.office_id from public.office_members om where om.user_id = auth.uid()
    )
  );

-- ============================================================
-- 7. One-time data migration for EXISTING accounts (safe to run once; idempotent).
--    Mints each existing user their own office, with office_id = their user_id, so
--    existing Storage paths (<user_id>/...) automatically match the new office-scoped
--    Storage policies above with zero file movement — same id, new meaning.
-- ============================================================
insert into public.offices (id, name)
select ad.user_id, 'המשרד שלי'
from public.app_data ad
where not exists (select 1 from public.offices o where o.id = ad.user_id)
on conflict (id) do nothing;

insert into public.office_members (office_id, user_id, role)
select ad.user_id, ad.user_id, 'owner'
from public.app_data ad
where not exists (
  select 1 from public.office_members om where om.office_id = ad.user_id and om.user_id = ad.user_id
)
on conflict (office_id, user_id) do nothing;

update public.app_data set office_id = user_id where office_id is null;
