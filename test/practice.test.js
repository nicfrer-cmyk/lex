// Practice-management modules (src/practice.js): deadline arithmetic, billing
// statement totals, the dashboard agenda and the merge rules for the new data.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function load() {
  const sandbox = {
    console, __req: () => ({}),
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {}, getElementById: () => null },
    window: { addEventListener: () => {} }, navigator: { userAgent: 'test' },
  };
  vm.createContext(sandbox);
  // const/let bindings aren't exposed on a vm context, so bridge the one the tests need.
  vm.runInContext(read('src/app.js') + '\n' + read('src/practice.js') + '\n;globalThis.CASE_STAGES = CASE_STAGES;', sandbox, { filename: 'app+practice.js' });
  return sandbox;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

test('a 60-day period is calendar days, rolled past Friday/Saturday', () => {
  const { computeDeadline } = load();
  // 1.1.2026 + 60 days = 2.3.2026 (Monday) — no roll.
  assert.equal(computeDeadline('2026-01-01', 60).due, '2026-03-02');
  // 2.1.2026 + 1 day = 3.1.2026 (Saturday) → Sunday 4.1.2026.
  const r = computeDeadline('2026-01-02', 1);
  assert.equal(r.raw, '2026-01-03');
  assert.equal(r.due, '2026-01-04');
  assert.ok(r.warnings.some(w => /שבת/.test(w)));
  // A Friday end moves to Sunday too.
  assert.equal(computeDeadline('2026-01-01', 1).due, '2026-01-04');
});

test('a period touching the summer recess is flagged for verification', () => {
  const { computeDeadline } = load();
  const r = computeDeadline('2026-07-01', 30);
  assert.ok(r.warnings.some(w => /פגרת הקיץ/.test(w)));
  const winter = computeDeadline('2026-01-05', 30);
  assert.ok(!winter.warnings.some(w => /פגרת הקיץ/.test(w)));
});

test('statement totals: hours × rate, VAT only when the case bills VAT', () => {
  const { buildStatementLines } = load();
  const entries = [{ id: 'a', duration: 5400, description: 'הכנת כתב הגנה' }, { id: 'b', duration: 1800 }];
  const withVat = plain(buildStatementLines(entries, 500, 18, true));
  assert.deepEqual(withVat.lines.map(l => [l.hours, l.amount]), [[1.5, 750], [0.5, 250]]);
  assert.equal(withVat.subtotal, 1000);
  assert.equal(withVat.vat, 180);
  assert.equal(withVat.total, 1180);
  const noVat = plain(buildStatementLines(entries, 500, 18, false));
  assert.equal(noVat.vat, 0);
  assert.equal(noVat.total, 1000);
});

test('the dashboard agenda surfaces near deadlines, hearings, expiring contracts and unbilled time', () => {
  const { practiceAgenda } = load();
  const today = new Date(2026, 9, 30); // 30.10.2026
  const db = {
    cases: [{ id: 'k', name: 'הסכם שכירות', caseType: 'contract', status: 'active', contract: { endDate: '2026-12-01' } },
            { id: 'l', name: 'כהן נ׳ לוי', caseType: 'litigation', status: 'active' }],
    events: [
      { id: 'd1', title: 'כתב הגנה', date: '2026-11-05', type: 'מועד אחרון', caseId: 'l' },
      { id: 'd2', title: 'ישן', date: '2026-09-01', type: 'מועד אחרון' },
      { id: 'h1', title: 'קדם משפט', date: '2026-11-02', type: 'קדם משפט', time: '09:00' },
      { id: 'h2', title: 'רחוק', date: '2026-12-20', type: 'דיון' },
    ],
    tasks: [{ id: 't', done: false, due: '2026-10-20' }, { id: 't2', done: true, due: '2026-10-01' }],
    timeEntries: [{ caseId: 'l', duration: 7200 }, { caseId: 'l', duration: 3600, billedStatementId: 's' }],
  };
  const a = plain(practiceAgenda(db, today));
  assert.deepEqual(a.deadlines.map(d => d.id), ['d1']);
  assert.equal(a.deadlines[0].caseName, 'כהן נ׳ לוי');
  assert.deepEqual(a.hearings.map(h => h.id), ['h1']);
  assert.deepEqual(a.contracts.map(c => c.id), ['k']);
  assert.equal(a.overdueTasks, 1);
  assert.equal(a.unbilledHours, 2);
});

test('billing statements and their numbering merge safely across sessions', async () => {
  const { mergeDb } = await import('file://' + path.join(ROOT, 'src', 'db-merge.js').replace(/\\/g, '/'));
  const base = { billingStatements: [], counters: { nextClientNumber: 3, nextBillingNumber: 5, caseCounters: {} } };
  const local = { billingStatements: [{ id: 'mine', number: 5 }], counters: { nextClientNumber: 3, nextBillingNumber: 6, caseCounters: {} } };
  const remote = { billingStatements: [{ id: 'theirs', number: 5 }], counters: { nextClientNumber: 3, nextBillingNumber: 6, caseCounters: {} } };
  mergeDb(local, remote, base);
  assert.deepEqual(local.billingStatements.map(s => s.id).sort(), ['mine', 'theirs']);
  assert.equal(local.counters.nextBillingNumber, 6);
});

test('new case types have their own stages and are wired into the form and the agent', () => {
  const { CASE_STAGES, isDebtCase, caseAmountLabel } = load();
  assert.ok(CASE_STAGES.litigation.includes('קדם משפט'));
  assert.ok(CASE_STAGES.contract.includes('ממתין לחתימה'));
  assert.equal(isDebtCase({ caseType: 'litigation' }), false);
  assert.equal(isDebtCase({}), true, 'old cases without a type stay debt cases');
  assert.equal(caseAmountLabel({ caseType: 'contract' }), 'שווי העסקה');
  const html = read('src/app.html');
  assert.match(html, /<option value="litigation">ליטיגציה אזרחית<\/option>/);
  assert.match(read('src/app.js'), /enum:\['debt','litigation','contract','general'\]/);
});

test('billing is hidden from secretaries like finance, and loads after app.js', () => {
  const app = read('src/app.js');
  assert.match(app, /id === 'billing'\) && currentRole === 'secretary'/);
  const b = read('build.mjs');
  assert.ok(b.indexOf("'practice.js'") > b.indexOf("'app.js'"));
});

test('replacing a document keeps the previous file as a version', () => {
  const app = read('src/app.js');
  const fn = app.slice(app.indexOf('async function uploadNewVersion'));
  assert.ok(fn.indexOf('d.versions.push(') < fn.indexOf('d.filePath = filePath;'));
});
