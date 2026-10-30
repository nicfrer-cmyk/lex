# LexTrack — הנחיות לפרויקט

## מה זה
LexTrack היא מערכת לניהול תיקים במשרד עורכי דין ישראלי (הוצאה לפועל, גבייה, חדלות פירעון וליטיגציה כללית). היא מפיקה מסמכים משפטיים באופן אוטומטי. המטרה: SaaS למשרדי עורכי דין בישראל.
המחיר שנקבע: ₪97 לחודש למשרד, עד 20GB אחסון, ו-14 ימי ניסיון.

## סטאק
- **צד לקוח:** HTML/JS בלי framework (`src/`). נבנה עם `build.mjs` ו-esbuild לתיקייה `dist/`, ומתארח ב-Netlify (`https://zesty-marigold-0edcb2.netlify.app/`).
- **שרת:** Supabase (פרויקט `syxutnwbpjsvzlwfpvyc`): Auth, Postgres עם RLS, Storage (bucket בשם `documents`) ו-Edge Functions ב-Deno/TypeScript.
- **דסקטופ:** Electron (`main.js`) הוא רק חלון שטוען את האתר החי. אין בו preload ואין IPC.
- **מובייל:** Capacitor לאנדרואיד (`android/`), במצב remote URL שטוען את אותו אתר.
- **מסמכים:** `docxtemplater` ו-`pizzip` למילוי תבניות. `docx` (קיים, אבל מיועד לצמצום, ראו עקרונות). `mammoth` לתצוגה מקדימה. `pdf-lib` ו-`pdfjs-dist` ל-PDF.
- **AI:** Anthropic Claude, תמיד דרך ה-Edge Function בשם `ai-proxy`. אסור לקרוא ל-Anthropic מהלקוח.
- **שירות קולי:** `services/voice-gateway` (Asterisk, Python ו-Docker), שמחובר למרכז השיחות.

## מבנה תיקיות
```
src/                  קוד הלקוח (מקור אמת)
  app.html            markup ו-CSS. ‏build.mjs מזריק אליו את תגי ה-script
  app.js              הלוגיקה הראשית: תיקים, לקוחות, הפקת מסמכים, סוכן AI
  platform.web.js     שכבת Platform מעל Supabase (נטען ראשון, ומגדיר את window.Buffer)
  db-merge.js         מיזוג תלת-כיווני של הבלוב (שמירה בטוחה מול כותבים מקבילים)
  practice.js         ליטיגציה, חוזים, מחשבון מועדים, חיוב ושעות, "השבוע במשרד"
  auth.js             התחברות והרשמה
  ai-center.js, automations.js, call-center.js   מרכז ה-AI, מרכז האוטומציות, מרכז השיחות
  template-manager.js מסך ניהול תבניות
  legal-content.js    תנאי שימוש ומדיניות פרטיות
  supabase-config.js  URL ומפתח anon ציבורי בלבד
supabase/functions/   ‏Edge Functions (ai-proxy, ai-gateway, call-center, grow-webhook ועוד)
supabase/functions/_shared/  קוד משותף לפונקציות
supabase/migrations/  מיגרציות (המערכת המחייבת לשינויים חדשים)
supabase-schema*.sql  סכימה היסטורית וקבצי fix1–fix17 (כולם כבר הורצו. לא להוסיף חדשים כאן)
services/voice-gateway/  שער הטלפוניה הקולי
test/                 בדיקות node:test
docs/                 תיעוד מרכז ה-AI ומרכז השיחות
dist/, www/           פלט בנייה (לא לערוך ידנית)
```

## פקודות
```bash
npm install
npm test                                   # כל הבדיקות (node --test)
npm run build                              # בונה את dist/
npm start                                  # Electron (טוען את האתר החי, לא את dist המקומי)
supabase db push                           # הרצת מיגרציות
supabase functions deploy <name>           # פריסת פונקציה (לחלק מהן נדרש --no-verify-jwt, ראו docs/AI_CENTER_DEPLOYMENT.md)
supabase secrets set KEY=value             # סודות שרת (ANTHROPIC_API_KEY ועוד, ראו .env.example)
npx cap sync android                       # סנכרון אנדרואיד
```
- הפריסה ל-Netlify קורית אוטומטית מ-Git (`netlify.toml`).
- **אריזת Electron:** אין כרגע כלי אריזה (electron-builder או forge). זו משימה פתוחה.

