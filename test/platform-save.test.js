// End-to-end test of the real Platform.loadDB/saveDB code against an in-memory fake of
// supabase-js. platform.web.js is bundled with esbuild exactly like build.mjs does,
// except @supabase/supabase-js is swapped for the fake below — so the version check,
// the conflict re-read and the three-way merge all run as they do in the browser.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

// A tiny query builder covering exactly the calls platform.web.js makes on
// office_members and app_data. `store.onBeforeUpdate` lets a test inject a concurrent
// server write between the browser's load and its save.
const FAKE_SUPABASE = `
export function createClient() {
  const store = globalThis.__store;
  const tables = store.tables;
  function builder(table) {
    const q = { table, op: 'select', filters: [], payload: null, single: false };
    const exec = () => {
      const rows = tables[table] || (tables[table] = []);
      const match = (r) => q.filters.every(([k, v]) => r[k] === v);
      if (q.op === 'select') {
        const found = rows.filter(match).map(r => JSON.parse(JSON.stringify(r)));
        return { data: q.single ? (found[0] || null) : found, error: null };
      }
      if (q.op === 'insert') {
        if (table === 'app_data' && rows.some(r => r.office_id === q.payload.office_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        const row = { ...JSON.parse(JSON.stringify(q.payload)), updated_at: 'v' + (++store.version) };
        rows.push(row);
        return { data: q.single ? { updated_at: row.updated_at } : [row], error: null };
      }
      if (q.op === 'update') {
        if (store.onBeforeUpdate) { const f = store.onBeforeUpdate; store.onBeforeUpdate = null; f(); }
        const hit = rows.filter(match);
        hit.forEach(r => { Object.assign(r, JSON.parse(JSON.stringify(q.payload))); r.updated_at = 'v' + (++store.version); });
        store.updates++;
        return { data: hit.map(r => ({ updated_at: r.updated_at })), error: null };
      }
      if (q.op === 'upsert') { store.upserts++; return { data: null, error: null }; }
      return { data: null, error: null };
    };
    const api = {
      select() { return api; },
      eq(k, v) { q.filters.push([k, v]); return api; },
      maybeSingle() { q.single = true; return api; },
      single() { q.single = true; return api; },
      insert(p) { q.op = 'insert'; q.payload = p; return api; },
      update(p) { q.op = 'update'; q.payload = p; return api; },
      upsert(p) { q.op = 'upsert'; q.payload = p; return api; },
      then(res, rej) { try { res(exec()); } catch (e) { rej(e); } },
    };
    return api;
  }
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'a@b.c' } } }),
            onAuthStateChange() {}, setSession: async () => ({}) },
    from: builder,
    storage: { from: () => ({}) },
    functions: { invoke: async () => ({ data: null, error: null }) },
    rpc: async () => ({ data: null, error: null }),
  };
}`;

async function loadPlatform(initialBlob) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'platform.web.js')],
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent',
    plugins: [{
      name: 'fake-supabase',
      setup(b) {
        b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'fake', namespace: 'fake' }));
        b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: FAKE_SUPABASE, loader: 'js' }));
      },
    }],
  });
  const store = {
    version: 1, updates: 0, upserts: 0, onBeforeUpdate: null,
    tables: {
      office_members: [{ office_id: 'o1', user_id: 'u1', role: 'owner' }],
      app_data: initialBlob ? [{ office_id: 'o1', data: initialBlob, updated_at: 'v1' }] : [],
    },
  };
  const window = {};
  const sandbox = {
    window, console, globalThis: null, __store: store,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: globalThis.crypto, TextDecoder, TextEncoder, Blob, URL, setTimeout, clearTimeout,
    location: { origin: 'http://x', pathname: '/', search: '' },
    document: { addEventListener() {}, getElementById: () => null },
    navigator: { userAgent: 'test' },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(out.outputFiles[0].text, sandbox);
  return { Platform: window.Platform, store };
}

const row = (store) => store.tables.app_data.find(r => r.office_id === 'o1');
// Arrays built inside the vm sandbox belong to another realm; copy into this one.
const ids = (arr) => Array.from(arr, x => x.id).sort();

test('saveDB before a successful load is refused (no blank overwrite)', async () => {
  const { Platform, store } = await loadPlatform({ cases: [{ id: 'c1' }] });
  await assert.rejects(() => Platform.saveDB({ cases: [] }), /לא נטענו/);
  assert.deepEqual(ids(row(store).data.cases), ['c1']);
});

test('a concurrent server write is merged, not overwritten', async () => {
  const blob = { cases: [{ id: 'c1', stage: 'פתיחה', debtorPhone: '' }], tasks: [], clients: [], counters: { nextClientNumber: 1, caseCounters: {} } };
  const { Platform, store } = await loadPlatform(blob);
  const db = await Platform.loadDB();

  // The user edits the stage and adds a task...
  db.cases[0].stage = 'דיון';
  db.tasks.push({ id: 'mine', text: 'להגיש כתב טענות' });
  // ...while the voice agent adds a callback and fills the phone, just before our save.
  store.onBeforeUpdate = () => {
    const r = row(store);
    r.data.tasks.push({ id: 'cb', text: 'חזרה ללקוח' });
    r.data.cases[0].debtorPhone = '050-1234567';
    r.updated_at = 'v' + (++store.version);
  };

  const outcome = await Platform.saveDB(db);
  assert.equal(outcome.merged, true);
  const saved = row(store).data;
  assert.deepEqual(ids(saved.tasks), ['cb', 'mine']);
  assert.equal(saved.cases[0].stage, 'דיון');
  assert.equal(saved.cases[0].debtorPhone, '050-1234567');
  assert.equal(store.upserts, 0, 'never a blind upsert');

  // A second save from the same session (no conflict now) goes straight through.
  db.cases[0].notes = 'הערה';
  const before = store.updates;
  await Platform.saveDB(db);
  assert.equal(store.updates, before + 1);
  assert.equal(row(store).data.cases[0].notes, 'הערה');
  assert.equal(row(store).data.tasks.length, 2);
});

test('a new office whose row was created meanwhile by the server keeps the server data', async () => {
  const { Platform, store } = await loadPlatform(null);
  const db = (await Platform.loadDB()) || { tasks: [], leads: [] };
  assert.equal(row(store), undefined);
  // A WhatsApp lead arrives and the server creates the row before our first save.
  store.tables.app_data.push({ office_id: 'o1', data: { tasks: [], leads: [{ id: 'lead1' }] }, updated_at: 'v' + (++store.version) });
  db.tasks.push({ id: 't1' });
  await Platform.saveDB(db);
  const saved = row(store).data;
  assert.deepEqual(ids(saved.leads), ['lead1']);
  assert.deepEqual(ids(saved.tasks), ['t1']);
});
