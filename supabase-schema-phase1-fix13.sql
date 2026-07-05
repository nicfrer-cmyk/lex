-- app_data.office_id was added without ON DELETE CASCADE (unlike every other
-- office-scoped table: office_members, office_invites, ai_usage, subscriptions,
-- client_errors all already cascade) — as-is, deleting an office would just fail
-- outright with a foreign-key-violation error, since app_data rows still reference
-- it. Needed for the new "delete my account" feature (see delete-account Edge
-- Function) to actually work.
alter table public.app_data drop constraint if exists app_data_office_id_fkey;
alter table public.app_data add constraint app_data_office_id_fkey
  foreign key (office_id) references public.offices(id) on delete cascade;
