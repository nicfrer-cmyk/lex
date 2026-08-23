-- ============================================================================
-- מרכז שיחות — הקשחה לקראת שיחות אמיתיות
-- ============================================================================
--
-- כל השינויים כאן additive. אף עמודה לא נמחקת, אף טבלה לא משנה משמעות,
-- ואף מיגרציה קודמת לא נערכת. שיחות שכבר נשמרו ממשיכות להיקרא כרגיל:
-- כל עמודה חדשה היא nullable או בעלת default.
--
-- ארבע הוספות שנוגעות בליבה:
--
--  1. office_commands — כל שינוי שמקורו ב-AI נרשם כפקודה עם מפתח
--     אידמפוטנטיות. זה מה שהופך retry לבטוח: הרצה שנייה של אותה פקודה
--     מחזירה את התוצאה הראשונה במקום ליצור פגישה שנייה.
--
--  2. Snapshot של תצורת הסוכן על השיחה. prompt שמשתנה בצהריים לא יכול
--     לשנות בדיעבד את מה ששיחה של הבוקר "התנהלה לפיו" — שאלה שנשאלת
--     בדיוק כשמשהו משתבש.
--
--  3. identity_status. Caller ID אינו אימות זהות. ההפרדה בין
--     "המספר מוכר" לבין "הזהות אומתה" היא מה שמונע מסירת פרטי תיק למי
--     שהשיג טלפון.
--
--  4. call_turn_metrics. השהיה היא תכונת המוצר המרכזית בשיחה קולית;
--     בלי מדידה לכל שלב אי אפשר לדעת אם STT, המודל או ההקראה הם הצוואר.
--
-- הרצה: supabase db push
-- ============================================================================


-- ============================================================
-- 1. office_commands — שכבת המוטציה הבטוחה
-- ============================================================
--
-- ⚠ הטבלה הזו אינה יומן. היא **חלק מנתיב הכתיבה**: לפני שפקודה מוחלת
-- על ה-blob נרשמת כאן שורה, ובסיום נשמרת התוצאה. שתי תוצאות מכך:
--
--   • אידמפוטנטיות אמיתית — unique(office_id, idempotency_key). ניסיון
--     חוזר מוצא את השורה, מחזיר את result_payload, ולא נוגע ב-blob.
--   • ניתן לענות על "מה ה-AI שינה בתיק הזה ומתי" בלי לשחזר מ-audit.
--
-- מדוע command_type הוא רשימה סגורה: ה-AI לא מספק פונקציית mutate. הוא
-- שולח שם פקודה מתוך רשימה מוגדרת, והקוד בוחר את המוטציה. פקודה שאינה
-- ברשימה נדחית ברמת ה-DB, לא רק ברמת הקוד.
create table if not exists public.office_commands (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  command_id text not null,
  call_id uuid references public.call_sessions(id) on delete set null,
  tool_call_id text,
  agent_id uuid references public.voice_agents(id) on delete set null,
  idempotency_key text not null,
  command_type text not null check (command_type in (
    'create_lead','update_lead','create_task','create_note',
    'create_appointment','create_callback','update_callback'
  )),
  schema_version text not null default '1',
  payload jsonb not null default '{}'::jsonb,
  -- התוצאה המלאה שהוחזרה בפעם הראשונה. זה מה שמוחזר בניסיון חוזר.
  result_payload jsonb,
  entity_type text,
  entity_id text,
  status text not null default 'pending'
    check (status in ('pending','applied','failed','conflict')),
  error text,
  -- כמה פעמים saveOfficeDb נאלץ לקרוא מחדש בגלל כתיבה מקבילה. מדד
  -- ישיר לעומס עריכה בו-זמנית; אם הוא מטפס, כדאי לדעת.
  conflict_retries int not null default 0,
  actor_type text not null default 'agent'
    check (actor_type in ('agent','user','system','webhook')),
  actor_id text,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  unique (office_id, idempotency_key)
);
create index if not exists office_commands_office_idx
  on public.office_commands(office_id, created_at desc);
create index if not exists office_commands_call_idx on public.office_commands(call_id);
alter table public.office_commands enable row level security;

-- קריאה בלבד מהדפדפן. הכתיבה עוברת ב-service_role, כמו כל טבלאות השיחה.
drop policy if exists "office_commands_select" on public.office_commands;
create policy "office_commands_select" on public.office_commands
  for select using (is_office_member(office_id));


-- ============================================================
-- 2. call_sessions — זהות, תצורה, מצב, איכות
-- ============================================================

