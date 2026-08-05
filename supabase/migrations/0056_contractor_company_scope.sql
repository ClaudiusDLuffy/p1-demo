-- Contractor company accounts keep one canonical assignment/invoice identity
-- while allowing separate people to sign in and retain their own audit actor.
-- Company access widens the set of the contractor's own jobs; it never grants
-- a staff role or access to another contractor company.

begin;

alter table public.organizations
  add column if not exists canonical_contractor_id uuid
    references public.profiles(id),
  add column if not exists active boolean not null default true;

create unique index if not exists organizations_canonical_contractor_unique
  on public.organizations(canonical_contractor_id)
  where canonical_contractor_id is not null;

alter table public.profiles
  add column if not exists contractor_organization_id uuid
    references public.organizations(id),
  add column if not exists contractor_access_level text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_contractor_access_level_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_contractor_access_level_check
      check (
        (
          contractor_organization_id is null
          and contractor_access_level is null
        )
        or (
          contractor_organization_id is not null
          and contractor_access_level in (
            'company_admin',
            'invoice',
            'report_only'
          )
        )
      );
  end if;
end
$$;

create index if not exists profiles_contractor_organization
  on public.profiles(contractor_organization_id)
  where contractor_organization_id is not null;

comment on column public.organizations.canonical_contractor_id is
  'Profile id retained on work orders and contractor invoices for this company.';
comment on column public.profiles.contractor_organization_id is
  'Optional contractor company parent. Null keeps the existing single-login behavior.';
comment on column public.profiles.contractor_access_level is
  'company_admin = company-wide contractor scope and invoicing; invoice = invoicing; report_only = field workflow only.';

-- These helpers are SECURITY DEFINER so policies can inspect the current
-- profile/company without recursively invoking profiles RLS.
create or replace function public.current_contractor_account_id()
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
  where profile.id = auth.uid()
$$;

create or replace function public.can_access_contractor_account(
  p_contractor_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.is_staff()
    or (
      p_contractor_id is not null
      and p_contractor_id = public.current_contractor_account_id()
    )
$$;

create or replace function public.can_invoice_for_contractor(
  p_contractor_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles profile
    left join public.organizations organization
      on organization.id = profile.contractor_organization_id
     and organization.active = true
    where profile.id = auth.uid()
      and profile.role = 'contractor'
      and profile.active = true
      and p_contractor_id = case
        when profile.contractor_organization_id is not null
          then organization.canonical_contractor_id
        else profile.id
      end
      and (
        (
          profile.contractor_organization_id is null
          and coalesce(profile.contractor_tier, 'direct') = 'direct'
        )
        or profile.contractor_access_level in ('company_admin', 'invoice')
      )
  )
$$;

create or replace function public.can_manage_contractor_company()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles profile
    join public.organizations organization
      on organization.id = profile.contractor_organization_id
     and organization.active = true
     and organization.canonical_contractor_id is not null
    where profile.id = auth.uid()
      and profile.role = 'contractor'
      and profile.active = true
      and profile.contractor_access_level = 'company_admin'
  )
$$;

create or replace function public.can_read_contractor_profile(
  p_profile_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.is_staff()
    or p_profile_id = auth.uid()
    or exists (
      select 1
      from public.profiles viewer
      join public.profiles target
        on target.id = p_profile_id
       and target.contractor_organization_id = viewer.contractor_organization_id
      join public.organizations organization
        on organization.id = viewer.contractor_organization_id
       and organization.active = true
      where viewer.id = auth.uid()
        and viewer.role = 'contractor'
        and viewer.active = true
        and target.role = 'contractor'
        and viewer.contractor_access_level = 'company_admin'
    )
    or exists (
      select 1
      from public.profiles viewer
      join public.profiles target
        on target.id = p_profile_id
       and target.dispatcher_id = viewer.id
       and target.role = 'contractor'
      where viewer.id = auth.uid()
        and viewer.role = 'contractor'
        and viewer.active = true
        and coalesce(viewer.contractor_tier, '') = 'mr_freeze'
    )
$$;

create or replace function public.get_my_contractor_scope()
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'contractorAccountId', public.current_contractor_account_id(),
    'organizationId', profile.contractor_organization_id,
    'organizationName', organization.name,
    'accessLevel', coalesce(
      profile.contractor_access_level,
      case
        when profile.role = 'contractor'
          and coalesce(profile.contractor_tier, 'direct') = 'direct'
          then 'invoice'
        when profile.role = 'contractor' then 'report_only'
        else null
      end
    ),
    'canInvoice', public.can_invoice_for_contractor(
      public.current_contractor_account_id()
    ),
    'canManageTeam', public.can_manage_contractor_company()
  )
  from public.profiles profile
  left join public.organizations organization
    on organization.id = profile.contractor_organization_id
   and organization.active = true
  where profile.id = auth.uid()
$$;

revoke all on function public.current_contractor_account_id()
  from public, anon;
revoke all on function public.can_access_contractor_account(uuid)
  from public, anon;
revoke all on function public.can_invoice_for_contractor(uuid)
  from public, anon;
revoke all on function public.can_manage_contractor_company()
  from public, anon;
revoke all on function public.can_read_contractor_profile(uuid)
  from public, anon;
revoke all on function public.get_my_contractor_scope()
  from public, anon;

