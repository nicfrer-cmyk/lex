-- The one plan LexTrack sells: ₪97/month, up to 20GB of document storage per office.
-- storage_limit_gb is enforced client-side in platform.web.js on every upload (see
-- PLAN_STORAGE_LIMIT_GB there) — stored here too so it's inspectable/adjustable per
-- office later (e.g. a future bigger-storage plan) without a code change.
alter table public.subscriptions add column if not exists storage_limit_gb integer not null default 20;
