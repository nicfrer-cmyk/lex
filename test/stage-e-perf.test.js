// Stage E (performance/quality): save coalescing is exercised for real through app.js's
// saveDB with a slow fake Platform; build-level changes are source checks.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadApp(platform) {
  const el = () => ({ style: {}, textContent: '', classList: { add() {}, remove() {} } });
  const sandbox = {
    console, setTimeout, clearTimeout, __req: () => ({}),
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {}, getElementById: el },
    window: { addEventListener: () => {} }, navigator: { userAgent: 'test' },
    Platform: platform,
  };
  vm.createContext(sandbox);
  vm.runInContext(read('src/app.js'), sandbox, { filename: 'app.js' });
  return sandbox;
}

test('a burst of saves becomes at most two uploads, all callers resolved', async () => {
  let uploads = 0;
  const platform = { saveDB: () => new Promise(r => { uploads++; setTimeout(() => r({ merged: false, renumbered: [] }), 30); }) };
  const app = loadApp(platform);
  const calls = [];
  for (let i = 0; i < 10; i++) calls.push(app.saveDB());
  await Promise.all(calls);
  // All ten join the save queued before it starts (it uploads the latest db, so every
  // caller's change is in it); at worst one more follows an already-running upload.
  assert.ok(uploads >= 1 && uploads <= 2, `uploads=${uploads}`);
});

test('a save queued after a failure still runs, and the failure reaches its caller', async () => {
  let n = 0;
  const platform = { saveDB: () => (++n === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ merged: false, renumbered: [] })) };
  const app = loadApp(platform);
  await assert.rejects(app.saveDB(), /offline/);
  await app.saveDB();
  assert.equal(n, 2);
});

test('platform bundle is minified and vendor files are cached long-term', () => {
  const b = read('build.mjs');
  assert.match(b, /outfile: path\.join\(outDir, 'platform\.js'\),[\s\S]{0,400}minify: true/);
  assert.match(b, /'\/vendor\/\*',\s*'  Cache-Control: public, max-age=31536000, immutable'/);
});

test('search boxes render after a pause, not on every keystroke', () => {
  const html = read('src/app.html');
  for (const fn of ['renderCases', 'renderClients', 'renderDocs']) {
    assert.match(html, new RegExp(`oninput="debouncedRender\\('${fn}',this\\.value\\)"`));
  }
});

test('tests run in CI on every push', () => {
  const wf = read('.github/workflows/test.yml');
  assert.match(wf, /run: npm test/);
  assert.match(wf, /run: node build\.mjs/);
});

test('static HTML carries no single office\'s identity', () => {
  const html = read('src/app.html');
  assert.ok(!/ירין|אשואל/.test(html));
});
