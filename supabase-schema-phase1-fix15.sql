-- Push notifications: hearing reminders, task-due reminders, and stuck-case alerts.
-- See supabase/functions/send-push-notification and check-and-send-reminders.

-- One row per subscribed browser/device. A user can have several (phone + desktop).
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  office_id uuid not null references public.offices(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions_own" on public.push_subscriptions;
create policy "push_subscriptions_own" on public.push_subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Dedup tracking so the daily reminder check doesn't re-notify the same hearing/task/
-- stuck-case every time it runs. item_id is the case/task/event's own id (from the
-- office's app_data JSON blob — there's no normalized events/tasks table to key off).
create table if not exists public.sent_reminders (
  office_id uuid not null references public.offices(id) on delete cascade,
  item_type text not null check (item_type in ('hearing','task','stuck_case')),
  item_id text not null,
  sent_at timestamptz not null default now(),
  primary key (office_id, item_type, item_id)
);
alter table public.sent_reminders enable row level security;
-- No client-facing policy at all: only service_role (the check-and-send-reminders
-- function) ever reads or writes this table — it's bookkeeping, not something a
-- user needs to see or could usefully edit.
