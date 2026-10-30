// Regression tests for stage C (XSS, headers, Electron, AI safety). The escaping
// helpers are exercised for real in a vm sandbox; the rest are source checks for code
// that only runs in a browser, in Electron or on Deno.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const appJs = read('src/app.js');

function loadApp() {
  const sandbox = {
    console, __req: () => ({}),
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { querySelectorAll: () => [], addEventListener: () => {}, getElementById: () => null },
    window: { addEventListener: () => {} }, navigator: { userAgent: 'test' },
  };
  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox, { filename: 'app.js' });
  return sandbox;
}

test('jsArg yields a JS literal that survives HTML-entity decoding', () => {
  const { jsArg } = loadApp();
  const hostile = `x'),alert(1),('`;
  const attr = jsArg(hostile);
  assert.ok(!/['"]/.test(attr), 'no raw quotes in the attribute value');
  // What the browser does: decode entities, then run the handler source.
  const decoded = attr.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(JSON.parse(decoded), hostile, 'decodes back to exactly one string argument');
});

test('safeToken and safeColor reject markup', () => {
  const { safeToken, safeColor } = loadApp();
  assert.equal(safeToken('active" onmouseover="x'), 'activeonmouseoverx');
  assert.equal(safeColor('#2563eb'), '#2563eb');
  assert.equal(safeColor('rgba(37,99,235,0.15)'), 'rgba(37,99,235,0.15)');
  assert.equal(safeColor('red;background:url(x)'), 'transparent');
  assert.equal(safeColor('x" onclick="y', 'var(--accent2)'), 'var(--accent2)');
});

test('docx preview HTML is always sanitized before innerHTML', () => {
  const lines = appJs.split('\n').filter(l => /innerHTML/.test(l) && /result\.value/.test(l));
  assert.ok(lines.length >= 3, 'all three mammoth preview sinks found');
  for (const l of lines) assert.ok(!/(?<!sanitizeDocHtml\()result\.value/.test(l), 'unsanitized: ' + l.trim().slice(0, 80));
});

test('file-name/path onclick arguments go through jsArg', () => {
  assert.match(appJs, /efilingOpenFile\(\$\{jsArg\(/);
  assert.ok(!/efilingOpenFile\('\$\{/.test(appJs));
  assert.ok(!/Platform\.openFile\('\$\{/.test(appJs), 'no hand-quoted openFile args');
  const tm = read('src/template-manager.js');
  assert.ok(!/replace\(\/'\/g, "\\\\'"\)/.test(tm), 'no quote-replacing escapes in the template manager');
  assert.match(tm, /jsArg\(folderName\)/);
});

test('status/stage/colour fields are escaped where rendered as HTML', () => {
  assert.ok(!/badge-\$\{c\.status\}/.test(appJs));
  assert.ok(!/>\$\{c\.stage\}<\/(td|div)>/.test(appJs));
  assert.ok(!/background:\$\{c\.color\}/.test(appJs));
});

test('Electron window is confined to the app and the sign-in flow', () => {
  const main = read('main.js');
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /'will-navigate'/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /sandbox: true/);
});

test('hosting sends anti-framing and a CSP (report-only first)', () => {
  const toml = read('netlify.toml');
  assert.match(toml, /X-Frame-Options = "DENY"/);
  assert.match(toml, /X-Content-Type-Options = "nosniff"/);
  assert.match(toml, /Content-Security-Policy-Report-Only = "[^"]*frame-ancestors 'none'/);
});

test('sign-out clears the remembered session before the reload-triggering signOut', () => {
  const p = read('src/platform.web.js');
  const body = p.slice(p.indexOf('async signOut()'), p.indexOf('async resetPasswordForEmail'));
  assert.ok(body.indexOf('clearRememberedSession()') < body.indexOf('supabase.auth.signOut()'));
  assert.match(body, /finally \{\s*clearRememberedSession\(\);/);
});

test('AI approval card always shows the real recipient', () => {
  const ai = read('src/ai-center.js');
  assert.match(ai, /function ApprovalRecipient\(a, payload\)/);
  assert.match(ai, /\$\{ApprovalRecipient\(a, payload\)\}/);
  assert.match(ai, /case 'create_matter'[\s\S]{0,900}stages\.includes\(p\.stage\)/, 'AI-proposed stage is validated');
});

test('ai-comms runs every check before claiming the approval, and only for messages', () => {
  const src = read('supabase/functions/ai-comms/index.ts');
  const fn = src.slice(src.indexOf('async function sendApproved'), src.indexOf('// ---- תיעוד ----'));
  const claim = fn.indexOf(".update({ applied_at: new Date().toISOString() })");
  for (const guard of ["'forbidden'", "'emergency_stop'", "'no_recipient'", "'provider_mock'", 'MESSAGE_ACTIONS.has']) {
    const at = fn.indexOf(guard);
    assert.ok(at > 0 && at < claim, `${guard} must run before the claim`);
  }
  assert.ok(fn.indexOf('await send()') > claim, 'the send happens only after the claim');
});

test('calendar events are built from the approved proposal, not the request body', () => {
  const src = read('supabase/functions/ai-comms/index.ts');
  const fn = src.slice(src.indexOf('async function createCalendarEvent'));
  assert.match(fn, /\['create_event', 'create_deadline'\]\.includes\(approval\.action_type\)/);
  assert.ok(!/title: String\(body\.title/.test(fn));
  assert.match(fn, /title: String\(ev\.title/);
});

test('the legacy automation engine in ai-cron no longer runs by default', () => {
  const src = read('supabase/functions/ai-cron/index.ts');
  assert.match(src, /body\.legacyAutomations === true\s*\?\s*await runAutomations\(sb\)/);
  assert.ok(!/array\['reap','drain','automations','learn'\]/.test(read('scripts/setup-cron.sh')));
});

test('external job payloads and unverified memories reach the model as untrusted content', () => {
  const src = read('supabase/functions/_shared/context.ts');
  assert.match(src, /wrapUntrusted\(JSON\.stringify\(opts\.payload, null, 2\), 'job_payload'\)/);
  assert.match(src, /wrapUntrusted\(line, 'memory', m\.id\)/);
});

test('OAuth callback page escapes the message it renders', () => {
  const src = read('supabase/functions/integrations-google/index.ts');
  assert.ok(!/<p>\$\{msg\}<\/p>/.test(src));
});
