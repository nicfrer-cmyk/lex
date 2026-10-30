// בקרת משרד (src/office-checks.js): המנוע הדטרמיניסטי שרץ בדפדפן.
// נטען יחד עם app.js ו-practice.js כי הוא משתמש בעזרי התאריכים שלהם.
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
  vm.runInContext(read('src/app.js') + '\n' + read('src/practice.js') + '\n' + read('src/office-checks.js')
    + '\n;globalThis.OFFICE_CHECKS = OFFICE_CHECKS;', sandbox, { filename: 'app+practice+checks.js' });
  return sandbox;
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const NOW = new Date(2026, 9, 30); // 30.10.2026

function sampleDb() {
  return {
    settings: {}, counters: {},
    clients: [
      { id: 'c1', name: 'ישראל ישראלי', phone: '050', email: '' },
      { id: 'c2', name: 'חברה בע"מ', phone: '', email: '' },
    ],
    cases: [
      // ללא פעילות 45 יום, בלי משימה ובלי מועד, בלי הסכם שכ"ט
      { id: 'k1', name: 'ישראלי נ׳ כהן', client: 'c1', caseType: 'debt', status: 'active', stage: 'איסוף מסמכים', amount: 50000,
        opened: '1.8.2026', diary: [{ text: 'נפתח', date: '1.8.2026, 10:00' }, { text: 'שיחה', date: '15.9.2026, 11:00' }], legalDocs: {}, debtorName: 'כהן', debtorId: '1' },
      // פעיל ועדכני, עם משימה פתוחה
      { id: 'k2', name: 'חברה נ׳ לוי', client: 'c2', caseType: 'debt', status: 'active', stage: 'התראה ראשונה', amount: 250000,
        opened: '20.10.2026', diary: [{ text: 'נפתח', date: '28.10.2026, 09:00' }], legalDocs: { atfDraft: true, poaDraft: true }, debtorName: 'לוי', debtorId: '2' },
      // חוזה שמסתיים בעוד 30 יום עם 14 ימי הודעה
      { id: 'k3', name: 'הסכם שכירות', client: 'c1', caseType: 'contract', status: 'active', stage: 'חתום ופעיל', opened: '1.1.2026',
        diary: [{ text: 'x', date: '29.10.2026, 09:00' }], contract: { endDate: '2026-11-29', noticeDays: 14, renewal: 'auto' } },
      // סגור עם יתרת נאמנות
      { id: 'k4', name: 'תיק סגור', client: 'c1', caseType: 'debt', status: 'closed', opened: '1.1.2026', diary: [] },
    ],
    tasks: [
      { id: 't1', text: 'לשלוח מכתב', due: '2026-10-10', done: false, caseId: 'k2' },
      { id: 't2', text: 'בלי תאריך', due: '', done: false },
      { id: 't3', text: 'הושלמה', due: '2026-09-01', done: true },
    ],
    events: [
      { id: 'e1', title: 'קדם משפט', date: '2026-11-03', time: '09:00', type: 'קדם משפט', caseId: 'k1' },
      { id: 'e2', title: 'מועד אחרון להגשת כתב הגנה', date: '2026-11-01', type: 'מועד אחרון', caseId: 'k2' },
      { id: 'e3', title: 'פגישה', date: '2026-11-03', time: '09:00', type: 'פגישה', caseId: 'k2' },
      { id: 'e4', title: 'דיון שעבר', date: '2026-10-20', type: 'דיון', caseId: 'k1' }, // k1's last diary entry is from September
    ],
    leads: [{ id: 'l1', name: 'פונה חדש', status: 'new', createdAt: '2026-10-20T10:00:00Z' }],
    timeEntries: [{ id: 'te1', caseId: 'k2', duration: 6 * 3600 }, { id: 'te2', caseId: 'k2', duration: 3600, billedStatementId: 's1' }],
    billingStatements: [{ id: 's1', number: 7, caseId: 'k2', clientId: 'c2', status: 'sent', date: '2026-09-01', total: 1180 }],
    trustTransactions: [{ id: 'tr1', caseId: 'k4', type: 'deposit', amount: 2000, status: 'posted' }],
    docs: [{ id: 'd1', name: 'סריקה.pdf', caseId: '' }],
    payments: [],
  };
}

test('every check has a key, category, label and a run function', () => {
  const { OFFICE_CHECKS } = load();
  assert.ok(OFFICE_CHECKS.length >= 18);
  const keys = new Set();
  for (const ch of OFFICE_CHECKS) {
    assert.ok(ch.key && ch.cat && ch.label && typeof ch.run === 'function', ch.key);
    assert.ok(!keys.has(ch.key), 'duplicate key ' + ch.key); keys.add(ch.key);
    assert.equal(typeof ch.describe({ days: 1, hours: 1, amount: 1 }), 'string');
  }
});

