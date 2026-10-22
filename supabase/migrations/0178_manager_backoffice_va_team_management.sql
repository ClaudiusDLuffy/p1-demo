begin;

-- VA team administration is limited to active managers and back-office staff.
-- Keep the role check in the database boundary as well as the UI.
create or replace function public.configure_va_coordinator_team_v1(
  p_team_id uuid default null,
  p_name text default null,
  p_coordinator_profile_ids uuid[] default '{}',
  p_technician_profile_ids uuid[] default '{}'
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, va_coordinator_private, pg_temp as $$
declare
  v_team_id uuid := p_team_id;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_coordinators uuid[] := coalesce(p_coordinator_profile_ids, '{}');
  v_technicians uuid[] := coalesce(p_technician_profile_ids, '{}');
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles actor
    where actor.id = auth.uid()
      and actor.role in ('manager', 'back_office')
      and actor.active = true
  ) then
    raise exception 'Active manager or back-office access required' using errcode = '42501';
  end if;
  if v_name is null or length(v_name) > 120
    or cardinality(v_coordinators) > 100 or cardinality(v_technicians) > 500
    or array_position(v_coordinators, null) is not null
    or array_position(v_technicians, null) is not null
    or cardinality(v_coordinators) <> (select count(distinct item) from unnest(v_coordinators) item)
    or cardinality(v_technicians) <> (select count(distinct item) from unnest(v_technicians) item) then
    raise exception 'Invalid VA team configuration' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(v_coordinators) requested(profile_id)
    left join public.profiles p on p.id = requested.profile_id
    where p.id is null or p.role <> 'va_coordinator' or p.active is not true
  ) then raise exception 'Coordinator roster contains an ineligible profile' using errcode = '23514'; end if;
  if exists (
    select 1 from unnest(v_technicians) requested(profile_id)
    left join public.profiles p on p.id = requested.profile_id
    left join public.contractor_technicians t on t.profile_id = p.id and t.is_active = true
    where p.id is null or p.role <> 'contractor' or p.active is not true or t.profile_id is null
  ) then raise exception 'Technician roster contains an ineligible profile' using errcode = '23514'; end if;

  if v_team_id is null then
    insert into va_coordinator_private.teams(name) values (v_name) returning id into v_team_id;
  else
    update va_coordinator_private.teams set name = v_name
    where id = v_team_id and active = true;
    if not found then raise exception 'Active VA team not found' using errcode = 'P0002'; end if;
  end if;

  delete from va_coordinator_private.team_members m
    where m.team_id = v_team_id and not (m.profile_id = any(v_coordinators));
  insert into va_coordinator_private.team_members(team_id, profile_id)
    select v_team_id, requested.profile_id from unnest(v_coordinators) requested(profile_id)
    on conflict do nothing;
  delete from va_coordinator_private.team_technicians t
    where t.team_id = v_team_id and not (t.technician_profile_id = any(v_technicians));
  insert into va_coordinator_private.team_technicians(team_id, technician_profile_id)
    select v_team_id, requested.profile_id from unnest(v_technicians) requested(profile_id)
    on conflict do nothing;

  insert into va_coordinator_private.assignment_events(
    team_id, actor_id, coordinator_profile_ids, technician_profile_ids
  ) values (v_team_id, auth.uid(), v_coordinators, v_technicians);

  return jsonb_build_object('teamId', v_team_id, 'name', v_name,
    'coordinatorCount', cardinality(v_coordinators), 'technicianCount', cardinality(v_technicians));
end;
$$;

create or replace function public.list_va_coordinator_team_management_v1()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, va_coordinator_private, pg_temp as $$
declare
  v_teams jsonb;
  v_coordinators jsonb;
  v_technicians jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles actor
    where actor.id = auth.uid()
      and actor.role in ('manager', 'back_office')
      and actor.active = true
  ) then
    raise exception 'Active manager or back-office access required' using errcode = '42501';
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

  return jsonb_build_object('teams', v_teams, 'coordinators', v_coordinators, 'technicians', v_technicians);
end;
$$;

revoke all on function public.list_va_coordinator_team_management_v1() from public, anon;
grant execute on function public.list_va_coordinator_team_management_v1() to authenticated, service_role;
revoke all on function public.configure_va_coordinator_team_v1(uuid,text,uuid[],uuid[]) from public, anon;
grant execute on function public.configure_va_coordinator_team_v1(uuid,text,uuid[],uuid[]) to authenticated, service_role;

commit;
