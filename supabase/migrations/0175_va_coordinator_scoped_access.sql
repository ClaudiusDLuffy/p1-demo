begin;

do $prerequisite$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.oid = 'public.user_role'::regtype and e.enumlabel = 'va_coordinator'
  ) then
    raise exception 'Apply migration 0174_add_va_coordinator_role.sql first';
  end if;
  if to_regclass('public.private_object_bindings') is null
     or to_regprocedure('public.is_staff()') is null
     or to_regprocedure('public.is_invoice_controller()') is null
     or to_regprocedure('public.mark_work_order_activity_synced_v1(uuid,boolean)') is null then
    raise exception 'VA coordinator prerequisites are missing';
  end if;
end;
$prerequisite$;

create schema if not exists va_coordinator_private;
revoke all on schema va_coordinator_private from public, anon, authenticated, service_role;

create table va_coordinator_private.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table va_coordinator_private.team_members (
  team_id uuid not null references va_coordinator_private.teams(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, profile_id)
);

create table va_coordinator_private.team_technicians (
  team_id uuid not null references va_coordinator_private.teams(id) on delete cascade,
  technician_profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, technician_profile_id)
);

create table va_coordinator_private.assignment_events (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references va_coordinator_private.teams(id),
  actor_id uuid not null references public.profiles(id),
  coordinator_profile_ids uuid[] not null,
  technician_profile_ids uuid[] not null,
  created_at timestamptz not null default now()
);

create index va_coordinator_team_members_profile_idx
  on va_coordinator_private.team_members(profile_id, team_id);
create index va_coordinator_team_technicians_profile_idx
  on va_coordinator_private.team_technicians(technician_profile_id, team_id);

create function va_coordinator_private.validate_team_member()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, va_coordinator_private, pg_temp as $$
begin
  if not exists (select 1 from public.profiles p where p.id = new.profile_id
    and p.role = 'va_coordinator' and p.active = true) then
    raise exception 'Team member must be an active VA coordinator' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger va_coordinator_team_member_valid
before insert or update on va_coordinator_private.team_members
for each row execute function va_coordinator_private.validate_team_member();

create function va_coordinator_private.validate_team_technician()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, va_coordinator_private, pg_temp as $$
begin
  if not exists (
    select 1 from public.profiles p
    join public.contractor_technicians t on t.profile_id = p.id and t.is_active = true
    where p.id = new.technician_profile_id and p.role = 'contractor' and p.active = true
  ) then
    raise exception 'Team technician must be an active portal contractor technician' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger va_coordinator_team_technician_valid
before insert or update on va_coordinator_private.team_technicians
for each row execute function va_coordinator_private.validate_team_technician();

create function public.configure_va_coordinator_team_v1(
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
  if auth.uid() is null or not public.is_staff() or public.is_invoice_controller() then
    raise exception 'Active authorized staff access required' using errcode = '42501';
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

create function public.is_va_coordinator()
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid()
    and p.role = 'va_coordinator' and p.active = true)
$$;

