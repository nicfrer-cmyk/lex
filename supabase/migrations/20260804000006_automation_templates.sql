-- ============================================================================
-- קטלוג תבניות האוטומציה
-- ============================================================================
--
-- ## עיקרון: תבנית לא מוצעת אם היא לא יכולה לעבוד
--
-- המפרט מבקש עשרות אוטומציות שמניחות ישויות שאינן קיימות במערכת הזו —
-- חשבוניות, הוצאות, עובדים, שדה "אחראי". תבנית כזו נשמרת בקטלוג עם
-- `requires`, מוצגת במסך כ"דורש הרחבה", ו**לא ניתנת להדלקה**.
--
-- זו החלופה הישרה לשתי האפשרויות הגרועות: מתג שנראה פעיל ולא עושה כלום
-- (סעיף 35 אוסר), או מחיקת התבנית — שהייתה מאבדת את הידע שהיא קיימת
-- ומחייבת לגלות אותה מחדש כשהישות תיווצר.
--
-- ## מה נבדק בפועל לפני כתיבת הקובץ
-- app_data.data מכיל: cases, clients, tasks, events, docs, payments,
-- timeEntries, trustTransactions, counters, settings, efilingBundles.
-- **אין** invoices, expenses, employees, leads (במשרד שנבדק), ואין שדה
-- אחראי באף ישות.
-- ============================================================================

insert into public.automation_templates (
  key, name, description, category, trigger_type,
  default_trigger_config, default_conditions, default_actions,
  default_severity, default_execution_level, default_cooldown_minutes,
  estimated_minutes_saved, requires
)
values

-- ============================================================
-- תיקים — עובד על נתונים אמיתיים
-- ============================================================
('matter_inactive',
 'תיק ללא פעילות',
 'תיק פעיל שלא נרשמה בו פעילות ביומן מעל 14 יום. פותח משימת בדיקה ומתריע לאחראי.',
 'תיקים', 'matter_inactive',
 '{"days":14}', '[]',
 '[{"type":"notify","level":"warning","title":"תיק ללא פעילות: {{subject.data.name}}","body":"{{reason}}"},
   {"type":"create_task","text":"לבדוק את התיק {{subject.data.name}} — אין פעילות מעל 14 יום","due_in_days":3,"priority":"normal"}]',
 'normal', 'notify', 4320, 12, '{}'),

('matter_no_next_action',
 'תיק ללא פעולה עתידית',
 'תיק פעיל שאין בו אף משימה פתוחה ואף מועד עתידי. אף אחד לא יודע מה הצעד הבא.',
 'תיקים', 'matter_no_next_action',
 '{}', '[]',
 '[{"type":"notify","level":"warning","title":"אין פעולה הבאה: {{subject.data.name}}","body":"{{reason}}"},
   {"type":"create_task","text":"לקבוע את הצעד הבא בתיק {{subject.data.name}}","due_in_days":5}]',
 'normal', 'notify', 10080, 10, '{}'),

('matter_incomplete',
 'תיק חדש עם פרטים חסרים',
 'תיק שנפתח ב-30 הימים האחרונים וחסרים בו לקוח, מספר, ערכאה, הסכם שכר טרחה או מסמכי פתיחה.',
 'תיקים', 'matter_incomplete',
 '{"opened_within_days":30}', '[]',
 '[{"type":"create_task","text":"להשלים פרטים בתיק {{subject.data.name}}: {{subject.data.missingList}}","due_in_days":7,"priority":"high"},
   {"type":"notify","level":"info","title":"תיק לא הושלם: {{subject.data.name}}","body":"חסר: {{subject.data.missingList}}"}]',
 'normal', 'notify', 10080, 15, '{}'),

('matter_high_value_idle',
 'תיק בסכום גבוה ללא פעילות',
 'תיק מעל ₪50,000 שלא נגעו בו מעל שבוע. אותה בדיקה כמו "תיק ללא פעילות" אבל בסף מחמיר יותר.',
 'תיקים', 'matter_inactive',
 '{"days":7}',
 '[{"field":"amount","op":"gte","value":50000}]',
 '[{"type":"notify","level":"urgent","title":"תיק בסכום גבוה ללא טיפול: {{subject.data.name}}","body":"{{reason}}"},
   {"type":"escalate","title":"{{subject.data.name}} — ₪{{subject.data.amount}}"}]',
 'high', 'notify', 2880, 15, '{}'),

-- ============================================================
-- משימות
-- ============================================================
('task_overdue',
 'משימה באיחור',
 'משימה שעבר מועד היעד שלה ולא סומנה כהושלמה.',
 'משימות', 'task_overdue',
 '{"min_days_late":1}', '[]',
 '[{"type":"notify","level":"warning","title":"משימה באיחור {{subject.data.daysLate}} ימים","body":"{{subject.data.text}} — תיק {{subject.data.caseName}}"}]',
 'normal', 'notify', 1440, 3, '{}'),

