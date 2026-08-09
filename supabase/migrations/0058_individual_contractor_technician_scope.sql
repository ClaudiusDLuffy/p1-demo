-- Company-owned work orders keep their canonical contractor identity while
-- report-only portal technicians receive access only to jobs explicitly
-- assigned to their own login. The existing technician_on_job text remains a
-- durable display snapshot; authorization uses profile ids.

begin;

alter table public.contractor_technicians
  add column if not exists profile_id uuid
    references public.profiles(id) on delete set null;

create unique index if not exists contractor_technicians_profile_unique
  on public.contractor_technicians(profile_id)
  where profile_id is not null;

alter table public.work_orders
  add column if not exists assigned_technician_profile_id uuid
    references public.profiles(id) on delete set null,
  add column if not exists technician_assigned_at timestamptz,
  add column if not exists technician_assigned_by uuid
    references public.profiles(id) on delete set null;

create index if not exists work_orders_assigned_technician_active
  on public.work_orders(assigned_technician_profile_id, updated_at desc)
  where assigned_technician_profile_id is not null
    and deleted_at is null;

create table if not exists public.work_order_technician_assignments (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null
    references public.work_orders(id) on delete cascade,
  technician_profile_id uuid not null
    references public.profiles(id),
  assigned_at timestamptz not null default now(),
  assigned_by uuid references public.profiles(id) on delete set null,
  ended_at timestamptz,
  ended_by uuid references public.profiles(id) on delete set null,
  constraint work_order_technician_assignment_dates check (
    ended_at is null or ended_at >= assigned_at
  )
);

create unique index if not exists work_order_technician_one_current
  on public.work_order_technician_assignments(work_order_id)
  where ended_at is null;

create index if not exists work_order_technician_history
  on public.work_order_technician_assignments(
    work_order_id,
    assigned_at desc
  );

create index if not exists technician_work_order_history
  on public.work_order_technician_assignments(
    technician_profile_id,
    assigned_at desc
  );

create or replace function public.contractor_account_id_for_profile(
  p_profile_id uuid
)
returns uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select case
    when profile.role <> 'contractor' or profile.active is not true then null
    when profile.contractor_organization_id is not null
      then organization.canonical_contractor_id
    else profile.id
  end
  from public.profiles profile
  left join public.organizations organization
    on organization.id = profile.contractor_organization_id
   and organization.active = true
  where profile.id = p_profile_id
$$;

