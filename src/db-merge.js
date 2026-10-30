// מיזוג three-way של ה-blob של המשרד — הלוגיקה שמחליטה אילו נתונים שורדים
// כשכמה כותבים עובדים במקביל (שני עורכי דין, שני טאבים, הסוכן הקולי,
// וואטסאפ, מנוע האוטומציות).
//
// ## למה three-way
// כל ה-CRM הוא ערך jsonb יחיד. כשהשמירה מגלה שמישהו כתב מאז הטעינה, יש
// שלוש גרסאות: baseline (מה שנטען), local (מה שהמשתמש עשה מאז) ו-remote (מה
// שבשרת עכשיו). רק בעזרת ה-baseline אפשר לדעת *מי* שינה כל דבר:
//
//   local == baseline, remote שונה   → רק הצד השני שינה    → לוקחים את remote
//   local שונה, remote == baseline   → רק המשתמש שינה      → שומרים את local
//   שניהם שינו                       → המשתמש סמכותי       → local
//
// ## לפי פריט ולפי שדה
// קולקציה (cases, tasks...) מתמזגת לפי id, ובתוך פריט שקיים בשלושתם — לפי
// שדה. כך עו"ד אחד שמעדכן שלב בתיק ועו"ד אחר שמוסיף טלפון לאותו תיק לא
// דורסים זה את זה. מערכים בלי id (יומן הטיפול) מתמזגים לפי תוכן.
//
// ## מחיקות
//   נמחק בשרת, המשתמש לא נגע בו          → נשאר מחוק (בעבר "חזר לחיים")
//   נמחק בשרת, המשתמש ערך אותו           → נשמר (עדיף לא לאבד עבודה)
//   המשתמש מחק                            → נשאר מחוק
//
// קובץ נפרד כי platform.web.js לא נטען תחת Node; הבדיקות מייבאות את אותו
// קובץ בדיוק (test/db-merge.test.js).

/** קולקציות מערך שכל פריט בהן נושא id. */
export const MERGEABLE_COLLECTIONS = [
  'tasks', 'leads', 'events', 'clients', 'cases',
  'docs', 'payments', 'timeEntries', 'trustTransactions',
];

export const deepCopy = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

// השוואה שאינה תלויה בסדר מפתחות — jsonb ב-Postgres מסדר מפתחות מחדש, ולכן
// אותו אובייקט שחזר מהשרת אינו זהה מחרוזתית לזה שנשלח.
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}
export const same = (a, b) => stable(a) === stable(b);

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const hasIds = (arr) => Array.isArray(arr) && arr.length > 0 && arr.every(x => isObj(x) && x.id);

/** ערך אחד (שדה, או פריט שלם). */
function mergeValue(l, r, b) {
  if (same(l, b)) return deepCopy(r);
  if (same(r, b) || same(l, r)) return l;
  // שניהם שינו. אובייקט/מערך — יורדים פנימה כדי לשמור את שני השינויים.
  if (isObj(l) && isObj(r)) return mergeFields(l, r, isObj(b) ? b : {});
  if (Array.isArray(l) && Array.isArray(r)) return mergeArray(l, r, Array.isArray(b) ? b : []);
  return l;
}

function mergeFields(l, r, b) {
  const out = {};
  const keys = new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(b)]);
  for (const k of keys) {
    const inL = k in l, inR = k in r, inB = k in b;
    if (inL && inR) out[k] = mergeValue(l[k], r[k], b[k]);
    else if (inL && !inR) {
      // הוסר בצד השני: אם המשתמש לא שינה אותו — מכבדים את ההסרה.
      if (!(inB && same(l[k], b[k]))) out[k] = l[k];
    } else if (!inL && inR) {
      // הוסר אצל המשתמש: אם הצד השני לא שינה אותו — נשאר מוסר.
      if (!(inB && same(r[k], b[k]))) out[k] = deepCopy(r[k]);
    }
  }
  return out;
}

/** מערך: לפי id אם יש, אחרת לפי תוכן (יומן הטיפול, רשימות פשוטות). */
function mergeArray(l, r, b) {
  if (hasIds(l) || hasIds(r) || hasIds(b)) return mergeById(l, r, b).result;
  if (same(l, b)) return deepCopy(r);
  if (same(r, b)) return l;
  // שניהם שינו מערך בלי מזהים: מה שהמשתמש מחק מה-baseline נשאר מחוק, ומה
  // שהצד השני הוסיף (ולא היה ב-baseline) מצטרף.
  const baseSet = new Set(b.map(stable));
  const localSet = new Set(l.map(stable));
  const out = l.slice();
  for (const item of r) {
    const s = stable(item);
    if (!baseSet.has(s) && !localSet.has(s)) { out.push(deepCopy(item)); localSet.add(s); }
  }
  return out;
}

function mergeById(l, r, b, stats) {
  const byId = (arr) => new Map((arr || []).filter(x => isObj(x) && x.id).map(x => [x.id, x]));
  const L = byId(l), R = byId(r), B = byId(b);
  const result = [];
  for (const item of l || []) {
    if (!isObj(item) || !item.id) { result.push(item); continue; }
    const id = item.id;
    if (R.has(id)) {
      const merged = B.has(id) ? mergeValue(item, R.get(id), B.get(id)) : mergeValue(item, R.get(id), {});
      if (stats && !same(merged, item)) stats.updated++;
      result.push(merged);
    } else if (B.has(id)) {
      // נמחק בצד השני. נשאר רק אם המשתמש ערך אותו מאז הטעינה.
      if (!same(item, B.get(id))) result.push(item);
      else if (stats) stats.removed++;
    } else {
      result.push(item); // חדש אצל המשתמש
    }
  }
  // נוספו בצד השני (ולא היו ב-baseline). מה שהיה ב-baseline וחסר מקומית —
  // המשתמש מחק אותו, ונשאר מחוק.
  const added = [];
  for (const item of r || []) {
    if (!isObj(item) || !item.id) continue;
    if (!L.has(item.id) && !B.has(item.id)) added.push(deepCopy(item));
  }
  if (stats) stats.added += added.length;
  return { result: added.concat(result) };
}

