-- Fix for "null value in column user_id ... violates not-null constraint": app_data's
-- original user_id column is still the table's PRIMARY KEY (from Phase 2), which
-- implies NOT NULL — and a primary key column can't be made nullable while it's still
-- the primary key. New signups now insert rows keyed by office_id only, so:
--   1. Drop user_id as the primary key (existing rows/values are untouched, just the
--      constraint).
--   2. Make user_id nullable (now allowed).
--   3. office_id already has a UNIQUE constraint (fix4), which is what
--      upsert(..., {onConflict:'office_id'}) actually needs — no need to also make it
--      the primary key.
alter table public.app_data drop constraint if exists app_data_pkey;
alter table public.app_data alter column user_id drop not null;
