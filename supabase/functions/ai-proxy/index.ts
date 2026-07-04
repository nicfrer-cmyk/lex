// LexTrack Phase 1 — server-side Anthropic proxy.
//
// Replaces the old client-side `fetch('https://api.anthropic.com/v1/messages', ...)`
// calls in src/app.js. The client sends just the Anthropic Messages API body
// ({ model, max_tokens, system, tools, messages }); this function adds the real
// API key (a server secret, never shipped to the browser), enforces a per-office
// monthly action quota, forwards the request, logs usage, and returns Anthropic's
// JSON response unchanged so app.js's existing response-parsing code doesn't
// need to change.
//
// Deploy: `supabase functions deploy ai-proxy`
// Secret: `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...` (the business's own key)
//
// TODO(Phase 4): MONTHLY_QUOTA is a placeholder flat limit. Once the `subscriptions`/
// `plans` tables exist, look up the office's actual plan instead of this constant.
const MONTHLY_QUOTA = 200;

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

// Haiku/Sonnet pricing per 1M tokens (USD) — mirrors the rates app.js used to
// compute session cost client-side; kept here now purely for the ai_usage log,
// not shown to end users anymore (Phase 1 removes the dollar-cost UI).
const RATES = {
  haiku: { in: 1, out: 5 },
  sonnet: { in: 3, out: 15 },
};

// Browsers calling a cross-origin endpoint (the Netlify site calling *.supabase.co)
// with custom headers (Authorization, apikey, content-type) send a CORS preflight
// OPTIONS request first. Without these headers on EVERY response (including
// OPTIONS), the browser blocks the real request before it ever reaches this code —
// this is exactly what "Failed to send a request to the Edge Function" looked like
// on a real phone (it wasn't caught by earlier testing because that used Node's
// fetch directly, which doesn't enforce CORS the way a browser/WebView does).
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
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const authHeader = req.headers.get('Authorization') || '';
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Identify the caller from their JWT (supabase.functions.invoke() attaches it
  // automatically) without needing the anon key's RLS — this function uses the
  // service_role key internally because it's the one trusted server-side writer
  // (ai_usage inserts, quota check across the whole office).
  const token = authHeader.replace('Bearer ', '');
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData.user) {
    return json({ error: 'לא מחובר' }, 401);
  }

  const { data: member, error: memberErr } = await supabase
    .from('office_members').select('office_id').eq('user_id', userData.user.id).maybeSingle();
  if (memberErr || !member) {
    return json({ error: 'לא נמצא משרד מקושר למשתמש' }, 403);
  }
  const officeId = member.office_id;

  // Quota check: count this calendar month's ai_usage rows for the office.
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const { count, error: countErr } = await supabase
    .from('ai_usage').select('id', { count: 'exact', head: true })
    .eq('office_id', officeId).gte('created_at', monthStart.toISOString());
  if (countErr) {
    return json({ error: countErr.message }, 500);
  }
  if ((count ?? 0) >= MONTHLY_QUOTA) {
    return json({
      error: `הגעת למכסת פעולות ה-AI החודשית (${MONTHLY_QUOTA}). המכסה מתאפסת בתחילת החודש הבא.`,
    }, 429);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const useCaching = body.useCaching !== false;
  const anthropicHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  if (useCaching) anthropicHeaders['anthropic-beta'] = 'prompt-caching-2024-07-31';

  const anthropicBody = {
    model: body.model,
    max_tokens: body.max_tokens,
    system: body.system,
    tools: body.tools,
    messages: body.messages,
  };

  const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: anthropicHeaders,
    body: JSON.stringify(anthropicBody),
  });
  const data = await anthropicResp.json();

  if (anthropicResp.ok && data.usage) {
    const isHaiku = String(body.model || '').includes('haiku');
    const rates = isHaiku ? RATES.haiku : RATES.sonnet;
    const costUsd = (data.usage.input_tokens / 1e6) * rates.in + (data.usage.output_tokens / 1e6) * rates.out;
    await supabase.from('ai_usage').insert({
      office_id: officeId,
      user_id: userData.user.id,
      model: body.model,
      input_tokens: data.usage.input_tokens,
      output_tokens: data.usage.output_tokens,
      cost_usd: costUsd,
    });
  }

  return json(data, anthropicResp.status);
});
