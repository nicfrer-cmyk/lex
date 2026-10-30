// LexTrack Phase 1 — server-side Anthropic proxy.
//
// Replaces the old client-side `fetch('https://api.anthropic.com/v1/messages', ...)`
// calls in src/app.js. The client sends the Anthropic Messages API body
// ({ model, max_tokens, system, tools, messages }) plus an optional `feature` string
// (e.g. 'request-gen') used only for the ai_usage log, never forwarded to Anthropic;
// this function adds the real API key (a server secret, never shipped to the
// browser), enforces a per-office monthly action quota, forwards the request, logs
// usage, and returns Anthropic's JSON response unchanged so app.js's existing
// response-parsing code doesn't need to change.
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

// The request body comes from the browser, and every call is billed to the platform's
// own key — so the model, output size, tools and request size are all fixed here, not
// trusted from the client. These are exactly the models src/app.js uses.
// Pricing per 1M tokens (USD), used for the ai_usage log and the monthly cost cap.
const MODEL_RATES: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
};
const MAX_OUTPUT_TOKENS = 8192;
// agentUploadFile allows a 10MB PDF/image, which is ~13.4MB once base64-encoded.
const MAX_BODY_BYTES = 15 * 1024 * 1024;
// Per-office monthly spend ceiling on the platform key, on top of the call-count quota
// (200 maximum-size calls could otherwise cost far more than the plan price).
const MONTHLY_USD_CAP = Number(Deno.env.get('AI_PROXY_MONTHLY_USD_CAP') || '25');

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

  // Same gate the client's checkSubscriptionGate() shows — enforced here too, since
  // calling this endpoint directly skips the paywall screen entirely.
  const { data: sub } = await supabase
    .from('subscriptions').select('status, trial_ends_at').eq('office_id', officeId).maybeSingle();
  if (sub) {
    const trialExpired = sub.status === 'trial' && sub.trial_ends_at && new Date(sub.trial_ends_at) < new Date();
    if (trialExpired || sub.status === 'past_due' || sub.status === 'canceled') {
      return json({ error: 'המנוי של המשרד אינו פעיל, ולכן פעולות AI חסומות. יש לחדש את המנוי.' }, 402);
    }
  }

  // Quota check: this calendar month's ai_usage rows for the office — both the call
  // count and their total logged cost.
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const { data: usageRows, error: countErr } = await supabase
    .from('ai_usage').select('cost_usd')
    .eq('office_id', officeId).gte('created_at', monthStart.toISOString());
  if (countErr) {
    return json({ error: countErr.message }, 500);
  }
  const count = (usageRows || []).length;
  const spentUsd = (usageRows || []).reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  if (count >= MONTHLY_QUOTA || spentUsd >= MONTHLY_USD_CAP) {
    return json({
      error: `הגעת למכסת פעולות ה-AI החודשית. המכסה מתאפסת בתחילת החודש הבא.`,
    }, 429);
  }

  const contentLength = Number(req.headers.get('content-length') || '0');
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: 'הבקשה גדולה מדי.' }, 413);
  }
  let body;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'הבקשה גדולה מדי.' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const rates = MODEL_RATES[String(body.model || '')];
  if (!rates) {
    return json({ error: 'מודל לא נתמך.' }, 400);
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return json({ error: 'חסרות הודעות בבקשה.' }, 400);
  }
  // Only the app's own client-side tools (name + input_schema). Anthropic server
  // tools (web_search etc., identified by a `type`) are billed per use on our key.
  if (body.tools !== undefined) {
    const toolsOk = Array.isArray(body.tools) && body.tools.every((t: any) =>
      t && typeof t.name === 'string' && t.input_schema && (t.type === undefined || t.type === 'custom'));
    if (!toolsOk) return json({ error: 'כלים לא נתמכים בבקשה.' }, 400);
  }
  const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 1024, 1), MAX_OUTPUT_TOKENS);

  const useCaching = body.useCaching !== false;
  const anthropicHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  if (useCaching) anthropicHeaders['anthropic-beta'] = 'prompt-caching-2024-07-31';

  const anthropicBody = {
    model: body.model,
    max_tokens: maxTokens,
    system: body.system,
    tools: body.tools,
    messages: body.messages,
  };

  // Network failures and non-JSON upstream replies (gateway HTML, timeouts) used to
  // throw out of the handler, so the runtime answered 500 with no CORS headers and the
  // browser showed only a generic "failed to send" error.
  let anthropicResp: Response;
  let data: any;
  try {
    anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify(anthropicBody),
    });
    data = await anthropicResp.json();
  } catch (_e) {
    return json({ error: 'שירות ה-AI אינו זמין כרגע. נסה/י שוב בעוד מספר דקות.' }, 502);
  }

  if (anthropicResp.ok && data.usage) {
    const costUsd = (data.usage.input_tokens / 1e6) * rates.in + (data.usage.output_tokens / 1e6) * rates.out;
    await supabase.from('ai_usage').insert({
      office_id: officeId,
      user_id: userData.user.id,
      model: body.model,
      input_tokens: data.usage.input_tokens,
      output_tokens: data.usage.output_tokens,
      cost_usd: costUsd,
      // Optional caller-supplied tag (e.g. 'request-gen') so cost can be broken down
      // by feature later — undefined/omitted just stores null, same as every row
      // logged before this field existed.
      feature: typeof body.feature === 'string' ? body.feature.slice(0, 64) : null,
    });
  }

  // Anthropic's error body is { type: 'error', error: { type, message } }. Every client
  // caller expects `error` to be a displayable string — passing the object through is
  // what showed users "[object Object]".
  if (!anthropicResp.ok) {
    const msg = (data && data.error && typeof data.error.message === 'string') ? data.error.message : 'שגיאה בשירות ה-AI';
    return json({ error: msg }, anthropicResp.status);
  }
  return json(data, anthropicResp.status);
});
