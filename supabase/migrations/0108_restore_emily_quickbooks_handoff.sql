-- Restore the explicitly approved QuickBooks handoff owner. The handoff
-- capability is additive: it permits staging/confirming accounting batches
-- without changing the user's broader portal role or controller-only scope.

begin;

do $migration$
declare
  matching_profile_count integer;
  active_staff_match_count integer;
  emily_profile_id uuid;
begin
  select
    count(*),
    count(*) filter (
      where profile.active = true
        and profile.role in ('manager', 'dispatcher', 'back_office')
    )
  into matching_profile_count, active_staff_match_count
  from public.profiles profile
  where lower(trim(coalesce(profile.email, '')))
    = 'emilyb@phospitality.com';

  if matching_profile_count <> 1 or active_staff_match_count <> 1 then
    raise exception
      'Expected exactly one active staff profile for the approved QuickBooks handoff owner; found % email match(es) and % active staff match(es)',
      matching_profile_count,
      active_staff_match_count
      using errcode = '23514';
  end if;

  select profile.id
  into emily_profile_id
  from public.profiles profile
  where lower(trim(coalesce(profile.email, '')))
      = 'emilyb@phospitality.com'
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office');

  insert into public.staff_permission_grants (
    profile_id,
    permission,
    granted_by
  ) values (
    emily_profile_id,
    'quickbooks_handoff',
    null
  )
  on conflict (profile_id, permission) do nothing;
end
$migration$;

commit;