test('finds the expected issues in a sample office', () => {
  const { runOfficeChecks } = load();
  const f = plain(runOfficeChecks(sampleDb(), NOW));
  const byCheck = (k) => f.filter(x => x.check === k).map(x => x.entityId);
  assert.deepEqual(byCheck('matter_inactive'), ['k1']);
  assert.deepEqual(byCheck('matter_no_next_action'), ['k3']);        // k1 has a hearing, k2 a task; the contract has nothing
  assert.deepEqual(byCheck('matter_missing_docs'), ['k1']);
  assert.deepEqual(byCheck('matter_high_value_idle'), []);           // k2 is high value but active
  assert.deepEqual(byCheck('deadline_soon'), ['e2']);
  assert.deepEqual(byCheck('event_without_prep_task'), ['e1']);      // k1 has no open task
  assert.deepEqual(byCheck('event_passed_unmarked'), ['e4']);
  assert.equal(byCheck('event_conflict').length, 1);
  assert.deepEqual(byCheck('task_overdue'), ['t1']);
  assert.deepEqual(byCheck('task_no_due_date'), ['t2']);
  assert.deepEqual(byCheck('client_missing_contact'), ['c2']);
  assert.deepEqual(byCheck('lead_untouched'), ['l1']);
  assert.deepEqual(byCheck('unbilled_hours'), ['k2']);
  assert.deepEqual(byCheck('statement_unpaid'), ['s1']);
  assert.deepEqual(byCheck('trust_in_closed_case'), ['k4']);
  assert.deepEqual(byCheck('contract_ending'), ['k3']);
  assert.deepEqual(byCheck('contract_notice'), []);                  // notice date 15.11 is 16 days away, outside the 14-day window
  assert.deepEqual(byCheck('document_unlinked'), ['d1']);
  // urgent findings come first
  assert.equal(f[0].severity, 'high');
});

test('contract notice: flagged only inside the 14-day window', () => {
  const { runOfficeChecks } = load();
  const db = sampleDb();
  db.cases[2].contract = { endDate: '2026-11-20', noticeDays: 14 }; // notice date 6.11 → in 7 days
  assert.ok(runOfficeChecks(db, NOW).some(x => x.check === 'contract_notice'));
  db.cases[2].contract = { endDate: '2026-12-31', noticeDays: 14 }; // notice date 17.12 → too far
  assert.ok(!runOfficeChecks(db, NOW).some(x => x.check === 'contract_notice'));
});

test('settings: disabled checks are skipped and thresholds are honoured', () => {
  const { runOfficeChecks } = load();
  const db = sampleDb();
  db.settings.officeChecks = { matter_inactive: { enabled: true, days: 60 }, task_overdue: { enabled: false } };
  const f = runOfficeChecks(db, NOW);
  assert.ok(!f.some(x => x.check === 'matter_inactive'), '45 idle days < 60 threshold');
  assert.ok(!f.some(x => x.check === 'task_overdue'));
  db.settings.officeChecks.matter_inactive.days = 'abc'; // invalid → default 30
  assert.ok(runOfficeChecks(db, NOW).some(x => x.check === 'matter_inactive'));
});

test('a finding becomes one task, never two, and "done" hides it for 30 days', () => {
  const { runOfficeChecks, ocCreateTaskFromFinding, ocDismissFinding } = load();
  const db = sampleDb();
  const today = '2026-10-30';
  const f = runOfficeChecks(db, NOW).find(x => x.check === 'matter_inactive');
  const t1 = ocCreateTaskFromFinding(db, f, today);
  const t2 = ocCreateTaskFromFinding(db, f, today);
  assert.equal(t1.id, t2.id);
  assert.equal(db.tasks.filter(t => t.source && t.source.check === 'matter_inactive').length, 1);
  assert.equal(t1.caseId, 'k1');
  assert.equal(t1.due, '2026-11-02');
  assert.deepEqual(db.checkState.taskLinks['matter_inactive:k1'], t1.id);
  // the finding now reports its task
  assert.equal(runOfficeChecks(db, NOW).find(x => x.check === 'matter_inactive').taskId, t1.id);
  // completing the task releases the link so a new one can be created later
  t1.done = true;
  assert.equal(runOfficeChecks(db, NOW).find(x => x.check === 'matter_inactive').taskId, null);

  ocDismissFinding(db, f, 30, today);
  assert.ok(!runOfficeChecks(db, NOW).some(x => x.check === 'matter_inactive'));
  assert.ok(runOfficeChecks(db, NOW, { includeDismissed: true }).some(x => x.check === 'matter_inactive'));
  assert.ok(runOfficeChecks(db, new Date(2026, 11, 15)).some(x => x.check === 'matter_inactive'), 'back after 30 days');
});

test('an empty office produces no findings and no crash', () => {
  const { runOfficeChecks, ocSummary } = load();
  const f = plain(runOfficeChecks({ cases: [], clients: [], tasks: [], events: [] }, NOW));
  assert.deepEqual(f, []);
  assert.deepEqual(plain(ocSummary(f)), { total: 0, high: 0, byCat: {} });
});

test('checkState is a plain top-level key, so the merge keeps it field by field', async () => {
  const { mergeDb } = await import('file://' + path.join(ROOT, 'src', 'db-merge.js').replace(/\\/g, '/'));
  const base = { checkState: { dismissed: {}, taskLinks: {} } };
  const local = { checkState: { dismissed: { 'a:1': '2026-12-01' }, taskLinks: {} } };
  const remote = { checkState: { dismissed: {}, taskLinks: { 'b:2': 't9' } } };
  mergeDb(local, remote, base);
  assert.equal(local.checkState.dismissed['a:1'], '2026-12-01');
  assert.equal(local.checkState.taskLinks['b:2'], 't9');
});

test('the panel, dashboard hook and build order are wired', () => {
  const html = read('src/app.html');
  assert.match(html, /id="oc-body"/);
  assert.match(html, /בקרת משרד/);
  assert.match(read('src/app.js'), /renderOfficeChecks\(\)/);
  assert.match(read('src/app.js'), /officeChecksDashboard\(\)/);
  const b = read('build.mjs');
  assert.ok(b.indexOf("'office-checks.js'") > b.indexOf("'practice.js'"));
  assert.ok(!b.includes("'automations.js'"));
});