alter table public.call_sessions
  -- ---- זהות ----
  -- ⚠ ברירת המחדל היא unidentified **גם** כשהמספר מוכר. phone_match
  -- אומר "המספר מופיע ב-CRM", לא "זה האדם". התאמת מספר היא רמז, לא
  -- הוכחה: טלפון אבוד, בן משפחה, או זיוף Caller ID מייצרים אותה
  -- התאמה בדיוק. מסירת פרטי תיק דורשת verified.
  add column if not exists identity_status text not null default 'unidentified'
    check (identity_status in ('unidentified','phone_match','verified','rejected')),
  add column if not exists identity_verified_at timestamptz,
  add column if not exists identity_verification_method text,
  add column if not exists raw_caller_phone text,

  -- ---- Snapshot של תצורת הסוכן ----
  -- נלקח בתחילת השיחה ואינו משתנה אחריה.
  add column if not exists agent_config_version text,
  add column if not exists prompt_version text,
  add column if not exists prompt_hash text,
  add column if not exists tools_policy_version text,
  add column if not exists llm_provider text,
  add column if not exists llm_model text,
  add column if not exists stt_provider text,
  add column if not exists stt_model text,
  add column if not exists tts_provider text,
  add column if not exists tts_model text,
  add column if not exists agent_snapshot jsonb,

  -- ---- מכונת המצבים ----
  -- נפרד מ-status: status הוא מצב השיחה מבחינת הטלפוניה (מצלצל/פעילה/
  -- הסתיימה), voice_state הוא מה שהסוכן עושה **בתוך** שיחה פעילה.
  -- מיזוגם היה יוצר מצב שבו "בשיחה" לא מבחין בין הקשבה לבין המתנה לכלי.
  add column if not exists voice_state text not null default 'ringing'
    check (voice_state in ('ringing','answering','listening','transcribing',
                           'thinking','speaking','waiting_for_tool','on_hold',
                           'completing','ended','failed')),
  add column if not exists voice_state_at timestamptz not null default now(),

  -- ---- עיבוד לאחר השיחה ----
  -- ⚠ סיכום, סיווג מפורט וניתוח רגש **לא** מעכבים ניתוק. השיחה נסגרת,
  -- והעיבוד הכבד רץ אחריה. מתקשר שממתין בקו בזמן שמודל מסכם הוא בדיוק
  -- מה שגורם לשיחות להישמע איטיות.
  add column if not exists post_call_status text not null default 'none'
    check (post_call_status in ('none','pending','processing','done','failed')),
  add column if not exists post_call_error text,
  add column if not exists post_call_completed_at timestamptz,
  add column if not exists tags text[],

  -- ---- איכות ----
  add column if not exists interruptions_count int not null default 0,
  add column if not exists silence_events int not null default 0,
  add column if not exists avg_turn_latency_ms int,
  add column if not exists max_turn_latency_ms int,
  add column if not exists stt_low_confidence_count int not null default 0,
  add column if not exists tool_failures_count int not null default 0,
  add column if not exists call_completed_normally boolean,
  -- ⚠ נשאר null בכוונה. ציון איכות שמחושב בנוסחה שהומצאה בלי נתונים
  -- אמיתיים הוא מספר שנראה אמין ואינו אומר דבר. השדה מוכן; המנוע לא.
  add column if not exists quality_score numeric;

create index if not exists call_sessions_postcall_idx
  on public.call_sessions(office_id, post_call_status)
  where post_call_status = 'pending';
create index if not exists call_sessions_identity_idx
  on public.call_sessions(office_id, identity_status);


-- ============================================================
-- 3. call_actions — קישור לפקודה ומדידה
-- ============================================================

alter table public.call_actions
  add column if not exists tool_call_id text,
  add column if not exists schema_version text not null default '1',
  add column if not exists agent_id uuid references public.voice_agents(id) on delete set null,
  add column if not exists command_id uuid references public.office_commands(id) on delete set null,
  add column if not exists latency_ms int,
  -- true כשהתוצאה הוחזרה ממטמון אידמפוטנטיות ולא בוצעה מחדש. ההבחנה
  -- חשובה: "בוצע" ו"כבר היה מבוצע" נראים זהים בלעדיה.
  add column if not exists replayed boolean not null default false;

create index if not exists call_actions_toolcall_idx
  on public.call_actions(call_id, tool_call_id);


