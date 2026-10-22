begin;

-- Test identities remain usable by their existing workflows, but must not be
-- selectable as production VA-team technicians.
alter table public.profiles
  add column if not exists is_test_account boolean not null default false;

comment on column public.profiles.is_test_account is
  'Marks a portal profile as a test identity; test identities are excluded from VA team technician rosters.';

create function public.list_va_coordinator_team_management_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_result jsonb;
  v_teams jsonb;
  v_technicians jsonb;
begin
  -- The existing RPC performs the authoritative manager/back-office check.
  v_result := public.list_va_coordinator_team_management_v1();

  select coalesce(jsonb_agg(
    jsonb_set(team.value, '{technicians}', eligible.items)
    order by team.value->>'name'
  ), '[]'::jsonb)
  into v_teams
  from jsonb_array_elements(coalesce(v_result->'teams', '[]'::jsonb)) team(value)
  cross join lateral (
    select coalesce(jsonb_agg(person.value order by person.value->>'name'), '[]'::jsonb) as items
    from jsonb_array_elements(coalesce(team.value->'technicians', '[]'::jsonb)) person(value)
    where not exists (
      select 1 from public.profiles profile
      where profile.id = (person.value->>'id')::uuid
        and profile.is_test_account = true
    )
  ) eligible;

  select coalesce(jsonb_agg(person.value order by person.value->>'name'), '[]'::jsonb)
  into v_technicians
  from jsonb_array_elements(coalesce(v_result->'technicians', '[]'::jsonb)) person(value)
  where not exists (
    select 1 from public.profiles profile
    where profile.id = (person.value->>'id')::uuid
      and profile.is_test_account = true
  );

  return jsonb_set(jsonb_set(v_result, '{teams}', v_teams), '{technicians}', v_technicians);
end;
$$;

create function public.configure_va_coordinator_team_v2(
  p_team_id uuid default null,
  p_name text default null,
  p_coordinator_profile_ids uuid[] default '{}',
  p_technician_profile_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles actor
    where actor.id = auth.uid()
      and actor.role in ('manager', 'back_office')
      and actor.active = true
  ) then
    raise exception 'Active manager or back-office access required' using errcode = '42501';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_technician_profile_ids, '{}')) requested(profile_id)
    left join public.profiles profile on profile.id = requested.profile_id
    where profile.id is null
      or profile.role <> 'contractor'
      or profile.active is not true
      or profile.is_test_account is true
      or not exists (
        select 1 from public.contractor_technicians technician
        where technician.profile_id = profile.id and technician.is_active = true
      )
  ) then
    raise exception 'Technician roster contains an ineligible profile' using errcode = '23514';
  end if;

  return public.configure_va_coordinator_team_v1(
    p_team_id, p_name, p_coordinator_profile_ids, p_technician_profile_ids
  );
end;
$$;

revoke all on function public.list_va_coordinator_team_management_v2() from public, anon;
grant execute on function public.list_va_coordinator_team_management_v2() to authenticated, service_role;
revoke all on function public.configure_va_coordinator_team_v2(uuid,text,uuid[],uuid[]) from public, anon;
grant execute on function public.configure_va_coordinator_team_v2(uuid,text,uuid[],uuid[]) to authenticated, service_role;

-- Prevent authenticated clients from bypassing the filtered RPCs.
revoke all on function public.list_va_coordinator_team_management_v1() from authenticated;
revoke all on function public.configure_va_coordinator_team_v1(uuid,text,uuid[],uuid[]) from authenticated;

commit;
