-- ============================================================================
-- מרכז שיחות — סכמה
-- ============================================================================
--
-- שלושה ממצאים מה-Audit של הפרויקט מעצבים את הקובץ הזה:
--
-- 1. אין טבלאות clients/cases/tasks. כל ה-CRM הוא ערך jsonb יחיד ב-
--    app_data.data, ומזהי הישויות בתוכו הם מחרוזות base36 שנוצרו ע"י uid()
--    ב-app.js. לכן client_id / lead_id / task_id / event_id כאן הם **text
--    ללא foreign key** — בדיוק כמו ב-20260804000000_ai_center.sql. FK
--    לטבלה שאינה קיימת אינו ניתן לכתיבה, ו-uuid לא תואם לפורמט.
--
-- 2. גבול הבידוד היחיד הוא office_id, ו-RLS נאכף דרך is_office_member() /
--    is_office_owner() (שתיהן כבר קיימות). אין כאן מנגנון הרשאות חדש.
--
-- 3. **טבלאות השיחה אינן ניתנות לכתיבה מהדפדפן כלל.** אין להן policy של
--    insert/update/delete — רק select לחברי המשרד. כל כתיבה עוברת דרך
--    Edge Function עם service_role, שמאמתת חתימת HMAC (שרת הקול) או JWT
--    (סימולציה מהדפדפן). זו ההחלטה שמונעת את התרחיש הגרוע: דפדפן שמצהיר
--    "התקבלה שיחה מלקוח X" וגורם למערכת ליצור לידים, משימות ופגישות.
--    טבלאות ההגדרה (סוכנים, כלים, קווים, הגדרות) כן ניתנות לעריכה — לבעל
--    המשרד בלבד.
--
-- הכול additive: אף טבלה קיימת לא משתנה, אף עמודה לא נמחקת, אין פעולה
-- הרסנית. כל אובייקט נוצר עם "if not exists" / "drop policy if exists",
-- כך שהרצה חוזרת בטוחה — אותו דפוס כמו שאר המיגרציות בפרויקט.
--
-- הרצה: supabase db push  (או הדבקה ב-SQL Editor)
-- ============================================================================


-- ============================================================
-- 1. phone_lines — קווי הטלפון של המשרד
-- ============================================================
-- קו = שורה. המספר הציבורי אינו קבוע בקוד באף מקום; הוא נתון, ולכן אפשר
-- להוסיף קו שני (למשל מספר ייעודי להוצאה לפועל) בלי שינוי קוד.
--
-- provider_status ו-sip_status נפרדים בכוונה: אפשר שהספק מוגדר אבל
-- הרישום ל-SIP נכשל, וההבחנה הזו היא ההבדל בין "לא הגדרנו" לבין "הגדרנו
-- והוא לא עולה" — שתי תקלות שונות לגמרי לאדם שמנסה לאתר למה אין שיחות.
create table if not exists public.phone_lines (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  public_number text not null,
  label text,
  provider text not null default 'self_hosted',
  provider_status text not null default 'not_configured'
    check (provider_status in ('not_configured','configuring','configured','error')),
  sip_status text not null default 'not_configured'
    check (sip_status in ('not_configured','registering','registered','failed')),
  is_active boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (office_id, public_number)
);
create index if not exists phone_lines_office_idx on public.phone_lines(office_id);
alter table public.phone_lines enable row level security;

drop policy if exists "phone_lines_select" on public.phone_lines;
create policy "phone_lines_select" on public.phone_lines
  for select using (is_office_member(office_id));
drop policy if exists "phone_lines_write" on public.phone_lines;
create policy "phone_lines_write" on public.phone_lines
  for all using (is_office_owner(office_id)) with check (is_office_owner(office_id));


