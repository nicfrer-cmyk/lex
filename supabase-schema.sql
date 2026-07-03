-- LexTrack Supabase schema.
-- Run this once in your Supabase project's SQL Editor (Project → SQL Editor → New query → paste → Run).
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE where possible.

-- ============================================================
-- 1. app_data — one row per user, the whole app state as JSON.
--    Mirrors the shape of the old local data.json 1:1 (cases, clients,
--    tasks, events, docs, payments, settings, timeEntries, counters).
-- ============================================================
create table if not exists public.app_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_data enable row level security;

-- Each user may only ever see/change their own row. This is the entire
-- multi-tenant isolation guarantee for the app's data.
drop policy if exists "app_data_select_own" on public.app_data;
create policy "app_data_select_own" on public.app_data
  for select using (auth.uid() = user_id);

drop policy if exists "app_data_insert_own" on public.app_data;
create policy "app_data_insert_own" on public.app_data
  for insert with check (auth.uid() = user_id);

drop policy if exists "app_data_update_own" on public.app_data;
create policy "app_data_update_own" on public.app_data
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Keep updated_at fresh on every write.
create or replace function public.app_data_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists app_data_touch on public.app_data;
create trigger app_data_touch
  before update on public.app_data
  for each row execute function public.app_data_set_updated_at();

-- ============================================================
-- 2. Storage bucket "documents" — generated docs, imported templates.
--    Path convention enforced by policy: <user_id>/<anything>.
--    Private bucket — nothing is publicly readable without a signed URL
--    or an authenticated request from the owning user.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

drop policy if exists "documents_select_own" on storage.objects;
create policy "documents_select_own" on storage.objects
  for select using (
    bucket_id = 'documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "documents_insert_own" on storage.objects;
create policy "documents_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "documents_update_own" on storage.objects;
create policy "documents_update_own" on storage.objects
  for update using (
    bucket_id = 'documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "documents_delete_own" on storage.objects;
create policy "documents_delete_own" on storage.objects
  for delete using (
    bucket_id = 'documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
