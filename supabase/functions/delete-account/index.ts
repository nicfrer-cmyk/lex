// LexTrack — permanently deletes the calling owner's office and everything in it:
// all Storage files (documents/templates), the app_data blob, the office row
// (cascades to office_members/office_invites/ai_usage/subscriptions/client_errors —
// see fix9/fix13 etc.), and finally the owner's own auth account. Only the OWNER
// can trigger this for their own office; other members just lose their membership
// (cascade) but keep their own login, since they may belong to another office later.
//
// Deploy: `supabase functions deploy delete-account`
//
// Irreversible by design — the client (Settings) requires typing the exact office
// name before calling this, but that's a UX safeguard, not a server-side one; this
// function itself does not ask for confirmation again.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'documents';

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

// Recursively removes every object under a Storage prefix — list() isn't
// recursive, so this walks one level of subfolders deep (matches the only shapes
// this bucket actually has: documents/ flat, templates/<folder>/ one level).
async function deleteAllUnderPrefix(supabase: ReturnType<typeof createClient>, prefix: string) {
  const { data: entries } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  for (const entry of entries || []) {
    const path = `${prefix}/${entry.name}`;
    if (entry.id === null) {
      // A folder, not a file — recurse one level.
      const { data: files } = await supabase.storage.from(BUCKET).list(path, { limit: 1000 });
      const filePaths = (files || []).filter(f => f.id !== null).map(f => `${path}/${f.name}`);
      if (filePaths.length) await supabase.storage.from(BUCKET).remove(filePaths);
    } else {
      await supabase.storage.from(BUCKET).remove([path]);
    }
  }
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
  if (member.role !== 'owner') return json({ error: 'רק בעל המשרד יכול למחוק את החשבון' }, 403);

  const officeId = member.office_id;

  await deleteAllUnderPrefix(supabase, `${officeId}/documents`);
  await deleteAllUnderPrefix(supabase, `${officeId}/templates`);

  const { error: appDataErr } = await supabase.from('app_data').delete().eq('office_id', officeId);
  if (appDataErr) return json({ error: appDataErr.message }, 500);

  // Cascades to office_members, office_invites, ai_usage, subscriptions,
  // client_errors (see fix9/fix13 — all ON DELETE CASCADE on office_id).
  const { error: officeErr } = await supabase.from('offices').delete().eq('id', officeId);
  if (officeErr) return json({ error: officeErr.message }, 500);

  const { error: authDeleteErr } = await supabase.auth.admin.deleteUser(userData.user.id);
  if (authDeleteErr) return json({ error: authDeleteErr.message }, 500);

  return json({ ok: true });
});