('task_overdue_severe',
 'משימה באיחור חמור',
 'משימה שבאיחור של מעל שבוע. מסלימה לבעל המשרד ומעלה את עדיפות המשימה.',
 'משימות', 'task_overdue',
 '{"min_days_late":7}', '[]',
 '[{"type":"escalate","title":"משימה באיחור {{subject.data.daysLate}} ימים: {{subject.data.text}}"},
   {"type":"set_task_priority","priority":"urgent"}]',
 'high', 'auto', 4320, 5, '{}'),

('task_due_soon',
 'משימה שמתקרבת למועד',
 'משימה שמועד היעד שלה בתוך יומיים.',
 'משימות', 'task_due_soon',
 '{"days":2}', '[]',
 '[{"type":"notify","level":"info","title":"מועד מתקרב: {{subject.data.text}}","body":"בעוד {{subject.data.daysUntil}} ימים — תיק {{subject.data.caseName}}"}]',
 'low', 'notify', 1440, 2, '{}'),

('task_no_due_date',
 'משימה ללא תאריך יעד',
 'משימה פתוחה בלי מועד — כלומר לא תופיע בשום תזכורת ואף אחד לא ייזכר בה.',
 'משימות', 'task_no_due_date',
 '{}', '[]',
 '[{"type":"notify","level":"info","title":"משימה ללא מועד: {{subject.data.text}}","body":"כדאי לקבוע תאריך יעד כדי שהיא תופיע בתזכורות."}]',
 'low', 'notify', 10080, 2, '{}'),

-- ============================================================
-- מועדים ודיונים
-- ============================================================
('event_approaching',
 'מועד או דיון מתקרב',
 'אירוע ביומן בתוך 7 ימים. בודק גם אם יש משימת הכנה ומסמכים בתיק.',
 'מועדים', 'event_approaching',
 '{"days":7}', '[]',
 '[{"type":"notify","level":"warning","title":"{{subject.data.type}} בעוד {{subject.data.daysUntil}} ימים","body":"{{subject.data.title}} — תיק {{subject.data.caseName}}"}]',
 'high', 'notify', 1440, 5, '{}'),

('event_without_prep_task',
 'דיון ללא משימת הכנה',
 'דיון מתקרב שאין בתיק שלו אף משימה פתוחה. פותח משימת הכנה.',
 'מועדים', 'event_without_prep_task',
 '{"days":14}', '[]',
 '[{"type":"create_task","text":"הכנה ל{{subject.data.type}}: {{subject.data.title}}","due_in_days":3,"priority":"high"},
   {"type":"notify","level":"warning","title":"אין משימת הכנה ל{{subject.data.title}}","body":"{{reason}}"}]',
 'high', 'notify', 2880, 12, '{}'),

('event_passed_unmarked',
 'מועד שעבר ללא תיעוד',
 'אירוע שתאריכו עבר ולא נרשמה אחריו שום פעילות ביומן התיק.',
 'מועדים', 'event_passed_unmarked',
 '{"grace_days":1}', '[]',
 '[{"type":"escalate","title":"מועד שעבר ללא תיעוד: {{subject.data.title}}"},
   {"type":"create_task","text":"לתעד מה קרה ב{{subject.data.title}} ({{subject.data.date}})","due_in_days":1,"priority":"urgent"}]',
 'critical', 'notify', 2880, 10, '{}'),

('event_conflict',
 'התנגשות ביומן',
 'שני אירועים או יותר באותו יום ובאותה שעה.',
 'מועדים', 'event_conflict',
 '{}', '[]',
 '[{"type":"notify","level":"urgent","title":"התנגשות ביומן","body":"{{subject.data.date}} {{subject.data.time}} — {{subject.data.titles}}"}]',
 'critical', 'notify', 1440, 8, '{}'),

-- ============================================================
-- מסמכים
-- ============================================================
('document_unlinked',
 'מסמך שלא שויך לתיק',
 'מסמך שהועלה ולא נקשר לאף תיק — למעשה אבוד במערכת.',
 'מסמכים', 'document_unlinked',
 '{}', '[]',
 '[{"type":"notify","level":"info","title":"מסמך ללא תיק: {{subject.data.name}}","body":"יש לשייך אותו לתיק כדי שיימצא."}]',
 'normal', 'notify', 10080, 4, '{}'),

('document_unanalyzed',
 'מסמך חדש — ניתוח AI',
 'מסמך שהועלה וטרם נותח. מפעיל סוכן שיחלץ תאריכים, סכומים וצדדים. זו התבנית היחידה כאן שעולה כסף.',
 'מסמכים', 'document_unanalyzed',
 '{}', '[]',
 '[{"type":"invoke_agent","agent":"document-analysis","job_type":"analyze_document",
    "goal":"נתח את המסמך, חלץ תאריכים סכומים וצדדים, ואתר מועדים עם ציטוט מקור","priority":4}]',
 'normal', 'prepare', 1440, 20, '{}'),

