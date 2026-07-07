create table if not exists public.email_intake_log (
  id uuid primary key default gen_random_uuid(),
  email_id text not null,
  subject text,
  action text not null,
  work_order_id text,
  reason text,
  parse_confidence text,
  contractor_assigned text,
  raw_subject text,
  raw_from text,
  processed_at timestamptz default now(),
  created_at timestamptz default now()
);

alter table public.email_intake_log
  enable row level security;

create policy email_intake_log_read
  on public.email_intake_log
  for select using (
    public.get_my_role() in ('manager', 'dispatcher', 'back_office')
  );

create policy email_intake_log_insert
  on public.email_intake_log
  for insert with check (true);

grant select on public.email_intake_log to authenticated;
grant insert on public.email_intake_log to authenticated;
grant all on public.email_intake_log to service_role;
