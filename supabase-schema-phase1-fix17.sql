-- "Open in Word, linked to the site" — desktop Word can open/edit/save a document
-- directly against a server over WebDAV (this is literally the mechanism behind
-- SharePoint/OneDrive's "Edit in Desktop App", not something Microsoft-exclusive).
-- Supabase Storage doesn't speak WebDAV itself, so the `webdav` Edge Function is a
-- thin WebDAV-protocol bridge in front of it. This migration adds what that function
-- needs: a way for Word's Basic-Auth prompt to authenticate (can't reuse a normal
-- Supabase session/JWT — Word has no way to present one), and minimal single-writer
-- locking so two people can't silently clobber each other's edits.

-- ============================================================
-- webdav_credentials — one long-lived credential per user, generated client-side
-- (Settings → "פתח ב-Word"): a random 256-bit token is generated in the browser,
-- ONLY its SHA-256 hash is ever sent/stored (same posture as a password — a fast
-- hash is fine here specifically because the token itself has enormous entropy,
-- unlike a human-chosen password where slow hashing matters against guessing).
-- Client can upsert its OWN row (self-service regeneration); only the webdav Edge
-- Function (service_role) ever reads it, to verify Word's Basic-Auth attempt.
-- ============================================================
create table if not exists public.webdav_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  office_id uuid not null references public.offices(id) on delete cascade,
  email text not null,
  token_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists webdav_credentials_email_idx on public.webdav_credentials(email);
alter table public.webdav_credentials enable row level security;

drop policy if exists "webdav_credentials_upsert_own" on public.webdav_credentials;
create policy "webdav_credentials_upsert_own" on public.webdav_credentials
  for insert with check (user_id = auth.uid() and is_office_member(office_id));
drop policy if exists "webdav_credentials_update_own" on public.webdav_credentials;
create policy "webdav_credentials_update_own" on public.webdav_credentials
  for update using (user_id = auth.uid()) with check (user_id = auth.uid() and is_office_member(office_id));
drop policy if exists "webdav_credentials_select_own" on public.webdav_credentials;
create policy "webdav_credentials_select_own" on public.webdav_credentials
  for select using (user_id = auth.uid());
-- No delete policy — regenerating overwrites (upsert) the existing row instead;
-- nothing needs to remove a credential outright.

-- ============================================================
-- webdav_locks — RFC4918 write locks, keyed by "{office_id}/{doc_id}" (the same
-- identifier the webdav function uses to resolve a document, see index.ts). Locks
-- are short-lived and Word renews them periodically while a document stays open;
-- an expired lock is just ignored/overwritten rather than requiring manual cleanup.
-- No client-facing policies — service_role (the Edge Function) only.
-- ============================================================
create table if not exists public.webdav_locks (
  path text primary key,
  lock_token text not null,
  office_id uuid not null references public.offices(id) on delete cascade,
  locked_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);
alter table public.webdav_locks enable row level security;