-- ============================================================
-- 2. voice_agents — הסוכנים הקוליים
-- ============================================================
-- סוכן = שורה ולא קוד, באותו עיקרון של ai_agents. הפרדה מ-ai_agents
-- מכוונת: לסוכן קולי יש שדות שאין להם משמעות בסוכן טקסט (voice_id, stt,
-- greeting, business_hours), ולסוכן טקסט יש תקציב והרצות שאין להם משמעות
-- בשיחה חיה. איחוד היה יוצר טבלה שחצי מעמודותיה תמיד null.
create table if not exists public.voice_agents (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  slug text not null,
  name text not null,
  description text,
  role text not null default 'receptionist',
  system_prompt text not null default '',
  greeting text not null default '',
  language text not null default 'he-IL',
  -- ספקים: הכול מופשט מאחורי Provider/Adapter. 'mock' הוא ברירת המחדל
  -- ולא תקלה — היא מה שמאפשר לבדוק את המערכת מקצה לקצה בלי טלפוניה.
  voice_provider text not null default 'mock',
  voice_id text,
  llm_provider text not null default 'anthropic',
  llm_model text not null default 'claude-haiku-4-5-20251001',
  stt_provider text not null default 'mock',
  stt_model text,
  temperature numeric not null default 0.3,
  max_turns int not null default 20,
  -- שעות פעילות: {"tz":"Asia/Jerusalem","days":{"0":[["09:00","18:00"]],...}}
  business_hours jsonb not null default '{}'::jsonb,
  -- כללי הסלמה: מתי לפתוח משימת חזרה דחופה / לבקש נציג אנושי
  escalation_rules jsonb not null default '{}'::jsonb,
  -- כללי דחיפות ניתנים לעריכה (ראה _shared/voice/urgency.ts)
  urgency_rules jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (office_id, slug)
);
create index if not exists voice_agents_office_idx on public.voice_agents(office_id);
alter table public.voice_agents enable row level security;

drop policy if exists "voice_agents_select" on public.voice_agents;
create policy "voice_agents_select" on public.voice_agents
  for select using (is_office_member(office_id));
-- שינוי prompt של סוכן שמדבר עם לקוחות בשם המשרד הוא שינוי בעל השלכה
-- משפטית — בעלים בלבד, כמו ב-ai_agents.
drop policy if exists "voice_agents_write" on public.voice_agents;
create policy "voice_agents_write" on public.voice_agents
  for all using (is_office_owner(office_id)) with check (is_office_owner(office_id));


-- ============================================================
-- 3. agent_tools — מה מותר לסוכן לעשות
-- ============================================================
-- ⚠ זו הטבלה שמגדירה את גבול הסמכות של ה-AI. הוא **לעולם לא מקבל גישת
-- SQL**: הוא מבקש כלי בשם, ה-gateway מחפש אותו כאן, ואם השורה חסרה או
-- enabled=false — הבקשה נדחית ונרשמת כ-blocked ב-call_actions. מסמך,
-- מתקשר או מודל שהשתכנע אחרת אינם יכולים להרחיב את הרשימה.
--
-- שם הטבלה הוא agent_tools ולא voice_agent_tools לפי המפרט. הוא נבדל
-- מ-ai_agent_tools הקיימת (סוכני הטקסט) — שתי מערכות, שני קטלוגים.
create table if not exists public.agent_tools (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  agent_id uuid not null references public.voice_agents(id) on delete cascade,
  tool_name text not null,
  enabled boolean not null default true,
  requires_confirmation boolean not null default false,
  risk_level text not null default 'low'
    check (risk_level in ('none','low','medium','high','critical')),
  -- available=false פירושו "הכלי קיים בקוד אבל חסר לו תנאי סביבה" —
  -- למשל transfer_call בלי HUMAN_TRANSFER_NUMBER. זה שונה מ-enabled=false
  -- ("בעל המשרד כיבה אותו") וההבחנה מוצגת למשתמש כפי שהיא.
  available boolean not null default true,
  unavailable_reason text,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, tool_name)
);
create index if not exists agent_tools_office_idx on public.agent_tools(office_id);
create index if not exists agent_tools_agent_idx on public.agent_tools(agent_id);
alter table public.agent_tools enable row level security;

