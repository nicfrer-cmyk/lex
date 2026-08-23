-- ============================================================================
-- מרכז שיחות — נתוני ברירת מחדל
-- ============================================================================
--
-- הפרדה מקובץ הסכמה, באותו דפוס של 20260804000001_ai_center_seed.sql:
-- הרצה חוזרת של הסכמה לא אמורה לדרוס תוכן שבעל המשרד ערך. כאן הכול
-- מבוסס on conflict do nothing — סוכן שה-prompt שלו שונה במסך ההגדרות
-- לא יחזור לברירת המחדל בהרצה הבאה.
--
-- הכול מוחל גם על משרדים קיימים (ה-INSERT ... SELECT למטה) וגם על משרד
-- חדש (הטריגר בסוף), כדי שלא יהיה מצב של משרד בלי מזכירה דיגיטלית.
-- ============================================================================


-- ============================================================
-- 1. הגדרות מרכז השיחות
-- ============================================================
-- המספר הציבורי של המשרד. נשמר כנתון ולא כקבוע בקוד, ולכן ניתן לשינוי
-- ממסך ההגדרות בלי deploy.
insert into public.call_center_settings (office_id, public_office_phone)
select id, '0552745790' from public.offices
on conflict (office_id) do nothing;


-- ============================================================
-- 2. הקו הראשי
-- ============================================================
-- provider_status='not_configured' משקף את המציאות: המספר קיים במערכת,
-- אבל אין ספק טלפוניה מחובר ואין רישום SIP. המסך יציג בדיוק את זה ולא
-- "מחובר" — הצגת מצב חיבור שגוי במערכת טלפוניה פירושה שיחות שנופלות בלי
-- שאיש יודע.
insert into public.phone_lines (office_id, public_number, label, provider, provider_status, sip_status)
select id, '0552745790', 'המספר הראשי של המשרד', 'self_hosted', 'not_configured', 'not_configured'
from public.offices
on conflict (office_id, public_number) do nothing;


-- ============================================================
-- 3. סוכן ברירת המחדל — מזכירת המשרד
-- ============================================================
-- ה-prompt הוא מדיניות ולא קישוט. שני חלקים בו אינם ניתנים למשא ומתן
-- והם גם נאכפים בקוד ולא רק בטקסט:
--   • איסור ייעוץ משפטי — הפרה שלו היא סיכון אתי ומשפטי ממשי למשרד.
--   • רשימת הכלים — הסוכן יכול לבקש רק מה שרשום ב-agent_tools, וה-gateway
--     בודק מול ה-DB לפני כל ביצוע. הנחיה מנחה, קוד אוכף.
insert into public.voice_agents (
  office_id, slug, name, description, role, system_prompt, greeting, language,
  voice_provider, llm_provider, llm_model, stt_provider, temperature,
  business_hours, escalation_rules, urgency_rules, is_active
)
select
  o.id,
  'receptionist',
  'מזכירת המשרד',
  'המזכירה הדיגיטלית שעונה לשיחות הנכנסות: מזהה לקוחות, קולטת פניות, פותחת לידים, יוצרת משימות וקובעת פגישות.',
  'receptionist',
  $PROMPT$את מזכירה דיגיטלית של משרד עורכי דין.

המטרה שלך היא לתת מענה אדמיניסטרטיבי מקצועי, אדיב וקצר.

## סגנון
- עברית תקנית, גוף ראשון נקבה, משפטים קצרים.
- שיחת טלפון, לא צ'אט: אין רשימות ממוספרות, אין כותרות, אין אימוג'ים.
- שאלה אחת בכל פעם. אל תשאלי שלוש שאלות במשפט אחד.
- אם המתקשר במצוקה — קודם להכיר בכך, אחר כך לאסוף פרטים.

## את רשאית
- לזהות לקוחות קיימים לפי מספר הטלפון.
- לקבל פרטי פנייה: שם, נושא, דחיפות, מה קרה ומתי.
- לפתוח ליד חדש לפונה שאינו לקוח.
- ליצור משימה לעורך הדין.
- לקבוע פגישה במועד פנוי ביומן.
- להעביר הודעה לעורך הדין.
- לספק מידע אדמיניסטרטיבי המאושר במערכת (שעות פעילות, כתובת, איך מגיעים).

## אסור לך
- לתת ייעוץ משפטי מכל סוג.
- לקבוע מה הלקוח "צריך לעשות" מבחינה משפטית.
- להעריך סיכויים או להבטיח תוצאה משפטית כלשהי.
- להציג את עצמך כעורכת דין. אם נשאלת — את מזכירה דיגיטלית של המשרד.
- למסור פרטי תיק, סכומים, מועדים או מסמכים לפני שזוהה שהמתקשר הוא הלקוח.
- למסור מידע על לקוח אחד למתקשר אחר, בשום נסיבות.
- לבצע פעולה שאינה ברשימת הכלים המאושרים שלך.

אם המתקשר מבקש ייעוץ משפטי, אמרי בפשטות שאינך רשאית לייעץ, ושעורך הדין
יחזור אליו — וצרי משימה.

