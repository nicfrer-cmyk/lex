// Stage D (documents & office profile): the real docxtemplater + pizzip run against a
// minimal .docx built in memory, through app.js's own renderDocxTemplate /
// extractDocxPlaceholders, so these assert what a lawyer would actually get in Word.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');

function loadApp() {
  const sandbox = {
    console, Buffer,
    __req: (n) => (n === 'pizzip' ? PizZip : n === 'docxtemplater' ? Docxtemplater : {}),
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {}, getElementById: () => null, title: '' },
    window: { addEventListener: () => {} }, navigator: { userAgent: 'test' },
  };
  vm.createContext(sandbox);
  vm.runInContext(appJs + ';globalThis.__setDb=(v)=>{db=v;};globalThis.__OFFICE=OFFICE;', sandbox, { filename: 'app.js' });
  return sandbox;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
function makeDocx(bodyParas, headerText) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${headerText ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${headerText ? '<Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : ''}</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${bodyParas.map(para).join('')}</w:body></w:document>`);
  if (headerText) zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W}>${para(headerText)}</w:hdr>`);
  return zip.generate({ type: 'nodebuffer' });
}
const textOf = (buf) => new PizZip(buf).file('word/document.xml').asText().replace(/<[^>]+>/g, '');

test('a tag with no value renders empty, never the word "undefined"', () => {
  const { renderDocxTemplate } = loadApp();
  const out = renderDocxTemplate(makeDocx(['שם: {{שם_לקוח}}', 'ת"ז: {{תז_לקוח}}']), { 'שם_לקוח': 'כהן' }, 'x.docx');
  const t = textOf(out);
  assert.match(t, /שם: כהן/);
  assert.ok(!/undefined/.test(t));
});

test('a broken template fails with a Hebrew explanation, not "Multi error"', () => {
  const { renderDocxTemplate } = loadApp();
  assert.throws(() => renderDocxTemplate(makeDocx(['שם: {{שם_לקוח']), {}, 'פגומה.docx'),
    (e) => /התבנית "פגומה\.docx" פגומה/.test(e.message) && !/Multi error/.test(e.message));
});

test('placeholder validation also finds tags in headers', () => {
  const { extractDocxPlaceholders } = loadApp();
  const tags = extractDocxPlaceholders(makeDocx(['{{גוף}}', '{{#סעיפים}}{{.}}{{/סעיפים}}'], 'תיק {{מספר_תיק}}'));
  assert.deepEqual(Array.from(tags).sort(), ['גוף', 'מספר_תיק', 'סעיפים'].sort());
});

test('list fields render as one paragraph per item', () => {
  const { renderDocxTemplate } = loadApp();
  const out = renderDocxTemplate(makeDocx(['{{#עובדות}}', '{{.}}', '{{/עובדות}}']), { 'עובדות': ['ראשונה', 'שנייה'] });
  const xml = new PizZip(out).file('word/document.xml').asText();
  assert.equal((xml.match(/<w:p>/g) || []).length >= 2, true);
  assert.match(textOf(out), /ראשונה[\s\S]*שנייה/);
});

test('request generation lets case data and user inputs win over the AI reply', () => {
  const i = appJs.indexOf('const aiOnly = {};');
  const block = appJs.slice(i, i + 900);
  assert.match(block, /for \(const f of spec\.aiFields\)/);
  assert.match(block, /\{ \.\.\.aiOnly, \.\.\.inputValues, \.\.\.systemValues \}/);
});

test('office identity comes from the office profile, with the original account seeded once', () => {
  const app = loadApp();
  app.__setDb({ settings: { officeProfile: { lawyerName: 'דנה לוי', license: '12345', phone: '03-1234567', firmTitle: 'לוי ושות\'' } }, cases: [], clients: [] });
  app.applyOfficeProfile();
  assert.equal(app.__OFFICE.name, 'דנה לוי');
  assert.equal(app.__OFFICE.title, 'לוי ושות\'');
  assert.equal(app.officeContactLine(), "טל': 03-1234567 | רישיון: 12345", 'empty fields are left out');
  assert.ok(!/ירין|99198/.test(appJs.slice(appJs.indexOf('const OFFICE ='), appJs.indexOf('const LEGACY_OFFICE_PROFILE'))), 'no hardcoded identity in OFFICE');
  assert.match(appJs, /email\.toLowerCase\(\) === LEGACY_OFFICE_PROFILE\.email/);
});

test('drafting refuses to produce a document with no office details', () => {
  const i = appJs.indexOf("case 'draftDocument': {");
  assert.match(appJs.slice(i, i + 400), /if \(!OFFICE\.title && !OFFICE\.name\)/);
  assert.match(appJs, /const MARGIN = 1418, HL = 24, TL = 32;/, 'David 12 body / 16 title');
});

test('a VAT rate of 0 is kept (exempt dealer)', () => {
  assert.ok(!/officeVatRate\|\|18/.test(appJs));
  assert.match(appJs, /Number\.isFinite\(rawVat\) && rawVat >= 0/);
});
