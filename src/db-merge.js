// מיזוג three-way של ה-blob — הפונקציה שמונעת אובדן נתונים.
//
// ## הבעיה שנמדדה בייצור
// כל ה-CRM הוא ערך jsonb יחיד, ו-`Platform.saveDB` כתב אותו כולו בלי
// לבדוק אם השתנה מאז הטעינה. כל עוד רק המשתמש כתב זה עבד. מרגע שהסוכן
// הקולי מוסיף משימות מהשרת, כל שמירה מהדפדפן מחקה בשקט את מה שנוצר
// בינתיים: 3 מתוך 4 בקשות חזרה שנוצרו מ-ElevenLabs נעלמו, ו-call_actions
// רשם "success" על משימות שכבר לא היו קיימות.
//
// ## הכלל
//   פריט שיש בשרת ולא היה ב-baseline  → מישהו אחר הוסיף אותו   → שומרים
//   פריט שהיה ב-baseline ואינו מקומי   → המשתמש מחק אותו        → נשאר מחוק
//   כל השאר                            → העותק המקומי סמכותי
//
// ⚠ ה-baseline הוא מה שהופך את זה לנכון. בלעדיו, "מה שיש בשרת ואין
// מקומית" היה מחזיר לחיים כל פריט שהמשתמש הרגע מחק.
//
// קובץ נפרד ולא פונקציה בתוך platform.web.js: זו הלוגיקה שמחליטה אילו
// נתונים שורדים במשרד עורכי דין, והיא חייבת להיבדק ישירות. platform.web.js
// מייבא אותה (esbuild מאגד), והבדיקות מייבאות את אותו קובץ בדיוק.

/**
 * הקולקציות שממוזגות לפי id — כל מה שהסוכן הקולי ומנוע האוטומציות
 * יכולים להוסיף מהשרת.
 *
 * ⚠ `settings` ו-`counters` **אינם** כאן במכוון: הם אובייקטים ולא
 * מערכים, ומיזוג לפי id חסר משמעות עבורם. המשתמש סמכותי עליהם.
 */
export const MERGEABLE_COLLECTIONS = [
  'tasks', 'leads', 'events', 'clients', 'cases',
  'docs', 'payments', 'timeEntries', 'trustTransactions',
];

/**
 * מחזיר לתוך `local` פריטים שנוספו ב-`remote` מאז `baseline`.
 * מוטציה במקום — `local` הוא אובייקט ה-db הגלובלי וה-UI מחזיק אליו הפניה.
 *
 * @returns מספר הפריטים שמוזגו
 */
export function mergeRemoteAdditions(local, remote, baseline) {
  if (!local || !remote || !baseline) return 0;
  let merged = 0;

  for (const key of MERGEABLE_COLLECTIONS) {
    const remoteArr = Array.isArray(remote[key]) ? remote[key] : [];
    if (!remoteArr.length) continue;

    const baseIds = new Set((Array.isArray(baseline[key]) ? baseline[key] : [])
      .map(x => x && x.id).filter(Boolean));
    if (!Array.isArray(local[key])) local[key] = [];
    const localIds = new Set(local[key].map(x => x && x.id).filter(Boolean));

    for (const item of remoteArr) {
      if (!item || !item.id) continue;
      // היה כבר ב-baseline → העותק המקומי סמכותי עליו, כולל מחיקה.
      if (baseIds.has(item.id)) continue;
      if (localIds.has(item.id)) continue;
      // נוצר בשרת אחרי הטעינה — למשל בקשת חזרה שהסוכן הקולי פתח.
      local[key].unshift(item);
      merged++;
    }
  }
  return merged;
}

export const deepCopy = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