## מקרה של ספק
צרי משימה לעורך הדין ואמרי למתקשר שהפנייה נרשמה ושיחזרו אליו.
עדיף משימה מיותרת מאשר פנייה שנעלמה.

## סיווג
בכל שיחה סווגי את הנושא (למשל: הוצאה לפועל, חוזים, נזיקין, משפחה,
עבודה, פלילי, מקרקעין, כללי) ואת רמת הדחיפות. מצבים שבהם יש מועד קרוב,
עיקול, פינוי, צו, מעצר או חשבון חסום — דחופים.

## סיום
לפני סיום, סכמי בקצרה למתקשר מה נרשם ומה יקרה הלאה.$PROMPT$,
  'משרד עורכי הדין ירין אשואל, שלום. מדברת המזכירה הדיגיטלית. איך אפשר לעזור?',
  'he-IL',
  'mock', 'anthropic', 'claude-haiku-4-5-20251001', 'mock', 0.3,
  -- שעות פעילות: א'-ה' 09:00-18:00. יום 5=שישי, 6=שבת — סגור.
  '{"tz":"Asia/Jerusalem","days":{"0":[["09:00","18:00"]],"1":[["09:00","18:00"]],"2":[["09:00","18:00"]],"3":[["09:00","18:00"]],"4":[["09:00","18:00"]]},"outside_hours_behavior":"take_message"}'::jsonb,
  '{"on_urgency":["high","critical"],"create_callback_task":true,"callback_priority":"urgent","on_tool_failure":"create_task","on_legal_advice_request":"create_task"}'::jsonb,
  -- כללי דחיפות ניתנים לעריכה. המנוע ב-_shared/voice/urgency.ts משלב
  -- אותם עם ניתוח המודל — הוא לא מסתמך על מילות מפתח בלבד.
  $URG${
    "keywords": {
      "critical": ["מעצר", "צו מעצר", "פינוי היום", "דיון מחר", "דיון היום"],
      "high": ["עיקול", "עוקל", "חשבון חסום", "חשבון מעוקל", "פינוי", "צו", "הוצאה לפועל",
               "דדליין", "מועד אחרון", "היום", "מחר", "אזהרה", "התראה", "כינוס", "הליך"],
      "normal": ["פגישה", "ייעוץ", "שאלה", "עדכון", "מסמך"]
    },
    "boosters": {
      "deadline_within_days": 3,
      "existing_client": false,
      "repeat_caller_within_hours": 24
    },
    "max_from_keywords": "high"
  }$URG$::jsonb,
  true
from public.offices o
on conflict (office_id, slug) do nothing;


-- ============================================================
-- 4. הכלים המותרים לסוכן
-- ============================================================
-- ⚠ transfer_call נכנס עם available=false במכוון ומסיבה קונקרטית:
-- כל עוד HUMAN_TRANSFER_NUMBER לא הוגדר, היעד היחיד שהמערכת מכירה הוא
-- המספר הציבורי — ואם השיחה הופנתה ממנו אל ה-AI מלכתחילה, העברה חזרה
-- אליו יוצרת לולאת forwarding שמסתיימת בשיחה תקועה או בחיוב מיותר.
-- במקומה נוצרת משימת חזרה. השדה מתמלא אוטומטית כשמגדירים מספר.
--
-- send_message גם הוא available=false: שליחת הודעה יוצאת בשם המשרד
-- דורשת ספק תקשורת מוגדר, ו"נשלח" שלא נשלח גרוע מ"לא נשלח".
insert into public.agent_tools
  (office_id, agent_id, tool_name, enabled, requires_confirmation, risk_level, available, unavailable_reason)
select a.office_id, a.id, t.tool_name, t.enabled, t.requires_confirmation, t.risk_level,
       t.available, t.unavailable_reason
from public.voice_agents a
cross join (values
  ('lookup_client',          true,  false, 'none',   true,  null),
  ('lookup_lead',            true,  false, 'none',   true,  null),
  ('create_lead',            true,  false, 'low',    true,  null),
  ('create_task',            true,  false, 'medium', true,  null),
  ('create_note',            true,  false, 'low',    true,  null),
  ('check_calendar',         true,  false, 'none',   true,  null),
  ('create_appointment',     true,  false, 'medium', true,  null),
  ('request_human_callback', true,  false, 'low',    true,  null),
  ('send_message',           true,  true,  'high',   false, 'נדרש ספק תקשורת מוגדר (WhatsApp/SMS) לשליחת הודעות יוצאות'),
  ('transfer_call',          true,  true,  'high',   false, 'לא הוגדר HUMAN_TRANSFER_NUMBER. העברה למספר הציבורי עלולה ליצור לולאת ניתוב — במקומה נוצרת משימת חזרה.')
) as t(tool_name, enabled, requires_confirmation, risk_level, available, unavailable_reason)
where a.slug = 'receptionist'
on conflict (agent_id, tool_name) do nothing;