-- ============================================================
-- 4. call_turn_metrics — השהיה לכל תור
-- ============================================================
--
-- טבלה נפרדת ולא עמודות על call_sessions: לשיחה יש תורות רבים, וממוצע
-- על השיחה מסתיר את התור האחד שלקח שמונה שניות — שהוא בדיוק זה שגרם
-- למתקשר לנתק.
create table if not exists public.call_turn_metrics (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  call_id uuid not null references public.call_sessions(id) on delete cascade,
  turn_index int not null,
  stt_latency_ms int,
  llm_first_token_ms int,
  llm_total_ms int,
  tool_latency_ms int,
  tts_first_audio_ms int,
  tts_total_ms int,
  -- מרגע שהמתקשר סיים לדבר ועד שהוא שמע את התחלת התשובה. זה המספר
  -- שהאדם בקו מרגיש; כל השאר הם רכיביו.
  turn_latency_ms int,
  tool_calls int not null default 0,
  interrupted boolean not null default false,
  stt_confidence numeric,
  created_at timestamptz not null default now(),
  unique (call_id, turn_index)
);
create index if not exists call_turn_metrics_office_idx
  on public.call_turn_metrics(office_id, created_at desc);
alter table public.call_turn_metrics enable row level security;

drop policy if exists "call_turn_metrics_select" on public.call_turn_metrics;
create policy "call_turn_metrics_select" on public.call_turn_metrics
  for select using (is_office_member(office_id));


-- ============================================================
-- 5. call_center_settings — Production gate והתנהגות שיחה
-- ============================================================

alter table public.call_center_settings
  -- ⚠ המפסק הראשי. false כברירת מחדל, וגם חיבור SIP תקין לא מדליק
  -- אותו: הפעלת שיחות אמיתיות היא החלטה של אדם, לא תוצאה של תשתית
  -- שהתחברה. ההפעלה חסומה כל עוד בדיקת המוכנות מחזירה ready=false.
  add column if not exists live_calls_enabled boolean not null default false,
  add column if not exists live_calls_enabled_at timestamptz,
  add column if not exists live_calls_enabled_by uuid references auth.users(id),
  add column if not exists max_call_duration_seconds int not null default 600,
  add column if not exists silence_timeout_ms int not null default 8000,
  add column if not exists barge_in_enabled boolean not null default true,
  -- ⚠ 0 = אין SLA מוגדר. הסוכן מונחה לא להבטיח זמן חזרה מדויק כל עוד
  -- הערך אפס. הבטחה שלא נשמרת גרועה מהיעדר הבטחה.
  add column if not exists callback_sla_hours int not null default 0,
  add column if not exists transcript_enabled boolean not null default true,
  add column if not exists identity_policy text not null default 'strict'
    check (identity_policy in ('strict','phone_match_ok')),
  add column if not exists media_transport text not null default 'audiosocket'
    check (media_transport in ('audiosocket','websocket'));


-- ============================================================
-- 6. voice_gateway_status — ספקים, Outbox, תעבורה
-- ============================================================

alter table public.voice_gateway_status
  -- מבנה מלא לכל ספק: {stt:{name,mode,healthy,production_ready,...}, ...}
  add column if not exists providers jsonb not null default '{}'::jsonb,
  add column if not exists transport text,
  add column if not exists outbox_pending int not null default 0,
  add column if not exists outbox_dead_letter int not null default 0,
  add column if not exists live_calls_accepted boolean not null default false;


-- ============================================================
-- 7. voice_dead_letters — פעולות שלא סונכרנו
-- ============================================================
--
-- ⚠ הראי ב-CRM של ה-Outbox שבשרת הקול. בלעדיו, פעולה שמיצתה את כל
-- הניסיונות הייתה נשארת בקובץ על שרת שאיש לא פותח — כלומר פנייה של
-- לקוח שנעלמה בשקט. המפרט אוסר זאת מפורשות.
create table if not exists public.voice_dead_letters (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  outbox_id text not null,
  call_external_id text,
  call_id uuid references public.call_sessions(id) on delete set null,
  tool_call_id text,
  idempotency_key text,
  endpoint text,
  action text,
  payload jsonb not null default '{}'::jsonb,
  attempt_count int not null default 0,
  last_error text,
  error_code text,
  status text not null default 'dead_letter'
    check (status in ('dead_letter','retrying','resolved')),
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (office_id, outbox_id)
);
create index if not exists voice_dead_letters_open_idx
  on public.voice_dead_letters(office_id, status) where status <> 'resolved';
alter table public.voice_dead_letters enable row level security;

drop policy if exists "voice_dead_letters_select" on public.voice_dead_letters;
create policy "voice_dead_letters_select" on public.voice_dead_letters
  for select using (is_office_member(office_id));
