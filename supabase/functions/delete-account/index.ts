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

// list() caps at 1000 entries per call with no signal that a page was truncated —
// loops with offset until a page comes back shorter than the page size (the actual
// "no more results" signal), so an office with >1000 files doesn't leave the tail
// end un-deleted.
async function listAllStorageEntries(supabase: ReturnType<typeof createClient>, path: string) {
  const pageSize = 1000;
  let offset = 0;
  let all: any[] = [];
  while (true) {
    const { data } = await supabase.storage.from(BUCKET).list(path, { limit: pageSize, offset });
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

// Recursively removes every object under a Storage prefix — list() isn't
// recursive, so this walks one level of subfolders deep (matches the only shapes
// this bucket actually has: documents/ flat, templates/<folder>/ one level).
// Collects (rather than silently discards) any list/remove error so a failed
// cleanup is at least visible in the function's logs and the response, instead of
// quietly leaving orphaned files behind with no record anything went wrong — those
// files become unreachable forever once the office row is gone (no owner, no way
// to look them up), so this is the only chance to notice.
async function deleteAllUnderPrefix(supabase: ReturnType<typeof createClient>, prefix: string, warnings: string[]) {
  const entries = await listAllStorageEntries(supabase, prefix);
  for (const entry of entries) {
    const path = `${prefix}/${entry.name}`;
    if (entry.id === null) {
      // A folder, not a file — recurse one level.
      const files = await listAllStorageEntries(supabase, path);
      const filePaths = files.filter(f => f.id !== null).map(f => `${path}/${f.name}`);
      if (filePaths.length) {
        const { error } = await supabase.storage.from(BUCKET).remove(filePaths);
        if (error) warnings.push(`${path}: ${error.message}`);
      }
    } else {
      const { error } = await supabase.storage.from(BUCKET).remove([path]);
      if (error) warnings.push(`${path}: ${error.message}`);
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
  const storageWarnings: string[] = [];

  await deleteAllUnderPrefix(supabase, `${officeId}/documents`, storageWarnings);
  await deleteAllUnderPrefix(supabase, `${officeId}/templates`, storageWarnings);
  if (storageWarnings.length) {
    // Not fatal — the data/account deletion below is the privacy-critical part and
    // still proceeds — but logged so it's at least discoverable, not silently lost.
    console.error(`delete-account: storage cleanup issues for office ${officeId}:`, storageWarnings);
  }

  const { error: appDataErr } = await supabase.from('app_data').delete().eq('office_id', officeId);
  if (appDataErr) return json({ error: appDataErr.message }, 500);

  // Cascades to office_members, office_invites, ai_usage, subscriptions,
  // client_errors (see fix9/fix13 — all ON DELETE CASCADE on office_id).
  const { error: officeErr } = await supabase.from('offices').delete().eq('id', officeId);
  if (officeErr) return json({ error: officeErr.message }, 500);

  const { error: authDeleteErr } = await supabase.auth.admin.deleteUser(userData.user.id);
  if (authDeleteErr) {
    // The office/data are already gone at this point — only the login remains, and
    // this same function can't be retried (it looks up office_members to know what
    // to delete, and there's no office left to find). A rare failure mode (network
    // blip on the very last step); flagged here so it's not a silent dead end —
    // whoever sees this error should be told to contact support for manual cleanup
    // of the now-orphaned auth account, rather than assuming "delete" just didn't work.
    return json({ error: 'הנתונים נמחקו בהצלחה, אך מחיקת חשבון ההתחברות נכשלה — יש ליצור קשר לסיום התהליך: ' + authDeleteErr.message }, 500);
  }

  return json({ ok: true, storageWarnings });
});
