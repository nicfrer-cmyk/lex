-- ai_usage logs office_id/model/tokens/cost per AI call but has no way to tell which
-- feature made the call — so "how much did the הכן בקשה (request-generation) flow
-- cost across all offices" can't be separated from the AI agent chat or anything else
-- that calls Platform.callAI. Nullable, additive, breaks nothing already writing rows
-- without it (see supabase/functions/ai-proxy/index.ts, updated in the same change
-- to read an optional feature field off the request body and store it here).
alter table public.ai_usage add column if not exists feature text;
