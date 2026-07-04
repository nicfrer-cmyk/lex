// LexTrack — sends the actual invite email for an already-created office_invites
// row (see Platform.createInvite(), unchanged), instead of the owner having to
// copy-paste the link themselves. Needs the service_role key because
// auth.admin.inviteUserByEmail() is an Admin API call — there is no anon-key
// equivalent, which is why this couldn't be done from the client at all before.
//
// Deploy: `supabase functions deploy send-invite-email`
// Secret: uses SUPABASE_SERVICE_ROLE_KEY, already required by ai-proxy — no new
//   secret to add IF that's already set; otherwise `supabase secrets set
//   SUPABASE_SERVICE_ROLE_KEY=...` (Dashboard → Settings → API → service_role,
//   "reveal" — treat it like a master password, never expose it client-side)
//
// *** Depends on real SMTP being configured (Supabase Dashboard → Authentication →
// Email) — otherwise this either fails outright or hits the same free-tier
// send-rate limit that's the whole reason email confirmation is currently
// disabled. Not meaningful to deploy before that's sorted. ***

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// TODO: set this to the real deployed site URL once decided (custom domain or the
// current Netlify one) — used to build the redirect the invite email link lands on.
const SITE_URL = Deno.env.get('SITE_URL') || 'https://zesty-marigold-0edcb2.netlify.app';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') || '';
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const token = authHeader.replace('Bearer ', '');
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData.user) return json({ error: 'לא מחובר' }, 401);

  let body: { inviteToken?: string };
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  if (!body.inviteToken) return json({ error: 'Missing inviteToken' }, 400);

  // Confirm the caller actually owns the office this invite belongs to — service_role
  // bypasses RLS entirely, so this check has to happen explicitly here, it's not
  // inherited from the office_invites_owner_creates policy the client-side insert used.
  const { data: invite, error: inviteErr } = await supabase
    .from('office_invites').select('office_id, email, redeemed_at, expires_at')
    .eq('token', body.inviteToken).maybeSingle();
  if (inviteErr || !invite) return json({ error: 'הזמנה לא נמצאה' }, 404);
  if (invite.redeemed_at) return json({ error: 'ההזמנה כבר נוצלה' }, 400);
  if (new Date(invite.expires_at) < new Date()) return json({ error: 'ההזמנה פגה' }, 400);

  const { data: member } = await supabase
    .from('office_members').select('office_id').eq('user_id', userData.user.id).eq('role', 'owner').maybeSingle();
  if (!member || member.office_id !== invite.office_id) {
    return json({ error: 'רק בעל המשרד יכול לשלוח הזמנה זו' }, 403);
  }

  const { error: sendErr } = await supabase.auth.admin.inviteUserByEmail(invite.email, {
    redirectTo: `${SITE_URL}?invite=${body.inviteToken}`,
  });
  if (sendErr) return json({ error: sendErr.message }, 502);

  return json({ ok: true });
});