grant execute on function public.current_contractor_account_id(),
  public.can_access_contractor_account(uuid),
  public.can_invoice_for_contractor(uuid),
  public.can_manage_contractor_company(),
  public.can_read_contractor_profile(uuid),
  public.get_my_contractor_scope()
  to authenticated, service_role;

create or replace function public.validate_contractor_organization()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.canonical_contractor_id is not null
     and not exists (
       select 1
       from public.profiles profile
       where profile.id = new.canonical_contractor_id
         and profile.role = 'contractor'
         and profile.active = true
         and profile.contractor_organization_id = new.id
     ) then
    raise exception 'Canonical contractor must be an active contractor member of the organization'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_contractor_organization_trigger
  on public.organizations;
create trigger validate_contractor_organization_trigger
  before insert or update of canonical_contractor_id, active
  on public.organizations
  for each row execute function public.validate_contractor_organization();

-- A self-service profile update must never become role escalation or let a
-- contractor move themselves into a different company.
create or replace function public.protect_profile_security_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() in ('service_role', '')
     or auth.uid() is null
     or public.is_staff() then
    return new;
  end if;

  if auth.uid() <> old.id
     or new.id is distinct from old.id
     or new.role is distinct from old.role
     or new.active is distinct from old.active
     or new.contractor_tier is distinct from old.contractor_tier
     or new.dispatcher_id is distinct from old.dispatcher_id
     or new.contractor_nte_display is distinct from old.contractor_nte_display
     or new.default_labor_rate is distinct from old.default_labor_rate
     or new.default_truck_rate is distinct from old.default_truck_rate
     or new.default_parts_markup is distinct from old.default_parts_markup
     or new.is_assignable is distinct from old.is_assignable
     or new.contractor_organization_id is distinct from old.contractor_organization_id
     or new.contractor_access_level is distinct from old.contractor_access_level then
    raise exception 'Profile permission fields may only be changed by P1 staff'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_profile_security_fields_trigger
  on public.profiles;
create trigger protect_profile_security_fields_trigger
  before update on public.profiles
  for each row execute function public.protect_profile_security_fields();

alter table public.organizations enable row level security;

drop policy if exists organizations_read on public.organizations;
create policy organizations_read on public.organizations
  for select using (
    public.is_staff()
    or exists (
      select 1
      from public.profiles profile
      where profile.id = auth.uid()
        and profile.contractor_organization_id = organizations.id
        and profile.role = 'contractor'
        and profile.active = true
    )
  );

drop policy if exists organizations_write on public.organizations;
create policy organizations_write on public.organizations
  for all using (public.is_staff())
  with check (public.is_staff());

revoke all on public.organizations from anon;
grant select, insert, update, delete on public.organizations to authenticated;
grant all on public.organizations to service_role;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select using (public.can_read_contractor_profile(id));

-- Work-order ownership remains the canonical contractor profile. Every active
-- company member can work inside that boundary, without learning that another
-- contractor company exists.
drop policy if exists wo_read on public.work_orders;
create policy wo_read on public.work_orders
  for select using (
    public.is_staff()
    or public.can_access_contractor_account(contractor_id)
  );

drop policy if exists wo_update on public.work_orders;
create policy wo_update on public.work_orders
  for update using (
    public.is_staff()
    or public.can_access_contractor_account(contractor_id)
  )
  with check (
    public.is_staff()
    or public.can_access_contractor_account(contractor_id)
  );

drop policy if exists ct_read on public.contractor_technicians;
create policy ct_read on public.contractor_technicians
  for select using (
    public.is_staff()
    or public.can_access_contractor_account(contractor_id)
  );

-- Completion idempotency belongs to an assignment, not the work order for
-- all time. Without this version stamp, a receiving contractor could not
-- complete a job that a prior contractor had once completed and staff later
-- reassigned. The same stamp gives activity RLS an exact boundary in addition
-- to its timestamp check.
alter table public.activities
  add column if not exists contractor_assignment_version integer not null default 0;

update public.activities activity
set contractor_assignment_version = coalesce(
  (
    select history.assignment_version
    from public.work_order_assignment_history history
    where history.work_order_id = activity.work_order_id
      and activity.created_at >= coalesce(
        history.assignment_started_at,
        '-infinity'::timestamptz
      )
      and activity.created_at < history.assignment_ended_at
    order by history.assignment_ended_at
    limit 1
  ),
  (
    select work_order.contractor_assignment_version
    from public.work_orders work_order
    where work_order.id = activity.work_order_id
  ),
  0
);

create index if not exists idx_activities_assignment_version
  on public.activities(
    work_order_id,
    contractor_assignment_version,
    created_at desc
  )
  where deleted_at is null;

drop index if exists public.activities_one_job_completion_per_work_order;
create unique index if not exists activities_one_job_completion_per_assignment
  on public.activities(work_order_id, contractor_assignment_version)
  where event_key = 'job_completed'
    and deleted_at is null;

create or replace function public.protect_activity_assignment_version()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_assignment_version integer;
begin
  if tg_op = 'UPDATE' then
    if new.work_order_id is distinct from old.work_order_id
       or new.contractor_assignment_version
         is distinct from old.contractor_assignment_version then
      raise exception 'Activity assignment identity cannot be changed'
        using errcode = '42501';
    end if;
    return new;
  end if;

  select work_order.contractor_assignment_version
  into current_assignment_version
  from public.work_orders work_order
  where work_order.id = new.work_order_id;

  if not found then
    raise exception 'Activity must reference an existing work order';
  end if;

  new.contractor_assignment_version := current_assignment_version;
  return new;
