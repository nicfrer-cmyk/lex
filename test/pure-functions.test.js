// Regression tests for app.js's pure business-logic functions — the fee/date math
// that had real, documented bugs earlier (VAT never applied, the "both" fee type
// silently dropping its percent portion, UTC-vs-local date bugs around Israel's
// midnight). app.js is a single global <script> (not an ES module — its top-level
// functions must stay reachable from onclick="..." attributes in app.html), so it
// can't be require()'d directly. Instead it's executed in a vm context with a
// minimal DOM/browser stub — Node's `let`/`const` top-level bindings (db,
// officeVatRate) aren't exposed as context properties by the vm module, only
// `function` declarations are, so a small bridge snippet is appended to the real
// source (not to the shipped file) to expose read/write access to that state for
// the tests below.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appJsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const bridge = `
;globalThis.__test = {
  getDb: () => db,
  setOfficeVatRate: (v) => { officeVatRate = v; },
};
`;

function loadApp() {
  const sandbox = {
    console,
    __req: () => ({}), // docx/pizzip/docxtemplater — unused by the functions under test
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      querySelectorAll: () => [],
      addEventListener: () => {},
      getElementById: () => null,
    },
    // Top-level window.addEventListener('error'/'unhandledrejection', ...) calls
    // (client-side error logging) run at script-load time just like the
    // document.* listeners above, so this needs the same kind of stub.
    window: { addEventListener: () => {} },
    navigator: { userAgent: 'test' },
  };
  vm.createContext(sandbox);
  vm.runInContext(appJsSource + bridge, sandbox, { filename: 'app.js' });
  return sandbox;
}

test('localDateISO uses local Y/M/D, not a UTC conversion', () => {
  const { localDateISO } = loadApp();
  assert.equal(localDateISO(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(localDateISO(new Date(2026, 11, 31)), '2026-12-31');
});

test('daysSinceHE handles both date-only (toLocaleDateString) and datetime (toLocaleString) he-IL formats', () => {
  const { daysSinceHE } = loadApp();
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
  // Regression: a diary entry's date is stamped via toLocaleString('he-IL'), which
  // appends ", HH:MM:SS" — splitting the whole string on "." (not just the date
  // portion) used to make the year parse as NaN, silently returning null for every
  // case with any diary history at all (see the comment on daysSinceHE itself).
  assert.equal(daysSinceHE(tenDaysAgo.toLocaleDateString('he-IL')), 10);
  assert.equal(daysSinceHE(tenDaysAgo.toLocaleString('he-IL')), 10);
  assert.equal(daysSinceHE(''), null);
});

test('localMonthKey uses local Y/M', () => {
  const { localMonthKey } = loadApp();
  assert.equal(localMonthKey(new Date(2026, 6, 4)), '2026-07');
});

test('heToISO converts DD.MM.YYYY to YYYY-MM-DD, and passes through anything else', () => {
  const { heToISO } = loadApp();
  assert.equal(heToISO('04.07.2026'), '2026-07-04');
  assert.equal(heToISO(''), '');
  assert.equal(heToISO('not-a-date'), 'not-a-date');
});

test('calcExpectedFee: percent, with and without VAT', () => {
  const app = loadApp();
  app.__test.setOfficeVatRate(18);
  assert.equal(app.calcExpectedFee({ feeType: 'percent', amount: 10000, feePct: 15, feeVat: 'no' }), 1500);
  assert.equal(app.calcExpectedFee({ feeType: 'percent', amount: 10000, feePct: 15, feeVat: 'yes' }), 1770);
});

test('calcExpectedFee: fixed', () => {
  const app = loadApp();
  assert.equal(app.calcExpectedFee({ feeType: 'fixed', feeFixed: 5000, feeVat: 'no' }), 5000);
});

test('calcExpectedFee: both = fixed + percent-of-debt (previously dropped the percent portion)', () => {
  const app = loadApp();
  assert.equal(app.calcExpectedFee({ feeType: 'both', feeFixed: 2000, amount: 10000, feePct: 10, feeVat: 'no' }), 3000);
});

test('calcExpectedFee: hourly = logged hours x hourly rate (feeFixed)', () => {
  const app = loadApp();
  const db = app.__test.getDb();
  db.timeEntries = [{ caseId: 'c1', duration: 3600 * 2 }]; // 2 hours
  assert.equal(app.calcExpectedFee({ id: 'c1', feeType: 'hourly', feeFixed: 300, feeVat: 'no' }), 600);
});

test('calcCollectedFee: percent is earned proportionally to actual debt payments', () => {
  const app = loadApp();
  const db = app.__test.getDb();
  db.payments = [{ caseId: 'c1', type: 'debt', amount: 4000 }];
  assert.equal(app.calcCollectedFee({ id: 'c1', feeType: 'percent', feePct: 15, feeVat: 'no' }), 600);
});

test('calcCollectedFee: fixed fee is earned only once the debt is FULLY collected', () => {
  const app = loadApp();
  const db = app.__test.getDb();
  db.payments = [{ caseId: 'c2', type: 'debt', amount: 5000 }];
  assert.equal(app.calcCollectedFee({ id: 'c2', feeType: 'fixed', amount: 10000, feeFixed: 1500, feeVat: 'no' }), 0);
  db.payments = [{ caseId: 'c2', type: 'debt', amount: 10000 }];
  assert.equal(app.calcCollectedFee({ id: 'c2', feeType: 'fixed', amount: 10000, feeFixed: 1500, feeVat: 'no' }), 1500);
});

test('calcCollectedFee: an unset debt amount is not mistaken for "fully collected" with zero payments', () => {
  const app = loadApp();
  const db = app.__test.getDb();
  db.payments = [];
  assert.equal(app.calcCollectedFee({ id: 'c3', feeType: 'fixed', amount: 0, feeFixed: 1500, feeVat: 'no' }), 0);
});
