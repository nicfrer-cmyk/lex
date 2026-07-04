-- Subscription/billing scaffold (Grow/Meshulam). Kept as its own table, not columns
-- on `offices`, and deliberately given NO client-writable RLS policy at all — status
-- can only ever be set by server-side code holding the service_role key (the
-- create-payment-page / grow-webhook Edge Functions), which bypasses RLS by design.
-- If this lived on `offices` instead, the existing "owner can update their office"
-- policy would let any office owner set their own subscription_status='active'
-- straight from the browser console, skipping payment entirely.
create table if not exists public.subscriptions (
  office_id uuid primary key references public.offices(id) on delete cascade,
  status text not null default 'trial' check (status in ('trial','active','past_due','canceled')),
  plan text,
  grow_customer_id text, -- Grow/Meshulam's identifier for the recurring charge, once one exists
  trial_ends_at timestamptz not null default (now() + interval '14 days'),
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions_select_own_office" on public.subscriptions;
create policy "subscriptions_select_own_office" on public.subscriptions
  for select using (
    office_id in (select om.office_id from public.office_members om where om.user_id = auth.uid())
  );
-- No insert/update/delete policy for authenticated users — intentional (see above).

-- Every office gets a default trial subscription row automatically the moment it's
-- created. This runs as the function owner (effectively bypassing RLS), which is
-- what lets Platform.ensureSoloOffice() — running as the ordinary signed-in user via
-- the anon key — end up with a subscriptions row despite that table having no
-- client-facing insert policy.
create or replace function public.create_default_subscription()
returns trigger as $$
begin
  insert into public.subscriptions (office_id) values (new.id);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_create_default_subscription on public.offices;
create trigger trg_create_default_subscription
  after insert on public.offices
  for each row execute function public.create_default_subscription();

-- Backfill: offices created before this migration existed won't have a matching row.
insert into public.subscriptions (office_id)
select o.id from public.offices o
where not exists (select 1 from public.subscriptions s where s.office_id = o.id);