## עקרונות ארכיטקטורה (מחייבים)
1. **התבניות מבוססות על מסמכים אמיתיים.** כל מסמך משפטי מופק מתבנית docx שנוצרה ממסמך אמיתי של המשרד. לא בונים את המבנה או העיצוב של המסמך בקוד. כך העיצוב המקורי נשמר במלואו.
2. **הפרדה מוחלטת בין עיצוב לתוכן:**
   - docxtemplater אחראי על כל העיצוב, דרך התבנית.
   - ה-AI מייצר רק טקסט נרטיבי: עובדות, טיעון משפטי וסעדים מבוקשים.
   - ה-AI מחזיר JSON מובנה בלבד, שהמפתחות שלו הם שמות הפלייסהולדרים. אין בו עיצוב, Markdown או סמנים. שדה מסוג רשימה הוא מערך מחרוזות שמוצג בלולאה `{{#x}}…{{/x}}`.
   - המימוש המייצג: `rqGenerate()` ו-`loadRequestSpecs()` ב-`src/app.js`, יחד עם זוגות של `<name>.docx` ו-`<name>.spec.json` בתיקיית Storage בשם "תבניות".
3. **`merge_runs.py` רץ לפני כל עבודה עם תבנית**, כדי שהפלייסהולדרים לא יתפצלו בין XML runs. בדפדפן התפקיד הזה ממומש כך: docxtemplater מאחד פלייסהולדרים שהתפצלו בין runs באותה פסקה, ו-`extractDocxPlaceholders` מקמפל ובודק כל תבנית (כולל header ו-footer) כבר בזמן הייבוא. כל מילוי תבנית עובר דרך `renderDocxTemplate`.
4. **תמיד לטפל במקרי קצה:**
   - יומן ריק: לבקש אישור ולהמשיך על בסיס נתוני התיק בלבד.
   - שדות חסרים: לעצור ולהציג למשתמש את רשימת השדות החסרים.
   - JSON שבור מה-AI: לנקות backticks, לנסות שוב פעם אחת עם הודעת תיקון, ואם זה נכשל לא ליצור קובץ.
   - בלי חיבור לאינטרנט: הודעה ברורה בעברית, ושום פעולה לא נכשלת בשקט.
