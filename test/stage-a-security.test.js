// Regression tests for the stage-A security / data-safety fixes (see the deep review,
// 2026-10-30). Several of the fixed paths live in files that can't be imported under
// Node (platform.web.js pulls in supabase-js via esbuild; Edge Functions are Deno/TS),
// so those are pinned by source checks, the same approach call-center.test.js uses.
// Pure logic (the WebDAV path guard) is tested by behavior.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('storage-quota helpers that saveFile/tmImportFile call are defined (upload regression)', () => {
  const src = read('src/platform.web.js');
  for (const fn of ['listAllStorageEntries', 'officeStorageUsageBytes', 'enforceStorageQuota']) {
    assert.match(src, new RegExp(`async function ${fn}\\(`), `${fn} must be defined`);
  }
});

test('Platform.saveDB refuses to save before a successful load (no blank-blob overwrite)', () => {
  const src = read('src/platform.web.js');
  const saveBody = src.slice(src.indexOf('async saveDB(dbObj)'), src.indexOf('async saveFile('));
  assert.match(saveBody, /if \(!_dbLoaded\)\s*\{\s*throw/, 'saveDB must throw when nothing was loaded');
  assert.match(saveBody, /if \(!_dbRowExisted\)[\s\S]*?\.insert\(/, 'a missing row is inserted, not upserted');
  const loadBody = src.slice(src.indexOf('async loadDB()'), src.indexOf('async saveDB('));
  assert.match(loadBody, /_dbLoaded = true/);
});

test('bootApp handles a failed initial load instead of continuing on an empty db', () => {
  const src = read('src/app.js');
  assert.match(src, /loadDB\(\)\.catch\(showLoadFailure\)/);
  assert.ok(!/^\s*loadDB\(\);\s*$/m.test(src), 'no bare, unhandled loadDB() call');
});

test('WebDAV only serves Storage paths inside the authenticated office', () => {
  const src = read('supabase/functions/webdav/index.ts');
  const m = src.match(/function isOfficePath\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'isOfficePath must exist');
  // eslint-disable-next-line no-new-func
  const isOfficePath = new Function('officeId', 'filePath', m[1]);
  const office = '11111111-1111-1111-1111-111111111111';
  assert.equal(isOfficePath(office, `${office}/documents/abc-x.docx`), true);
  assert.equal(isOfficePath(office, '22222222-2222-2222-2222-222222222222/documents/x.docx'), false);
  assert.equal(isOfficePath(office, `${office}/../2222/documents/x.docx`), false);
  assert.equal(isOfficePath(office, `/${office}/documents/x.docx`), false);
  assert.equal(isOfficePath(office, `${office}`), false);
  assert.match(src, /resolveDoc[\s\S]*?isOfficePath\(officeId, doc\.filePath\)/);
  assert.match(src.slice(src.indexOf('async function authenticate')), /from\('office_members'\)/,
    'credentials must be re-checked against current membership');
});

test('read_document rejects file paths outside the office folder', () => {
  const src = read('supabase/functions/_shared/tools.ts');
  const tool = src.slice(src.indexOf("slug: 'read_document'"), src.indexOf("slug: 'read_document'") + 2500);
  assert.match(tool, /startsWith\(`\$\{ctx\.officeId\}\/`\)/);
});

test('ai-proxy fixes model, output size and tools instead of trusting the client', () => {
  const src = read('supabase/functions/ai-proxy/index.ts');
  assert.match(src, /MODEL_RATES\[String\(body\.model/);
  assert.match(src, /max_tokens: maxTokens/);
  assert.ok(!/max_tokens: body\.max_tokens/.test(src));
  assert.match(src, /t\.type === undefined \|\| t\.type === 'custom'/);
  assert.match(src, /from\('subscriptions'\)/);
  assert.match(src, /spentUsd >= MONTHLY_USD_CAP/);
  // every client model must be allowed, or AI features break after deploy
  const appSrc = read('src/app.js');
  const used = new Set(appSrc.match(/claude-(?:haiku|sonnet|opus)-[a-z0-9-]+/g));
  for (const model of used) assert.match(src, new RegExp(`'${model}'`), `${model} must be in MODEL_RATES`);
});

test('stage-A migration closes the office-takeover and invite-rewrite holes', () => {
  const sql = read('supabase/migrations/20261030000000_stage_a_security.sql');
  assert.match(sql, /create policy "office_members_insert_self_as_owner"[\s\S]*?public\.office_claimable\(office_id\)/);
  assert.match(sql, /create trigger office_invites_guard_update_trg/);
  assert.match(sql, /create trigger app_data_snapshot_trg\s+before update or delete on public\.app_data/);
  for (const p of ['app_data_select_own', 'app_data_insert_own', 'app_data_update_own',
    'documents_select_own', 'documents_insert_own', 'documents_update_own', 'documents_delete_own']) {
    assert.match(sql, new RegExp(`drop policy if exists "${p}"`));
  }
});
