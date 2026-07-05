-- Cleanup only, no behavior change. Found during a full RLS audit: has_any_office()
-- (defined in fix.sql) was superseded by already_a_member() in fix10.sql — its two
-- call sites were both replaced, and grep confirms zero remaining references
-- anywhere in the schema. Safe to drop.
drop function if exists public.has_any_office();
