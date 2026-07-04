// LexTrack — creates a hosted Grow (formerly Meshulam) payment page URL for the
// calling office's subscription. Mirrors ai-proxy's auth pattern: identify the
// caller from their JWT, resolve their office, service_role bypasses RLS for the
// actual subscriptions write (see supabase-schema-phase1-fix9.sql for why that
// table has no client-writable policy at all).
//
// Deploy: `supabase functions deploy create-payment-page`
// Secrets: `supabase secrets set GROW_USER_ID=... GROW_PAGE_CODE=...`
//   (from Grow's onboarding — Dashboard → Settings → API, or ask their support;
//   these are NOT the same as your Grow dashboard login)
//
// *** NOT YET WIRED TO A REAL CHARGE — see the TODO below. ***
// Grow's docs site (grow-il.readme.io) renders its endpoint reference client-side,
// which this environment couldn't scrape field-by-field, so the exact request body
// for a RECURRING charge (vs. a one-off payment) is unverified. What's confirmed
// from Grow's own docs: CreatePaymentProcess takes `userId` + `pageCode` (server-side
// only — client-side calls are rejected), returns a hosted payment URL good for 10
// minutes, and `ApproveTransaction` finalizes it. The one-off shape below is a
// reasonable starting point; before going live, get the recurring-specific fields
// (likely something like `paymentType`/`numberOfPayments`/a recurring flag) from
// Grow's actual reference for your account and fill in the TODO section.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GROW_USER_ID = Deno.env.get('GROW_USER_ID')!;
const GROW_PAGE_CODE = Deno.env.get('GROW_PAGE_CODE')!;
const GROW_API_BASE = 'https://api.meshulam.co.il'; // sandbox: https://sandbox.meshulam.co.il

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

  // TODO: replace with the verified recurring-payment fields from Grow's reference
  // for your account (likely a recurring/subscription flag + amount + frequency).
  // This is the one-off "CreatePaymentProcess" shape confirmed from their public docs.
  const growPayload = {
    userId: GROW_USER_ID,
    pageCode: GROW_PAGE_CODE,
    sum: 99, // TODO: real monthly price in ILS
    description: 'מנוי LexTrack',
    successUrl: `${SUPABASE_URL.replace('.supabase.co', '')}`, // TODO: real success redirect (your app's URL)
    cancelUrl: `${SUPABASE_URL.replace('.supabase.co', '')}`, // TODO: real cancel redirect
    // TODO: pass officeId through as custom/metadata field if Grow supports one, so
    // grow-webhook can match the incoming payment notification back to this office
    // without relying solely on grow_customer_id (which doesn't exist until after
    // the first successful charge).
  };

  const growResp = await fetch(`${GROW_API_BASE}/api/light/server/1.0/CreatePaymentProcess`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(growPayload),
  });
  const growData = await growResp.json();

  if (!growResp.ok || growData.status !== 1) {
    return json({ error: growData.message || 'שגיאה ביצירת עמוד תשלום' }, 502);
  }

  return json({ url: growData.data?.url });
});
