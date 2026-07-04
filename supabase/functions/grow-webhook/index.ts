// LexTrack — receives Grow (Meshulam)'s payment/recurring-charge webhook (the
// notifyUrl passed in create-payment-page) and marks the matching office's
// subscription active. This URL is set automatically via that function's
// notifyUrl param — you don't need to paste it into Grow's dashboard separately.
//
// Deploy: `supabase functions deploy grow-webhook --no-verify-jwt`
//   (--no-verify-jwt because Grow calls this directly with no Supabase auth token)
// Secret: reuses GROW_WEBHOOK_SECRET (same one create-payment-page sets as cField2)
//
// Confirmed from Grow's docs: this callback arrives as an HTTP POST with FORM-ENCODED
// data (NOT JSON — "the same way as you would send the data to CreatePaymentProcess
// ... and NOT as JSON"). Payload includes transactionId, transactionToken, asmachta,
// processId, processToken, status/statusCode (2 = paid), sum, paymentDate, card
// details, fullName/payerPhone/payerEmail, description, customFields (cField1 etc.),
// paymentsNum/allPaymentsNum. After receiving it, Grow's docs say you must call
// ApproveTransaction to acknowledge it.
//
// *** STILL UNCONFIRMED — verify against a real sandbox transaction: ***
// - Whether customFields arrive flattened at the top level (cField1=...) or nested
//   (customFields[cField1]=... / customFields.cField1) — this code checks both.
// - ApproveTransaction's exact required fields (guessing transactionId +
//   transactionToken below, following the transactionId/transactionToken naming
//   used elsewhere in their docs) and whether it's form-encoded too (assumed yes,
//   for consistency with everything else in this API).
// - Grow has NO documented signature/HMAC scheme for this callback, so cField2
//   (a secret only your server and Grow's request know) is the practical stand-in
//   for verifying a callback is genuine — without it, anyone who finds this URL
//   could mark any office "active" for free.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GROW_WEBHOOK_SECRET = Deno.env.get('GROW_WEBHOOK_SECRET')!;
const GROW_API_BASE = 'https://sandbox.meshulam.co.il';
const GROW_USER_ID = Deno.env.get('GROW_USER_ID')!;
const GROW_PAGE_CODE = Deno.env.get('GROW_PAGE_CODE')!;

function field(form: URLSearchParams, name: string): string | null {
  // Handles both a flat `cField1=...` and a possible nested `customFields[cField1]=...`
  // shape — unconfirmed which one Grow actually sends (see header comment).
  return form.get(name) || form.get(`customFields[${name}]`) || form.get(`customFields.${name}`);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const contentType = req.headers.get('content-type') || '';
  let form: URLSearchParams;
  if (contentType.includes('application/json')) {
    // Fallback in case this turns out to be JSON after all — build an equivalent
    // URLSearchParams so the rest of this function doesn't care either way.
    const body = await req.json().catch(() => ({}));
    form = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
  } else {
    form = new URLSearchParams(await req.text());
  }

  const webhookSecret = field(form, 'cField2');
  if (webhookSecret !== GROW_WEBHOOK_SECRET) {
    return new Response('Invalid secret', { status: 401 });
  }

  const officeId = field(form, 'cField1');
  const status = form.get('status') || form.get('statusCode');
  const isPaid = status === '2' || status === 'שולם';
  const transactionId = form.get('transactionId');
  const transactionToken = form.get('transactionToken');

  if (!isPaid) return new Response('ok', { status: 200 }); // acknowledge, nothing to activate

  if (!officeId) return new Response('Missing office reference (cField1)', { status: 400 });

  // Required by Grow's docs to finalize the transaction — best-effort; a failure
  // here shouldn't block activating the subscription, since the payment itself
  // already succeeded (isPaid above).
  if (transactionId && transactionToken) {
    try {
      await fetch(`${GROW_API_BASE}/api/light/server/1.0/ApproveTransaction`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          userId: GROW_USER_ID,
          pageCode: GROW_PAGE_CODE,
          transactionId,
          transactionToken,
        }).toString(),
      });
    } catch (e) { /* logged nowhere yet — see ROADMAP.md TODO on confirming this call's real shape */ }
  }

  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { error } = await supabase.from('subscriptions')
    .update({ status: 'active', grow_customer_id: transactionId, updated_at: new Date().toISOString() })
    .eq('office_id', officeId);
  if (error) return new Response(error.message, { status: 500 });

  return new Response('ok', { status: 200 });
});