drop policy if exists "agent_tools_select" on public.agent_tools;
create policy "agent_tools_select" on public.agent_tools
  for select using (is_office_member(office_id));
drop policy if exists "agent_tools_write" on public.agent_tools;
create policy "agent_tools_write" on public.agent_tools
  for all using (is_office_owner(office_id)) with check (is_office_owner(office_id));


-- ============================================================
-- 4. call_sessions — שיחה = Session
-- ============================================================
-- external_call_id הוא המפתח לאידמפוטנטיות. שרת הקול חוזר על בקשות שלא
-- קיבלו תשובה (סעיף ERROR HANDLING), ובלי אילוץ ייחודי כל retry היה יוצר
-- שיחה נוספת — ואיתה ליד נוסף, משימה נוספת ופגישה נוספת. האילוץ הזה הוא
-- מה שהופך "נסה שוב" לבטוח.
create table if not exists public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  external_call_id text not null,
  phone_line_id uuid references public.phone_lines(id) on delete set null,
  agent_id uuid references public.voice_agents(id) on delete set null,
  direction text not null default 'inbound' check (direction in ('inbound','outbound')),
  caller_phone text,
  called_phone text,
  -- מזהי CRM — text, כי הם חיים ב-blob ולא בטבלה (ראה הערת הפתיחה).
  client_id text,
  lead_id text,
  matter_id text,
  status text not null default 'ringing'
    check (status in ('ringing','answering','active','on_hold','transferring',
                      'completed','failed','missed')),
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds int not null default 0,
  category text,
  subcategory text,
  urgency text not null default 'normal'
    check (urgency in ('low','normal','high','critical')),
  sentiment text check (sentiment in ('positive','neutral','negative','distressed')),
  outcome text,
  summary text,
  -- הקלטה כבויה כברירת מחדל ובמכוון (סעיף RECORDINGS). 'disabled' הוא
  -- מצב תקין ולא שגיאה.
  recording_status text not null default 'disabled'
    check (recording_status in ('disabled','pending','available','failed','deleted')),
  recording_path text,
  transcript_status text not null default 'none'
    check (transcript_status in ('none','partial','final','failed')),
  -- כשכלי נכשל, השיחה ממשיכה והדגל הזה מסמן לאדם שיש מה להשלים.
  manual_followup_required boolean not null default false,
  followup_reason text,
  -- שיחת סימולציה מסומנת כך שאפשר לסנן אותה מדוחות, אבל היא עוברת בדיוק
  -- באותו קוד — זו כל הנקודה של מצב הבדיקה.
  is_simulation boolean not null default false,
  turn_count int not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (office_id, external_call_id)
);
create index if not exists call_sessions_office_started_idx
  on public.call_sessions(office_id, started_at desc);
create index if not exists call_sessions_active_idx
  on public.call_sessions(office_id, status)
  where status in ('ringing','answering','active','on_hold','transferring');
create index if not exists call_sessions_client_idx on public.call_sessions(office_id, client_id);
create index if not exists call_sessions_lead_idx on public.call_sessions(office_id, lead_id);
alter table public.call_sessions enable row level security;

-- קריאה בלבד מהדפדפן. כתיבה — service_role בלבד (ראה הערת הפתיחה §3).
drop policy if exists "call_sessions_select" on public.call_sessions;
create policy "call_sessions_select" on public.call_sessions
  for select using (is_office_member(office_id));