create function public.can_access_va_coordinator_work_order(p_work_order_id text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, va_coordinator_private as $$
  select public.is_va_coordinator() and exists (
    select 1 from public.work_orders w
    join va_coordinator_private.team_technicians tt
      on tt.technician_profile_id = w.assigned_technician_profile_id
    join va_coordinator_private.team_members tm on tm.team_id = tt.team_id
    join va_coordinator_private.teams team on team.id = tm.team_id and team.active = true
    join public.profiles technician on technician.id = tt.technician_profile_id
      and technician.role = 'contractor' and technician.active = true
    join public.contractor_technicians membership on membership.profile_id = technician.id
      and membership.is_active = true
    where w.id = p_work_order_id and w.deleted_at is null and tm.profile_id = auth.uid()
  )
$$;

revoke all on function public.is_va_coordinator() from public, anon;
revoke all on function public.can_access_va_coordinator_work_order(text) from public, anon;
grant execute on function public.is_va_coordinator() to authenticated, service_role;
grant execute on function public.can_access_va_coordinator_work_order(text) to authenticated, service_role;

create function public.can_read_va_coordinator_photo(uuid, text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, va_coordinator_private as $$
  select public.is_va_coordinator() and exists (
    select 1 from public.private_object_bindings binding
    join public.photos photo on photo.id = binding.photo_id
    join public.work_orders work_order on work_order.id = photo.work_order_id
    where binding.bucket = 'photos' and binding.purpose = 'photo'
      and binding.state = 'finalized' and binding.storage_object_id = $1
      and binding.object_path = $2 and binding.work_order_id = photo.work_order_id
      and photo.storage_path = binding.object_path and work_order.deleted_at is null
      and work_order.contractor_assignment_started_at is not null
      and photo.created_at >= work_order.contractor_assignment_started_at
      and public.can_access_va_coordinator_work_order(work_order.id)
  )
$$;
revoke all on function public.can_read_va_coordinator_photo(uuid,text) from public, anon;
grant execute on function public.can_read_va_coordinator_photo(uuid,text) to authenticated, service_role;

create function public.list_va_coordinator_work_orders_v1(
  p_search text default null, p_limit integer default 25, p_cursor jsonb default null
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, va_coordinator_private, pg_temp as $$
declare
  v_query text := nullif(btrim(coalesce(p_search, '')), '');
  v_cursor_time timestamptz;
  v_cursor_id text;
begin
  if not public.is_va_coordinator() then
    raise exception 'Active VA coordinator access required' using errcode = '42501';
  end if;
  if char_length(coalesce(p_search, '')) > 120 or coalesce(p_limit, 0) not between 1 and 100 then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if jsonb_typeof(p_cursor) <> 'object'
      or jsonb_typeof(p_cursor->'updatedAt') <> 'string'
      or jsonb_typeof(p_cursor->'id') <> 'string'
      or length(p_cursor->>'id') not between 1 and 128 then
      raise exception 'Invalid page cursor' using errcode = '22023';
    end if;
    begin
      v_cursor_time := (p_cursor->>'updatedAt')::timestamptz;
      v_cursor_id := p_cursor->>'id';
    exception when others then
      raise exception 'Invalid page cursor' using errcode = '22023';
    end;
  end if;
  return (
    with scoped as materialized (
      select w.id, w.store_number, w.city, w.store_state, w.summary, w.functional_status,
        w.status, w.priority, w.asset_make, w.asset_model, w.asset_serial,
        coalesce(w.updated_at, '1970-01-01 00:00:00+00'::timestamptz) as updated_sort,
        w.updated_at, tech.name as technician_name
      from public.work_orders w
      left join public.profiles tech on tech.id = w.assigned_technician_profile_id
      where w.deleted_at is null
        and exists (
          select 1 from va_coordinator_private.team_technicians tt
          join va_coordinator_private.team_members tm on tm.team_id = tt.team_id and tm.profile_id = auth.uid()
          join va_coordinator_private.teams team on team.id = tm.team_id and team.active = true
          join public.profiles technician on technician.id = tt.technician_profile_id
            and technician.role = 'contractor' and technician.active = true
          join public.contractor_technicians membership on membership.profile_id = technician.id
            and membership.is_active = true
          where tt.technician_profile_id = w.assigned_technician_profile_id
        )
        and (v_query is null or w.id ilike '%' || v_query || '%'
          or coalesce(w.store_number, '') ilike '%' || v_query || '%'
          or coalesce(w.summary, '') ilike '%' || v_query || '%'
          or coalesce(w.city, '') ilike '%' || v_query || '%')
        and (p_cursor is null or (coalesce(w.updated_at, '1970-01-01 00:00:00+00'::timestamptz), w.id)
          < (v_cursor_time, v_cursor_id))
    ), page_plus_one as (
      select * from scoped order by updated_sort desc, id desc limit p_limit + 1
    ), page_rows as (
      select * from page_plus_one order by updated_sort desc, id desc limit p_limit
    ), final_cursor as (
      select updated_sort, id from page_rows order by updated_sort asc, id asc limit 1
    )
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'storeNumber', store_number, 'city', city, 'state', store_state,
        'summary', summary, 'functionalStatus', functional_status, 'status', status,
        'priority', priority, 'assetMake', asset_make, 'assetModel', asset_model,
        'assetSerial', asset_serial, 'updatedAt', updated_at, 'technicianName', technician_name
      ) order by updated_sort desc, id desc) from page_rows), '[]'::jsonb),
      'hasMore', (select count(*) > p_limit from page_plus_one),
      'nextCursor', case when (select count(*) > p_limit from page_plus_one) then
        (select jsonb_build_object('updatedAt', updated_sort, 'id', id) from final_cursor)
        else null end
    )
  );
