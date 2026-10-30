// צוות ה-AI: חישוב הלוח (שרת), הכלים החדשים, הזריעה, והממשק.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SHARED = path.join(ROOT, 'supabase', 'functions', '_shared');
const load = (m) => import('file://' + path.join(SHARED, m).replace(/\\/g, '/'));

// staff-tools.ts קורא Deno.env בזמן טעינה.
globalThis.Deno ||= { env: { get: () => '' } };

test('nextRunAt: daily at 08:00 Jerusalem, never in the past', async () => {
  const { nextRunAt } = await load('staff-tools.ts');
  // 30.10.2026 10:00 Jerusalem (UTC+2 after DST ends 25.10) = 08:00Z → next is tomorrow 08:00 local = 06:00Z
  const after = new Date('2026-10-30T08:00:00Z');
  assert.equal(nextRunAt({ freq: 'daily', hour: 8 }, after), '2026-10-31T06:00:00.000Z');
  // 05:00 local → today at 08:00 local
  assert.equal(nextRunAt({ freq: 'daily', hour: 8 }, new Date('2026-10-30T03:00:00Z')), '2026-10-30T06:00:00.000Z');
});

test('nextRunAt: weekdays skip Friday/Saturday; weekly picks the listed days; monthly the day of month', async () => {
  const { nextRunAt } = await load('staff-tools.ts');
  // Thursday 29.10.2026 12:00 local → weekdays: Sunday 1.11 09:00 local (UTC+2 → 07:00Z)
  assert.equal(nextRunAt({ freq: 'weekdays', hour: 9 }, new Date('2026-10-29T10:00:00Z')), '2026-11-01T07:00:00.000Z');
  // weekly on Sun/Tue/Thu from Monday 2.11 → Tuesday 3.11 10:00 local
  assert.equal(nextRunAt({ freq: 'weekly', hour: 10, days: [0, 2, 4] }, new Date('2026-11-02T10:00:00Z')), '2026-11-03T08:00:00.000Z');
  // monthly on the 1st from 15.11 → 1.12 09:00 local
  assert.equal(nextRunAt({ freq: 'monthly', hour: 9, dom: 1 }, new Date('2026-11-15T10:00:00Z')), '2026-12-01T07:00:00.000Z');
  assert.equal(nextRunAt(null, new Date()), null);
});

test('nextRunAt: summer time is honoured (UTC+3)', async () => {
  const { nextRunAt } = await load('staff-tools.ts');
  // 1.7.2026 is in IDT → 08:00 local = 05:00Z
  assert.equal(nextRunAt({ freq: 'daily', hour: 8 }, new Date('2026-07-01T00:00:00Z')), '2026-07-01T05:00:00.000Z');
});

test('scheduleLabelHe matches the client-side label', async () => {
  const { scheduleLabelHe } = await load('staff-tools.ts');
  const sandbox = { console, window: {}, document: { getElementById: () => null } };
  vm.createContext(sandbox);
  vm.runInContext(read('src/ai-staff.js') + '\n;globalThis.aiScheduleLabel = aiScheduleLabel;', sandbox);
  for (const s of [{ freq: 'daily', hour: 8 }, { freq: 'weekdays', hour: 9 }, { freq: 'weekly', hour: 10, days: [0, 2, 4] }, { freq: 'monthly', hour: 9, dom: 1 }, null]) {
    assert.equal(sandbox.aiScheduleLabel(s), scheduleLabelHe(s));
  }
});

test('htmlToText strips scripts and tags but keeps paragraphs', async () => {
  const { htmlToText } = await load('staff-tools.ts');
  const t = htmlToText('<html><head><style>x{}</style><script>evil()</script></head><body><h1>כותרת</h1><p>פסקה &amp; עוד</p><div>שורה</div></body></html>');
  assert.ok(!t.includes('evil'));
  assert.match(t, /כותרת\s*\n\s*פסקה & עוד\s*\n\s*שורה/);
});