-- ============================================================
-- 5. call_transcript_segments — התמלול, בקטעים
-- ============================================================
-- לא שדה JSON אחד. קטעים מאפשרים: הזרמה בזמן אמת (כל קטע מגיע בנפרד),
-- חיפוש טקסטואלי, קישור בין פעולת כלי לרגע בשיחה שגרם לה, ומחיקה
-- סלקטיבית לפי מדיניות שמירה — כל אלה בלתי אפשריים בשדה יחיד.
create table if not exists public.call_transcript_segments (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  call_id uuid not null references public.call_sessions(id) on delete cascade,
  sequence int not null,
  speaker text not null check (speaker in ('caller','agent','human','system')),
  text text not null default '',
  started_at_ms int,
  ended_at_ms int,
  confidence numeric,
  is_final boolean not null default true,
  created_at timestamptz not null default now(),
  -- אידמפוטנטיות: מסירה חוזרת של אותו קטע מעדכנת ולא מכפילה.
  unique (call_id, sequence)
);
create index if not exists call_segments_call_idx
  on public.call_transcript_segments(call_id, sequence);
alter table public.call_transcript_segments enable row level security;

drop policy if exists "call_segments_select" on public.call_transcript_segments;
create policy "call_segments_select" on public.call_transcript_segments
  for select using (is_office_member(office_id));