end;
$$;

drop trigger if exists protect_activity_assignment_version_trigger
  on public.activities;
create trigger protect_activity_assignment_version_trigger
  before insert or update of work_order_id, contractor_assignment_version
  on public.activities
  for each row execute function public.protect_activity_assignment_version();

-- Activities retain the actual signed-in author while reads remain bounded to
-- the current assignment. This protects both outgoing and receiving companies.
drop policy if exists act_read on public.activities;
create policy act_read on public.activities
  for select using (
    public.is_staff()
    or (
      is_staff_only = false
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = activities.work_order_id
          and public.can_access_contractor_account(work_order.contractor_id)
          and work_order.deleted_at is null
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
    and exists (
      select 1
      from public.work_orders work_order
      where work_order.id = activities.work_order_id
        and work_order.deleted_at is null
        and (
          public.is_staff()
          or public.can_access_contractor_account(work_order.contractor_id)
        )
    )
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
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = activities.work_order_id
          and public.can_access_contractor_account(work_order.contractor_id)
          and work_order.deleted_at is null
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
    )
  );

-- Photo metadata and object bytes share the same current-assignment wall.
drop policy if exists photo_read on public.photos;
create policy photo_read on public.photos
  for select using (
    public.is_staff()
    or exists (
      select 1
      from public.work_orders work_order
      where work_order.id = photos.work_order_id
        and public.can_access_contractor_account(work_order.contractor_id)
        and work_order.deleted_at is null
        and work_order.contractor_assignment_started_at is not null
        and photos.created_at >= work_order.contractor_assignment_started_at
    )
  );

drop policy if exists photo_insert on public.photos;
create policy photo_insert on public.photos
  for insert with check (
    (
      public.is_staff()
      or uploader_id = auth.uid()
    )
    and exists (
      select 1
      from public.work_orders work_order
      where work_order.id = photos.work_order_id
        and work_order.deleted_at is null
        and (
          public.is_staff()
          or public.can_access_contractor_account(work_order.contractor_id)
        )
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
        from public.work_orders work_order
        where work_order.id = photos.work_order_id
          and public.can_access_contractor_account(work_order.contractor_id)
          and work_order.deleted_at is null
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
          and public.can_access_contractor_account(work_order.contractor_id)
          and work_order.deleted_at is null
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
    and (
      public.is_staff()
      or exists (
        select 1
        from public.work_orders work_order
        where work_order.id = split_part(name, '/', 2)
          and public.can_access_contractor_account(work_order.contractor_id)
          and work_order.deleted_at is null
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
        from public.photos photo
        join public.work_orders work_order
          on work_order.id = photo.work_order_id
        where photo.storage_path = name
          and photo.uploader_id = auth.uid()
          and public.can_access_contractor_account(work_order.contractor_id)
          and work_order.deleted_at is null
          and work_order.contractor_assignment_started_at is not null
          and photo.created_at >= work_order.contractor_assignment_started_at
      )
    )
  );

-- Parts and service notes are visible only if they were produced during the
-- current assignment. Individual author ids remain unchanged for audit.
drop policy if exists wo_parts_select on public.wo_parts;
create policy wo_parts_select on public.wo_parts
  for select using (
    public.is_staff()
    or exists (
      select 1
      from public.work_orders work_order
      where work_order.id = wo_parts.work_order_id
        and public.can_access_contractor_account(work_order.contractor_id)
        and work_order.deleted_at is null
        and work_order.contractor_assignment_started_at is not null
        and wo_parts.created_at >= work_order.contractor_assignment_started_at
    )
  );

drop policy if exists wo_parts_insert on public.wo_parts;
create policy wo_parts_insert on public.wo_parts
  for insert with check (
    (
      public.is_staff()
      or created_by = auth.uid()
    )
    and exists (
      select 1
      from public.work_orders work_order
      where work_order.id = wo_parts.work_order_id
        and work_order.deleted_at is null
        and (
          public.is_staff()
          or public.can_access_contractor_account(work_order.contractor_id)
        )
    )
  );

drop policy if exists wo_parts_update on public.wo_parts;
create policy wo_parts_update on public.wo_parts
  for update using (
    public.is_staff()
    or exists (
      select 1
      from public.work_orders work_order
      where work_order.id = wo_parts.work_order_id
        and public.can_access_contractor_account(work_order.contractor_id)
        and work_order.deleted_at is null
        and work_order.contractor_assignment_started_at is not null
        and wo_parts.created_at >= work_order.contractor_assignment_started_at
    )
  )
  with check (
    public.is_staff()
    or exists (
      select 1
      from public.work_orders work_order
      where work_order.id = wo_parts.work_order_id
        and public.can_access_contractor_account(work_order.contractor_id)
        and work_order.deleted_at is null
    )
  );

drop policy if exists service_notes_read on public.service_notes;
create policy service_notes_read on public.service_notes
  for select using (
    public.is_staff()
    or exists (
      select 1
      from public.work_orders work_order
      where work_order.id = service_notes.work_order_id
        and public.can_access_contractor_account(work_order.contractor_id)
        and work_order.deleted_at is null
        and work_order.contractor_assignment_started_at is not null
        and service_notes.created_at >= work_order.contractor_assignment_started_at
    )
  );

drop policy if exists service_notes_insert on public.service_notes;
create policy service_notes_insert on public.service_notes
  for insert with check (
    (
      public.is_staff()
      or created_by_id = auth.uid()
    )
    and exists (
      select 1
      from public.work_orders work_order
      where work_order.id = service_notes.work_order_id
        and work_order.deleted_at is null
        and (
          public.is_staff()
          or public.can_access_contractor_account(work_order.contractor_id)
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
        from public.work_orders work_order
        where work_order.id = service_notes.work_order_id
          and public.can_access_contractor_account(work_order.contractor_id)
          and work_order.deleted_at is null
          and work_order.contractor_assignment_started_at is not null
          and service_notes.created_at >= work_order.contractor_assignment_started_at
      )
    )
  );

-- Reports store both the canonical company owner and the actual submitter.
alter table public.work_reports
  add column if not exists submitted_by uuid
    references public.profiles(id);

update public.work_reports
set submitted_by = contractor_id
where submitted_by is null;

create or replace function public.protect_work_report_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  account_id uuid := public.current_contractor_account_id();
begin
  if auth.role() in ('service_role', '') or public.is_staff() then
    return new;
  end if;

  if actor_id is null or account_id is null then
    raise exception 'Contractor authentication is required'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    new.contractor_id := account_id;
    new.submitted_by := actor_id;
  elsif new.work_order_id is distinct from old.work_order_id
     or new.contractor_id is distinct from old.contractor_id
     or new.submitted_by is distinct from old.submitted_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Work report ownership cannot be changed'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.work_orders work_order
    where work_order.id = new.work_order_id
      and work_order.contractor_id = account_id
      and work_order.deleted_at is null
  ) then
    raise exception 'This work order is not assigned to your company'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE'
     and old.submitted_by <> actor_id
     and not public.can_manage_contractor_company() then
    raise exception 'Only the report author or a company admin may edit this report'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_work_report_identity_trigger
  on public.work_reports;
