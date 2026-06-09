create table if not exists public.work_reports (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null references public.work_orders(id),
  contractor_id uuid references public.profiles(id),
  technician_name text,
  arrival_time timestamptz,
  departure_time timestamptz,
  work_performed text,
  parts_used jsonb default '[]',
  resolution_code text,
  resolution_notes text,
  submitted_at timestamptz default now(),
  created_at timestamptz default now()
);

alter table public.work_reports enable row level security;

create policy work_reports_select on public.work_reports
  for select using (
    contractor_id = auth.uid()
    or exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('manager', 'dispatcher', 'back_office')
    )
  );

create policy work_reports_insert on public.work_reports
  for insert with check (
    contractor_id = auth.uid()
  );

create policy work_reports_update on public.work_reports
  for update using (
    contractor_id = auth.uid()
  );