create or replace function public.can_access_contractor_work_order(
  p_work_order_id text
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.is_staff()
    or exists (
      select 1
      from public.work_orders work_order
      join public.profiles viewer
        on viewer.id = auth.uid()
       and viewer.role = 'contractor'
       and viewer.active = true
      left join public.organizations organization
        on organization.id = viewer.contractor_organization_id
       and organization.active = true
      where work_order.id = p_work_order_id
        and work_order.deleted_at is null
        and work_order.contractor_id = case
          when viewer.contractor_organization_id is not null
            then organization.canonical_contractor_id
          else viewer.id
        end
        and (
          viewer.contractor_organization_id is null
          or viewer.contractor_access_level in ('company_admin', 'invoice')
          or (
            viewer.contractor_access_level = 'report_only'
            and work_order.assigned_technician_profile_id = viewer.id
          )
        )
    )
$$;

create or replace function public.can_manage_work_order_technician(
  p_work_order_id text
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.is_staff()
    or exists (
      select 1
      from public.work_orders work_order
      join public.profiles viewer
        on viewer.id = auth.uid()
       and viewer.role = 'contractor'
       and viewer.active = true
       and viewer.contractor_access_level = 'company_admin'
      join public.organizations organization
        on organization.id = viewer.contractor_organization_id
       and organization.active = true
       and organization.canonical_contractor_id = work_order.contractor_id
      where work_order.id = p_work_order_id
        and work_order.deleted_at is null
    )
$$;

revoke all on function public.contractor_account_id_for_profile(uuid)
  from public, anon;
revoke all on function public.can_access_contractor_work_order(text)
  from public, anon;
revoke all on function public.can_manage_work_order_technician(text)
  from public, anon;
grant execute on function public.contractor_account_id_for_profile(uuid),
  public.can_access_contractor_work_order(text),
  public.can_manage_work_order_technician(text)
  to authenticated, service_role;

create or replace function public.validate_contractor_technician_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.profile_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.profiles profile
    where profile.id = new.profile_id
      and profile.role = 'contractor'
      and profile.active = true
      and profile.contractor_access_level = 'report_only'
      and public.contractor_account_id_for_profile(profile.id)
        = new.contractor_id
  ) then
    raise exception 'Portal technician must be an active report-only member of this contractor company'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_contractor_technician_profile_trigger
  on public.contractor_technicians;
create trigger validate_contractor_technician_profile_trigger
  before insert or update of contractor_id, profile_id
  on public.contractor_technicians
  for each row execute function public.validate_contractor_technician_profile();

create or replace function public.protect_work_order_technician_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_role text := coalesce(auth.role(), '');
  technician_name text;
  assignment_changed boolean :=
    new.assigned_technician_profile_id
      is distinct from old.assigned_technician_profile_id;
  snapshot_changed boolean :=
    new.technician_on_job is distinct from old.technician_on_job;
begin
  if not assignment_changed and not snapshot_changed then
    return new;
  end if;

  if actor_role not in ('service_role', '') then
    if assignment_changed and not public.can_manage_work_order_technician(old.id) then
      raise exception 'Only P1 staff or a company administrator can assign a portal technician'
        using errcode = '42501';
    end if;

    if not assignment_changed
       and new.assigned_technician_profile_id is not null
       and not public.can_manage_work_order_technician(old.id) then
      raise exception 'Only P1 staff or a company administrator can change the assigned technician'
        using errcode = '42501';
    end if;

    if not assignment_changed
       and new.assigned_technician_profile_id is null
       and not public.can_access_contractor_work_order(old.id) then
      raise exception 'Technician snapshot update is not permitted'
        using errcode = '42501';
    end if;
  end if;

  if new.assigned_technician_profile_id is null then
    if assignment_changed then
      new.technician_on_job := null;
      new.technician_assigned_at := null;
      new.technician_assigned_by := null;
    end if;
    return new;
  end if;

  select profile.name
  into technician_name
  from public.profiles profile
  join public.contractor_technicians technician
    on technician.profile_id = profile.id
   and technician.contractor_id = new.contractor_id
   and technician.is_active = true
  where profile.id = new.assigned_technician_profile_id
    and profile.role = 'contractor'
    and profile.active = true
    and profile.contractor_access_level = 'report_only'
    and public.contractor_account_id_for_profile(profile.id)
      = new.contractor_id;

  if technician_name is null then
    raise exception 'Selected technician is not an active report-only member of the assigned contractor company'
      using errcode = '23514';
  end if;

  new.technician_on_job := technician_name;
  if assignment_changed then
    new.technician_assigned_at := now();
    new.technician_assigned_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists protect_work_order_technician_assignment_trigger
  on public.work_orders;
create trigger protect_work_order_technician_assignment_trigger
  before update of assigned_technician_profile_id, technician_on_job
  on public.work_orders
  for each row execute function public.protect_work_order_technician_assignment();

create or replace function public.record_work_order_technician_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.assigned_technician_profile_id
     is not distinct from old.assigned_technician_profile_id then
    return new;
  end if;

  update public.work_order_technician_assignments assignment
  set ended_at = now(),
      ended_by = auth.uid()
  where assignment.work_order_id = new.id
    and assignment.ended_at is null;

  if new.assigned_technician_profile_id is not null then
    insert into public.work_order_technician_assignments (
      work_order_id,
      technician_profile_id,
      assigned_at,
      assigned_by
    ) values (
      new.id,
      new.assigned_technician_profile_id,
      coalesce(new.technician_assigned_at, now()),
      new.technician_assigned_by
    );
  end if;

  return new;
end;
$$;

drop trigger if exists record_work_order_technician_assignment_trigger
  on public.work_orders;
create trigger record_work_order_technician_assignment_trigger
  after update of assigned_technician_profile_id
  on public.work_orders
  for each row execute function public.record_work_order_technician_assignment();

create or replace function public.assign_contractor_technician(
  p_work_order_id text,
  p_technician_profile_id uuid
)
returns public.work_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_name text;
  work_order public.work_orders%rowtype;
  technician_name text;
begin
  if actor_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  if not public.can_manage_work_order_technician(p_work_order_id) then
    raise exception 'Only P1 staff or the contractor company administrator can assign technicians'
      using errcode = '42501';
  end if;

  select *
  into work_order
  from public.work_orders
  where id = p_work_order_id
    and deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found'
      using errcode = 'P0002';
  end if;

  if p_technician_profile_id is not null then
    select profile.name
    into technician_name
    from public.profiles profile
    join public.contractor_technicians technician
      on technician.profile_id = profile.id
     and technician.contractor_id = work_order.contractor_id
     and technician.is_active = true
    where profile.id = p_technician_profile_id
      and profile.role = 'contractor'
      and profile.active = true
      and profile.contractor_access_level = 'report_only'
      and public.contractor_account_id_for_profile(profile.id)
        = work_order.contractor_id;

    if technician_name is null then
      raise exception 'Technician is not an active report-only member of this contractor company'
        using errcode = '22023';
    end if;
  end if;

  update public.work_orders
  set assigned_technician_profile_id = p_technician_profile_id,
      updated_at = now()
  where id = p_work_order_id
  returning * into work_order;

  select name into actor_name
  from public.profiles
  where id = actor_id;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data
  ) values (
    p_work_order_id,
    actor_id,
    coalesce(actor_name, 'Portal user'),
    case
      when p_technician_profile_id is null then 'Technician assignment cleared.'
      else format('Technician on job set to %s.', technician_name)
    end,
    'note',
    'technician_updated',
    jsonb_build_object(
      'technicianProfileId', p_technician_profile_id,
      'technician', technician_name
    )
  );

  return work_order;
