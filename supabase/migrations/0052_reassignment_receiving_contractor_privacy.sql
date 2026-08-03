-- A contractor assignment is a privacy boundary. The receiving contractor
-- must not inherit artifacts or workflow fields from a prior contractor.

begin;

alter table public.work_orders
  add column if not exists contractor_assignment_started_at timestamptz,
  add column if not exists contractor_assignment_version integer not null default 0;

-- Avoid making every existing work order look newly updated during backfill.
alter table public.work_orders disable trigger touch_wo;

update public.work_orders
set
  contractor_assignment_started_at = case
    when contractor_id is null then null
    else coalesce(contractor_assignment_started_at, dispatched_at, created_at, now())
  end,
  contractor_assignment_version = case
    when contractor_id is null then contractor_assignment_version
    else greatest(contractor_assignment_version, 1)
  end;

alter table public.work_orders enable trigger touch_wo;

create table if not exists public.work_order_assignment_history (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null
    references public.work_orders(id) on delete cascade,
  contractor_id uuid not null
    references public.profiles(id),
  next_contractor_id uuid
    references public.profiles(id),
  assignment_version integer not null,
  assignment_started_at timestamptz,
  assignment_ended_at timestamptz not null default now(),
  assignment_ended_by uuid
    references public.profiles(id),
  workflow_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_work_order_assignment_history_work_order
  on public.work_order_assignment_history(work_order_id, assignment_ended_at desc);

alter table public.work_order_assignment_history enable row level security;

drop policy if exists work_order_assignment_history_staff_read
  on public.work_order_assignment_history;
create policy work_order_assignment_history_staff_read
  on public.work_order_assignment_history
  for select using (public.is_staff());

drop policy if exists work_order_assignment_history_staff_write
  on public.work_order_assignment_history;
create policy work_order_assignment_history_staff_write
  on public.work_order_assignment_history
  for all using (public.is_staff())
  with check (public.is_staff());

revoke all on public.work_order_assignment_history from anon;
grant select, insert, update, delete
  on public.work_order_assignment_history to authenticated;
grant all on public.work_order_assignment_history to service_role;

create or replace function public.protect_work_order_assignment_boundary()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  boundary_at timestamptz := clock_timestamp();
  actor_role text := coalesce(auth.role(), '');
begin
  if tg_op = 'INSERT' then
    if new.contractor_id is null then
      new.contractor_assignment_started_at := null;
      new.contractor_assignment_version := 0;
    else
      new.contractor_assignment_started_at := coalesce(
        new.contractor_assignment_started_at,
        new.dispatched_at,
        boundary_at
      );
      new.contractor_assignment_version := greatest(
        coalesce(new.contractor_assignment_version, 0),
        1
      );
    end if;
    return new;
  end if;

  if new.contractor_id is not distinct from old.contractor_id then
    -- Assignment boundaries are system-owned and cannot be edited directly.
    new.contractor_assignment_started_at := old.contractor_assignment_started_at;
    new.contractor_assignment_version := old.contractor_assignment_version;
    return new;
  end if;

  if actor_role not in ('service_role', '') and not public.is_staff() then
    raise exception 'Only staff can change a work order assignment'
      using errcode = '42501';
  end if;

  if old.contractor_id is not null then
    insert into public.work_order_assignment_history (
      work_order_id,
      contractor_id,
      next_contractor_id,
      assignment_version,
      assignment_started_at,
      assignment_ended_at,
      assignment_ended_by,
      workflow_snapshot
    ) values (
      old.id,
      old.contractor_id,
      new.contractor_id,
      greatest(old.contractor_assignment_version, 1),
      old.contractor_assignment_started_at,
      boundary_at,
      auth.uid(),
      jsonb_build_object(
        'status', old.status,
        'functionalStatus', old.functional_status,
        'eta', old.eta,
        'dispatchedAt', old.dispatched_at,
        'startTime', old.start_time,
        'endTime', old.end_time,
        'technicianOnJob', old.technician_on_job,
        'assetMake', old.asset_make,
        'assetModel', old.asset_model,
        'assetSerial', old.asset_serial,
        'assetYear', old.asset_year,
        'resolutionCode', old.resolution_code,
        'resolutionNotes', old.resolution_notes,
        'partNeeded', old.part_needed,
        'partEta', old.part_eta,
        'invoiceTotal', old.invoice_total,
        'repairQuote', old.repair_quote,
        'installQuote', old.install_quote,
        'capitalNotes', old.capital_notes,
        'isCapital', old.is_capital,
        'capitalStatus', old.capital_status,
        'nteFlagged', old.nte_flagged,
        'nteFlagAmount', old.nte_flag_amount
      )
    );

    -- These columns are contractor workflow output. Preserve them in the
    -- staff-only archive, then start the receiving contractor with a clean job.
    new.eta := null;
    new.start_time := null;
    new.end_time := null;
    new.technician_on_job := null;
    new.asset_make := null;
    new.asset_model := null;
    new.asset_serial := null;
    new.asset_year := null;
    new.resolution_code := null;
    new.resolution_notes := null;
    new.part_needed := null;
    new.part_eta := null;
    new.invoice_total := null;
    new.repair_quote := null;
    new.install_quote := null;
    new.capital_notes := null;
    new.is_capital := false;
    new.capital_status := null;
    new.nte_flagged := false;
    new.nte_flag_amount := null;
  end if;

  new.contractor_assignment_version := old.contractor_assignment_version + 1;

  if new.contractor_id is null then
    new.contractor_assignment_started_at := null;
    new.dispatched_at := null;
    new.status := 'unassigned';
    new.functional_status := 'New';
  else
    new.contractor_assignment_started_at := boundary_at;
    new.dispatched_at := boundary_at;
    new.status := 'assigned';
    new.functional_status := 'Dispatched';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_work_order_assignment_boundary_trigger
  on public.work_orders;
create trigger protect_work_order_assignment_boundary_trigger
  before insert or update of contractor_id,
    contractor_assignment_started_at,
    contractor_assignment_version
  on public.work_orders
  for each row execute function public.protect_work_order_assignment_boundary();

-- A receiving contractor sees only activity created during their current
-- assignment. Staff retain the complete timeline across every assignment.
drop policy if exists act_read on public.activities;
create policy act_read on public.activities
  for select using (
    public.is_staff()
    or (
      is_staff_only = false
      and exists (
        select 1
        from public.work_orders w
        where w.id = work_order_id
          and w.contractor_id = auth.uid()
          and w.deleted_at is null
          and w.contractor_assignment_started_at is not null
          and activities.created_at >= w.contractor_assignment_started_at
      )
    )
  );

drop policy if exists act_update on public.activities;
create policy act_update on public.activities
  for update using (
    public.is_staff()
    or (
      author_id = auth.uid()
      and entered_by_role = 'contractor'
      and is_staff_override = false
      and override_for_contractor_id is null
      and exists (
        select 1
        from public.work_orders w
        where w.id = work_order_id
          and w.contractor_id = auth.uid()
          and w.deleted_at is null
          and w.contractor_assignment_started_at is not null
          and activities.created_at >= w.contractor_assignment_started_at
      )
    )
  )
  with check (
    public.is_staff()
    or (
      author_id = auth.uid()
      and entered_by_role = 'contractor'
      and is_staff_override = false
      and override_for_contractor_id is null
    )
  );

-- Photo metadata and binary objects follow the same assignment boundary.
drop policy if exists photo_read on public.photos;
create policy photo_read on public.photos
  for select using (
    public.is_staff()
    or exists (
      select 1
      from public.work_orders w
      where w.id = work_order_id
        and w.contractor_id = auth.uid()
        and w.deleted_at is null
        and w.contractor_assignment_started_at is not null
        and photos.created_at >= w.contractor_assignment_started_at
    )
  );

drop policy if exists photo_delete on public.photos;
create policy photo_delete on public.photos
  for delete using (
    public.is_staff()
    or (
      uploader_id = auth.uid()
      and exists (
        select 1
        from public.work_orders w
        where w.id = work_order_id
          and w.contractor_id = auth.uid()
          and w.deleted_at is null
          and w.contractor_assignment_started_at is not null
          and photos.created_at >= w.contractor_assignment_started_at
      )
    )
  );

drop policy if exists photos_read on storage.objects;
create policy photos_read on storage.objects
  for select using (
    bucket_id = 'photos'
    and (
      public.is_staff()
      or exists (
        select 1
        from public.photos p
        join public.work_orders w on w.id = p.work_order_id
        where p.storage_path = name
          and w.contractor_id = auth.uid()
          and w.deleted_at is null
          and w.contractor_assignment_started_at is not null
          and p.created_at >= w.contractor_assignment_started_at
      )
    )
  );

drop policy if exists photos_delete on storage.objects;
create policy photos_delete on storage.objects
  for delete using (
    bucket_id = 'photos'
    and (
      public.is_staff()
      or exists (
        select 1
        from public.photos p
        join public.work_orders w on w.id = p.work_order_id
        where p.storage_path = name
          and p.uploader_id = auth.uid()
          and w.contractor_id = auth.uid()
          and w.deleted_at is null
          and w.contractor_assignment_started_at is not null
          and p.created_at >= w.contractor_assignment_started_at
      )
    )
  );

-- Parts entered under an earlier assignment stay available to staff only.
drop policy if exists wo_parts_select on public.wo_parts;
create policy wo_parts_select on public.wo_parts
  for select using (
    public.is_staff()
    or exists (
      select 1
      from public.work_orders w
      where w.id = work_order_id
        and w.contractor_id = auth.uid()
        and w.deleted_at is null
        and w.contractor_assignment_started_at is not null
        and wo_parts.created_at >= w.contractor_assignment_started_at
    )
  );

drop policy if exists wo_parts_update on public.wo_parts;
create policy wo_parts_update on public.wo_parts
  for update using (
    public.is_staff()
    or exists (
      select 1
      from public.work_orders w
      where w.id = work_order_id
        and w.contractor_id = auth.uid()
        and w.deleted_at is null
        and w.contractor_assignment_started_at is not null
        and wo_parts.created_at >= w.contractor_assignment_started_at
    )
  )
  with check (
    public.is_staff()
    or exists (
      select 1
      from public.work_orders w
      where w.id = work_order_id
        and w.contractor_id = auth.uid()
        and w.deleted_at is null
    )
  );

-- Reports and visits already carry their contractor identity. Require that
-- identity to still match the active parent assignment for raw API access.
drop policy if exists work_reports_select on public.work_reports;
create policy work_reports_select on public.work_reports
  for select using (
    public.is_staff()
    or (
      contractor_id = auth.uid()
      and exists (
        select 1
        from public.work_orders w
        where w.id = work_order_id
          and w.contractor_id = auth.uid()
          and w.deleted_at is null
      )
    )
  );

drop policy if exists work_reports_update on public.work_reports;
create policy work_reports_update on public.work_reports
  for update using (
    public.is_staff()
    or (
      contractor_id = auth.uid()
      and exists (
        select 1
        from public.work_orders w
        where w.id = work_order_id
          and w.contractor_id = auth.uid()
          and w.deleted_at is null
      )
    )
  )
  with check (
    public.is_staff()
    or contractor_id = auth.uid()
  );

-- The legacy service_notes policy exposed every note to every signed-in user.
-- Bring it under the same parent and assignment-boundary rules.
drop policy if exists service_notes_read on public.service_notes;
create policy service_notes_read on public.service_notes
  for select using (
    public.is_staff()
    or exists (
      select 1
      from public.work_orders w
      where w.id = work_order_id
        and w.contractor_id = auth.uid()
        and w.deleted_at is null
        and w.contractor_assignment_started_at is not null
        and service_notes.created_at >= w.contractor_assignment_started_at
    )
  );

drop policy if exists service_notes_insert on public.service_notes;
create policy service_notes_insert on public.service_notes
  for insert with check (
    public.is_staff()
    or (
      created_by_id = auth.uid()
      and exists (
        select 1
        from public.work_orders w
        where w.id = work_order_id
          and w.contractor_id = auth.uid()
          and w.deleted_at is null
      )
    )
  );

drop policy if exists service_notes_update on public.service_notes;
create policy service_notes_update on public.service_notes
  for update using (
    public.is_staff()
    or (
      created_by_id = auth.uid()
      and exists (
        select 1
        from public.work_orders w
        where w.id = work_order_id
          and w.contractor_id = auth.uid()
          and w.deleted_at is null
          and w.contractor_assignment_started_at is not null
          and service_notes.created_at >= w.contractor_assignment_started_at
      )
    )
  );

-- Contractor accounts do not need a directory of competing contractors.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select using (
    auth.uid() = id
    or public.get_my_role() in ('manager', 'dispatcher', 'back_office')
  );

commit;
