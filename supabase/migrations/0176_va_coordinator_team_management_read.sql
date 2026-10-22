begin;

create function public.list_va_coordinator_team_management_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, va_coordinator_private, pg_temp
as $$
declare
  v_teams jsonb;
  v_coordinators jsonb;
  v_technicians jsonb;
begin
  if auth.uid() is null or not public.is_staff() or public.is_invoice_controller() then
    raise exception 'Active authorized staff access required' using errcode = '42501';
  end if;

  if (select count(*) from va_coordinator_private.teams where active) > 200
    or (select count(*) from public.profiles where role = 'va_coordinator' and active) > 100
    or (select count(distinct profile.id)
        from public.profiles profile
        join public.contractor_technicians technician
          on technician.profile_id = profile.id and technician.is_active
        where profile.role = 'contractor' and profile.active) > 500 then
    raise exception 'VA team directory exceeds its supported size' using errcode = '54000';
  end if;

  select coalesce(jsonb_agg(team_json order by team_json->>'name'), '[]'::jsonb)
    into v_teams
    from (
      select jsonb_build_object(
        'id', team.id,
        'name', team.name,
        'coordinators', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', profile.id, 'name', profile.name, 'active', profile.active
          ) order by profile.name, profile.id)
          from va_coordinator_private.team_members membership
          join public.profiles profile on profile.id = membership.profile_id
          where membership.team_id = team.id
        ), '[]'::jsonb),
        'technicians', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', profile.id, 'name', profile.name, 'company', profile.company, 'active', profile.active
          ) order by profile.company, profile.name, profile.id)
          from va_coordinator_private.team_technicians membership
          join public.profiles profile on profile.id = membership.technician_profile_id
          where membership.team_id = team.id
        ), '[]'::jsonb)
      ) as team_json
      from va_coordinator_private.teams team
      where team.active
    ) teams;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', profile.id, 'name', profile.name, 'active', profile.active
  ) order by profile.name, profile.id), '[]'::jsonb)
    into v_coordinators
    from public.profiles profile
    where profile.role = 'va_coordinator' and profile.active;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', eligible.id, 'name', eligible.name, 'company', eligible.company, 'active', eligible.active
  ) order by eligible.company, eligible.name, eligible.id), '[]'::jsonb)
    into v_technicians
    from (
      select profile.id, profile.name, profile.company, profile.active
      from public.profiles profile
      join public.contractor_technicians technician
        on technician.profile_id = profile.id and technician.is_active
      where profile.role = 'contractor' and profile.active
      group by profile.id, profile.name, profile.company, profile.active
    ) eligible;

  return jsonb_build_object(
    'teams', v_teams,
    'coordinators', v_coordinators,
    'technicians', v_technicians
  );
end;
$$;

revoke all on function public.list_va_coordinator_team_management_v1() from public, anon;
grant execute on function public.list_va_coordinator_team_management_v1() to authenticated, service_role;

commit;
