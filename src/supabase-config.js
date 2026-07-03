// Filled in once the user creates their Supabase project (see supabase-schema.sql for the
// matching SQL). The anon/public key is designed to be embedded client-side — RLS policies
// in supabase-schema.sql are what actually keep each user's data private, not secrecy of this key.
// NEVER put the service_role key here or anywhere in this repo.
export const SUPABASE_URL = 'https://syxutnwbpjsvzlwfpvyc.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_0G17eagr5PdjbieBue02EQ_2mcZqcs4';
