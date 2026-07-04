-- Fix for "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification": app_data.office_id was added as a plain column with no
-- uniqueness constraint, but platform.web.js's saveDB() does
-- .upsert({office_id, data}, {onConflict: 'office_id'}) which needs one.
-- (user_id stays the primary key for now — this just adds office_id as a second,
-- separately-enforced unique key, additive and non-destructive.)
alter table public.app_data add constraint app_data_office_id_unique unique (office_id);