end;
$$;

revoke all on function public.assign_contractor_technician(text, uuid)
  from public, anon;
grant execute on function public.assign_contractor_technician(text, uuid)
  to authenticated, service_role;

alter table public.work_order_technician_assignments enable row level security;

drop policy if exists work_order_technician_assignments_read
  on public.work_order_technician_assignments;
create policy work_order_technician_assignments_read
  on public.work_order_technician_assignments
  for select using (
    public.is_staff()
    or public.can_manage_work_order_technician(work_order_id)
  );

drop policy if exists work_order_technician_assignments_write
  on public.work_order_technician_assignments;
create policy work_order_technician_assignments_write
  on public.work_order_technician_assignments
  for all using (public.is_staff())
  with check (public.is_staff());

revoke all on public.work_order_technician_assignments from anon;
grant select on public.work_order_technician_assignments to authenticated;
grant all on public.work_order_technician_assignments to service_role;

drop policy if exists wo_read on public.work_orders;
create policy wo_read on public.work_orders
  for select using (public.can_access_contractor_work_order(id));

drop policy if exists wo_update on public.work_orders;
create policy wo_update on public.work_orders
  for update using (public.can_access_contractor_work_order(id))
  with check (public.can_access_contractor_work_order(id));

drop policy if exists ct_read on public.contractor_technicians;
create policy ct_read on public.contractor_technicians
  for select using (
    public.is_staff()
    or profile_id = auth.uid()
    or exists (
      select 1
      from public.profiles viewer
      join public.organizations organization
        on organization.id = viewer.contractor_organization_id
       and organization.active = true
       and organization.canonical_contractor_id
         = contractor_technicians.contractor_id
      where viewer.id = auth.uid()
        and viewer.role = 'contractor'
        and viewer.active = true
        and viewer.contractor_access_level = 'company_admin'
    )
  );

