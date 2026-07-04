// LexTrack — receives Grow (Meshulam)'s payment/recurring-charge webhook and marks
// the matching office's subscription active. This URL goes into Grow's dashboard
// (wherever they ask for a "callback"/"webhook"/"IPN" URL), NOT into app code.
//
// Deploy: `supabase functions deploy grow-webhook --no-verify-jwt`
//   (--no-verify-jwt because Grow calls this directly, with no Supabase auth token —
//   see the TODO below for verifying the request is genuinely from Grow instead)
//
// *** NOT YET VERIFIED AGAINST A REAL GROW WEBHOOK — see the TODOs below. ***
// Same limitation as create-payment-page: couldn't confirm Grow's exact webhook
// payload shape or signing scheme from their docs site in this environment. Confirm
// against a real test transaction (Grow's sandbox) before relying on this.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body = await req.json().catch(() => null);
  if (!body) return new Response('Invalid JSON', { status: 400 });

  // TODO: verify this request actually came from Grow — e.g. a signature header, a
  // shared secret query param you configure in their dashboard, or an IP allowlist.
  // Without this, anyone who finds this URL could mark any office "active" for free.

  // TODO: confirm the real field names Grow sends. Guessing at the shape based on
  // common payment-webhook conventions (transaction id, status, and whatever you
  // passed through as metadata in create-payment-page's growPayload) — do not trust
  // this until checked against an actual sandbox payment.
  const growCustomerId: string | undefined = body.transactionId || body.processId;
  const officeIdFromMetadata: string | undefined = body.officeId; // if Grow echoes back custom fields
  const isSuccess = body.status === 1 || body.status === 'success';

  if (!isSuccess) return new Response('ok', { status: 200 }); // acknowledge, nothing to update

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const matchColumn = officeIdFromMetadata ? 'office_id' : 'grow_customer_id';
  const matchValue = officeIdFromMetadata || growCustomerId;
  if (!matchValue) return new Response('Missing office/customer reference', { status: 400 });

  const { error } = await supabase.from('subscriptions')
    .update({ status: 'active', grow_customer_id: growCustomerId, updated_at: new Date().toISOString() })
    .eq(matchColumn, matchValue);
  if (error) return new Response(error.message, { status: 500 });

  return new Response('ok', { status: 200 });
});