-- ============================================================
-- 5. שורת heartbeat ריקה
-- ============================================================
-- last_heartbeat_at נשאר null, ולכן voice_gateway_state מחזיר
-- 'never_connected' והמסך מציג "לא מחובר". השורה קיימת רק כדי שהמסך
-- יציג מצב מוגדר במקום "אין נתונים".
insert into public.voice_gateway_status (office_id, components)
select id, '{"asterisk":"not_configured","sip":"not_configured","stt":"mock","llm":"mock","tts":"mock"}'::jsonb
from public.offices
on conflict (office_id) do nothing;


-- ============================================================
-- 6. משרד חדש מקבל את הכול אוטומטית
-- ============================================================
-- הטריגר רץ AFTER INSERT על offices. הוא משכפל בדיוק את מה שלמעלה, כדי
-- שמשרד שנרשם מחר לא יגלה מרכז שיחות ריק בלי סוכן ובלי קו.
create or replace function public.call_center_for_new_office()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent_id uuid;
  v_template public.voice_agents%rowtype;
begin
  insert into public.call_center_settings (office_id, public_office_phone)
  values (new.id, '0552745790')
  on conflict (office_id) do nothing;

  insert into public.phone_lines (office_id, public_number, label, provider, provider_status, sip_status)
  values (new.id, '0552745790', 'המספר הראשי של המשרד', 'self_hosted', 'not_configured', 'not_configured')
  on conflict (office_id, public_number) do nothing;

  insert into public.voice_gateway_status (office_id, components)
  values (new.id, '{"asterisk":"not_configured","sip":"not_configured","stt":"mock","llm":"mock","tts":"mock"}'::jsonb)
  on conflict (office_id) do nothing;

  -- ה-prompt נלקח מסוכן קיים במקום להיות משוכפל כאן: שתי עותקות של אותו
  -- טקסט מדיניות היו נפרדות בעדכון הראשון, והמשרד החדש היה מקבל בשקט
  -- מדיניות ישנה יותר מזו של כולם.
  select * into v_template from public.voice_agents
  where slug = 'receptionist' and office_id <> new.id
  order by created_at limit 1;

  if v_template.id is null then
    -- אין ממי להעתיק (המשרד הראשון בהתקנה נקייה). המיגרציה הזו כבר
    -- יצרה סוכן לכל משרד קיים, ולכן המצב הזה נדיר; יוצרים שלד פעיל
    -- ומסמנים שדורש הגדרה, במקום להשאיר משרד בלי מזכירה.
    insert into public.voice_agents (office_id, slug, name, role, system_prompt, is_active)
    values (new.id, 'receptionist', 'מזכירת המשרד', 'receptionist',
            'את מזכירה דיגיטלית של משרד עורכי דין. אינך רשאית לתת ייעוץ משפטי.', true)
    returning id into v_agent_id;
  else
    insert into public.voice_agents (
      office_id, slug, name, description, role, system_prompt, greeting, language,
      voice_provider, llm_provider, llm_model, stt_provider, temperature,
      business_hours, escalation_rules, urgency_rules, is_active)
    values (
      new.id, v_template.slug, v_template.name, v_template.description, v_template.role,
      v_template.system_prompt, v_template.greeting, v_template.language,
      v_template.voice_provider, v_template.llm_provider, v_template.llm_model,
      v_template.stt_provider, v_template.temperature,
      v_template.business_hours, v_template.escalation_rules, v_template.urgency_rules, true)
    returning id into v_agent_id;
  end if;

  insert into public.agent_tools
    (office_id, agent_id, tool_name, enabled, requires_confirmation, risk_level, available, unavailable_reason)
  select new.id, v_agent_id, t.tool_name, t.enabled, t.requires_confirmation, t.risk_level,
         t.available, t.unavailable_reason
  from (values
    ('lookup_client',          true,  false, 'none',   true,  null),
    ('lookup_lead',            true,  false, 'none',   true,  null),
    ('create_lead',            true,  false, 'low',    true,  null),
    ('create_task',            true,  false, 'medium', true,  null),
    ('create_note',            true,  false, 'low',    true,  null),
    ('check_calendar',         true,  false, 'none',   true,  null),
    ('create_appointment',     true,  false, 'medium', true,  null),
    ('request_human_callback', true,  false, 'low',    true,  null),
    ('send_message',           true,  true,  'high',   false, 'נדרש ספק תקשורת מוגדר (WhatsApp/SMS) לשליחת הודעות יוצאות'),
    ('transfer_call',          true,  true,  'high',   false, 'לא הוגדר HUMAN_TRANSFER_NUMBER. העברה למספר הציבורי עלולה ליצור לולאת ניתוב — במקומה נוצרת משימת חזרה.')
  ) as t(tool_name, enabled, requires_confirmation, risk_level, available, unavailable_reason)
  on conflict (agent_id, tool_name) do nothing;

  return new;
end;
$$;

drop trigger if exists offices_call_center on public.offices;
create trigger offices_call_center after insert on public.offices
  for each row execute function public.call_center_for_new_office();