create trigger protect_work_report_identity_trigger
  before insert or update on public.work_reports
  for each row execute function public.protect_work_report_identity();

drop policy if exists work_reports_select on public.work_reports;
create policy work_reports_select on public.work_reports
  for select using (
    public.is_staff()
    or (
      public.can_access_contractor_account(contractor_id)
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = work_reports.work_order_id
          and work_order.contractor_id = work_reports.contractor_id
          and work_order.deleted_at is null
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
    and exists (
      select 1
      from public.work_orders work_order
      where work_order.id = work_reports.work_order_id
        and work_order.contractor_id = work_reports.contractor_id
        and work_order.deleted_at is null
    )
  );

drop policy if exists work_reports_update on public.work_reports;
create policy work_reports_update on public.work_reports
  for update using (
    public.is_staff()
    or (
      public.can_access_contractor_account(contractor_id)
      and (
        submitted_by = auth.uid()
        or public.can_manage_contractor_company()
      )
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = work_reports.work_order_id
          and work_order.contractor_id = work_reports.contractor_id
          and work_order.deleted_at is null
          and work_order.contractor_assignment_started_at is not null
          and work_reports.created_at >= work_order.contractor_assignment_started_at
      )
    )
  )
  with check (
    public.is_staff()
    or (
      contractor_id = public.current_contractor_account_id()
      and (
        submitted_by = auth.uid()
        or public.can_manage_contractor_company()
      )
    )
  );

-- Visit ownership stays on the canonical contractor; check-in/check-out actor
-- columns identify the real person. Company admins may close a teammate's
-- open visit, while ordinary members may only close their own.
create or replace function public.protect_work_order_visit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := coalesce(auth.role(), '');
  actor_is_staff boolean := public.is_staff();
  actor_account_id uuid := public.current_contractor_account_id();
  assigned_contractor_id uuid;
  work_order_is_active boolean;
