-- Follow-up to 0106: the original bootstrap roster contained the misspelling
-- "Raymon Rush". Because that row was record-only, selecting it updated the
-- work-order label without assigning Raymond Rush's portal profile.

begin;

do $$
declare
  scrc_organization_id uuid;
  scrc_contractor_id uuid;
  rush_profile_id uuid;
  rush_technician_id uuid;
  matching_count integer;
  canonical_name constant text := 'Raymond Rush';
begin
  select count(*)
  into matching_count
  from public.organizations organization
  join public.profiles canonical
    on canonical.id = organization.canonical_contractor_id
   and canonical.contractor_organization_id = organization.id
   and canonical.role = 'contractor'
   and canonical.active = true
  where organization.active = true
    and lower(canonical.email) = 'scrcdallastexas@gmail.com';

  if matching_count <> 1 then
    raise exception 'Expected exactly one active SCRC organization; found %',
      matching_count using errcode = '23514';
  end if;

  select organization.id, organization.canonical_contractor_id
  into scrc_organization_id, scrc_contractor_id
  from public.organizations organization
  join public.profiles canonical
    on canonical.id = organization.canonical_contractor_id
   and canonical.contractor_organization_id = organization.id
   and canonical.role = 'contractor'
   and canonical.active = true
  where organization.active = true
    and lower(canonical.email) = 'scrcdallastexas@gmail.com';

  select count(*)
  into matching_count
  from public.profiles profile
  where lower(profile.email) = 'rayrush50@gmail.com'
    and profile.role = 'contractor'
    and profile.active = true
    and profile.contractor_organization_id = scrc_organization_id
    and profile.contractor_access_level = 'report_only'
    and profile.name = canonical_name;

  if matching_count <> 1 then
    raise exception 'Expected exactly one canonical SCRC login for Raymond Rush; found %',
      matching_count using errcode = '23514';
  end if;

  select profile.id
  into rush_profile_id
  from public.profiles profile
  where lower(profile.email) = 'rayrush50@gmail.com'
    and profile.role = 'contractor'
    and profile.active = true
    and profile.contractor_organization_id = scrc_organization_id
    and profile.contractor_access_level = 'report_only'
    and profile.name = canonical_name
  for update;

  select count(*)
  into matching_count
  from public.contractor_technicians technician
  where technician.profile_id = rush_profile_id
    and technician.contractor_id = scrc_contractor_id
    and technician.is_active = true
    and technician.name = canonical_name;

  if matching_count <> 1 then
    raise exception 'Expected exactly one canonical active technician link for Raymond Rush; found %',
      matching_count using errcode = '23514';
  end if;

  select technician.id
  into rush_technician_id
  from public.contractor_technicians technician
  where technician.profile_id = rush_profile_id
    and technician.contractor_id = scrc_contractor_id
    and technician.is_active = true
    and technician.name = canonical_name
  for update;

  if exists (
    select 1
    from public.contractor_technicians technician
    where technician.contractor_id = scrc_contractor_id
      and technician.id <> rush_technician_id
      and technician.profile_id is not null
      and regexp_replace(lower(trim(technician.name)), '[^a-z0-9]+', '', 'g')
        in ('rush', 'rushraymond', 'raymondrush', 'raymonrush')
  ) then
    raise exception 'A Raymond Rush alias is linked to a different portal profile'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.work_orders work_order
    where work_order.contractor_id = scrc_contractor_id
      and work_order.deleted_at is null
      and regexp_replace(
        lower(trim(coalesce(work_order.technician_on_job, ''))),
        '[^a-z0-9]+',
        '',
        'g'
      ) in ('rush', 'rushraymond', 'raymondrush', 'raymonrush')
      and work_order.assigned_technician_profile_id is not null
      and work_order.assigned_technician_profile_id <> rush_profile_id
  ) then
    raise exception 'A Raymond Rush work-order label is assigned to a different portal profile'
      using errcode = '23514';
  end if;

  -- Preserve all old spelling rows as inactive history. The UUID suffix keeps
  -- the original label recognizable without colliding with the linked row.
  update public.contractor_technicians technician
  set name = format(
        '%s [legacy-%s]',
        technician.name,
        technician.id::text
      ),
      is_active = false,
      updated_at = now()
  where technician.contractor_id = scrc_contractor_id
    and technician.id <> rush_technician_id
    and technician.profile_id is null
    and technician.is_active = true
    and regexp_replace(lower(trim(technician.name)), '[^a-z0-9]+', '', 'g')
      in ('rush', 'rushraymond', 'raymondrush', 'raymonrush');

  -- Convert every current text-only Rush assignment into the structured
  -- profile assignment used by RLS. Existing correctly linked rows only have
  -- their display snapshot canonicalized.
  update public.work_orders work_order
  set assigned_technician_profile_id = rush_profile_id,
      technician_on_job = canonical_name,
      updated_at = now()
  where work_order.contractor_id = scrc_contractor_id
    and work_order.deleted_at is null
    and (
      (
        work_order.assigned_technician_profile_id = rush_profile_id
        and work_order.technician_on_job is distinct from canonical_name
      )
      or (
        work_order.assigned_technician_profile_id is null
        and regexp_replace(
          lower(trim(coalesce(work_order.technician_on_job, ''))),
          '[^a-z0-9]+',
          '',
          'g'
        ) in ('rush', 'rushraymond', 'raymondrush', 'raymonrush')
      )
    );
end
$$;

commit;
