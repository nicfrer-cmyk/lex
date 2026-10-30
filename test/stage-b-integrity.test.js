// Regression tests for stage B (data integrity): trust-ledger arithmetic, safe deletes,
// version restore, session switching and the WebDAV write guard. app.js is loaded in a
// vm sandbox the same way pure-functions.test.js does it; the rest are source checks
// for code that can't run under Node (Supabase client, Deno functions, SQL).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const appJs = read('src/app.js');

function loadApp(dbValue) {
  const sandbox = {
    console,
    __req: () => ({}),
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { querySelectorAll: () => [], addEventListener: () => {}, getElementById: () => null },
    window: { addEventListener: () => {} },
    navigator: { userAgent: 'test' },
  };
  vm.createContext(sandbox);
  vm.runInContext(appJs + `;globalThis.__setDb = (v) => { db = v; };`, sandbox, { filename: 'app.js' });
  if (dbValue) sandbox.__setDb(dbValue);
  return sandbox;
}

test('earmark/release do not move the trust balance', () => {
  const { trustLedgerDelta } = loadApp();
  assert.equal(trustLedgerDelta({ type: 'deposit', amount: 1000 }), 1000);
  assert.equal(trustLedgerDelta({ type: 'expense', amount: 200 }), -200);
  assert.equal(trustLedgerDelta({ type: 'earmark', amount: 300 }), 0);
  assert.equal(trustLedgerDelta({ type: 'release', amount: 300 }), 0);
  assert.equal(trustLedgerDelta({ type: 'correction', amount: -50 }), -50);
  assert.equal(trustLedgerDelta({ type: 'deposit', amount: 1000, status: 'reversed' }), 0);
});

test('the ledger running balance ends at the same figure as the summary card', () => {
  const txs = [
    { id: '1', caseId: 'c', type: 'deposit', amount: 5000, date: '2026-01-01' },
    { id: '2', caseId: 'c', type: 'earmark', amount: 1500, date: '2026-01-02' },
    { id: '3', caseId: 'c', type: 'expense', amount: 700, date: '2026-01-03' },
    { id: '4', caseId: 'c', type: 'release', amount: 500, date: '2026-01-04' },
    { id: '5', caseId: 'c', type: 'refund', amount: 300, date: '2026-01-05', status: 'reversed' },
  ];
  const app = loadApp({ cases: [], clients: [], trustTransactions: txs });
  const totals = app.caseTrustTotals('c');
  const running = txs.reduce((s, t) => s + app.trustLedgerDelta(t), 0);
  assert.equal(running, totals.balance);
  assert.equal(totals.balance, 4300);
  assert.equal(totals.reserved, 1000);
});

test('deleteCase refuses to delete financial records and offers archiving', () => {
  const body = appJs.slice(appJs.indexOf('async function deleteCase()'), appJs.indexOf('function editCase()'));
  const guard = body.indexOf('if(trustCount||payCount)');
  const removal = body.indexOf('db.trustTransactions=');
  assert.ok(guard > 0 && removal > guard, 'the financial-records guard must run before anything is removed');
  assert.match(body.slice(guard, removal), /c\.status='closed'/);
  assert.match(body.slice(guard, removal), /return;/);
  assert.match(body, /Platform\.deleteDocumentFile/);
  assert.match(body, /timerCaseId===id/);
});

test('every one-click delete now asks for confirmation', () => {
  for (const fn of ['delTask', 'delEvent', 'delPayment', 'delDoc', 'delTimeEntry']) {
    const start = appJs.indexOf(`async function ${fn}(`);
    assert.ok(start >= 0, `${fn} must be async`);
    const snippet = appJs.slice(start, appJs.indexOf('\n}', start) > 0 && appJs.indexOf('\n}', start) - start < 1200 ? appJs.indexOf('\n}', start) + 2 : start + 1200);
    assert.match(snippet, /await customConfirm\(/, `${fn} must confirm`);
    const del = snippet.indexOf('filter(');
    assert.ok(del > 0 && snippet.indexOf('customConfirm') < del, `${fn} confirms before deleting`);
  }
});

test('closing a case with a trust balance requires an explanation', () => {
  const s = appJs.slice(appJs.indexOf('let trustCloseNote'), appJs.indexOf('let trustCloseNote') + 1400);
  assert.match(s, /trust\.balance !== 0/);
  assert.match(s, /note===null \|\| !note\.trim\(\)\) \{[^}]*return;/);
});

test('loadDB waits for in-flight saves before replacing db', () => {
  const body = appJs.slice(appJs.indexOf('async function loadDB()'), appJs.indexOf('const data = await Platform.loadDB()'));
  assert.match(body, /await _saveChain;/);
});

test('a different user (or sign-out) on a booted tab reloads instead of reusing memory', () => {
  const auth = read('src/auth.js');
  assert.match(auth, /appBooted && bootedUserId && \(!session \|\| session\.user\.id !== bootedUserId\)\) \{\s*location\.reload\(\)/);
});

test('version restore is owner-only server side and snapshots the current state first', () => {
  const sql = read('supabase/migrations/20261030000001_stage_b_restore.sql');
  const fn = sql.slice(sql.indexOf('create or replace function public.restore_app_data_version'));
  assert.match(fn, /am_office_owner\(v_office\)/);
  assert.ok(fn.indexOf("'restore'") < fn.indexOf('update public.app_data'), 'snapshot before overwrite');
  assert.match(sql, /list_app_data_versions[\s\S]*security invoker/);
});

test('WebDAV PUT ignores empty bodies and caps size', () => {
  const src = read('supabase/functions/webdav/index.ts');
  const put = src.slice(src.indexOf("req.method === 'PUT'"));
  assert.match(put, /bytes\.length === 0\) return new Response\(null, \{ status: 204 \}\)/);
  assert.ok(put.indexOf('bytes.length === 0') < put.indexOf('.upload('), 'guard before upload');
  assert.match(put, /MAX_PUT_BYTES/);
});

test('server normalizeDb creates fresh defaults and a usable client counter', () => {
  const src = read('supabase/functions/_shared/db.ts');
  assert.ok(!/\.\.\.EMPTY_DB/.test(src), 'no shared default object');
  assert.match(src, /counters\.nextClientNumber = 1/);
});