-- סימון כטופל הוא פעולה אנושית מהמסך, ולכן זו הטבלה היחידה כאן שכן
-- ניתנת לעדכון מהדפדפן — ורק ע"י בעל המשרד.
drop policy if exists "voice_dead_letters_update" on public.voice_dead_letters;
create policy "voice_dead_letters_update" on public.voice_dead_letters
  for update using (is_office_owner(office_id)) with check (is_office_owner(office_id));


-- ============================================================
-- 8. updated_at triggers
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['voice_dead_letters'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format(
      'create trigger %I_touch before update on public.%I
       for each row execute function public.ai_touch_updated_at()', t, t);
  end loop;
end $$;


-- ============================================================
-- 9. סטטיסטיקת מרכז השיחות — עדכון
-- ============================================================
--
-- ⚠ create or replace על פונקציה קיימת. החתימה והטיפוס המוחזר זהים,
-- ולכן קוד קיים שקורא לה ממשיך לעבוד; נוספו מפתחות בלבד ל-jsonb.
create or replace function public.call_center_stats(p_office_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  day_start timestamptz := date_trunc('day', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem';
  week_start timestamptz := date_trunc('week', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem';
begin
  -- security definer עוקף RLS, ולכן הסינון המפורש הזה הוא מה שמונע
  -- ממשתמש לשלוח מזהה של משרד אחר ולקבל את המונים שלו.
  if not is_office_member(p_office_id) then
    raise exception 'access denied';
  end if;

  select jsonb_build_object(
    'calls_today', (
      select count(*) from call_sessions
      where office_id = p_office_id and started_at >= day_start),
    'calls_active', (
      select count(*) from call_sessions
      where office_id = p_office_id
        and status in ('ringing','answering','active','on_hold','transferring')),
    'leads_today', (
      select count(*) from call_actions a
      where a.office_id = p_office_id and a.tool_name = 'create_lead'
        and a.status = 'success' and a.started_at >= day_start),
    'appointments_today', (
      select count(*) from call_actions a
      where a.office_id = p_office_id and a.tool_name = 'create_appointment'
        and a.status = 'success' and a.started_at >= day_start),
    'appointments_week', (
      select count(*) from call_actions a
      where a.office_id = p_office_id and a.tool_name = 'create_appointment'
        and a.status = 'success' and a.started_at >= week_start),
    'tasks_today', (
      select count(*) from call_actions a
      where a.office_id = p_office_id
        and a.tool_name in ('create_task','request_human_callback')
        and a.status = 'success' and a.started_at >= day_start),
    'requires_attention', (
      select count(*) from call_sessions
      where office_id = p_office_id
        and (status in ('failed','missed')
             or manual_followup_required
             or (urgency in ('high','critical') and outcome is null))
        and started_at >= now() - interval '14 days'),
    'failed_actions_today', (
      select count(*) from call_actions
      where office_id = p_office_id and status in ('failed','blocked')
        and started_at >= day_start),

    -- ⚠ ממתינים לחזרה נספרים מתוך ה-blob. משימות אינן טבלה במערכת הזו
    -- (ראה ההערה ב-20260822000000), ולכן הספירה היא על jsonb. זה נראה
    -- חריג ונכון: ספירה מטבלה מקבילה הייתה דורשת סנכרון שיסטה.
    'callbacks_waiting', (
      select count(*)
      from app_data ad,
           lateral jsonb_array_elements(
             case when jsonb_typeof(ad.data->'tasks') = 'array'
                  then ad.data->'tasks' else '[]'::jsonb end) t
      where ad.office_id = p_office_id
        and t->'callback' is not null
        and coalesce(t->'callback'->>'status', 'waiting')
            in ('waiting','no_answer','reschedule')),

    'dead_letters', (
      select count(*) from voice_dead_letters
      where office_id = p_office_id and status <> 'resolved'),
    'outbox_pending', (
      select coalesce(outbox_pending, 0) from voice_gateway_status
      where office_id = p_office_id),
    'gateway_state', coalesce(voice_gateway_state(p_office_id), 'never_connected'),
    'live_calls_enabled', (
      select coalesce(live_calls_enabled, false) from call_center_settings
      where office_id = p_office_id)
  ) into result;

  return result;
end;
$$;

grant execute on function public.call_center_stats(uuid) to authenticated;


-- ============================================================
-- 10. סטטיסטיקת השהיה
-- ============================================================
--
-- P50 ו-P95 ולא ממוצע בלבד: בשיחה קולית הזנב הוא הבעיה. ממוצע של 1.4
-- שניות נשמע מצוין גם כשאחת מכל עשרים שיחות ממתינה שש שניות — וזו
-- השיחה שבה המתקשר מנתק.
create or replace function public.voice_latency_stats(p_office_id uuid, p_days int default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not is_office_member(p_office_id) then
    raise exception 'access denied';
  end if;

  select jsonb_build_object(
    'turns', count(*),
    'turn_avg_ms', round(avg(turn_latency_ms)),
    'turn_p50_ms', round(percentile_cont(0.5) within group (order by turn_latency_ms)),
    'turn_p95_ms', round(percentile_cont(0.95) within group (order by turn_latency_ms)),
    'stt_avg_ms', round(avg(stt_latency_ms)),
    'stt_p95_ms', round(percentile_cont(0.95) within group (order by stt_latency_ms)),
    'llm_first_token_avg_ms', round(avg(llm_first_token_ms)),
    'llm_avg_ms', round(avg(llm_total_ms)),
    'llm_p95_ms', round(percentile_cont(0.95) within group (order by llm_total_ms)),
    'tool_avg_ms', round(avg(tool_latency_ms)),
    'tool_p95_ms', round(percentile_cont(0.95) within group (order by tool_latency_ms)),
    'tts_first_audio_avg_ms', round(avg(tts_first_audio_ms)),
    'tts_avg_ms', round(avg(tts_total_ms)),
    'interruptions', count(*) filter (where interrupted)
  ) into result
  from call_turn_metrics
  where office_id = p_office_id
    and created_at >= now() - make_interval(days => greatest(1, p_days));

  return coalesce(result, '{"turns":0}'::jsonb);
end;
$$;

grant execute on function public.voice_latency_stats(uuid, int) to authenticated;


-- ============================================================
-- 11. Realtime
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['office_commands','voice_dead_letters','call_turn_metrics'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
              when undefined_object then null;
    end;
  end loop;
end $$;


-- ============================================================
-- 12. נרמול המספר הציבורי הקיים ל-E.164
-- ============================================================
--
-- ⚠ מעדכן **רק** ערכים בפורמט מקומי ישראלי מוכר, ורק כשהתוצאה חד-משמעית.
-- מספר בפורמט אחר נשאר כמו שהוא: נרמול אגרסיבי על נתון קיים הוא בדיוק
-- הדרך להפוך מספר תקין למספר שגוי בלי שאיש ישים לב.
update public.call_center_settings
set public_office_phone = '+972' || substring(public_office_phone from 2)
where public_office_phone ~ '^0[2-9][0-9]{7,8}$';

update public.phone_lines
set public_number = '+972' || substring(public_number from 2)
where public_number ~ '^0[2-9][0-9]{7,8}$';


-- ============================================================
-- 13. מדיניות הסוכן — אין העברה חיה
-- ============================================================
--
-- החלטת המוצר: הסוכן **אינו מעביר שיחה** לעורך הדין. כל בקשה לדבר איתו
-- הופכת לבקשת חזרה. בלי ההנחיה המפורשת הזו הסוכן אומר "אני מעבירה
-- אותך" — ואז לא מעביר, וזו ההבטחה הגרועה ביותר שאפשר לתת בטלפון.
--
-- ⚠ ההוספה מותנית בכך שהטקסט טרם קיים. prompt שבעל המשרד ערך במסך
-- **לא** נדרס: התוספת מתווספת לסופו, והתנאי מונע כפילות בהרצה חוזרת.
update public.voice_agents
set system_prompt = system_prompt || E'

' ||
$CB$## בקשה לדבר עם עורך הדין

עורך הדין אינו זמין לשיחות טלפון, ואינך יכולה להעביר אליו שיחה.

אל תאמרי "אני מעבירה אותך" או "אני מחברת אותך". אמרי משהו בסגנון:
"עורך הדין אינו זמין כרגע לשיחה. אשמח לקחת את פרטי הפנייה ולבקש שיחזור אליך."

לפני שאת רושמת את הבקשה, אספי:
1. שם מלא.
2. סיבת הפנייה, במשפט או שניים.
3. עד כמה זה דחוף.
4. אם רלוונטי — מתי נוח שיחזרו אליו.

ואז הפעילי request_human_callback ואשרי שהפנייה נרשמה.

אל תבטיחי זמן חזרה מדויק. "יחזרו אליך בהקדם" מותר; "תוך שעה" אסור,
אלא אם נמסר לך במפורש זמן מחייב.$CB$
where slug = 'receptionist'
  and system_prompt not like '%עורך הדין אינו זמין כרגע לשיחה%';