drop policy if exists act_read on public.activities;
create policy act_read on public.activities
  for select using (
    public.is_staff()
    or (
      is_staff_only = false
      and public.can_access_contractor_work_order(work_order_id)
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = activities.work_order_id
          and work_order.contractor_assignment_started_at is not null
          and activities.contractor_assignment_version
            = work_order.contractor_assignment_version
          and activities.created_at >= work_order.contractor_assignment_started_at
      )
    )
  );

drop policy if exists act_insert on public.activities;
create policy act_insert on public.activities
  for insert with check (
    author_id = auth.uid()
    and public.can_access_contractor_work_order(work_order_id)
    and (
      (
        public.is_staff()
        and entered_by_role in ('manager', 'dispatcher', 'back_office')
      )
      or (
        entered_by_role = 'contractor'
        and is_staff_override = false
        and is_staff_only = false
        and override_for_contractor_id is null
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
      and public.can_access_contractor_work_order(work_order_id)
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = activities.work_order_id
          and work_order.contractor_assignment_started_at is not null
          and activities.contractor_assignment_version
            = work_order.contractor_assignment_version
          and activities.created_at >= work_order.contractor_assignment_started_at
      )
    )
  )
  with check (
    public.is_staff()
    or (
      author_id = auth.uid()
      and entered_by_role = 'contractor'
      and is_staff_override = false
      and is_staff_only = false
      and override_for_contractor_id is null
      and public.can_access_contractor_work_order(work_order_id)
    )
  );

drop policy if exists photo_read on public.photos;
create policy photo_read on public.photos
  for select using (
    public.is_staff()
    or (
      public.can_access_contractor_work_order(work_order_id)
      and exists (
        select 1 from public.work_orders work_order
        where work_order.id = photos.work_order_id
          and work_order.contractor_assignment_started_at is not null
          and photos.created_at >= work_order.contractor_assignment_started_at
      )
    )
  );

drop policy if exists photo_insert on public.photos;
create policy photo_insert on public.photos
  for insert with check (
    (public.is_staff() or uploader_id = auth.uid())
    and public.can_access_contractor_work_order(work_order_id)
  );

drop policy if exists photo_delete on public.photos;
create policy photo_delete on public.photos
  for delete using (
    public.is_staff()
    or (
      uploader_id = auth.uid()
      and public.can_access_contractor_work_order(work_order_id)
      and exists (
        select 1 from public.work_orders work_order
        where work_order.id = photos.work_order_id
          and work_order.contractor_assignment_started_at is not null
          and photos.created_at >= work_order.contractor_assignment_started_at
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
        from public.photos photo
        join public.work_orders work_order
          on work_order.id = photo.work_order_id
        where photo.storage_path = name
          and public.can_access_contractor_work_order(work_order.id)
          and work_order.contractor_assignment_started_at is not null
          and photo.created_at >= work_order.contractor_assignment_started_at
      )
    )
  );

drop policy if exists photos_insert on storage.objects;
create policy photos_insert on storage.objects
  for insert with check (
    bucket_id = 'photos'
    and split_part(name, '/', 1) = 'wo'
    and public.can_access_contractor_work_order(split_part(name, '/', 2))
  );

drop policy if exists photos_delete on storage.objects;
create policy photos_delete on storage.objects
  for delete using (
    bucket_id = 'photos'
    and (
      public.is_staff()
      or exists (
        select 1
        from public.photos photo
        join public.work_orders work_order
          on work_order.id = photo.work_order_id
        where photo.storage_path = name
          and photo.uploader_id = auth.uid()
          and public.can_access_contractor_work_order(work_order.id)
          and work_order.contractor_assignment_started_at is not null
          and photo.created_at >= work_order.contractor_assignment_started_at
      )
    )
  );

drop policy if exists wo_parts_select on public.wo_parts;
create policy wo_parts_select on public.wo_parts
  for select using (
    public.is_staff()
    or (
      public.can_access_contractor_work_order(work_order_id)
      and exists (
        select 1 from public.work_orders work_order
        where work_order.id = wo_parts.work_order_id
          and work_order.contractor_assignment_started_at is not null
          and wo_parts.created_at >= work_order.contractor_assignment_started_at
      )
    )
  );