// מספרי לקוח הם מזהה עסקי שמודפס על מסמכים — שני לקוחות עם אותו מספר
// אסורים. אם המיזוג חושף התנגשות, הלקוח שהמשתמש יצר בסשן הזה (לא היה
// ב-baseline ולא בשרת) מקבל מספר חדש, יחד עם תתי-המספרים של התיקים שלו.
function fixDuplicateClientNumbers(local, remote, baseline, renumbered) {
  const remoteIds = new Set((remote.clients || []).map(c => c && c.id));
  const baseIds = new Set((baseline.clients || []).map(c => c && c.id));
  const counters = local.counters || (local.counters = { nextClientNumber: 1, caseCounters: {} });
  const taken = new Map();
  for (const c of local.clients || []) {
    if (!c || !c.clientNumber) continue;
    const mine = !remoteIds.has(c.id) && !baseIds.has(c.id);
    if (!taken.has(c.clientNumber)) { taken.set(c.clientNumber, c); continue; }
    // התנגשות: מחליפים את זה שנוצר מקומית (אם שניהם כאלה — את השני).
    const victim = mine ? c : taken.get(c.clientNumber);
    if (victim !== c) taken.set(c.clientNumber, c);
    const maxNum = Math.max(0, ...(local.clients || []).map(x => parseInt(x && x.clientNumber) || 0));
    counters.nextClientNumber = Math.max(Number(counters.nextClientNumber) || 1, maxNum + 1);
    const oldNum = victim.clientNumber;
    victim.clientNumber = String(counters.nextClientNumber++);
    for (const cs of local.cases || []) {
      if (cs && cs.client === victim.id && typeof cs.caseSubNumber === 'string' && cs.caseSubNumber.startsWith(oldNum + '/')) {
        cs.caseSubNumber = victim.clientNumber + cs.caseSubNumber.slice(oldNum.length);
      }
    }
    renumbered.push({ name: victim.name || '', from: oldNum, to: victim.clientNumber });
    taken.set(victim.clientNumber, victim);
  }
}

function mergeCounters(l, r) {
  const out = isObj(l) ? { ...l } : {};
  const rr = isObj(r) ? r : {};
  out.nextClientNumber = Math.max(Number(out.nextClientNumber) || 1, Number(rr.nextClientNumber) || 1);
  const cc = { ...(isObj(out.caseCounters) ? out.caseCounters : {}) };
  for (const [k, v] of Object.entries(isObj(rr.caseCounters) ? rr.caseCounters : {})) {
    cc[k] = Math.max(Number(cc[k]) || 0, Number(v) || 0);
  }
  out.caseCounters = cc;
  return out;
}

/**
 * ממזג את remote לתוך local (מוטציה במקום: local הוא אובייקט ה-db הגלובלי
 * וה-UI מחזיק אליו הפניה).
 *
 * @returns {{added:number, updated:number, removed:number, renumbered:Array<{name,from,to}>}}
 */
export function mergeDb(local, remote, baseline) {
  const stats = { added: 0, updated: 0, removed: 0, renumbered: [] };
  if (!local || !remote) return stats;
  const base = baseline || {};

  for (const key of MERGEABLE_COLLECTIONS) {
    const l = Array.isArray(local[key]) ? local[key] : [];
    const r = Array.isArray(remote[key]) ? remote[key] : [];
    const b = Array.isArray(base[key]) ? base[key] : [];
    local[key] = mergeById(l, r, b, stats).result;
  }

  local.counters = mergeCounters(local.counters, remote.counters);

  // efilingBundles: מפה caseId → רשימת הגשות. כל רשימה מתמזגת לפי id.
  const lb = isObj(local.efilingBundles) ? local.efilingBundles : {};
  const rb = isObj(remote.efilingBundles) ? remote.efilingBundles : {};
  const bb = isObj(base.efilingBundles) ? base.efilingBundles : {};
  const eb = {};
  for (const cid of new Set([...Object.keys(lb), ...Object.keys(rb)])) {
    const merged = mergeValue(lb[cid], rb[cid], bb[cid]);
    if (merged !== undefined && merged !== null) eb[cid] = merged;
  }
  local.efilingBundles = eb;

  // כל מפתח עליון אחר (settings וכל מה שיתווסף) — מיזוג שדה-שדה.
  const handled = new Set([...MERGEABLE_COLLECTIONS, 'counters', 'efilingBundles']);
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    if (handled.has(key)) continue;
    if (key in remote && key in local) local[key] = mergeValue(local[key], remote[key], base[key]);
    else if (key in remote && !(key in base)) local[key] = deepCopy(remote[key]);
  }

  fixDuplicateClientNumbers(local, remote, base, stats.renumbered);
  return stats;
}

/**
 * תאימות לאחור: הגרסה הקודמת מיזגה רק תוספות. נשארת לשימוש של קוד ישן,
 * ומחזירה את מספר הפריטים שנוספו.
 */
export function mergeRemoteAdditions(local, remote, baseline) {
  if (!local || !remote || !baseline) return 0;
  return mergeDb(local, remote, baseline).added;
}