begin
  select
    work_order.contractor_id,
    work_order.deleted_at is null
  into
    assigned_contractor_id,
    work_order_is_active
  from public.work_orders work_order
  where work_order.id = new.work_order_id;

  if not found then
    raise exception 'Visit must reference an existing work order';
  end if;

  if new.check_in_activity_id is not null
     and not exists (
       select 1
       from public.activities activity
       where activity.id = new.check_in_activity_id
         and activity.work_order_id = new.work_order_id
     ) then
    raise exception 'Check-in activity must belong to the same work order';
  end if;

  if new.check_out_activity_id is not null
     and not exists (
       select 1
       from public.activities activity
       where activity.id = new.check_out_activity_id
         and activity.work_order_id = new.work_order_id
     ) then
    raise exception 'Check-out activity must belong to the same work order';
  end if;

  if tg_op = 'INSERT' then
    if not work_order_is_active then
      raise exception 'Cannot open a visit on an archived work order';
    end if;

    if assigned_contractor_id is null
       or new.contractor_id <> assigned_contractor_id then
      raise exception 'Visit contractor must match the assigned contractor';
    end if;

    if actor_role not in ('service_role', '') then
      new.checked_in_by := actor_id;

      if actor_is_staff and new.check_out_at is not null then
        new.checked_out_by := actor_id;
      end if;
    else
      new.checked_in_by := coalesce(new.checked_in_by, actor_id);
    end if;

    if new.checked_in_by is null then
      raise exception 'A check-in actor is required';
    end if;

    if actor_role not in ('service_role', '') and not actor_is_staff then
      if actor_id is null
         or actor_account_id is null
         or actor_account_id <> assigned_contractor_id
         or new.contractor_id <> actor_account_id
         or new.checked_in_by <> actor_id then
        raise exception 'Only a member of the assigned contractor can check in'
          using errcode = '42501';
      end if;

      if new.check_out_at is not null
         or new.checked_out_by is not null
         or new.check_out_activity_id is not null then
        raise exception 'Contractor check-in must create an open visit'
          using errcode = '42501';
      end if;
    end if;

    return new;
  end if;

  if new.work_order_id is distinct from old.work_order_id
     or new.contractor_id is distinct from old.contractor_id
     or new.check_in_at is distinct from old.check_in_at
     or new.checked_in_by is distinct from old.checked_in_by
     or new.check_in_activity_id is distinct from old.check_in_activity_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Visit check-in identity and timestamps are immutable';
  end if;

  if actor_role not in ('service_role', '') and actor_is_staff then
    if new.check_out_at is null then
      new.checked_out_by := null;
    elsif old.check_out_at is null then
      new.checked_out_by := actor_id;
    else
      new.checked_out_by := old.checked_out_by;
    end if;
  end if;

  if actor_role not in ('service_role', '') and not actor_is_staff then
    if not work_order_is_active
       or actor_id is null
       or actor_account_id is null
       or actor_account_id <> assigned_contractor_id
       or old.contractor_id <> actor_account_id
       or (
         old.checked_in_by <> actor_id
         and not public.can_manage_contractor_company()
       ) then
      raise exception 'Only the visit author or a company admin can close this visit'
        using errcode = '42501';
    end if;

    if old.check_out_at is not null then
      raise exception 'A contractor cannot change a closed visit'
        using errcode = '42501';
    end if;

    if new.check_out_at is null then
      raise exception 'Contractor visit updates must close the visit'
        using errcode = '42501';
    end if;

    new.checked_out_by := actor_id;
  end if;

  return new;
end;
$$;

drop policy if exists work_order_visits_read on public.work_order_visits;
create policy work_order_visits_read on public.work_order_visits
  for select using (
    public.is_staff()
    or (
      public.can_access_contractor_account(contractor_id)
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = work_order_visits.work_order_id
          and work_order.contractor_id = work_order_visits.contractor_id
          and work_order.deleted_at is null
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
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = work_order_visits.work_order_id
          and work_order.contractor_id = work_order_visits.contractor_id
          and work_order.deleted_at is null
      )
    )
  );

