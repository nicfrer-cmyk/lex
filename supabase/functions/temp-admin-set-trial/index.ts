// TEMPORARY testing utility — NOT part of the app. Deployed once to let the
// currently-logged-in owner test the trial-expiry paywall immediately instead of
// waiting 14 days, then deleted (`supabase functions delete temp-admin-set-trial`)
// right after use. Deployed WITH normal JWT verification (no --no-verify-jwt) and
// resolves office_id from the CALLER'S OWN auth token only — same pattern as every
// other function in this project (create-payment-page, delete-account, etc.). It
// cannot target any office other than the caller's own.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  const authHeader = req.headers.get('Authorization') || '';
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const token = authHeader.replace('Bearer ', '');
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData.user) {
    return new Response(JSON.stringify({ error: 'לא מחובר' }), { status: 401, headers: CORS_HEADERS });
  }

  const { data: member, error: memberErr } = await supabase
    .from('office_members').select('office_id, role').eq('user_id', userData.user.id).maybeSingle();
  if (memberErr || !member) {
    return new Response(JSON.stringify({ error: 'לא נמצא משרד' }), { status: 404, headers: CORS_HEADERS });
  }

  const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
  const { error: updateErr } = await supabase
    .from('subscriptions')
    .update({ trial_ends_at: pastDate, status: 'trial' })
    .eq('office_id', member.office_id);
  if (updateErr) {
    return new Response(JSON.stringify({ error: updateErr.message }), { status: 500, headers: CORS_HEADERS });
  }

  return new Response(JSON.stringify({ ok: true, trial_ends_at: pastDate }), {
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
});
