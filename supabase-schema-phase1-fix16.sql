-- Schedules the daily reminder check (hearings/tasks/stuck-cases → push
-- notifications). Without this, check-and-send-reminders is deployed and working
-- (confirmed with a real test call) but nothing ever calls it.
--
-- Enabling extensions is a project-wide change, unlike the table/policy changes in
-- earlier fix files — running this is your call, not something to do silently.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- 06:00 UTC = 09:00 Israel time in summer (IDT, UTC+3), 08:00 in winter (IST, UTC+2)
-- — a reasonable "start of the work day" check either way. Change the cron
-- expression below if a different time suits better.
select cron.schedule(
  'daily-reminders-check',
  '0 6 * * *',
  $$
  select net.http_post(
    url := 'https://syxutnwbpjsvzlwfpvyc.supabase.co/functions/v1/check-and-send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
  $$
);

-- To check it's registered: select * from cron.job;
-- To remove it later: select cron.unschedule('daily-reminders-check');
