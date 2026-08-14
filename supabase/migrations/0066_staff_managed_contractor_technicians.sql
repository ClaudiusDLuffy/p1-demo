-- Let P1 staff invite and deactivate contractor technicians without changing
-- the canonical contractor identity stored on work orders and invoices.
-- Deactivation is reversible and history is never deleted.

begin;

create table if not exists public.contractor_technician_admin_events (
  id uuid primary key default gen_random_uuid(),
  contractor_id uuid not null references public.profiles(id),
  technician_profile_id uuid not null references public.profiles(id),
  actor_id uuid not null references public.profiles(id),
  action text not null,
  access_level text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint contractor_technician_admin_event_action_check
    check (action in ('invited', 'reactivated', 'updated', 'deactivated')),
  constraint contractor_technician_admin_event_access_check
    check (access_level is null or access_level in ('invoice', 'report_only'))
);

create index if not exists contractor_technician_admin_events_company
  on public.contractor_technician_admin_events(contractor_id, created_at desc);
create index if not exists contractor_technician_admin_events_profile
  on public.contractor_technician_admin_events(technician_profile_id, created_at desc);

alter table public.contractor_technician_admin_events enable row level security;

drop policy if exists contractor_technician_admin_events_read
  on public.contractor_technician_admin_events;
create policy contractor_technician_admin_events_read
  on public.contractor_technician_admin_events
  for select using (
    public.is_staff()
    and not public.is_invoice_controller()
  );

revoke all on public.contractor_technician_admin_events from anon, authenticated;
grant select on public.contractor_technician_admin_events to authenticated;
grant all on public.contractor_technician_admin_events to service_role;

-- A managed technician can be field-only or invoice-capable. Invoice access
-- widens the allowed contractor workflow but never crosses the company wall.
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
      and profile.contractor_access_level in ('invoice', 'report_only')
      and public.contractor_account_id_for_profile(profile.id)
        = new.contractor_id
  ) then
    raise exception 'Portal technician must be an active invoice or report-only member of this contractor company'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

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
    and profile.contractor_access_level in ('invoice', 'report_only')
    and public.contractor_account_id_for_profile(profile.id)
      = new.contractor_id;

  if technician_name is null then
    raise exception 'Selected technician is not an active member of the assigned contractor company'
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
      and profile.contractor_access_level in ('invoice', 'report_only')
      and public.contractor_account_id_for_profile(profile.id)
        = work_order.contractor_id;

    if technician_name is null then
      raise exception 'Technician is not an active member of this contractor company'
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