-- ============================================================
-- 6. call_events — Audit Trail של השיחה
-- ============================================================
-- העמודה נקראת occurred_at ולא timestamp: `timestamp` הוא col_name_keyword
-- ב-Postgres, ו-`select timestamp from ...` הוא ביטוי דו-משמעי שהמנתח
-- עלול לפרש כהתחלה של literal מסוג timestamp. שם חד-משמעי עדיף על נאמנות
-- מילולית בעמודה שתיקרא בכל שאילתה של ציר הזמן.
create table if not exists public.call_events (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  call_id uuid not null references public.call_sessions(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists call_events_call_idx on public.call_events(call_id, occurred_at);
alter table public.call_events enable row level security;

drop policy if exists "call_events_select" on public.call_events;
create policy "call_events_select" on public.call_events
  for select using (is_office_member(office_id));


-- ============================================================
-- 7. call_actions — כל פעולה שה-AI ביקש
-- ============================================================
-- כולל את הפעולות שנדחו. שורת blocked היא ראיה שהמנגנון עבד, והיא שווה
-- לא פחות משורת success: היא מה שמאפשר לענות על "מה הסוכן ניסה לעשות
-- ולא הורשה".
create table if not exists public.call_actions (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  call_id uuid not null references public.call_sessions(id) on delete cascade,
  tool_name text not null,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb,
  status text not null default 'pending'
    check (status in ('pending','approved','executing','success','failed','blocked')),
  error text,
  -- מה נוצר בפועל ב-CRM — כדי שהמסך יוכל לקשר ישירות למשימה/פגישה/ליד.
  entity_type text,
  entity_id text,
  -- אותו כלי + אותו קלט + אותה שיחה = אותה פעולה. זה מה שמונע פגישה
  -- כפולה כשה-orchestrator שולח שוב אחרי timeout.
  idempotency_key text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (call_id, idempotency_key)
);
create index if not exists call_actions_call_idx on public.call_actions(call_id, started_at);
create index if not exists call_actions_office_idx on public.call_actions(office_id, status);
alter table public.call_actions enable row level security;

drop policy if exists "call_actions_select" on public.call_actions;
create policy "call_actions_select" on public.call_actions
  for select using (is_office_member(office_id));


-- ============================================================
-- 8. call_center_settings — הגדרות מרכז השיחות
-- ============================================================
-- שורה אחת לכל משרד, כמו ai_settings.
--
-- human_transfer_number ריק במכוון. המפרט אוסר במפורש להעביר שיחה אל
-- המספר הציבורי: אם השיחה הופנתה מ-0552745790 אל ה-AI, העברה חזרה אליו
-- יוצרת לולאת forwarding. כל עוד השדה ריק — transfer_call מסומן
-- available=false ובמקומו נוצרת משימת חזרה.
create table if not exists public.call_center_settings (
  office_id uuid primary key references public.offices(id) on delete cascade,
  public_office_phone text,
  human_transfer_number text,
  -- כבוי כברירת מחדל. הקלטת שיחה כפופה לחוק האזנת סתר ולכללי האתיקה,
  -- ולכן היא החלטה מפורשת של בעל המשרד ולא ברירת מחדל של מערכת.
  recording_enabled boolean not null default false,
  -- 0 = לא נמחק דבר. בשלב זה **אין מחיקה אוטומטית** — רק ארכיטקטורה.
  transcript_retention_days int not null default 0,
  recording_retention_days int not null default 0,
  call_metadata_retention_days int not null default 0,
  retention_enforcement boolean not null default false,
  simulation_enabled boolean not null default true,
  ai_enabled boolean not null default true,
  -- ניתוק חירום של המזכירה הדיגיטלית, במקביל ל-emergency_stop של ai_settings.
  emergency_stop boolean not null default false,
  emergency_stop_reason text,
  max_calls_per_hour_per_number int not null default 12,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
alter table public.call_center_settings enable row level security;

drop policy if exists "cc_settings_select" on public.call_center_settings;
create policy "cc_settings_select" on public.call_center_settings
  for select using (is_office_member(office_id));
drop policy if exists "cc_settings_write" on public.call_center_settings;
create policy "cc_settings_write" on public.call_center_settings
  for all using (is_office_owner(office_id)) with check (is_office_owner(office_id));


-- ============================================================
-- 9. voice_gateway_status — Heartbeat
-- ============================================================
-- ⚠ אין עמודת "online". הסטטוס **נגזר** מ-last_heartbeat_at, כי מצב
-- מאוחסן משקר: שרת קול שנפל באמצע לא יספיק לכתוב "offline", והמסך היה
-- ממשיך להציג ירוק בזמן שאף שיחה לא נענית. פונקציית העזר למטה מחשבת
-- online/degraded/offline מהזמן שעבר, ולכן היעדר heartbeat = offline
-- אוטומטית ובלי צורך בפעולה של אף אחד.
create table if not exists public.voice_gateway_status (
  office_id uuid primary key references public.offices(id) on delete cascade,
  last_heartbeat_at timestamptz,
  version text,
  -- {"asterisk":"not_configured","sip":"not_configured","stt":"mock",...}
  components jsonb not null default '{}'::jsonb,
  active_calls int not null default 0,
  queued_events int not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);
alter table public.voice_gateway_status enable row level security;

drop policy if exists "vg_status_select" on public.voice_gateway_status;
create policy "vg_status_select" on public.voice_gateway_status
  for select using (is_office_member(office_id));


-- ============================================================
-- 10. voice_request_nonces — Replay Protection
-- ============================================================
-- חתימת HMAC מוכיחה שהבקשה נוצרה ע"י מי שמחזיק בסוד. היא **לא** מוכיחה
-- שהיא לא נשלחה כבר: מי שהאזין לבקשה חתומה יכול לשדר אותה שוב כמות
-- שהיא. חלון זמן לבדו מצמצם את החלון אבל לא סוגר אותו. ה-nonce סוגר:
-- מפתח ראשי על הערך, ולכן שידור חוזר נכשל ב-insert.
create table if not exists public.voice_request_nonces (
  nonce text primary key,
  office_id uuid references public.offices(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists voice_nonces_created_idx on public.voice_request_nonces(created_at);
alter table public.voice_request_nonces enable row level security;
-- אין policy כלל: הטבלה נגישה ל-service_role בלבד. אין שום סיבה שדפדפן
-- יראה או יכתוב nonce.


-- ============================================================
-- 11. voice_rate_limits — מגבלת קצב לפי מספר מתקשר
-- ============================================================
-- endpoint טלפוניה פומבי בלי מגבלת קצב הוא הזמנה להצפת המערכת בשיחות
-- מזויפות שכל אחת מהן יוצרת ליד ומשימה. הספירה היא לפי חלון שעה מתגלגל.
create table if not exists public.voice_rate_limits (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  bucket_key text not null,
  window_start timestamptz not null,
  count int not null default 1,
  unique (office_id, bucket_key, window_start)
);
create index if not exists voice_rate_window_idx on public.voice_rate_limits(window_start);
alter table public.voice_rate_limits enable row level security;
-- service_role בלבד, כמו nonces.


-- ============================================================
-- 12. פונקציות עזר
-- ============================================================

-- מצב שרת הקול, מחושב מהזמן שעבר מאז ה-heartbeat האחרון.
-- 60 שניות = שני heartbeats שהוחמצו (מרווח 30 שניות) — סף שסופג רעש רשת
-- בלי להסתיר נפילה אמיתית ליותר מדקה.
create or replace function public.voice_gateway_state(p_office_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when s.last_heartbeat_at is null then 'never_connected'
    when s.last_heartbeat_at > now() - interval '60 seconds' then 'online'
    when s.last_heartbeat_at > now() - interval '5 minutes' then 'degraded'
    else 'offline'
  end
  from public.voice_gateway_status s
  where s.office_id = p_office_id;
$$;

-- מונים לדשבורד. שאילתה אחת במקום שמונה — הדשבורד נטען בכל כניסה למסך
-- ובכל אירוע Realtime, וזה ההבדל בין מסך שמגיב לבין מסך שמהבהב.
--
-- security definer + סינון מפורש ב-is_office_member: בלי הסינון, פונקציית
-- security definer הייתה עוקפת RLS ומחזירה מונים של משרד אחר למי ששולח
-- מזהה זר.
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
      join call_sessions c on c.id = a.call_id
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
    -- "דורש טיפול": שיחה שנכשלה, שלא נענתה, שסומנה להמשך ידני, או
    -- שדחיפותה גבוהה ולא נסגרה בתוצאה כלשהי.
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
    'gateway_state', coalesce(voice_gateway_state(p_office_id), 'never_connected')
  ) into result;

  return result;
end;
$$;

grant execute on function public.call_center_stats(uuid) to authenticated;
grant execute on function public.voice_gateway_state(uuid) to authenticated;

-- מונה מגבלת קצב, אטומי.
-- הספירה חייבת להיות insert ... on conflict do update ולא select-ואז-update:
-- שתי שיחות שנכנסות באותה שנייה היו קוראות שתיהן את אותו ערך ונספרות כאחת,
-- וזו בדיוק הנקודה שבה מגבלת קצב מפסיקה להגן.
create or replace function public.voice_rate_bump(
  p_office uuid, p_key text, p_window timestamptz)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.voice_rate_limits (office_id, bucket_key, window_start, count)
  values (p_office, p_key, p_window, 1)
  on conflict (office_id, bucket_key, window_start)
    do update set count = public.voice_rate_limits.count + 1
  returning count into v_count;

  -- ניקוי עצמי: חלונות בני יותר מיממה אינם משמשים איש.
  delete from public.voice_rate_limits where window_start < now() - interval '1 day';

  return v_count;
end;
$$;


-- ============================================================
-- 13. updated_at triggers
-- ============================================================
-- ai_touch_updated_at() כבר קיימת (20260804000000_ai_center.sql §22).
do $$
declare t text;
begin
  foreach t in array array[
    'phone_lines','voice_agents','agent_tools','call_sessions',
    'call_center_settings','voice_gateway_status'
  ] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format(
      'create trigger %I_touch before update on public.%I
       for each row execute function public.ai_touch_updated_at()', t, t);
  end loop;
end $$;


-- ============================================================
-- 14. Realtime
-- ============================================================
-- כדי שהמסך יראה שיחה חדשה, קטע תמלול ופעולה שבוצעה בלי רענון. RLS חל
-- גם על ערוצי Realtime, ולכן אין כאן חשיפה בין משרדים.
-- ה-DO block נדרש כי add table נכשל אם הטבלה כבר בפרסום.
do $$
declare t text;
begin
  foreach t in array array[
    'call_sessions','call_events','call_transcript_segments','call_actions',
    'voice_gateway_status'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
              when undefined_object then null;  -- הפרסום לא קיים בפרויקט הזה
    end;
  end loop;
end $$;
