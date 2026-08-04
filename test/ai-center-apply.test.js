// בדיקות אינטגרציה לנתיב הכתיבה של מרכז ה-AI (מפרט §23.2).
//
// ## למה דווקא כאן
// aiApplyApproval() ב-src/ai-center.js היא הפונקציה **היחידה** בכל המערכת
// שכותבת נתונים שסוכן ייצר אל תוך ה-CRM. אם היא תכתוב שם שדה שגוי, הרשומה
// תישמר בשקט ופשוט לא תופיע במסכים — בלי שגיאה, בלי אזהרה, ועם נתונים
// שנראים תקינים ב-JSON.
//
// המלכודות שהבדיקות כאן שומרות עליהן, כולן מהקוד האמיתי:
//   • ב-case מזהה הלקוח הוא `client` ולא `clientId`   (app.js:445)
//   • tasks.due / events.date הם YYYY-MM-DD           (app.js:2499, 2615)
//   • cases.opened / docs.date הם "5.7.2026" he-IL     (app.js:465, 3117)
//   • cases.diary[].date כולל שעה (toLocaleString)     (app.js:1037)
//   • docs.ext מוגבל ל-pdf|doc|xls|img                 (app.js:3105)
//
// שני הקבצים נטענים לאותו vm context, בדיוק בסדר שבו build.mjs טוען אותם,
// כי ai-center.js משתמש בגלובלים של app.js (db, uid, saveDB, notify).

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const appJs = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
const aiJs = fs.readFileSync(path.join(SRC, 'ai-center.js'), 'utf8');

const bridge = `
;globalThis.__test = {
  getDb: () => db,
  setDb: (v) => { db = v; },
  saves: () => __saveCount,
};
`;

function loadBoth() {
  const notifications = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    __req: () => ({}),
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      querySelectorAll: () => [],
      addEventListener: () => {},
      getElementById: () => null,
    },
    window: { addEventListener: () => {} },
    navigator: { userAgent: 'test' },
    setTimeout: () => 0,
    clearTimeout: () => {},
    Platform: {
      saveDB: async () => true,
      saveFile: async () => 'office/documents/mock-file.docx',
      openFile: async () => {},
    },
    __saveCount: 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(appJs + bridge, sandbox, { filename: 'app.js' });

  // saveDB האמיתי נוגע ב-DOM ובענן. מחליפים במונה, כדי שהבדיקות יוכלו
  // לוודא שהשמירה אכן נקראה — זו חצי מהנקודה של הפונקציה.
  vm.runInContext('saveDB = function(){ __saveCount++; };', sandbox);
  vm.runInContext('notify = function(m){ globalThis.__notes = (globalThis.__notes||[]); globalThis.__notes.push(m); };', sandbox);

  vm.runInContext(aiJs, sandbox, { filename: 'ai-center.js' });
  sandbox.__notifications = notifications;
  return sandbox;
}