drop policy if exists wo_parts_insert on public.wo_parts;
create policy wo_parts_insert on public.wo_parts
  for insert with check (
    (public.is_staff() or created_by = auth.uid())
    and public.can_access_contractor_work_order(work_order_id)
  );

drop policy if exists wo_parts_update on public.wo_parts;
create policy wo_parts_update on public.wo_parts
  for update using (
    public.is_staff()
    or (
      public.can_access_contractor_work_order(work_order_id)
      and exists (
        select 1 from public.work_orders work_order
        where work_order.id = wo_parts.work_order_id
          and work_order.contractor_assignment_started_at is not null
          and wo_parts.created_at >= work_order.contractor_assignment_started_at
      )
    )
  )
  with check (
    public.is_staff()
    or public.can_access_contractor_work_order(work_order_id)
  );

drop policy if exists service_notes_read on public.service_notes;
create policy service_notes_read on public.service_notes
  for select using (
    public.is_staff()
    or (
      public.can_access_contractor_work_order(work_order_id)
      and exists (
        select 1 from public.work_orders work_order
        where work_order.id = service_notes.work_order_id
          and work_order.contractor_assignment_started_at is not null
          and service_notes.created_at >= work_order.contractor_assignment_started_at
      )
    )
  );

drop policy if exists service_notes_insert on public.service_notes;
create policy service_notes_insert on public.service_notes
  for insert with check (
    (public.is_staff() or created_by_id = auth.uid())
    and public.can_access_contractor_work_order(work_order_id)
  );

drop policy if exists service_notes_update on public.service_notes;
create policy service_notes_update on public.service_notes
  for update using (
    public.is_staff()
    or (
      created_by_id = auth.uid()
      and public.can_access_contractor_work_order(work_order_id)
      and exists (
        select 1 from public.work_orders work_order
        where work_order.id = service_notes.work_order_id
          and work_order.contractor_assignment_started_at is not null
          and service_notes.created_at >= work_order.contractor_assignment_started_at
      )
    )
  );

drop policy if exists work_reports_select on public.work_reports;
create policy work_reports_select on public.work_reports
  for select using (
    public.is_staff()
    or (
      public.can_access_contractor_work_order(work_order_id)
      and exists (
        select 1 from public.work_orders work_order
        where work_order.id = work_reports.work_order_id
          and work_order.contractor_id = work_reports.contractor_id
          and work_order.contractor_assignment_started_at is not null
          and work_reports.created_at >= work_order.contractor_assignment_started_at
      )
    )
  );

drop policy if exists work_reports_insert on public.work_reports;
create policy work_reports_insert on public.work_reports
  for insert with check (
    contractor_id = public.current_contractor_account_id()
    and submitted_by = auth.uid()
    and public.can_access_contractor_work_order(work_order_id)
  );

drop policy if exists work_reports_update on public.work_reports;
create policy work_reports_update on public.work_reports
  for update using (
    public.is_staff()
    or (
      public.can_access_contractor_work_order(work_order_id)
      and (
        submitted_by = auth.uid()
        or public.can_manage_contractor_company()
      )
    )
  )
  with check (
    public.is_staff()
    or (
      contractor_id = public.current_contractor_account_id()
      and public.can_access_contractor_work_order(work_order_id)
      and (
        submitted_by = auth.uid()
        or public.can_manage_contractor_company()
      )
    )
  );

drop policy if exists work_order_visits_read on public.work_order_visits;
create policy work_order_visits_read on public.work_order_visits
  for select using (
    public.is_staff()
    or (
      public.can_access_contractor_work_order(work_order_id)
      and exists (
        select 1 from public.work_orders work_order
        where work_order.id = work_order_visits.work_order_id
          and work_order.contractor_id = work_order_visits.contractor_id
          and work_order.contractor_assignment_started_at is not null
          and work_order_visits.created_at >= work_order.contractor_assignment_started_at
      )
    )
  );

