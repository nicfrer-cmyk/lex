-- ============================================================================
-- אוטומציות תקשורת — שיחות ללא מענה והמרת פונה ללקוח
-- ============================================================================
--
-- הפער שנסגר כאן: הכלי `get_clients_waiting_for_reply` היה קיים מהיום
-- הראשון, אבל אף אוטומציה לא הפעילה אותו. כלומר המערכת *ידעה* לזהות שיחה
-- תקועה — ואף פעם לא נשאלה. שתי השורות כאן הן מה שהופך את זה לפעיל.
--
-- הטריגר `thread_no_reply` מוגדר ב-ai-cron/index.ts. הוא היחיד שעובד על
-- טבלה אמיתית (communication_threads) ולא על ה-blob של ה-CRM.
--
-- שתיהן נכנסות כ-is_active=false, כמו כל השאר. הפעלה היא החלטה של בעל
-- המשרד במסך האוטומציות — לא של מיגרציה.
-- ============================================================================

create or replace function public.seed_comm_automations_for_office(p_office uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.automation_rules (
    office_id, name, description, trigger_type, trigger_config, conditions, actions,
    is_active, requires_approval
  )
  select p_office, x.name, x.description, x.trigger, x.config::jsonb, x.conds::jsonb, x.acts::jsonb, false, true
  from (values

    -- ------------------------------------------------------------------
    -- 1. שיחה ללא מענה — לקוח או תיק קיים
    -- ------------------------------------------------------------------
    -- 4 שעות ולא 24: פונה שכתב בבוקר ולא קיבל מענה עד הצהריים כבר מחפש
    -- משרד אחר. הסף נמוך בכוונה, וניתן לשינוי במסך האוטומציות.
    ('שיחה ללא מענה — טיוטת תשובה',
     'הודעה נכנסת בוואטסאפ/מייל שלא נענתה מעל 4 שעות: הסוכן קורא את מה שנכתב ומכין טיוטת תשובה לאישורך.',
     'thread_no_reply',
     '{"hours":4,"channels":["whatsapp","email","sms"],"max_per_run":10}',
     '[]',
     '[{"agent":"client-service","job_type":"draft_reply","goal":"קרא את ההודעה האחרונה שהתקבלה וטרם נענתה, והכן טיוטת תשובה עניינית ומדויקת. אם חסר מידע כדי לענות — נסח את השאלה שצריך לשאול. אל תתחייב בשם המשרד ואל תיתן ייעוץ משפטי.","priority":2}]'),

    -- ------------------------------------------------------------------
    -- 2. פונה חדש שאינו לקוח — המרה לליד
    -- ------------------------------------------------------------------
    -- מופרד מהכלל הראשון בכוונה: פונה לא מוכר צריך סיווג ותמחור, לא
    -- "תשובה ללקוח". שני סוכנים שונים, שני סוגי פלט שונים.
    ('פונה חדש בוואטסאפ — סיווג והמרה לליד',
     'הודעה נכנסת ממספר שאינו לקוח קיים: סיווג הפנייה, דירוג, איתור מידע חסר, והכנת ליד + הודעת פתיחה לאישורך.',
     'thread_no_reply',
     '{"hours":1,"channels":["whatsapp"],"max_per_run":10}',
     -- התנאי הוא כל ההבדל: רק שרשורים שאינם משויכים ללקוח קיים.
     '[{"field":"isKnownClient","op":"eq","value":false}]',
     '[{"agent":"lead-intake","job_type":"process_lead","goal":"הפונה אינו לקוח קיים. סווג את הפנייה לפי תחום, דרג את הפוטנציאל, ציין איזה מידע חסר כדי לפתוח תיק, והכן הצעת ליד + הודעת פתיחה קצרה לאישור.","priority":2}]')

  ) as x(name, description, trigger, config, conds, acts)
  where not exists (
    select 1 from public.automation_rules ar
    where ar.office_id = p_office and ar.name = x.name
  );
end;
$$;

revoke all on function public.seed_comm_automations_for_office(uuid) from public, anon, authenticated;


-- הרצה על כל המשרדים הקיימים
do $$
declare o record;
begin
  for o in select id from public.offices loop
    perform public.seed_comm_automations_for_office(o.id);
  end loop;
end $$;


-- ומשרד חדש מקבל גם אותן.
--
-- הטריגר הקיים offices_seed_ai_center קורא ל-seed_ai_center_for_office
-- בלבד. במקום להוסיף טריגר שני (ואז הסדר ביניהם הופך למשמעותי), מרחיבים
-- את הפונקציה שכבר רצה.
create or replace function public.seed_ai_center_new_office()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_ai_center_for_office(new.id);
  perform public.seed_comm_automations_for_office(new.id);
  return new;
end;
$$;


-- ============================================================
-- אינדקס למנוע האוטומציות
-- ============================================================
-- loadOpenThreads רץ בכל טיק של 5 דקות ומסנן על (office_id, status)
-- וממיין על last_message_at. בלי האינדקס זו סריקה מלאה של תיבת התקשורת
-- 288 פעמים ביום.
create index if not exists comm_threads_open_idx
  on public.communication_threads(office_id, status, last_message_at desc);

-- וההודעות נשלפות לפי thread_id בכמות — האינדקס הקיים comm_messages_thread_idx
-- מכסה את זה, אין צורך בנוסף.