create or replace function public.configure_contractor_technician(
  p_actor_id uuid,
  p_contractor_id uuid,
  p_profile_id uuid,
  p_name text,
  p_phone text,
  p_access_level text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles%rowtype;
  canonical public.profiles%rowtype;
  member public.profiles%rowtype;
  organization_id uuid;
  organization_name text;
  technician_id uuid;
  prior_active boolean;
  prior_organization_id uuid;
  prior_access_level text;
  event_action text;
  slug_base text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;

  select * into actor
  from public.profiles
  where id = p_actor_id
    and active = true
    and role in ('manager', 'dispatcher', 'back_office');
  if not found then
    raise exception 'Active P1 staff actor required' using errcode = '42501';
  end if;
  if public.profile_has_staff_permission(p_actor_id, 'invoice_controller') then
    raise exception 'Operational staff access required' using errcode = '42501';
  end if;

  if p_access_level not in ('invoice', 'report_only') then
    raise exception 'Technician access must be invoice or report_only'
      using errcode = '22023';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'Technician name is required' using errcode = '22023';
  end if;
  if p_profile_id = p_contractor_id then
    raise exception 'The canonical contractor cannot be added as its own technician'
      using errcode = '22023';
  end if;

  select * into canonical
  from public.profiles
  where id = p_contractor_id
    and role = 'contractor'
    and active = true
  for update;
  if not found then
    raise exception 'Active canonical contractor not found' using errcode = 'P0002';
  end if;

  select * into member
  from public.profiles
  where id = p_profile_id
  for update;
  if not found then
    raise exception 'Invited contractor profile not found' using errcode = 'P0002';
  end if;
  if member.role <> 'contractor' then
    raise exception 'A staff account cannot become a contractor technician'
      using errcode = '23514';
  end if;
  if member.contractor_access_level = 'company_admin' then
    raise exception 'A contractor company administrator cannot be converted to a technician'
      using errcode = '23514';
  end if;

  -- Never repurpose a standalone contractor identity that already owns
  -- operational or financial history. Technician membership may be changed,
  -- but canonical contractor history must remain attached to its original
  -- company identity.
  if exists (
      select 1
      from public.organizations organization
      where organization.canonical_contractor_id = member.id
    )
    or exists (
      select 1
      from public.work_orders work_order
      where work_order.contractor_id = member.id
    )
    or exists (
      select 1
      from public.invoices invoice
      where invoice.contractor_id = member.id
    ) then
    raise exception 'An existing contractor account with history cannot be converted to a technician'
      using errcode = '23514';
  end if;

  prior_active := member.active;
  prior_organization_id := member.contractor_organization_id;
  prior_access_level := member.contractor_access_level;

  organization_id := canonical.contractor_organization_id;
  organization_name := coalesce(
    nullif(trim(canonical.company), ''),
    nullif(trim(canonical.name), ''),
    'Contractor company'
  );

  if organization_id is null then
    slug_base := trim(both '-' from regexp_replace(
      lower(organization_name),
      '[^a-z0-9]+',
      '-',
      'g'
    ));
    if slug_base = '' then
      slug_base := 'contractor';
    end if;

    insert into public.organizations (
      name,
      slug,
      active,
      canonical_contractor_id
    ) values (
      organization_name,
      slug_base || '-' || substr(replace(p_contractor_id::text, '-', ''), 1, 8),
      true,
      null
    )
    returning id into organization_id;

    update public.profiles
    set contractor_organization_id = organization_id,
        contractor_access_level = 'company_admin',
        is_assignable = true,
        updated_at = now()
    where id = canonical.id;

    update public.organizations
    set canonical_contractor_id = canonical.id,
        updated_at = now()
    where id = organization_id;
  else
    select organization.name
    into organization_name
    from public.organizations organization
    where organization.id = organization_id;

    if not exists (
      select 1
      from public.organizations organization
      where organization.id = organization_id
        and organization.active = true
        and (
          organization.canonical_contractor_id is null
          or organization.canonical_contractor_id = canonical.id
        )
    ) then
      raise exception 'Contractor organization is inactive or has a different canonical contractor'
        using errcode = '23514';
    end if;

    update public.profiles
    set contractor_access_level = 'company_admin',
        is_assignable = true,
        updated_at = now()
    where id = canonical.id;

    update public.organizations
    set canonical_contractor_id = canonical.id,
        updated_at = now()
    where id = organization_id
      and canonical_contractor_id is null;
  end if;

  if prior_organization_id is not null
     and prior_organization_id <> organization_id then
    raise exception 'This account already belongs to another contractor company'
      using errcode = '23514';
  end if;

  update public.profiles
  set name = trim(p_name),
      initials = upper(left(trim(p_name), 2)),
      phone = nullif(trim(p_phone), ''),
      title = 'Technician',
      company = organization_name,
      role = 'contractor',
      active = true,
      contractor_tier = 'contracted',
      dispatcher_id = null,
      contractor_organization_id = organization_id,
      contractor_access_level = p_access_level,
      is_assignable = false,
      updated_at = now()
  where id = member.id;

  select technician.id into technician_id
  from public.contractor_technicians technician
  where technician.contractor_id = canonical.id
    and (
      technician.profile_id = member.id
      or (
        technician.profile_id is null
        and lower(trim(technician.name)) = lower(trim(p_name))
      )
    )
  order by (technician.profile_id = member.id) desc
  limit 1
  for update;

  if technician_id is null then
    insert into public.contractor_technicians (
      contractor_id,
      profile_id,
      name,
      tier,
      is_active
    ) values (
      canonical.id,
      member.id,
      trim(p_name),
      'contracted',
      true
    )
    returning id into technician_id;
  else
    update public.contractor_technicians
    set profile_id = member.id,
        name = trim(p_name),
        tier = 'contracted',
        is_active = true,
        updated_at = now()
    where id = technician_id;
  end if;

  event_action := case
    when prior_active is false then 'reactivated'
    when prior_organization_id is null then 'invited'
    else 'updated'
  end;

  insert into public.contractor_technician_admin_events (
    contractor_id,
    technician_profile_id,
    actor_id,
    action,
    access_level,
    details
  ) values (
    canonical.id,
    member.id,
    actor.id,
    event_action,
    p_access_level,
    jsonb_build_object(
      'name', trim(p_name),
      'previousAccessLevel', prior_access_level,
      'organizationId', organization_id
    )
  );

  return jsonb_build_object(
    'contractorId', canonical.id,
    'organizationId', organization_id,
    'profileId', member.id,
    'technicianId', technician_id,
    'accessLevel', p_access_level,
    'action', event_action
  );
end;
$$;

create or replace function public.deactivate_contractor_technician(
  p_actor_id uuid,
  p_profile_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles%rowtype;
  member public.profiles%rowtype;
  canonical_id uuid;
  affected_work_orders text[] := '{}'::text[];
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;

  select * into actor
  from public.profiles
  where id = p_actor_id
    and active = true
    and role in ('manager', 'dispatcher', 'back_office');
  if not found then
    raise exception 'Active P1 staff actor required' using errcode = '42501';
  end if;
  if public.profile_has_staff_permission(p_actor_id, 'invoice_controller') then
    raise exception 'Operational staff access required' using errcode = '42501';
  end if;

  select profile.*
  into member
  from public.profiles profile
  where profile.id = p_profile_id
    and profile.role = 'contractor'
    and profile.active = true
    and profile.contractor_access_level in ('invoice', 'report_only')
  for update of profile;

  if not found then
    raise exception 'Managed contractor technician not found' using errcode = 'P0002';
  end if;

  select organization.canonical_contractor_id
  into canonical_id
  from public.organizations organization
  where organization.id = member.contractor_organization_id
    and organization.active = true;

  if canonical_id is null then
    raise exception 'Managed contractor technician company not found' using errcode = 'P0002';
  end if;
  if member.id = canonical_id then
    raise exception 'The canonical contractor account cannot be deactivated here'
      using errcode = '23514';
  end if;

  select coalesce(array_agg(work_order.id order by work_order.id), '{}'::text[])
  into affected_work_orders
  from public.work_orders work_order
  where work_order.assigned_technician_profile_id = member.id
    and work_order.deleted_at is null
    and work_order.status <> 'closed';

  update public.work_order_technician_assignments assignment
  set ended_at = now(),
      ended_by = actor.id
  where assignment.technician_profile_id = member.id
    and assignment.ended_at is null;

  update public.work_orders
  set assigned_technician_profile_id = null,
      updated_at = now()
  where assigned_technician_profile_id = member.id
    and deleted_at is null
    and status <> 'closed';

  update public.contractor_technicians
  set is_active = false,
      updated_at = now()
  where profile_id = member.id;

  update public.profiles
  set active = false,
      is_assignable = false,
      updated_at = now()
  where id = member.id;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data
  )
  select
    work_order_id,
    actor.id,
    actor.name,
    format('Technician %s was deactivated; the technician assignment was cleared.', member.name),
    'system',
    'technician_deactivated',
    jsonb_build_object(
      'technicianProfileId', member.id,
      'technician', member.name
    )
  from unnest(affected_work_orders) as affected(work_order_id);

  insert into public.contractor_technician_admin_events (
    contractor_id,
    technician_profile_id,
    actor_id,
    action,
    access_level,
    details
  ) values (
    canonical_id,
    member.id,
    actor.id,
    'deactivated',
    member.contractor_access_level,
    jsonb_build_object('clearedWorkOrders', affected_work_orders)
  );

  return jsonb_build_object(
    'contractorId', canonical_id,
    'profileId', member.id,
    'deactivated', true,
    'clearedWorkOrderIds', affected_work_orders
  );
end;
$$;

revoke all on function public.configure_contractor_technician(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
revoke all on function public.deactivate_contractor_technician(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.configure_contractor_technician(
  uuid, uuid, uuid, text, text, text
) to service_role;
grant execute on function public.deactivate_contractor_technician(uuid, uuid)
  to service_role;

commit;