function freshDb(app) {
  app.__test.setDb({
    cases: [], clients: [], tasks: [], events: [], docs: [], payments: [], leads: [],
    timeEntries: [], trustTransactions: [], settings: {}, efilingBundles: {},
    counters: { nextClientNumber: 1, caseCounters: {} },
  });
  return app.__test.getDb();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HE_DATE = /^\d{1,2}\.\d{1,2}\.\d{4}$/;

// ============================================================

test('create_task: נכתב בדיוק בשמות השדות ש-saveTask כותב', async () => {
  const app = loadBoth();
  const db = freshDb(app);
  db.cases.push({ id: 'case1', name: 'תיק בדיקה', client: '', diary: [] });

  const res = await app.aiApplyApproval({
    action_type: 'create_task',
    proposed_payload: {
      text: 'להגיש בקשה לביטול עיקול', due: '2026-08-20',
      caseId: 'case1', priority: 'urgent', notes: 'דחוף',
    },
  });

  assert.equal(db.tasks.length, 1);
  const t = db.tasks[0];
  assert.equal(t.text, 'להגיש בקשה לביטול עיקול');
  assert.equal(t.caseId, 'case1');
  assert.equal(t.priority, 'urgent');
  assert.equal(t.done, false, 'משימה חדשה חייבת להיווצר כלא-מבוצעת');
  assert.match(t.due, ISO_DATE, 'due חייב להיות YYYY-MM-DD — כך הוא מושווה ב-app.js:2534');
  assert.ok(t.id && typeof t.id === 'string');
  assert.equal(app.__test.saves(), 1, 'חייב לקרוא ל-saveDB');
  assert.ok(res.message);
});

test('create_deadline: נשמר כאירוע עם סימון שהמועד אושר', async () => {
  const app = loadBoth();
  const db = freshDb(app);
  db.cases.push({ id: 'case1', name: 'תיק', client: '', diary: [] });

  await app.aiApplyApproval({
    action_type: 'create_deadline',
    proposed_payload: {
      title: 'מועד אחרון להגשת תגובה', date: '2026-09-01',
      caseId: 'case1', deadlineStatus: 'suggested',
    },
  });

  assert.equal(db.events.length, 1);
  const e = db.events[0];
  assert.equal(e.title, 'מועד אחרון להגשת תגובה');
  assert.match(e.date, ISO_DATE);
  assert.equal(e.type, 'מועד אחרון', 'חייב להיות ערך מרשימת סוגי האירועים ב-app.html');
  assert.equal(e.caseId, 'case1');
  // המעבר suggested → confirmed קורה רק ברגע האישור האנושי (מפרט §5.9).
  assert.ok(e.aiConfirmedAt, 'חייב לתעד מתי המועד אושר');
  assert.equal(e.aiSuggested, true, 'חייב לשמר שהמועד מקורו בחילוץ אוטומטי');
});

test('add_diary_entry: הפורמט תואם את daysSinceHE שקורא אותו', async () => {
  const app = loadBoth();
  const db = freshDb(app);
  db.cases.push({ id: 'case1', name: 'תיק', client: '', diary: [] });

  await app.aiApplyApproval({
    action_type: 'add_diary_entry',
    proposed_payload: { caseId: 'case1', text: 'נשלחה התראה לחייב' },
  });

  const entry = db.cases[0].diary[0];
  assert.equal(entry.text, 'נשלחה התראה לחייב');
  // toLocaleString('he-IL') → "5.7.2026, 14:23:10". daysSinceHE (app.js:494)
  // מפצל על פסיק ואז על נקודה; פורמט אחר היה מחזיר null בשקט וכל התיק
  // היה נראה "ללא פעילות מעולם".
  assert.equal(app.daysSinceHE(entry.date), 0, 'daysSinceHE חייב לפרסר את מה שכתבנו');
});

test('add_diary_entry: תיק שלא קיים נכשל במפורש ולא בשקט', async () => {
  const app = loadBoth();
  freshDb(app);
  await assert.rejects(
    () => app.aiApplyApproval({
      action_type: 'add_diary_entry',
      proposed_payload: { caseId: 'nope', text: 'x' },
    }),
    /התיק לא נמצא/,
  );
});

test('create_client: מקבל מספר לקוח, ראשי תיבות וצבע כמו saveClient', async () => {
  const app = loadBoth();
  const db = freshDb(app);

  await app.aiApplyApproval({
    action_type: 'create_client',
    proposed_payload: {
      name: 'ישראל ישראלי', type: 'יחיד',
      phone: '+972501234567', email: 'a@b.co.il', idNum: '123456789',
    },
  });

  const c = db.clients[0];
  assert.equal(c.name, 'ישראל ישראלי');
  assert.equal(c.idNum, '123456789', 'השדה נקרא idNum, לא idNumber');
  assert.equal(c.clientNumber, '1', 'clientNumber הוא מחרוזת של מספר שלם');
  assert.equal(c.initials, 'יי', 'ראשי תיבות משתי המילים הראשונות');
  assert.ok(c.color && c.textColor, 'חייב צבע כדי שה-client-avatar יוצג');
  assert.equal(db.counters.nextClientNumber, 2, 'המונה חייב להתקדם');
});

test('create_matter: מזהה הלקוח נשמר בשדה client ולא clientId', async () => {
  const app = loadBoth();
  const db = freshDb(app);
  db.clients.push({ id: 'cl1', name: 'לקוח', clientNumber: '7' });

  await app.aiApplyApproval({
    action_type: 'create_matter',
    proposed_payload: {
      name: 'תביעת חוב', client: 'cl1', caseType: 'debt',
      amount: 50000, court: 'שלום תל אביב', debtorName: 'החייב',
    },
  });

  const c = db.cases[0];
  // המלכודת המרכזית: app.js:445 שומר `client`, וכל הקוד שמחפש תיקים של
  // לקוח מסנן לפי c.client. שדה בשם clientId היה נשמר ופשוט לא נקשר לאיש.
  assert.equal(c.client, 'cl1');
  assert.equal(c.clientId, undefined, 'אסור שיהיה שדה clientId מבלבל');
  assert.equal(c.status, 'active');
  assert.equal(c.amount, 50000);
  assert.match(c.opened, HE_DATE, 'opened הוא he-IL ("5.7.2026") ולא ISO');
  assert.equal(c.caseSubNumber, '7/1', 'תת-מספר נגזר ממספר הלקוח');
  assert.equal(c.closedAt, null);
  assert.ok(Array.isArray(c.diary) && c.diary.length === 1, 'תיק חדש מתועד ביומן');
  assert.ok(c.stage, 'חייב שלב התחלתי');
});

test('create_matter: לקוח שלא קיים נדחה', async () => {
  const app = loadBoth();
  freshDb(app);
  await assert.rejects(
    () => app.aiApplyApproval({
      action_type: 'create_matter',
      proposed_payload: { name: 'תיק', client: 'ghost' },
    }),
    /הלקוח לא נמצא/,
  );
});

test('tag_document: מסמן שהמסמך נותח כדי שלא ינותח שוב', async () => {
  const app = loadBoth();
  const db = freshDb(app);
  db.docs.push({ id: 'd1', name: 'החלטה.pdf', cat: 'אחר', caseId: '', ext: 'pdf' });

  await app.aiApplyApproval({
    action_type: 'tag_document',
    proposed_payload: { docId: 'd1', cat: 'פסקי דין', caseId: 'case1', aiSummary: 'החלטה בבקשה' },
  });

  const d = db.docs[0];
  assert.equal(d.cat, 'פסקי דין');
  assert.equal(d.caseId, 'case1');
  assert.equal(d.aiSummary, 'החלטה בבקשה');
  // בלי החותמת הזו האוטומציה "מסמך חדש" הייתה מנתחת את אותו מסמך שוב ושוב
  // ומשלמת על כך בכל סבב.
  assert.ok(d.aiAnalyzedAt, 'חייב לסמן aiAnalyzedAt');
});

test('create_lead + update_lead_score: מחזור החיים של ליד', async () => {
  const app = loadBoth();
  const db = freshDb(app);

  await app.aiApplyApproval({
    action_type: 'create_lead',
    proposed_payload: { name: 'פונה חדש', phone: '+972501234567', area: 'הוצאה לפועל', source: 'whatsapp' },
  });
  const lead = db.leads[0];
  assert.equal(lead.name, 'פונה חדש');
  assert.equal(lead.status, 'new');
  assert.ok(lead.createdAt);

  await app.aiApplyApproval({
    action_type: 'update_lead_score',
    proposed_payload: {
      leadId: lead.id, score: 82, scoreReason: 'סכום גבוה ומועד קרוב',
      urgency: 'high', missingInfo: ['מספר תיק'], followUpQuestions: ['מתי הוטל העיקול?'],
    },
  });
  assert.equal(db.leads[0].score, 82);
  assert.equal(db.leads[0].urgency, 'high');
  assert.deepEqual(db.leads[0].missingInfo, ['מספר תיק']);
});

test('פעולה לא מוכרת נכשלת במפורש במקום להיבלע', async () => {
  const app = loadBoth();
  freshDb(app);
  // מוטב שהמשתמש יראה "אין מנגנון החלה" מאשר שהאישור יסומן כבוצע
  // בזמן שבפועל לא קרה דבר.
  await assert.rejects(
    () => app.aiApplyApproval({ action_type: 'transfer_funds', proposed_payload: {} }),
    /אין מנגנון החלה/,
  );
});

test('edited_payload גובר על proposed_payload — "עריכה ואישור"', async () => {
  const app = loadBoth();
  const db = freshDb(app);

  await app.aiApplyApproval({
    action_type: 'create_task',
    proposed_payload: { text: 'הנוסח של הסוכן', priority: 'low' },
    edited_payload: { text: 'הנוסח שהמשתמש תיקן', priority: 'urgent' },
  });

  assert.equal(db.tasks[0].text, 'הנוסח שהמשתמש תיקן');
  assert.equal(db.tasks[0].priority, 'urgent');
});

// ============================================================
// עזרי תאריך של ai-center.js מול אלה של app.js
// ============================================================

test('aiTodayISO ו-localDateISO מסכימים על אותו יום', () => {
  const app = loadBoth();
  // שתי מימושים נפרדים באותה מערכת שנותנים תאריך שונה = מועד שמופיע
  // ביום אחר בשני מסכים. שניהם חייבים להיות בזמן מקומי ולא UTC.
  assert.equal(app.aiTodayISO(), app.localDateISO(new Date()));
});

test('aiIdleDays מפרסר את פורמט היומן של app.js', () => {
  const app = loadBoth();
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
  const c = { diary: [{ text: 'x', date: tenDaysAgo.toLocaleString('he-IL') }] };
  assert.equal(app.aiIdleDays(c), 10);
  assert.equal(app.aiIdleDays({ diary: [] }), null, 'תיק ללא יומן מוחזר null ולא 0');
  assert.equal(app.aiIdleDays({}), null);
});

test('aiAddDays חוצה חודשים ושנים נכון', () => {
  const app = loadBoth();
  assert.equal(app.aiAddDays('2026-07-05', 7), '2026-07-12');
  assert.equal(app.aiAddDays('2026-12-28', 7), '2027-01-04');
  assert.equal(app.aiAddDays('2024-02-28', 1), '2024-02-29');
});

test('aiDisplayDate הוא DD/MM/YYYY', () => {
  const app = loadBoth();
  assert.equal(app.aiDisplayDate('2026-07-05'), '05/07/2026');
});

// ============================================================
// אבטחת ה-UI
// ============================================================

test('כל טקסט שמגיע מסוכן עובר escapeHtml', () => {
  const app = loadBoth();
  // הפלט של סוכן הוא טקסט שמקורו, בין השאר, במסמכים של הצד שכנגד.
  // XSS דרך שם תיק או תוכן מסמך יריץ קוד אצל כל מי שיפתח את המסך.
  const evil = '<img src=x onerror="alert(1)">';
  const out = app.RiskBadge('high') + app.StatusChip('completed');
  assert.ok(!out.includes('<img'), 'בדיקת שפיות לרכיבים ללא קלט');

  const cited = app.SourceCitation([{ documentId: null, quote: evil }]);
  assert.ok(!cited.includes('<img src=x'), 'ציטוט מסמך חייב להיות מוברח');
  assert.ok(cited.includes('&lt;img'), 'הציטוט אמור להופיע מוברח, לא להיעלם');
});

test('StatusChip ו-RiskBadge כוללים טקסט ולא רק צבע', () => {
  const app = loadBoth();
  // מפרט §19.1: "הצג סטטוסים עם טקסט ואייקון, לא רק צבע" — נגישות.
  for (const s of ['completed', 'failed', 'waiting_approval', 'running']) {
    const html = app.StatusChip(s);
    assert.ok(/[֐-׿]/.test(html), `${s} חייב טקסט עברי`);
  }
  for (const r of ['none', 'low', 'medium', 'high', 'critical']) {
    assert.ok(/[֐-׿]/.test(app.RiskBadge(r)), `${r} חייב טקסט עברי`);
  }
});
