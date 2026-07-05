// LexTrack — creates a hosted Grow (formerly Meshulam) payment page URL for a
// recurring monthly subscription charge. Mirrors ai-proxy's auth pattern: identify
// the caller from their JWT, resolve their office, service_role bypasses RLS for the
// actual subscriptions write (see supabase-schema-phase1-fix9.sql for why that
// table has no client-writable policy at all).
//
// Deploy: `supabase functions deploy create-payment-page`
// Secrets: `supabase secrets set GROW_USER_ID=... GROW_PAGE_CODE=... GROW_WEBHOOK_SECRET=...`
//   (userId/pageCode from Grow's onboarding — Dashboard → Settings → API; the
//   webhook secret is one YOU make up — see grow-webhook/index.ts for why)
//
// Confirmed from Grow's docs (grow-il.readme.io — the reference pages themselves
// render client-side and only surface real field names through their search index,
// not a browsable page): CreatePaymentProcess is called with FORM-ENCODED data (NOT
// JSON), required fields pageCode/sum/fullName/phone (email/description optional),
// paymentType=1 + paymentNum=<count> for a Grow-MANAGED recurring charge (as opposed
// to isRecurringDebitId=1, which is the alternative "you manage the token yourself"
// approach — not used here, this is simpler), notifyUrl for the webhook callback,
// and cField1/cField2 etc. for custom fields Grow echoes back on the webhook.
//
// *** STILL UNCONFIRMED — verify against Grow's sandbox before going live: ***
// - Whether a direct (non-aggregator) merchant needs BOTH userId and pageCode, or
//   just pageCode alone (the first onboarding doc mentioned both; a second page
//   mentioned apiKey+userId specifically for aggregators managing multiple
//   merchants — unclear which category a direct Meshulam account falls into).
// - The exact shape of CreatePaymentProcess's own response (which field holds the
//   payment page URL) — "GROW will respond with a link" is all their docs confirm.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GROW_USER_ID = Deno.env.get('GROW_USER_ID')!;
const GROW_PAGE_CODE = Deno.env.get('GROW_PAGE_CODE')!;
const GROW_WEBHOOK_SECRET = Deno.env.get('GROW_WEBHOOK_SECRET')!;
const GROW_API_BASE = 'https://sandbox.meshulam.co.il'; // switch to https://api.meshulam.co.il for real charges
const SITE_URL = Deno.env.get('SITE_URL') || 'https://zesty-marigold-0edcb2.netlify.app';
// The one plan LexTrack currently sells: ₪97/month, up to 20GB of document storage
// (see PLAN_STORAGE_LIMIT_GB in platform.web.js, which is what's actually enforced
// on upload — keep the two in sync if this ever changes).
const MONTHLY_PRICE_ILS = 97;
const PLAN_NAME = 'בסיסי — עד 20GB אחסון';

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

  const { data: member, error: memberErr } = await supabase
    .from('office_members').select('office_id, role').eq('user_id', userData.user.id).maybeSingle();
  if (memberErr || !member) return json({ error: 'לא נמצא משרד מקושר למשתמש' }, 403);
  if (member.role !== 'owner') return json({ error: 'רק בעל המשרד יכול לשדרג את המנוי' }, 403);

  const { data: office } = await supabase.from('offices').select('name').eq('id', member.office_id).maybeSingle();

  // cField1 = office_id (so grow-webhook can match the payment back to an office
  // without needing a prior grow_customer_id), cField2 = a shared secret only we
  // know (Grow's webhook has no signature scheme — this is the practical substitute:
  // grow-webhook rejects any callback where this doesn't come back unchanged).
  const growForm = new URLSearchParams({
    userId: GROW_USER_ID,
    pageCode: GROW_PAGE_CODE,
    sum: String(MONTHLY_PRICE_ILS),
    fullName: office?.name || userData.user.email || 'לקוח LexTrack',
    phone: '0000000000', // TODO: Grow requires this — collect a real phone number before charging, or confirm a placeholder is accepted
    email: userData.user.email || '',
    description: `מנוי LexTrack חודשי — ${PLAN_NAME}`,
    paymentType: '1', // Grow-managed recurring (not token-managed) — see comment above
    paymentNum: '999', // TODO: confirm how Grow expects "ongoing until canceled" vs a fixed count
    notifyUrl: `${SUPABASE_URL}/functions/v1/grow-webhook`,
    successUrl: `${SITE_URL}?payment=success`,
    cancelUrl: `${SITE_URL}?payment=cancelled`,
    cField1: member.office_id,
    cField2: GROW_WEBHOOK_SECRET,
  });

  const growResp = await fetch(`${GROW_API_BASE}/api/light/server/1.0/CreatePaymentProcess`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: growForm.toString(),
  });
  // TODO: confirm response envelope against a real sandbox call — this assumes JSON
  // with a `data.url` (or `url`) field per Grow's overview page; adjust once verified.
  const growData = await growResp.json().catch(() => null);
  const payUrl = growData?.data?.url || growData?.url;

  if (!growResp.ok || !payUrl) {
    return json({ error: (growData && (growData.message || growData.errorMessage)) || 'שגיאה ביצירת עמוד תשלום' }, 502);
  }

  return json({ url: payUrl });
});