test('the new tools are registered, and the sensitive ones only propose or stay drafts', async () => {
  // tools.ts מייבא supabase-js מ-https ולכן לא נטען ב-Node; הרישום נבדק במקור.
  const src = read('supabase/functions/_shared/tools.ts');
  assert.match(src, /import \{ STAFF_TOOLS \} from '\.\/staff-tools\.ts'/);
  assert.match(src, /new Map\(\[\.\.\.TOOLS, \.\.\.STAFF_TOOLS\]/);
  const { STAFF_TOOLS } = await load('staff-tools.ts');
  const slugs = STAFF_TOOLS.map(t => t.slug);
  for (const s of ['get_brand_kit', 'list_work_items', 'create_work_item', 'update_work_item', 'web_search', 'fetch_url', 'get_team_status', 'delegate_task']) {
    assert.ok(slugs.includes(s), s);
  }
  assert.equal(new Set(slugs).size, slugs.length, 'duplicate slugs');
  // כל כלי צוות הוא סיכון נמוך לכל היותר: תוצר נולד כטיוטה, ושליחה/פרסום הם של בעל המשרד.
  for (const t of STAFF_TOOLS) assert.ok(['none', 'low'].includes(t.risk), `${t.slug} risk=${t.risk}`);
});

test('create_work_item accepts free-form metadata (the model adds its own keys)', async () => {
  // נמצא בריצה אמיתית: הקריאייטיב שלח metadata עם visual_suggestion ונדחה.
  const { STAFF_TOOLS } = await load('staff-tools.ts');
  const { validate } = await load('schema.ts');
  const def = STAFF_TOOLS.find(t => t.slug === 'create_work_item');
  const out = validate({ kind: 'post', title: 'כותרת', body: 'גוף הפוסט הארוך מספיק', metadata: { visual_suggestion: 'x', post_number: 1 } }, def.schema);
  assert.equal(out.metadata.visual_suggestion, 'x');
  assert.throws(() => validate({ kind: 'post', title: 'כותרת', body: 'גוף הפוסט', evil: 1 }, def.schema), /שדות לא מוכרים/);
});

test('fetch_url refuses private and non-http targets', async () => {
  const { STAFF_TOOLS } = await load('staff-tools.ts');
  const fetchUrl = STAFF_TOOLS.find(t => t.slug === 'fetch_url');
  for (const u of ['http://localhost/x', 'http://127.0.0.1/', 'file:///etc/passwd', 'https://syxutnwbpjsvzlwfpvyc.supabase.co/rest/v1/app_data', 'ftp://x.y/z']) {
    const r = await fetchUrl.handler({ url: u }, {});
    assert.equal(r.ok, false, u);
  }
});

test('web_search without a key fails closed with a clear owner instruction', async () => {
  const { STAFF_TOOLS } = await load('staff-tools.ts');
  const r = await STAFF_TOOLS.find(t => t.slug === 'web_search').handler({ query: 'פסיקה' }, {});
  assert.equal(r.ok, false);
  assert.match(r.text, /BRAVE_SEARCH_API_KEY/);
});

test('seed: every team member the gateway routes to, and every tool it is granted, exists', () => {
  const sql = read('supabase/migrations/20261031000000_ai_staff.sql');
  const gw = read('supabase/functions/ai-gateway/index.ts');
  const routed = [...gw.matchAll(/agent: '([a-z-]+)'/g)].map(m => m[1]);
  for (const slug of new Set(routed)) assert.ok(sql.includes(`'${slug}'`), `gateway routes to ${slug} but the seed lacks it`);
  // הכלים שמוענקים בזריעה קיימים בקוד.
  const tools = read('supabase/functions/_shared/tools.ts') + read('supabase/functions/_shared/staff-tools.ts');
  const grantsSection = sql.slice(sql.indexOf('----- הרשאות כלים -----'), sql.indexOf('----- מה נדרש מבעל המשרד -----'));
  const granted = new Set([...grantsSection.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).filter(s => s.includes('_')));
  for (const s of granted) assert.ok(tools.includes(`slug: '${s}'`), `seed grants unknown tool ${s}`);
  // סוכני מסמכים מושבתים ולא נמחקים.
  assert.match(sql, /set status = 'disabled', visible = false/);
  assert.ok(!/delete from public\.ai_agents/.test(sql));
});

test('the chat is the manager: it can delegate, see the team and list work, and the system prompt says so', () => {
  const app = read('src/app.js');
  for (const n of ['teamStatus', 'delegateToAgent', 'listWorkItems']) {
    assert.match(app, new RegExp(`name:'${n}'`));
    assert.match(app, new RegExp(`case '${n}':`));
  }
  assert.match(app, /delegateToAgent עם יעד מפורט/);
  // delegateToAgent is a sandboxed tool call before the cached draftDocument entry (cache_control must stay last).
  assert.ok(app.indexOf("name:'delegateToAgent'") < app.indexOf("name:'draftDocument'"));
});

test('UI: six tabs, team first, and ai-staff.js loads after ai-center.js', () => {
  const ac = read('src/ai-center.js');
  const tabs = [...ac.matchAll(/\{ id: '([a-z]+)',\s+label/g)].map(m => m[1]);
  assert.deepEqual(tabs, ['team', 'work', 'approvals', 'inbox', 'setup', 'advanced']);
  assert.match(ac, /let aiTab = 'team'/);
  const b = read('build.mjs');
  assert.ok(b.indexOf("'ai-staff.js'") > b.indexOf("'ai-center.js'"));
  assert.match(read('src/app.html'), /עוזר AI/);
});

test('ai-cron enqueues routines once per agent per day and skips paused offices', () => {
  const cron = read('supabase/functions/ai-cron/index.ts');
  assert.match(cron, /tasks\.includes\('routines'\)/);
  assert.match(cron, /stableHash\('routine', a\.id, todayISO\(\)\)/);
  assert.match(cron, /emergency_stop \|\| st\?\.automations_paused/);
  assert.match(cron, /trigger_type: 'schedule'/);
});
