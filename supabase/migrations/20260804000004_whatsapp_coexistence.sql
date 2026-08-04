-- ============================================================================
-- WhatsApp Coexistence — תיקון אינדקס לצורך upsert על הודעות
-- ============================================================================
--
-- הרקע: webhook-whatsapp קולט מעכשיו גם `message_echoes` — הודעות שנשלחו
-- מאפליקציית WhatsApp Business בטלפון. Meta שולחת echo גם על הודעה שהמערכת
-- עצמה שלחה דרך ה-API, ולכן הכתיבה חייבת להיות upsert לפי
-- external_message_id, אחרת אותה הודעה מופיעה פעמיים במסך.
--
-- ⚠ והנה הבעיה: comm_messages_external_uniq הוגדר כאינדקס **חלקי**
-- (`where external_message_id is not null`). Postgres אינו יכול להסיק
-- אינדקס חלקי מרשימת עמודות ב-ON CONFLICT, ולכן כל upsert היה נכשל
-- ב-42P10 — גם כשאין שום התנגשות. כלומר: כל הודעה שהיית שולח מהטלפון
-- הייתה נעלמת בשקט.
--
-- (זו הפעם השנייה שהדפוס הזה מופיע בפרויקט. הראשונה הייתה
-- ai_learning_insights_dedupe, ותוקנה באותו אופן.)
--
-- הסרת ה-WHERE אינה משנה את הסמנטיקה: ב-unique index ערכי NULL נחשבים
-- שונים זה מזה כברירת מחדל, ולכן מספר בלתי מוגבל של שורות ללא
-- external_message_id עדיין מותר — בדיוק כמו קודם.
-- ============================================================================

drop index if exists public.comm_messages_external_uniq;
create unique index if not exists comm_messages_external_uniq
  on public.communication_messages(office_id, channel, external_message_id);


-- ============================================================
-- אינדקס לתיבה האחודה
-- ============================================================
-- מסך התקשורת ומנוע האוטומציות שניהם שולפים הודעות לפי שרשור בסדר כרונולוגי.
-- comm_messages_thread_idx כבר מכסה זאת. מה שחסר הוא איתור שרשור לפי
-- המספר — הנתיב שכל webhook נכנס עובר בו, פעמיים לכל הודעה.
create index if not exists comm_threads_participant_idx
  on public.communication_threads(office_id, channel, participant_identifier);