drop policy if exists work_order_visits_update on public.work_order_visits;
create policy work_order_visits_update on public.work_order_visits
  for update using (
    public.is_staff()
    or (
      public.can_access_contractor_account(contractor_id)
      and (
        checked_in_by = auth.uid()
        or public.can_manage_contractor_company()
      )
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = work_order_visits.work_order_id
          and work_order.contractor_id = work_order_visits.contractor_id
          and work_order.deleted_at is null
          and work_order.contractor_assignment_started_at is not null
          and work_order_visits.created_at >= work_order.contractor_assignment_started_at
      )
    )
  )
  with check (
    public.is_staff()
    or (
      contractor_id = public.current_contractor_account_id()
      and checked_out_by = auth.uid()
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
  set
    contractor_attention_acknowledged_at = now(),
    contractor_attention_acknowledged_by = auth.uid()
  where activity.id = p_activity_id
    and activity.requires_contractor_attention = true
    and activity.contractor_attention_acknowledged_at is null
    and activity.deleted_at is null
    and exists (
      select 1
      from public.work_orders work_order
      where work_order.id = activity.work_order_id
        and public.can_access_contractor_account(work_order.contractor_id)
        and work_order.deleted_at is null
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

create or replace function public.protect_activity_contractor_attention()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := coalesce(auth.role(), '');
  actor_is_staff boolean := public.is_staff();
  assigned_contractor_id uuid;
  assignment_started_at timestamptz;
  assignment_version integer;
  flag_changed boolean;
  acknowledgement_changed boolean;
  work_order_changed boolean;
begin
  select
    work_order.contractor_id,
    work_order.contractor_assignment_started_at,
    work_order.contractor_assignment_version
  into
    assigned_contractor_id,
    assignment_started_at,
    assignment_version
  from public.work_orders work_order
  where work_order.id = new.work_order_id
    and work_order.deleted_at is null;

  if tg_op = 'INSERT' then
    work_order_changed := false;
    flag_changed := new.requires_contractor_attention;
    acknowledgement_changed :=
      new.contractor_attention_acknowledged_at is not null
      or new.contractor_attention_acknowledged_by is not null;
  else
    work_order_changed := new.work_order_id is distinct from old.work_order_id;
    flag_changed :=
      new.requires_contractor_attention is distinct from old.requires_contractor_attention
      or (work_order_changed and new.requires_contractor_attention);
    acknowledgement_changed :=
      new.contractor_attention_acknowledged_at
        is distinct from old.contractor_attention_acknowledged_at
      or new.contractor_attention_acknowledged_by
        is distinct from old.contractor_attention_acknowledged_by;
  end if;

  if flag_changed then
    if actor_role not in ('service_role', '') and not actor_is_staff then
      raise exception 'Only staff can change contractor attention flags'
        using errcode = '42501';
    end if;

    if new.requires_contractor_attention
       and assigned_contractor_id is null then
      raise exception 'Contractor attention requires an assigned contractor';
    end if;

    new.contractor_attention_acknowledged_at := null;
    new.contractor_attention_acknowledged_by := null;
  end if;

  if acknowledgement_changed and not flag_changed then
    if actor_role in ('service_role', '') then
      null;
    elsif new.contractor_attention_acknowledged_at is null
          and new.contractor_attention_acknowledged_by is null then
      if not actor_is_staff then
        raise exception 'Only staff can reopen contractor attention'
          using errcode = '42501';
      end if;
    else
      if actor_id is null
         or assigned_contractor_id is null
         or not public.can_access_contractor_account(assigned_contractor_id)
         or assignment_started_at is null
         or new.contractor_assignment_version is distinct from assignment_version
         or new.created_at < assignment_started_at then
        raise exception 'Only the assigned contractor company can acknowledge attention'
          using errcode = '42501';
      end if;

      if not new.requires_contractor_attention then
        raise exception 'Activity does not require contractor attention';
      end if;

      new.contractor_attention_acknowledged_by := actor_id;
      new.contractor_attention_acknowledged_at := coalesce(
        new.contractor_attention_acknowledged_at,
        now()
      );
    end if;
  end if;

  return new;
end;
$$;

-- Contractor invoices are owned by the canonical company profile. The actual
-- creator remains in created_by and submitted invoices stay contractor-locked.
create or replace function public.enforce_contractor_invoice_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null or public.is_staff() then
    return new;
  end if;

  if old.invoice_type = 'contractor' then
    if not public.can_invoice_for_contractor(old.contractor_id) then
      raise exception 'You cannot edit invoices for this contractor company'
        using errcode = '42501';
    end if;

    if new.contractor_id is distinct from old.contractor_id
       or new.work_order_id is distinct from old.work_order_id
       or new.invoice_type is distinct from old.invoice_type
       or new.created_by is distinct from old.created_by then
      raise exception 'Contractor invoice ownership cannot be changed'
        using errcode = '42501';
    end if;

    if not exists (
      select 1
      from public.work_orders work_order
      where work_order.id = old.work_order_id
        and work_order.contractor_id = old.contractor_id
        and work_order.deleted_at is null
        and work_order.contractor_assignment_started_at is not null
        and old.created_at >= work_order.contractor_assignment_started_at
    ) then
      raise exception 'This work order is no longer assigned to your company'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.attach_contractor_invoice_pdf(
  p_invoice_id uuid,
  p_storage_path text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  invoice public.invoices%rowtype;
begin
  if actor_id is null then
    raise exception 'Authentication is required'
      using errcode = '42501';
  end if;

  if nullif(trim(coalesce(p_storage_path, '')), '') is null then
    raise exception 'PDF storage path is required'
      using errcode = '22023';
  end if;

  select candidate.*
  into invoice
  from public.invoices candidate
  where candidate.id = p_invoice_id
    and candidate.invoice_type = 'contractor'
    and candidate.deleted_at is null
  for update;

  if not found then
    raise exception 'Contractor invoice was not found'
      using errcode = 'P0002';
  end if;

  if not public.is_staff() and not (
    public.can_invoice_for_contractor(invoice.contractor_id)
    and (
      invoice.state = 'draft'
      or (
        invoice.state = 'submitted'
        and invoice.pdf_storage_path is null
      )
    )
    and exists (
      select 1
      from public.work_orders work_order
      where work_order.id = invoice.work_order_id
        and work_order.contractor_id = invoice.contractor_id
        and work_order.deleted_at is null
        and work_order.contractor_assignment_started_at is not null
        and invoice.created_at >= work_order.contractor_assignment_started_at
    )
  ) then
    raise exception 'This invoice PDF is locked'
      using errcode = '42501';
  end if;

  update public.invoices
  set pdf_storage_path = trim(p_storage_path),
      updated_at = now()
  where id = p_invoice_id;
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
        and public.can_access_contractor_account(contractor_id)
        and exists (
          select 1
          from public.work_orders work_order
          where work_order.id = invoices.work_order_id
            and work_order.contractor_id = invoices.contractor_id
            and work_order.deleted_at is null
            and work_order.contractor_assignment_started_at is not null
            and invoices.created_at >= work_order.contractor_assignment_started_at
        )
      )
    )
  );

drop policy if exists inv_insert on public.invoices;
create policy inv_insert on public.invoices
  for insert with check (
    (
      not public.is_invoice_controller()
      and public.is_staff()
    )
    or (
      invoice_type = 'contractor'
      and state = 'draft'
      and contractor_id = public.current_contractor_account_id()
      and created_by = auth.uid()
      and public.can_invoice_for_contractor(contractor_id)
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = invoices.work_order_id
          and work_order.contractor_id = invoices.contractor_id
          and work_order.deleted_at is null
      )
    )
  );

drop policy if exists inv_update on public.invoices;
create policy inv_update on public.invoices
  for update using (
    (
      public.is_staff()
      and (
        not public.is_invoice_controller()
        or (
          invoice_type = 'contractor'
          and state = 'approved'
        )
      )
    )
    or (
      invoice_type = 'contractor'
      and state = 'draft'
      and public.can_invoice_for_contractor(contractor_id)
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = invoices.work_order_id
          and work_order.contractor_id = invoices.contractor_id
          and work_order.deleted_at is null
          and work_order.contractor_assignment_started_at is not null
          and invoices.created_at >= work_order.contractor_assignment_started_at
      )
    )
  )
  with check (
    (
      public.is_staff()
      and (
        not public.is_invoice_controller()
        or (
          invoice_type = 'contractor'
          and state = 'paid'
        )
      )
    )
    or (
      invoice_type = 'contractor'
      and state in ('draft', 'submitted')
      and public.can_invoice_for_contractor(contractor_id)
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = invoices.work_order_id
          and work_order.contractor_id = invoices.contractor_id
          and work_order.deleted_at is null
      )
    )
  );

