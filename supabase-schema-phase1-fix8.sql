-- Lightweight, zero-new-account error logging: an alternative to a third-party
-- service like Sentry, using the Supabase project this app already runs on. Any
-- office member can log an error for their own office; only the owner can read them
-- back (Settings > errors section).
create table if not exists public.client_errors (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  message text not null,
  stack text,
  url text,
  user_agent text,
  created_at timestamptz not null default now()
);
alter table public.client_errors enable row level security;

drop policy if exists "client_errors_insert_own_office" on public.client_errors;
create policy "client_errors_insert_own_office" on public.client_errors
  for insert with check (
    user_id = auth.uid()
    and office_id in (select om.office_id from public.office_members om where om.user_id = auth.uid())
  );

drop policy if exists "client_errors_owner_views" on public.client_errors;
create policy "client_errors_owner_views" on public.client_errors
  for select using (
    office_id in (select om.office_id from public.office_members om where om.user_id = auth.uid() and om.role = 'owner')
  );

-- Keep the table from growing forever — errors older than 30 days aren't worth
-- keeping for this use case (a live "did something break recently" log, not an
-- audit trail). Run manually / on a schedule; no pg_cron assumed to be enabled.
-- delete from public.client_errors where created_at < now() - interval '30 days';