end;
$$;

create function public.get_va_coordinator_work_order_v1(p_work_order_id text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, va_coordinator_private, pg_temp as $$
begin
  if not public.is_va_coordinator() then
    raise exception 'Active VA coordinator access required' using errcode = '42501';
  end if;
  if p_work_order_id is null or length(p_work_order_id) > 100 then
    raise exception 'Invalid work order' using errcode = '22023';
  end if;
  return (
    select jsonb_build_object(
      'id', w.id, 'storeNumber', w.store_number, 'city', w.city, 'state', w.store_state,
      'address', w.address, 'summary', w.summary, 'description', w.description,
      'functionalStatus', w.functional_status, 'status', w.status,
      'priority', w.priority, 'assetMake', w.asset_make, 'assetModel', w.asset_model,
      'assetSerial', w.asset_serial, 'assetYear', w.asset_year,
      'technicianName', tech.name, 'updatedAt', w.updated_at
    ) from public.work_orders w
    left join public.profiles tech on tech.id = w.assigned_technician_profile_id
    where w.id = p_work_order_id and public.can_access_va_coordinator_work_order(w.id)
  );
end;
$$;

create function public.list_va_coordinator_technician_notes_v1(
  p_work_order_id text, p_limit integer default 100
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, va_coordinator_private, pg_temp as $$
begin
  if not public.can_access_va_coordinator_work_order(p_work_order_id) then
    raise exception 'Work order is outside your VA team' using errcode = '42501';
  end if;
  if coalesce(p_limit, 0) not between 1 and 100 then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', n.id, 'workOrderId', p_work_order_id, 'text', n.text, 'createdAt', n.created_at,
      'authorName', n.author_name, 'syncedToSevenElevenAt', n.synced_to_7eleven_at,
      'syncedById', n.synced_to_7eleven_by, 'syncedByName', sync_actor.name,
      'requiresSevenElevenSync', n.requires_7eleven_sync
    ) order by n.created_at desc nulls last, n.id desc), '[]'::jsonb)
    from (
      select a.id, a.text, a.created_at, a.author_name,
        a.synced_to_7eleven_at, a.synced_to_7eleven_by, a.requires_7eleven_sync
      from public.activities a
      join public.work_orders w on w.id = a.work_order_id
      where a.work_order_id = p_work_order_id and a.deleted_at is null
        and a.contractor_assignment_version = w.contractor_assignment_version
        and a.workflow_cycle = w.workflow_cycle
        and w.contractor_assignment_started_at is not null
        and a.created_at >= w.contractor_assignment_started_at
        and a.entered_by_role = 'contractor' and a.is_staff_only = false
      order by a.created_at desc nulls last, a.id desc limit p_limit
    ) n left join public.profiles sync_actor on sync_actor.id = n.synced_to_7eleven_by
  );
end;
$$;