drop policy if exists line_read on public.invoice_lines;
create policy line_read on public.invoice_lines
  for select using (
    exists (
      select 1
      from public.invoices invoice
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
            and public.can_access_contractor_account(invoice.contractor_id)
            and exists (
              select 1
              from public.work_orders work_order
              where work_order.id = invoice.work_order_id
                and work_order.contractor_id = invoice.contractor_id
                and work_order.deleted_at is null
                and work_order.contractor_assignment_started_at is not null
                and invoice.created_at >= work_order.contractor_assignment_started_at
            )
          )
        )
    )
  );

drop policy if exists line_write on public.invoice_lines;
create policy line_write on public.invoice_lines
  for all using (
    exists (
      select 1
      from public.invoices invoice
      where invoice.id = invoice_lines.invoice_id
        and (
          (
            public.is_staff()
            and not public.is_invoice_controller()
          )
          or (
            invoice.invoice_type = 'contractor'
            and invoice.state = 'draft'
            and public.can_invoice_for_contractor(invoice.contractor_id)
            and exists (
              select 1
              from public.work_orders work_order
              where work_order.id = invoice.work_order_id
                and work_order.contractor_id = invoice.contractor_id
                and work_order.deleted_at is null
                and work_order.contractor_assignment_started_at is not null
                and invoice.created_at >= work_order.contractor_assignment_started_at
            )
          )
        )
    )
  )
  with check (
    exists (
      select 1
      from public.invoices invoice
      where invoice.id = invoice_lines.invoice_id
        and (
          (
            public.is_staff()
            and not public.is_invoice_controller()
          )
          or (
            invoice.invoice_type = 'contractor'
            and invoice.state = 'draft'
            and public.can_invoice_for_contractor(invoice.contractor_id)
            and exists (
              select 1
              from public.work_orders work_order
              where work_order.id = invoice.work_order_id
                and work_order.contractor_id = invoice.contractor_id
                and work_order.deleted_at is null
            )
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
            select 1
            from public.invoices invoice
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
        select 1
        from public.invoices invoice
        join public.work_orders work_order
          on work_order.id = invoice.work_order_id
        where invoice.pdf_storage_path = name
          and invoice.invoice_type = 'contractor'
          and invoice.deleted_at is null
          and public.can_access_contractor_account(invoice.contractor_id)
          and work_order.contractor_id = invoice.contractor_id
          and work_order.deleted_at is null
          and work_order.contractor_assignment_started_at is not null
          and invoice.created_at >= work_order.contractor_assignment_started_at
      )
    )
  );

drop policy if exists invoice_pdfs_insert on storage.objects;
create policy invoice_pdfs_insert on storage.objects
  for insert with check (
    bucket_id = 'invoice-pdfs'
    and (
      (
        public.is_staff()
        and not public.is_invoice_controller()
      )
      or exists (
        select 1
        from public.invoices invoice
        join public.work_orders work_order
          on work_order.id = invoice.work_order_id
        where invoice.id::text = split_part(name, '/', 1)
          and invoice.invoice_type = 'contractor'
          and invoice.deleted_at is null
          and invoice.state in ('draft', 'submitted')
          and public.can_invoice_for_contractor(invoice.contractor_id)
          and work_order.contractor_id = invoice.contractor_id
          and work_order.deleted_at is null
          and work_order.contractor_assignment_started_at is not null
          and invoice.created_at >= work_order.contractor_assignment_started_at
      )
    )
  );

create or replace function public.submit_contractor_invoice_once(
  p_submission_key uuid,
  p_work_order_id text,
  p_num text,
  p_user_typed_num boolean,
  p_cme text,
  p_store_address text,
  p_invoice_date date,
  p_service_date date,
  p_due_date date,
  p_terms text,
  p_sales_tax numeric,
  p_total_override numeric,
  p_lines jsonb
)
returns public.invoices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  account_id uuid := public.current_contractor_account_id();
  actor_name text;
  work_order public.work_orders%rowtype;
  saved_invoice public.invoices%rowtype;
  requested_num text := nullif(trim(coalesce(p_num, '')), '');
  final_num text;
  v_invoice_subtotal numeric(10,2);
  v_invoice_tax numeric(10,2) := round(greatest(coalesce(p_sales_tax, 0), 0), 2);
  v_invoice_total numeric(10,2);
  line_count integer := 0;
  attempt integer := 0;
begin
  if actor_id is null or account_id is null then
    raise exception 'Contractor authentication is required'
      using errcode = '42501';
  end if;

  if p_submission_key is null then
    raise exception 'A submission key is required'
      using errcode = '22023';
  end if;

  select invoice.*
  into saved_invoice
  from public.invoices invoice
  where invoice.contractor_id = account_id
    and invoice.submission_key = p_submission_key;

  if found then
    return saved_invoice;
  end if;

  select profile.name
  into actor_name
  from public.profiles profile
  where profile.id = actor_id
    and profile.role = 'contractor'
    and profile.active = true;

  if not found or not public.can_invoice_for_contractor(account_id) then
    raise exception 'This contractor account cannot submit invoices'
      using errcode = '42501';
  end if;

  select candidate.*
  into work_order
  from public.work_orders candidate
  where candidate.id = p_work_order_id
    and candidate.contractor_id = account_id
    and candidate.deleted_at is null
  for update;

  if not found then
    raise exception 'This work order is not assigned to your company'
      using errcode = '42501';
  end if;

  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'Invoice lines must be an array'
      using errcode = '22023';
  end if;

  select
    count(*)::integer,
    round(
      coalesce(
        sum(
          round(coalesce(line.qty, 1), 2)
          * round(coalesce(line.rate, 0), 2)
        ),
        0
      ),
      2
    )
  into line_count, v_invoice_subtotal
  from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
    as line(type text, description text, qty numeric, rate numeric);

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as line(type text, description text, qty numeric, rate numeric)
    where coalesce(line.qty, 0) <= 0
       or coalesce(line.rate, -1) < 0
  ) then
    raise exception 'Invoice lines require a positive quantity and non-negative rate'
      using errcode = '22023';
  end if;

  if p_total_override is not null then
    v_invoice_total := round(p_total_override, 2);
    v_invoice_subtotal := greatest(v_invoice_total - v_invoice_tax, 0);
  else
    v_invoice_total := v_invoice_subtotal + v_invoice_tax;
  end if;

  if v_invoice_total <= 0 then
    raise exception 'Invoice total must be greater than zero'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('contractor-invoice-number'));
  final_num := coalesce(requested_num, public.next_contractor_invoice_num());

  while attempt < 6 loop
    begin
      insert into public.invoices (
        num,
        work_order_id,
        store_number,
        store_address,
        contractor_id,
        cme,
        invoice_date,
        service_date,
        due_date,
        terms,
        state,
        subtotal,
        sales_tax,
        total,
        created_by,
        invoice_type,
        submission_key
      ) values (
        final_num,
        work_order.id,
        work_order.store_number,
        coalesce(
          nullif(trim(coalesce(p_store_address, '')), ''),
          work_order.address
        ),
        account_id,
        nullif(trim(coalesce(p_cme, '')), ''),
        coalesce(p_invoice_date, current_date),
        p_service_date,
        p_due_date,
        coalesce(nullif(trim(coalesce(p_terms, '')), ''), 'Net 30'),
        'draft',
        v_invoice_subtotal,
        v_invoice_tax,
        v_invoice_total,
        actor_id,
        'contractor',
        p_submission_key
      )
      returning * into saved_invoice;

      exit;
    exception when unique_violation then
      select invoice.*
      into saved_invoice
      from public.invoices invoice
      where invoice.contractor_id = account_id
        and invoice.submission_key = p_submission_key;

      if found then
        return saved_invoice;
      end if;

      if coalesce(p_user_typed_num, false) then
        raise exception 'Invoice #% already exists for this contractor', final_num
          using errcode = '23505';
      end if;

      final_num := public.next_contractor_invoice_num();
      attempt := attempt + 1;
    end;
  end loop;

  if saved_invoice.id is null then
    raise exception 'Could not allocate an unused invoice number'
      using errcode = '23505';
  end if;

  if line_count > 0 then
    insert into public.invoice_lines (
      invoice_id,
      position,
      type,
      description,
      qty,
      rate
    )
    select
      saved_invoice.id,
      line.ordinality::integer,
      coalesce(nullif(trim(line.item ->> 'type'), ''), 'Other'),
      coalesce(line.item ->> 'description', ''),
      round(coalesce(nullif(line.item ->> 'qty', '')::numeric, 1), 2),
      round(coalesce(nullif(line.item ->> 'rate', '')::numeric, 0), 2)
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
      with ordinality as line(item, ordinality);
  end if;

  update public.invoices invoice
  set state = 'submitted',
      updated_at = now()
  where invoice.id = saved_invoice.id
  returning invoice.* into saved_invoice;

  update public.work_orders
  set status = 'pending_approval',
      invoice_total = v_invoice_total,
      updated_at = now()
  where id = work_order.id;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data
  ) values (
    work_order.id,
    actor_id,
    actor_name,
    format(
      'Invoice %s submitted. Total: $%s.',
      saved_invoice.num,
      to_char(v_invoice_total, 'FM999999990.00')
    ),
    'system',
    'invoice_submitted',
    jsonb_build_object(
      'invoiceId', saved_invoice.id,
      'invoiceNum', saved_invoice.num,
      'total', v_invoice_total,
      'submissionKey', p_submission_key
    )
  );

  return saved_invoice;
end;
$$;

revoke all on function public.submit_contractor_invoice_once(
  uuid, text, text, boolean, text, text, date, date, date, text, numeric, numeric, jsonb
) from public, anon;
grant execute on function public.submit_contractor_invoice_once(
  uuid, text, text, boolean, text, text, date, date, date, text, numeric, numeric, jsonb
) to authenticated, service_role;

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
       and public.can_access_contractor_account(v_work_order.contractor_id)
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
  set
    status = 'completed',
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
  set
    check_out_at = p_completed_at,
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

revoke all on function public.complete_work_order_once(
  text, timestamptz, text, text, text, integer, text, text, text
) from public, anon;
grant execute on function public.complete_work_order_once(
  text, timestamptz, text, text, text, integer, text, text, text
) to authenticated, service_role;

commit;