-- ============================================================
-- לקוחות ותקשורת
-- ============================================================
('client_no_update',
 'לקוח שלא קיבל עדכון',
 'לקוח עם תיק פעיל שלא נרשמה בו פעילות מעל 30 יום.',
 'לקוחות', 'client_no_update',
 '{"days":30}', '[]',
 '[{"type":"create_task","text":"לעדכן את {{subject.data.name}} על מצב התיקים","due_in_days":3},
   {"type":"notify","level":"warning","title":"לקוח ללא עדכון: {{subject.data.name}}","body":"{{subject.data.idleDays}} ימים ללא פעילות ב-{{subject.data.activeCases}} תיקים"}]',
 'normal', 'notify', 20160, 15, '{}'),

('thread_no_reply',
 'הודעה ללא מענה',
 'הודעה נכנסת בוואטסאפ או במייל שלא נענתה מעל 4 שעות.',
 'תקשורת', 'thread_no_reply',
 '{"hours":4,"channels":["whatsapp","email","sms"]}', '[]',
 '[{"type":"notify","level":"urgent","title":"ללא מענה {{subject.data.waitedHours}} שעות","body":"{{subject.data.participant_name}}"}]',
 'high', 'notify', 240, 6, '{}'),

-- ============================================================
-- ניהול
-- ============================================================
('daily_digest',
 'סיכום בוקר',
 'כל בוקר ב-08:00: דיונים היום, משימות באיחור, תיקים בסיכון.',
 'ניהול', 'daily_digest',
 '{"hour":8}', '[]',
 '[{"type":"notify","level":"info","title":"סיכום הבוקר",
    "body":"{{subject.data.todayEvents}} אירועים היום · {{subject.data.todayTasks}} משימות להיום · {{subject.data.overdueTasks}} באיחור · {{subject.data.stuckCases}} תיקים תקועים"}]',
 'normal', 'notify', 720, 15, '{}'),

-- ============================================================
-- ⛔ תבניות שדורשות ישויות שאינן קיימות
-- ============================================================
-- נשמרות בקטלוג, מוצגות כ"דורש הרחבה", לא ניתנות להדלקה.
('matter_stuck_in_stage',
 'תיק תקוע באותו שלב',
 'תיק שנשאר באותו שלב מעל 30 יום. דורש שהמערכת תתעד מתי השלב השתנה.',
 'תיקים', 'matter_stuck_in_stage',
 '{"days":30}', '[]',
 '[{"type":"notify","level":"warning","title":"תקוע בשלב {{subject.data.stage}}","body":"{{subject.data.daysInStage}} ימים"}]',
 'normal', 'notify', 4320, 8, '{case.stageChangedAt}'),

('task_no_assignee',
 'משימה ללא אחראי',
 'משימה פתוחה שלא הוקצתה לאיש. דורש שדה אחראי במשימות — אינו קיים היום.',
 'משימות', 'task_no_due_date',
 '{}', '[]',
 '[{"type":"notify","level":"warning","title":"משימה ללא אחראי","body":"{{subject.data.text}}"}]',
 'normal', 'notify', 4320, 4, '{task.assignee}'),

('invoice_overdue',
 'חשבונית שלא שולמה',
 'חשבונית שעבר מועד התשלום שלה. דורש מודול חשבוניות — אינו קיים היום.',
 'כספים', 'matter_inactive',
 '{}', '[]',
 '[{"type":"notify","level":"warning","title":"חשבונית באיחור"}]',
 'high', 'notify', 4320, 10, '{invoices}'),

('trust_balance_mismatch',
 'אי-התאמה בחשבון נאמנות',
 'יתרת הנאמנות אינה תואמת לסכום הפעולות. דורש רישום תנועות נאמנות — הטבלה קיימת אך ריקה.',
 'נאמנות', 'matter_inactive',
 '{}', '[]',
 '[{"type":"escalate","title":"אי-התאמה בחשבון נאמנות"}]',
 'critical', 'notify', 1440, 30, '{trustTransactions}')

on conflict (key) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  trigger_type = excluded.trigger_type,
  default_trigger_config = excluded.default_trigger_config,
  default_actions = excluded.default_actions,
  requires = excluded.requires,
  estimated_minutes_saved = excluded.estimated_minutes_saved,
  version = public.automation_templates.version + 1,
  updated_at = now();


-- ============================================================
-- קישור הכללים הקיימים לתבניות
-- ============================================================
-- שמונת הכללים שנזרעו קודם + שניים של התקשורת קיימים כבר. מקשרים אותם
-- לתבניות לפי שם, ומעדכנים את שדות הביצוע החדשים — בלי לגעת ב-is_active,
-- כדי שכלל שהמשתמש הדליק לא ייכבה ולהפך.
update public.automation_rules r
set template_key = t.key,
    category = t.category,
    severity = t.default_severity,
    estimated_minutes_saved = t.estimated_minutes_saved,
    execution_level = case
      -- כלל שהמשתמש כבר סימן כדורש אישור נשאר ברמת "הכנה".
      when r.requires_approval then 'prepare' else t.default_execution_level end
from public.automation_templates t
where r.template_key is null
  and r.trigger_type = t.trigger_type;