create function public.list_va_coordinator_photos_v1(
  p_work_order_id text, p_limit integer default 100
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, va_coordinator_private, pg_temp as $$
begin
  if not public.can_access_va_coordinator_work_order(p_work_order_id) then
    raise exception 'Work order is outside your VA team' using errcode = '42501';
  end if;
  if coalesce(p_limit, 0) not between 1 and 100 then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'workOrderId', p.work_order_id, 'storagePath', p.storage_path, 'caption', p.caption,
      'createdAt', p.created_at, 'uploaderName', p.uploader_name
    ) order by p.created_at desc nulls last, p.id desc), '[]'::jsonb)
    from (
    select p.id, p.work_order_id, p.storage_path, p.caption, p.created_at, p.uploader_name
      from public.photos p join public.work_orders w on w.id = p.work_order_id
      where p.work_order_id = p_work_order_id
        and w.contractor_assignment_started_at is not null
        and p.created_at >= w.contractor_assignment_started_at
        and exists (
          select 1 from public.private_object_bindings binding
          where binding.purpose = 'photo' and binding.photo_id = p.id
            and binding.work_order_id = p.work_order_id
            and binding.object_path = p.storage_path and binding.state = 'finalized'
        )
      order by created_at desc nulls last, id desc limit p_limit
    ) p
  );
end;
$$;

create or replace function public.mark_work_order_activity_synced_v1(p_activity_id uuid, p_synced boolean)
returns void language plpgsql security definer
set search_path = pg_catalog, public, va_coordinator_private, pg_temp as $$
declare
  v_work_order_id text;
  v_is_va boolean := public.is_va_coordinator();
begin
  if auth.uid() is null or (not public.is_staff() and not v_is_va) then
    raise exception 'Active staff access required' using errcode = '42501';
  end if;
  if p_activity_id is null or p_synced is null then
    raise exception 'Activity and synchronization state are required' using errcode = '22023';
  end if;
  if v_is_va and not p_synced then
    raise exception 'VA coordinators may only record a completed transfer' using errcode = '42501';
  end if;
  select a.work_order_id into v_work_order_id
  from public.activities a where a.id = p_activity_id and a.deleted_at is null;
  if not found then raise exception 'Activity not found' using errcode = 'P0002'; end if;
  perform 1 from public.work_orders w where w.id = v_work_order_id for update;
  perform 1 from public.activities a
    join public.work_orders w on w.id = a.work_order_id
    where a.id = p_activity_id and a.requires_7eleven_sync for update of a;
  if not found then raise exception 'Activity is not a field update' using errcode = '22023'; end if;
  if v_is_va and not exists (
    select 1 from public.activities a join public.work_orders w on w.id = a.work_order_id
    where a.id = p_activity_id and a.deleted_at is null and a.entered_by_role = 'contractor'
      and a.is_staff_only = false and a.requires_7eleven_sync
      and a.contractor_assignment_version = w.contractor_assignment_version
      and a.workflow_cycle = w.workflow_cycle
      and w.contractor_assignment_started_at is not null
      and a.created_at >= w.contractor_assignment_started_at
      and a.synced_to_7eleven_at is null
      and public.can_access_va_coordinator_work_order(w.id)
  ) then
    raise exception 'Transferable technician note not found for your team' using errcode = '42501';
  end if;
  insert into public.work_order_lifecycle_transition_guards
    (transaction_id, work_order_id, actor_id, command_kind, activity_id)
  values (txid_current(), v_work_order_id, auth.uid(), 'sync', p_activity_id);
  update public.activities set
    synced_to_7eleven_at = case when p_synced then now() else null end,
    synced_to_7eleven_by = case when p_synced then auth.uid() else null end
  where id = p_activity_id and requires_7eleven_sync
    and (not v_is_va or synced_to_7eleven_at is null);
  if not found then raise exception 'Transferable technician note not found for your team' using errcode = '42501'; end if;
  delete from public.work_order_lifecycle_transition_guards
  where transaction_id = txid_current() and work_order_id = v_work_order_id
      and actor_id = auth.uid() and command_kind = 'sync' and activity_id = p_activity_id;
