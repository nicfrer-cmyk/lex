// Tests for the three-way merge that runs when a browser save finds that someone else
// (another lawyer or tab, the voice agent, WhatsApp, automations) wrote since load.
// Each case is a real data-loss scenario the old "additions only" merge got wrong.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const load = () => import('file://' + path.join(__dirname, '..', 'src', 'db-merge.js').replace(/\\/g, '/'));
const clone = (v) => JSON.parse(JSON.stringify(v));

test('a task the voice agent added server-side survives the user\'s save', async () => {
  const { mergeDb } = await load();
  const base = { tasks: [{ id: 't1', text: 'ישנה' }] };
  const local = { tasks: [{ id: 't1', text: 'ישנה — נערכה' }] };
  const remote = { tasks: [{ id: 'cb', text: 'חזרה ללקוח' }, { id: 't1', text: 'ישנה' }] };
  const s = mergeDb(local, remote, base);
  assert.deepEqual(local.tasks.map(t => t.id).sort(), ['cb', 't1']);
  assert.equal(local.tasks.find(t => t.id === 't1').text, 'ישנה — נערכה');
  assert.equal(s.added, 1);
});

test('two lawyers editing different fields of the same case keep both edits', async () => {
  const { mergeDb } = await load();
  const base = { cases: [{ id: 'c1', stage: 'פתיחה', debtorPhone: '' }] };
  const local = clone(base); local.cases[0].stage = 'דיון';
  const remote = clone(base); remote.cases[0].debtorPhone = '050-1234567';
  mergeDb(local, remote, base);
  assert.equal(local.cases[0].stage, 'דיון');
  assert.equal(local.cases[0].debtorPhone, '050-1234567');
});

test('a server write to a case diary is merged, not overwritten (id-less array)', async () => {
  const { mergeDb } = await load();
  const base = { cases: [{ id: 'c1', diary: [{ text: 'פתיחת תיק', date: '1.1.2026' }] }] };
  const local = clone(base); local.cases[0].diary.push({ text: 'שיחה עם הלקוח', date: '2.1.2026' });
  const remote = clone(base); remote.cases[0].diary.push({ text: 'הסוכן הקולי: בקשת חזרה', date: '2.1.2026' });
  mergeDb(local, remote, base);
  assert.deepEqual(local.cases[0].diary.map(d => d.text),
    ['פתיחת תיק', 'שיחה עם הלקוח', 'הסוכן הקולי: בקשת חזרה']);
});

test('an item deleted elsewhere stays deleted when this tab did not touch it', async () => {
  const { mergeDb } = await load();
  const base = { tasks: [{ id: 'a' }, { id: 'b' }] };
  const local = clone(base);
  const remote = { tasks: [{ id: 'a' }] };
  const s = mergeDb(local, remote, base);
  assert.deepEqual(local.tasks.map(t => t.id), ['a']);
  assert.equal(s.removed, 1);
});

test('an item deleted elsewhere but edited here is kept (no lost work)', async () => {
  const { mergeDb } = await load();
  const base = { tasks: [{ id: 'a', text: 'x' }] };
  const local = { tasks: [{ id: 'a', text: 'x — עודכן' }] };
  const remote = { tasks: [] };
  mergeDb(local, remote, base);
  assert.equal(local.tasks.length, 1);
});

test('an item this tab deleted stays deleted even though the server still has it', async () => {
  const { mergeDb } = await load();
  const base = { payments: [{ id: 'p1', amount: 100 }] };
  const local = { payments: [] };
  const remote = { payments: [{ id: 'p1', amount: 100 }, { id: 'p2', amount: 50 }] };
  mergeDb(local, remote, base);
  assert.deepEqual(local.payments.map(p => p.id), ['p2']);
});

test('counters take the higher value so numbers are never reused', async () => {
  const { mergeDb } = await load();
  const base = { counters: { nextClientNumber: 5, caseCounters: { c1: 2 } } };
  const local = { counters: { nextClientNumber: 6, caseCounters: { c1: 2, c2: 1 } } };
  const remote = { counters: { nextClientNumber: 7, caseCounters: { c1: 3 } } };
  mergeDb(local, remote, base);
  assert.equal(local.counters.nextClientNumber, 7);
  assert.deepEqual(local.counters.caseCounters, { c1: 3, c2: 1 });
});

test('a client created here with a number taken concurrently is renumbered, with its cases', async () => {
  const { mergeDb } = await load();
  const base = { clients: [{ id: 'old', clientNumber: '1' }], cases: [], counters: { nextClientNumber: 2, caseCounters: {} } };
  const local = clone(base);
  local.clients.push({ id: 'mine', name: 'כהן', clientNumber: '2' });
  local.cases.push({ id: 'k', client: 'mine', caseSubNumber: '2/1' });
  local.counters.nextClientNumber = 3;
  const remote = clone(base);
  remote.clients.push({ id: 'theirs', name: 'לוי', clientNumber: '2' });
  remote.counters.nextClientNumber = 3;
  const s = mergeDb(local, remote, base);
  const nums = local.clients.map(c => c.clientNumber);
  assert.equal(new Set(nums).size, nums.length, 'client numbers must be unique');
  assert.equal(local.clients.find(c => c.id === 'theirs').clientNumber, '2', 'the already-saved client keeps its number');
  const mine = local.clients.find(c => c.id === 'mine');
  assert.notEqual(mine.clientNumber, '2');
  assert.equal(local.cases[0].caseSubNumber, mine.clientNumber + '/1');
  assert.equal(s.renumbered.length, 1);
});

test('settings merge field by field', async () => {
  const { mergeDb } = await load();
  const base = { settings: { a: 1, b: 1 } };
  const local = { settings: { a: 2, b: 1 } };
  const remote = { settings: { a: 1, b: 3 } };
  mergeDb(local, remote, base);
  assert.deepEqual(local.settings, { a: 2, b: 3 });
});

test('e-filing bundles created concurrently in the same case are both kept', async () => {
  const { mergeDb } = await load();
  const base = { efilingBundles: { c1: [{ id: 'f1', items: [] }] } };
  const local = clone(base); local.efilingBundles.c1.push({ id: 'f2', items: [] });
  const remote = clone(base); remote.efilingBundles.c1.push({ id: 'f3', items: [] });
  mergeDb(local, remote, base);
  assert.deepEqual(local.efilingBundles.c1.map(b => b.id).sort(), ['f1', 'f2', 'f3']);
});

test('jsonb key reordering is not mistaken for a change', async () => {
  const { mergeDb } = await load();
  const base = { cases: [{ id: 'c1', a: 1, b: { x: 1, y: 2 } }] };
  const local = { cases: [{ id: 'c1', a: 1, b: { x: 1, y: 2 } }] };
  const remote = { cases: [{ b: { y: 2, x: 1 }, id: 'c1', a: 5 }] };
  mergeDb(local, remote, base);
  assert.equal(local.cases[0].a, 5, 'remote change applied since local was unchanged');
});

test('first save after an insert conflict merges everything already on the server', async () => {
  const { mergeDb } = await load();
  const local = { tasks: [{ id: 'mine' }], leads: [] };
  const remote = { tasks: [{ id: 'srv' }], leads: [{ id: 'l1' }] };
  mergeDb(local, remote, {});
  assert.deepEqual(local.tasks.map(t => t.id).sort(), ['mine', 'srv']);
  assert.deepEqual(local.leads.map(l => l.id), ['l1']);
});
