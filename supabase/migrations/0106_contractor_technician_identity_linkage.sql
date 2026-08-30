-- A technician dropdown row and a portal login represent the same person only
-- when contractor_technicians.profile_id points at that login. A text label by
-- itself is a historical/display record and must never be mistaken for portal
-- assignment identity.

begin;

-- Keep every linked dropdown row's display name canonical with its portal
-- profile. Unlinked legacy rows remain valid for record-only use.
create or replace function public.validate_contractor_technician_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  linked_profile_name text;
begin
  if new.profile_id is null then
    return new;
  end if;

  select profile.name
  into linked_profile_name
  from public.profiles profile
  where profile.id = new.profile_id
    and profile.role = 'contractor'
    and profile.active = true
    and profile.contractor_access_level in ('invoice', 'report_only')
    and public.contractor_account_id_for_profile(profile.id)
      = new.contractor_id;

  if linked_profile_name is null then
    raise exception 'Portal technician must be an active invoice or report-only member of this contractor company'
      using errcode = '23514';
  end if;

  new.name := linked_profile_name;
  return new;
end;
$$;

revoke all on function public.validate_contractor_technician_profile()
  from public, anon, authenticated;
grant execute on function public.validate_contractor_technician_profile()
  to service_role;

drop trigger if exists validate_contractor_technician_profile_trigger
  on public.contractor_technicians;
create trigger validate_contractor_technician_profile_trigger
  before insert or update of contractor_id, profile_id, name
  on public.contractor_technicians
  for each row execute function public.validate_contractor_technician_profile();

-- Repair the confirmed SCRC identity mismatch. The block is deliberately
-- guarded by exact company and login email, rejects ambiguous/cross-profile
-- aliases, preserves old dropdown rows as inactive history, and uses the normal
-- work-order assignment triggers to create structured assignment history.
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
    and profile.contractor_access_level = 'report_only';

  if matching_count <> 1 then
    raise exception 'Expected exactly one active report-only SCRC login for Raymond Rush; found %',
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
  for update;

  select count(*)
  into matching_count
  from public.contractor_technicians technician
  where technician.profile_id = rush_profile_id
    and technician.contractor_id = scrc_contractor_id
    and technician.is_active = true;

  if matching_count <> 1 then
    raise exception 'Expected exactly one active SCRC technician link for Raymond Rush; found %',
      matching_count using errcode = '23514';
  end if;

  select technician.id
  into rush_technician_id
  from public.contractor_technicians technician
  where technician.profile_id = rush_profile_id
    and technician.contractor_id = scrc_contractor_id
    and technician.is_active = true
  for update;

  if exists (
    select 1
    from public.contractor_technicians technician
    where technician.contractor_id = scrc_contractor_id
      and technician.id <> rush_technician_id
      and technician.profile_id is not null
      and regexp_replace(lower(trim(technician.name)), '[^a-z0-9]+', '', 'g')
        in ('rush', 'rushraymond', 'raymondrush')
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
      ) in ('rush', 'rushraymond', 'raymondrush')
      and work_order.assigned_technician_profile_id is not null
      and work_order.assigned_technician_profile_id <> rush_profile_id
  ) then
    raise exception 'A Raymond Rush work-order label is assigned to a different portal profile'
      using errcode = '23514';
  end if;

  -- Preserve obsolete name rows for history while removing them from active
  -- dropdowns. The unique suffix also prevents a collision with the canonical
  -- linked row name.
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
    and regexp_replace(lower(trim(technician.name)), '[^a-z0-9]+', '', 'g')
      in ('rush', 'rushraymond', 'raymondrush');

  update public.profiles
  set name = canonical_name,
      initials = 'RR',
      updated_at = now()
  where id = rush_profile_id;

  update public.contractor_technicians
  set name = canonical_name,
      tier = 'contracted',
      is_active = true,
      updated_at = now()
  where id = rush_technician_id;

  update public.work_orders work_order
  set assigned_technician_profile_id = rush_profile_id,
      technician_on_job = canonical_name,
      updated_at = now()
  where work_order.contractor_id = scrc_contractor_id
    and work_order.deleted_at is null
    and (
      work_order.assigned_technician_profile_id = rush_profile_id
      or (
        work_order.assigned_technician_profile_id is null
        and regexp_replace(
          lower(trim(coalesce(work_order.technician_on_job, ''))),
          '[^a-z0-9]+',
          '',
          'g'
        ) in ('rush', 'rushraymond', 'raymondrush')
      )
    );
end
$$;

comment on function public.validate_contractor_technician_profile() is
  'Validates that a linked technician belongs to the same contractor company and canonicalizes the dropdown name to the linked portal profile name. Unlinked rows remain record-only labels.';

commit;