drop policy if exists work_order_visits_insert on public.work_order_visits;
create policy work_order_visits_insert on public.work_order_visits
  for insert with check (
    public.is_staff()
    or (
      contractor_id = public.current_contractor_account_id()
      and checked_in_by = auth.uid()
      and check_out_at is null
      and checked_out_by is null
      and public.can_access_contractor_work_order(work_order_id)
    )
  );

drop policy if exists work_order_visits_update on public.work_order_visits;
create policy work_order_visits_update on public.work_order_visits
  for update using (
    public.is_staff()
    or (
      public.can_access_contractor_work_order(work_order_id)
      and (
        checked_in_by = auth.uid()
        or public.can_manage_contractor_company()
      )
    )
  )
  with check (
    public.is_staff()
    or (
      contractor_id = public.current_contractor_account_id()
      and checked_out_by = auth.uid()
      and public.can_access_contractor_work_order(work_order_id)
    )
  );

create or replace function public.acknowledge_contractor_attention(
  p_activity_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  update public.activities activity
  set contractor_attention_acknowledged_at = now(),
      contractor_attention_acknowledged_by = auth.uid()
  where activity.id = p_activity_id
    and activity.requires_contractor_attention = true
    and activity.contractor_attention_acknowledged_at is null
    and activity.deleted_at is null
    and public.can_access_contractor_work_order(activity.work_order_id)
    and exists (
      select 1 from public.work_orders work_order
      where work_order.id = activity.work_order_id
        and work_order.contractor_assignment_started_at is not null
        and activity.contractor_assignment_version
          = work_order.contractor_assignment_version
        and activity.created_at >= work_order.contractor_assignment_started_at
    );

  if not found then
    raise exception 'Pending contractor attention item not found'
      using errcode = '42501';
  end if;
end;
$$;

drop policy if exists inv_read on public.invoices;
create policy inv_read on public.invoices
  for select using (
    deleted_at is null
    and (
      (
        public.is_staff()
        and (
          not public.is_invoice_controller()
          or invoice_type = 'staff'
          or state in ('approved', 'paid')
        )
      )
      or (
        invoice_type = 'contractor'
        and public.can_invoice_for_contractor(contractor_id)
        and public.can_access_contractor_work_order(work_order_id)
        and exists (
          select 1 from public.work_orders work_order
          where work_order.id = invoices.work_order_id
            and work_order.contractor_id = invoices.contractor_id
            and work_order.contractor_assignment_started_at is not null
            and invoices.created_at >= work_order.contractor_assignment_started_at
        )
      )
    )
  );

drop policy if exists line_read on public.invoice_lines;
create policy line_read on public.invoice_lines
  for select using (
    exists (
      select 1 from public.invoices invoice
      where invoice.id = invoice_lines.invoice_id
        and invoice.deleted_at is null
        and (
          (
            public.is_staff()
            and (
              not public.is_invoice_controller()
              or invoice.invoice_type = 'staff'
              or invoice.state in ('approved', 'paid')
            )
          )
          or (
            invoice.invoice_type = 'contractor'
            and public.can_invoice_for_contractor(invoice.contractor_id)
            and public.can_access_contractor_work_order(invoice.work_order_id)
          )
        )
    )
  );

drop policy if exists invoice_pdfs_read on storage.objects;
create policy invoice_pdfs_read on storage.objects
  for select using (
    bucket_id = 'invoice-pdfs'
    and (
      (
        public.is_staff()
        and (
          not public.is_invoice_controller()
          or exists (
            select 1 from public.invoices invoice
            where invoice.pdf_storage_path = name
              and invoice.deleted_at is null
              and (
                invoice.invoice_type = 'staff'
                or invoice.state in ('approved', 'paid')
              )
          )
        )
      )
      or exists (
        select 1 from public.invoices invoice
        where invoice.pdf_storage_path = name
          and invoice.invoice_type = 'contractor'
          and invoice.deleted_at is null
          and public.can_invoice_for_contractor(invoice.contractor_id)
          and public.can_access_contractor_work_order(invoice.work_order_id)
      )
    )
  );

create or replace function public.complete_work_order_once(
  p_work_order_id text,
  p_completed_at timestamptz,
  p_asset_make text,
  p_asset_model text,
  p_asset_serial text,
  p_asset_year integer,
  p_resolution_code text,
  p_resolution_notes text,
  p_activity_text text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_actor_role text;
  v_work_order public.work_orders%rowtype;
  v_activity_id uuid;
  v_visits_closed integer := 0;
begin
  if v_actor_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  select profile.name, profile.role::text
  into v_actor_name, v_actor_role
  from public.profiles profile
  where profile.id = v_actor_id
    and profile.active = true;

  select *
  into v_work_order
  from public.work_orders
  where id = p_work_order_id
    and deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found';
  end if;

  if v_actor_role not in ('manager', 'dispatcher', 'back_office')
     and not (
       v_actor_role = 'contractor'
       and public.can_access_contractor_work_order(p_work_order_id)
     ) then
    raise exception 'Work order completion is not permitted'
      using errcode = '42501';
  end if;

  select activity.id
  into v_activity_id
  from public.activities activity
  where activity.work_order_id = p_work_order_id
    and activity.event_key = 'job_completed'
    and activity.deleted_at is null
    and activity.contractor_assignment_version
      = v_work_order.contractor_assignment_version
    and (
      public.is_staff()
      or (
        v_work_order.contractor_assignment_started_at is not null
        and activity.created_at >= v_work_order.contractor_assignment_started_at
      )
    )
  order by activity.created_at desc
  limit 1;

  if v_activity_id is not null or v_work_order.status = 'completed' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_completed',
      'activityId', v_activity_id
    );
  end if;

  if v_work_order.status in ('closed', 'capital') then
    raise exception 'This work order cannot be completed from its current status';
  end if;

  update public.work_orders
  set status = 'completed',
      functional_status = 'Completed',
      asset_make = nullif(trim(coalesce(p_asset_make, '')), ''),
      asset_model = nullif(trim(coalesce(p_asset_model, '')), ''),
      asset_serial = nullif(trim(coalesce(p_asset_serial, '')), ''),
      asset_year = p_asset_year,
      end_time = p_completed_at,
      resolution_code = nullif(trim(coalesce(p_resolution_code, '')), ''),
      resolution_notes = nullif(trim(coalesce(p_resolution_notes, '')), ''),
      updated_at = now()
  where id = p_work_order_id;

  update public.work_order_visits visit
  set check_out_at = p_completed_at,
      checked_out_by = v_actor_id,
      updated_at = now()
  where visit.work_order_id = p_work_order_id
    and visit.contractor_id = v_work_order.contractor_id
    and visit.check_out_at is null
    and (
      public.is_staff()
      or visit.created_at >= v_work_order.contractor_assignment_started_at
    );
  get diagnostics v_visits_closed = row_count;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    is_staff_override,
    event_key,
    event_data
  ) values (
    p_work_order_id,
    v_actor_id,
    coalesce(v_actor_name, 'Portal user'),
    p_activity_text,
    'note',
    v_actor_role in ('manager', 'dispatcher', 'back_office'),
    'job_completed',
    jsonb_build_object(
      'clockedOutAt', p_completed_at,
      'resolution', nullif(trim(coalesce(p_resolution_code, '')), ''),
      'closingNotes', nullif(trim(coalesce(p_resolution_notes, '')), '')
    )
  )
  returning id into v_activity_id;

  return jsonb_build_object(
    'applied', true,
    'activityId', v_activity_id,
    'visitsClosed', v_visits_closed
  );
end;
$$;

do $$
begin
  begin
    alter publication supabase_realtime
      add table public.work_order_technician_assignments;
  exception when duplicate_object then null;
  end;
end
$$;

commit;