end;
$$;

create or replace function public.protect_activity_7eleven_sync()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, va_coordinator_private, pg_temp as $$
begin
  if new.requires_7eleven_sync is distinct from old.requires_7eleven_sync
     or new.synced_to_7eleven_at is distinct from old.synced_to_7eleven_at
     or new.synced_to_7eleven_by is distinct from old.synced_to_7eleven_by then
    if auth.uid() is not null and not public.is_staff() then
      if not public.is_va_coordinator()
         or new.requires_7eleven_sync is distinct from old.requires_7eleven_sync
         or old.requires_7eleven_sync is not true
         or old.synced_to_7eleven_at is not null
         or new.synced_to_7eleven_at is null
         or new.synced_to_7eleven_by is distinct from auth.uid()
         or new.activity_channel is distinct from 'field_note'
         or new.entered_by_role is distinct from 'contractor'
         or new.is_staff_only is distinct from false
         or not exists (
           select 1 from public.work_order_lifecycle_transition_guards g
           where g.transaction_id = txid_current() and g.work_order_id = old.work_order_id
             and g.actor_id = auth.uid() and g.command_kind = 'sync' and g.activity_id = old.id
         )
         or not public.can_access_va_coordinator_work_order(old.work_order_id)
         or not exists (
           select 1 from public.work_orders w
           where w.id = old.work_order_id and w.deleted_at is null
             and w.contractor_assignment_started_at is not null
             and old.created_at >= w.contractor_assignment_started_at
             and old.contractor_assignment_version = w.contractor_assignment_version
             and old.workflow_cycle = w.workflow_cycle
         ) then
        raise exception 'Only authorized confirmed VA transfers may update this field'
          using errcode = '42501';
      end if;
    end if;

    if new.requires_7eleven_sync
       and new.activity_channel is distinct from 'field_note' then
      raise exception 'Only field notes can require a 7-Eleven update'
        using errcode = '23514';
    end if;

    if not new.requires_7eleven_sync
       or new.synced_to_7eleven_at is null then
      new.synced_to_7eleven_by := null;
    else
      new.synced_to_7eleven_by := auth.uid();
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.protect_activity_7eleven_sync() from public, anon, authenticated, service_role;

revoke all on function public.list_va_coordinator_work_orders_v1(text,integer,jsonb) from public, anon;
revoke all on function public.get_va_coordinator_work_order_v1(text) from public, anon;
revoke all on function public.list_va_coordinator_technician_notes_v1(text,integer) from public, anon;
revoke all on function public.list_va_coordinator_photos_v1(text,integer) from public, anon;
revoke all on function public.mark_work_order_activity_synced_v1(uuid,boolean) from public, anon;
revoke all on function public.configure_va_coordinator_team_v1(uuid,text,uuid[],uuid[]) from public, anon;
grant execute on function public.list_va_coordinator_work_orders_v1(text,integer,jsonb) to authenticated, service_role;
grant execute on function public.get_va_coordinator_work_order_v1(text) to authenticated, service_role;
grant execute on function public.list_va_coordinator_technician_notes_v1(text,integer) to authenticated, service_role;
grant execute on function public.list_va_coordinator_photos_v1(text,integer) to authenticated, service_role;
grant execute on function public.mark_work_order_activity_synced_v1(uuid,boolean) to authenticated, service_role;
grant execute on function public.configure_va_coordinator_team_v1(uuid,text,uuid[],uuid[]) to authenticated, service_role;
drop policy if exists va_coordinator_photos_read on storage.objects;
create policy va_coordinator_photos_read on storage.objects
for select using (
  bucket_id = 'photos'
  and public.can_read_va_coordinator_photo(objects.id, name)
);

commit;
