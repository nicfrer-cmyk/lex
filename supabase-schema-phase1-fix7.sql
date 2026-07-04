-- office_members had no email column, so the team list in Settings could only show
-- each member's raw user_id (truncated to 8 chars — unreadable). Looking up another
-- user's email after the fact needs the Supabase service_role key (admin API), which
-- this project doesn't have configured. Cheaper fix: capture the email at the moment
-- each member joins (app.js/platform.web.js already know their own logged-in email
-- at that point) and store it directly, no admin API needed.
alter table public.office_members add column if not exists email text;