5. **סודות:** מפתחות API (Anthropic, Grow, WhatsApp, Google) נשמרים רק כ-Supabase secrets ונקראים רק ב-Edge Functions. בצד הלקוח מותר רק מפתח ה-anon הציבורי. לעולם לא להכניס את מפתח ה-service_role ל-repo.
6. **ריבוי משרדים:**
   - כל נתון שייך ל-`office_id`, ו-RLS הוא ההגנה האמיתית. בדיקה בממשק בלבד אינה הרשאה.
   - פרטי המשרד (שם, רישיון, כתובת וכו') נטענים מטבלת `offices`, ואסור לכתוב אותם בקוד.
7. **XSS:** כל קלט של משתמש שנכנס ל-innerHTML עובר דרך `escapeHtml()`.

## סטנדרט עיצוב למסמכים
- גופן David, בגודל 12.
- כותרת בגודל 16, ממורכזת, עם קו תחתון.
- יישור לשני הצדדים (justified), RTL/bidi.
- ריווח שורות 1.15 (`line: 276`).
- שוליים של 2.5 ס"מ מכל צד (1418 twips).
- מספור עשרוני אוטומטי (`%1.`) עם הזחה תלויה.
- טבלת כותרת (צדדים): RTL, בלי גבולות, `visuallyRightToLeft: true`.
- את הסטנדרט הזה מיישמים **בתבנית ה-docx עצמה**, לא בקוד.

## מע"מ
18%. זו ברירת המחדל, וכל משרד יכול לשנות אותה (`offices.vat_rate`, המשתנה `officeVatRate` ב-`app.js`). לא לכתוב שיעור קבוע בקוד.

## מודלים
- מסמכים וניסוח: `claude-sonnet-4-6`.
- משימות קלות: `claude-haiku-4-5-20251001`.
- שינוי מודל נעשה במקום אחד, ונבדק מול התמחור שב-`ai-proxy`.

## כללי עבודה
- **לסרוק לפני כל שינוי:** לקרוא את הקוד הרלוונטי ואת מקומות הקריאה לו לפני שעורכים.
- **לעבוד בשלבים:** בסוף כל שלב לעצור, לדווח ולחכות לאישור מפורש. לא לשנות קוד בלי אישור.
- **לדווח בעברית.**
- **לבצע commit אחרי כל שלב שאושר**, בענף ייעודי ולא ישירות על `master`.
- לא לבצע push בלי בקשה מפורשת.
- להריץ `npm test` לפני כל commit. בדיקה חדשה מתווספת לכל תיקון באג.
- מיגרציות חדשות נכנסות רק ל-`supabase/migrations/`.

## מצב נוכחי ומשימות פתוחות (עודכן 30.10.2026, בסוף שלבים א'–ו')
**Git:** `master` (על `adb000d`) הוא הענף החי, ונטליפיי מפרסם ממנו. `feature/ai-call-center` גובה ל-GitHub אבל לא מוזג (ראו למטה). העותק ב-`OneDriveDesktopLexTrack` ישן.

**מה הושלם היום** (פירוט בהיסטוריית ה-Git):
- **א':** הגנה מפני דריסת נתוני המשרד בבלוב ריק; הקשחת `ai-proxy`; WebDAV ו-`read_document` מוגבלים לתיקיית המשרד; מיגרציית RLS.
- **ב':** שמירה עם בדיקת גרסה ומיזוג תלת-כיווני ברמת השדה (`src/db-merge.js`); מחיקות בטוחות (תיק עם רישומים כספיים עובר לארכיון ולא נמחק); שחזור גרסאות (`app_data_history`); תיקון כרטסת הנאמנות.
- **ג':** XSS (`jsArg`/`safeToken`/`sanitizeDocHtml`); כותרות אבטחה ב-`dist/_headers`; Electron מוגבל לאתר; בטיחות AI.
- **ד':** פרטי המשרד במסמכים לכל משרד (`db.settings.officeProfile`); `renderDocxTemplate` אחיד; הפקה לפי סוג הערכאה.
- **ה':** שמירות מאוחדות; `platform.js` מוקטן; cache ל-vendor; CI ב-GitHub Actions.
- **ו':** ליטיגציה וחוזים, צדדים, מחשבון מועדים, חיוב ושעות, "השבוע במשרד", גרסאות מסמכים (`src/practice.js`).

**ממתין לבעלים** (פירוט ב-`docs/DEPLOY_RUNBOOK_HE.md`):
- [ ] להריץ ב-SQL Editor את `20261030000000_stage_a_security.sql` ואת `20261030000001_stage_b_restore.sql`. **שלב א' לא רץ בייצור.**
- [ ] לפרוס את Edge Functions: webdav, ai-gateway, ai-comms, ai-cron, ai-worker, ai-learn, webhook-whatsapp, automation-engine.
- [ ] לעבור מ-CSP במצב Report-Only ל-CSP נאכף, אחרי שמוודאים בקונסול שאין הפרות.

**משימות פתוחות:**
- [ ] **מרכז השיחות:** לבסס את `feature/ai-call-center` מחדש על `master` (התנגשויות במנגנון השמירה); לתקן את SEC-2 (חתימת HMAC בלי מזהה משרד) ואת ה-API הפתוח של שער הקול.
- [ ] **מודל נתונים:** פירוק הבלוב לטבלאות עם RLS לפי תפקיד (המזכירה מוגבלת היום רק בממשק). התוכנית נמצאת בדוח הארכיטקטורה של הסריקה.
- [ ] **חשבוניות מס:** חיבור לספק (חשבונית ירוקה / iCount / Grow). היום המערכת מפיקה "דרישת תשלום" בלבד.
- [ ] **חתימה דיגיטלית:** דורשת ספק חיצוני; טבלת הגרסאות כבר מוכנה לכך.
- [ ] **Grow:** חסרים `GROW_USER_ID` ו-`GROW_PAGE_CODE`; ה-webhook לא מאומת מול Grow.
- [ ] **אבטחת חשבון:** MFA, וסיסמה מינימלית ארוכה מ-6 תווים.
- [ ] **מחשבון המועדים:** להרחיב לחגים ולפגרות פסח וסוכות, ולמועדי הוצאה לפועל, אחרי אימות משפטי.
