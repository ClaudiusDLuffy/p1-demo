-- Structured parts-tracking list per work order. Replaces the single
-- part_needed/part_eta scalar pair as the source of truth going forward;
-- those columns stay populated as a fallback for historical WOs.
-- Status enum kept simple per Lindsay 2026-06-18:
--   ordered → backordered → shipped → received
-- "Installed" is just job progress and lives elsewhere.

create table if not exists public.wo_parts (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null references public.work_orders(id) on delete cascade,
  description text not null,
  part_number text,
  qty numeric default 1,
  status text not null default 'ordered'
    check (status in ('ordered','backordered','shipped','received')),
  tracking_number text,
  expected_return_date date,
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_wo_parts_wo on public.wo_parts(work_order_id);
create index if not exists idx_wo_parts_status on public.wo_parts(status);

alter table public.wo_parts enable row level security;

-- READ: contractor assigned to the WO, or any staff role.
create policy wo_parts_select on public.wo_parts
  for select using (
    exists (
      select 1 from public.work_orders w
      where w.id = work_order_id
      and (
        w.contractor_id = auth.uid()
        or exists (
          select 1 from public.profiles p
          where p.id = auth.uid()
          and p.role in ('manager', 'dispatcher', 'back_office')
        )
      )
    )
  );

-- INSERT: contractor on their WO, or any staff role.
create policy wo_parts_insert on public.wo_parts
  for insert with check (
    exists (
      select 1 from public.work_orders w
      where w.id = work_order_id
      and w.deleted_at is null
      and (
        w.contractor_id = auth.uid()
        or exists (
          select 1 from public.profiles p
          where p.id = auth.uid()
          and p.role in ('manager', 'dispatcher', 'back_office')
        )
      )
    )
  );

-- UPDATE: same as insert — contractor on their WO, or staff.
create policy wo_parts_update on public.wo_parts
  for update using (
    exists (
      select 1 from public.work_orders w
      where w.id = work_order_id
      and (
        w.contractor_id = auth.uid()
        or exists (
          select 1 from public.profiles p
          where p.id = auth.uid()
          and p.role in ('manager', 'dispatcher', 'back_office')
        )
      )
    )
  );

-- DELETE: staff only. Contractors mark status, they don't erase history.
create policy wo_parts_delete on public.wo_parts
  for delete using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
      and p.role in ('manager', 'dispatcher', 'back_office')
    )
  );

grant select on public.wo_parts to anon;
grant select, insert, update, delete on public.wo_parts to authenticated;

-- Add to the supabase_realtime publication so the PortalShell channel gets
-- live INSERT/UPDATE/DELETE events. Wrapped in a DO block because ALTER
-- PUBLICATION has no IF NOT EXISTS; ignore the duplicate-add error if it's
-- already in there.
do $$
begin
  alter publication supabase_realtime add table public.wo_parts;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

comment on table public.wo_parts is
  'Structured per-WO parts list — replaces the part_needed/part_eta scalars as source of truth going forward. Contractors update status/tracking as parts move ordered → shipped → received.';
