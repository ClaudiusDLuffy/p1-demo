-- Give active VA coordinators global access to open work orders and allow
-- narrowly-scoped, individually-attributed 7-Eleven field-note queue entries.
-- This does not expose internal conversation or any billing/pricing workflow,
-- and it never submits updates to 7-Eleven.

begin;

create index if not exists work_orders_va_coordinator_open_updated_cursor_idx
  on public.work_orders (
    (coalesce(updated_at, '1970-01-01 00:00:00+00'::timestamptz)) desc,
    id desc
  )
  where deleted_at is null
    and status <> 'closed'
    and functional_status is distinct from 'Cancelled'::public.fsm_functional_status;

create or replace function public.can_access_va_coordinator_work_order(p_work_order_id text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_va_coordinator() and exists (
    select 1
    from public.work_orders work_order
    where work_order.id = p_work_order_id
      and work_order.deleted_at is null
      and work_order.status <> 'closed'
      and work_order.functional_status is distinct from 'Cancelled'::public.fsm_functional_status
  )
$$;

create or replace function public.list_va_coordinator_work_orders_v1(
  p_search text default null,
  p_limit integer default 25,
  p_cursor jsonb default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
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
      if not isfinite(v_cursor_time) then
        raise exception 'Invalid page cursor' using errcode = '22023';
      end if;
    exception when others then
      raise exception 'Invalid page cursor' using errcode = '22023';
    end;
  else
    v_cursor_time := 'infinity'::timestamptz;
    v_cursor_id := '';
  end if;
  return (
    with page_plus_one as materialized (
      select work_order.id, work_order.store_number, work_order.city,
        work_order.store_state, work_order.summary, work_order.functional_status,
        work_order.status, work_order.priority, work_order.asset_make,
        work_order.asset_model, work_order.asset_serial,
        coalesce(work_order.updated_at, '1970-01-01 00:00:00+00'::timestamptz) as updated_sort,
        work_order.updated_at, technician.name as technician_name
      from public.work_orders work_order
      left join public.profiles technician
        on technician.id = work_order.assigned_technician_profile_id
      where work_order.deleted_at is null
        and work_order.status <> 'closed'
        and work_order.functional_status is distinct from 'Cancelled'::public.fsm_functional_status
        and (v_query is null or (
          coalesce(work_order.id, '') || ' ' || coalesce(work_order.incident_id, '') || ' ' ||
          coalesce(work_order.store_number, '') || ' ' || coalesce(work_order.city, '') || ' ' ||
          coalesce(work_order.address, '') || ' ' || coalesce(work_order.summary, '') || ' ' ||
          coalesce(work_order.description, '')
        ) ilike '%' || v_query || '%')
        and (
          coalesce(work_order.updated_at, '1970-01-01 00:00:00+00'::timestamptz),
          work_order.id
        ) < (v_cursor_time, v_cursor_id)
      order by coalesce(work_order.updated_at, '1970-01-01 00:00:00+00'::timestamptz) desc,
        work_order.id desc
      limit p_limit + 1
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

-- Add VA-authored update entries to the existing field-note queue response.
-- Internal notes and other conversation channels are deliberately excluded.
create or replace function public.list_va_coordinator_technician_notes_v1(
  p_work_order_id text, p_limit integer default 100
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if not public.can_access_va_coordinator_work_order(p_work_order_id) then
    raise exception 'Work order is unavailable for VA review' using errcode = '42501';
  end if;
  if coalesce(p_limit, 0) not between 1 and 100 then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', n.id, 'workOrderId', p_work_order_id, 'text', n.text, 'createdAt', n.created_at,
      'authorName', n.author_name, 'enteredByRole', n.entered_by_role,
      'syncedToSevenElevenAt', n.synced_to_7eleven_at,
      'syncedById', n.synced_to_7eleven_by, 'syncedByName', sync_actor.name,
      'requiresSevenElevenSync', n.requires_7eleven_sync
    ) order by n.created_at desc nulls last, n.id desc), '[]'::jsonb)
    from (
      select a.id, a.text, a.created_at, a.author_name, a.entered_by_role,
        a.synced_to_7eleven_at, a.synced_to_7eleven_by, a.requires_7eleven_sync
      from public.activities a
      join public.work_orders w on w.id = a.work_order_id
      where a.work_order_id = p_work_order_id and a.deleted_at is null
        and a.workflow_cycle = w.workflow_cycle
        and a.activity_channel = 'field_note' and a.is_staff_only = false
        and a.requires_7eleven_sync = true
        and a.entered_by_role in ('contractor', 'manager', 'dispatcher', 'back_office', 'va_coordinator', 'system')
      order by a.created_at desc nulls last, a.id desc limit p_limit
    ) n left join public.profiles sync_actor on sync_actor.id = n.synced_to_7eleven_by
  );
end;
$$;

-- Work-order photos remain restricted to finalized photo bindings, but are no
-- longer hidden merely because they predate the latest contractor assignment.
create or replace function public.list_va_coordinator_photos_v1(
  p_work_order_id text, p_limit integer default 100
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if not public.can_access_va_coordinator_work_order(p_work_order_id) then
    raise exception 'Work order is unavailable for VA review' using errcode = '42501';
  end if;
  if coalesce(p_limit, 0) not between 1 and 100 then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', photo.id, 'workOrderId', p_work_order_id, 'storagePath', photo.storage_path,
      'caption', photo.caption, 'createdAt', photo.created_at, 'uploaderName', photo.uploader_name
    ) order by photo.created_at desc nulls last, photo.id desc), '[]'::jsonb)
    from (
      select p.id, p.work_order_id, p.storage_path, p.caption, p.created_at, p.uploader_name
      from public.photos p
      where p.work_order_id = p_work_order_id
        and exists (
          select 1 from public.private_object_bindings binding
          where binding.purpose = 'photo' and binding.photo_id = p.id
            and binding.work_order_id = p.work_order_id
            and binding.object_path = p.storage_path and binding.state = 'finalized'
        )
      order by p.created_at desc nulls last, p.id desc limit p_limit
    ) photo
  );
end;
$$;

create or replace function public.can_read_va_coordinator_photo(uuid, text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select public.is_va_coordinator() and exists (
    select 1 from public.private_object_bindings binding
    join public.photos photo on photo.id = binding.photo_id
    join public.work_orders work_order on work_order.id = photo.work_order_id
    where binding.bucket = 'photos' and binding.purpose = 'photo'
      and binding.state = 'finalized' and binding.storage_object_id = $1
      and binding.object_path = $2 and binding.work_order_id = photo.work_order_id
      and photo.storage_path = binding.object_path
      and public.can_access_va_coordinator_work_order(work_order.id)
  )
$$;

revoke all on function public.list_va_coordinator_photos_v1(text, integer) from public, anon;
grant execute on function public.list_va_coordinator_photos_v1(text, integer) to authenticated, service_role;
revoke all on function public.can_read_va_coordinator_photo(uuid, text) from public, anon;
grant execute on function public.can_read_va_coordinator_photo(uuid, text) to authenticated, service_role;

-- The role is represented in the activity audit column, but the database
-- permits only field-note activity for VA coordinators.
alter table public.activities drop constraint if exists activities_entered_by_role_check;
alter table public.activities add constraint activities_entered_by_role_check
  check (entered_by_role in (
    'manager', 'dispatcher', 'back_office', 'contractor', 'system', 'va_coordinator'
  ));

create or replace function public.stamp_activity_actor_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_role text;
  assigned_contractor uuid;
  requested_channel text;
  lifecycle_event boolean;
  invoice_event boolean;
begin
  if new.author_id is null and auth.uid() is not null then
    new.author_id := auth.uid();
  end if;

  if new.author_id is not null then
    select role::text into actor_role from public.profiles where id = new.author_id;
  end if;
  new.entered_by_role := coalesce(actor_role, 'system');

  if new.entered_by_role = 'contractor' then
    new.is_staff_override := false;
    new.override_for_contractor_id := null;
  elsif new.entered_by_role in ('manager', 'dispatcher', 'back_office') and new.is_staff_override then
    select contractor_id into assigned_contractor from public.work_orders where id = new.work_order_id;
    new.override_for_contractor_id := coalesce(new.override_for_contractor_id, assigned_contractor);
  else
    new.is_staff_override := false;
    new.override_for_contractor_id := null;
  end if;

  requested_channel := lower(coalesce(nullif(trim(new.activity_channel), ''), 'legacy'));
  if requested_channel not in ('field_note', 'internal_note', 'contractor_message', 'system_event', 'legacy') then
    raise exception 'Invalid activity channel' using errcode = '22023';
  end if;

  lifecycle_event := new.event_key in ('check_in', 'check_out', 'job_paused', 'job_completed');
  invoice_event := coalesce(new.event_key, '') ~ '^invoice_';
  if lifecycle_event then
    requested_channel := 'field_note';
  elsif requested_channel = 'internal_note' then
    requested_channel := 'internal_note';
  elsif requested_channel = 'contractor_message' then
    requested_channel := 'contractor_message';
  elsif invoice_event or new.type = 'system' or requested_channel = 'system_event'
        or new.event_key not in ('note', 'ai_note') then
    requested_channel := 'system_event';
  elsif requested_channel = 'legacy' then
    if new.event_key in ('note', 'ai_note')
       and new.entered_by_role in ('manager', 'dispatcher', 'back_office') then
      requested_channel := 'internal_note';
    elsif new.event_key in ('note', 'ai_note') and new.entered_by_role = 'contractor' then
      requested_channel := 'field_note';
    end if;
  end if;

  if requested_channel = 'internal_note'
     and new.entered_by_role not in ('manager', 'dispatcher', 'back_office') then
    raise exception 'Only staff can create internal notes' using errcode = '42501';
  end if;
  if new.entered_by_role = 'va_coordinator' and (
    requested_channel <> 'field_note'
    or new.event_key not in ('note', 'ai_note')
    or new.type <> 'note'
    or new.author_id is distinct from auth.uid()
  ) then
    raise exception 'VA coordinators may only add attributed field notes' using errcode = '42501';
  end if;
  if requested_channel in ('field_note', 'contractor_message')
     and new.entered_by_role not in ('manager', 'dispatcher', 'back_office', 'contractor', 'va_coordinator') then
    raise exception 'A signed-in portal user is required for this activity channel' using errcode = '42501';
  end if;
  if requested_channel = 'system_event' and new.entered_by_role = 'contractor'
     and new.type <> 'system' and new.event_key in ('note', 'ai_note') then
    raise exception 'Contractors cannot classify a user note as a system event' using errcode = '42501';
  end if;

  new.activity_channel := requested_channel;
  if requested_channel = 'internal_note' then
    new.is_staff_only := true;
    new.requires_contractor_attention := false;
    new.contractor_attention_acknowledged_at := null;
    new.contractor_attention_acknowledged_by := null;
  elsif requested_channel in ('field_note', 'contractor_message') then
    new.is_staff_only := false;
  end if;
  new.requires_7eleven_sync := requested_channel = 'field_note';
  if not new.requires_7eleven_sync then
    new.synced_to_7eleven_at := null;
    new.synced_to_7eleven_by := null;
  end if;
  return new;
end;
$$;

-- Extend the existing single-purpose sync transition to accept new VA-authored
-- queue entries. Existing contractor notes still require their current
-- assignment window; VA posts are bound by current assignment/workflow version.
create or replace function public.mark_work_order_activity_synced_v1(p_activity_id uuid, p_synced boolean)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
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
  perform 1 from public.activities a join public.work_orders w on w.id = a.work_order_id
  where a.id = p_activity_id and a.requires_7eleven_sync for update of a;
  if not found then raise exception 'Activity is not a field update' using errcode = '22023'; end if;
  if v_is_va and not exists (
    select 1 from public.activities a join public.work_orders w on w.id = a.work_order_id
    where a.id = p_activity_id and a.deleted_at is null
      and a.entered_by_role in ('contractor', 'manager', 'dispatcher', 'back_office', 'va_coordinator', 'system')
      and a.activity_channel = 'field_note' and a.is_staff_only = false
      and a.requires_7eleven_sync and a.synced_to_7eleven_at is null
      and a.workflow_cycle = w.workflow_cycle
      and public.can_access_va_coordinator_work_order(w.id)
  ) then
    raise exception 'Transferable field update not found' using errcode = '42501';
  end if;
  insert into public.work_order_lifecycle_transition_guards
    (transaction_id, work_order_id, actor_id, command_kind, activity_id)
  values (txid_current(), v_work_order_id, auth.uid(), 'sync', p_activity_id);
  update public.activities set
    synced_to_7eleven_at = case when p_synced then now() else null end,
    synced_to_7eleven_by = case when p_synced then auth.uid() else null end
  where id = p_activity_id and requires_7eleven_sync
    and (not v_is_va or synced_to_7eleven_at is null);
  if not found then raise exception 'Transferable field update not found' using errcode = '42501'; end if;
  delete from public.work_order_lifecycle_transition_guards
  where transaction_id = txid_current() and work_order_id = v_work_order_id
    and actor_id = auth.uid() and command_kind = 'sync' and activity_id = p_activity_id;
end;
$$;

create or replace function public.protect_activity_7eleven_sync()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
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
         or new.entered_by_role not in ('contractor', 'manager', 'dispatcher', 'back_office', 'va_coordinator', 'system')
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
             and old.workflow_cycle = w.workflow_cycle
             and old.entered_by_role in ('contractor', 'manager', 'dispatcher', 'back_office', 'va_coordinator', 'system')
         ) then
        raise exception 'Only authorized confirmed VA transfers may update this field' using errcode = '42501';
      end if;
    end if;
    if new.requires_7eleven_sync and new.activity_channel is distinct from 'field_note' then
      raise exception 'Only field notes can require a 7-Eleven update' using errcode = '23514';
    end if;
    if not new.requires_7eleven_sync or new.synced_to_7eleven_at is null then
      new.synced_to_7eleven_by := null;
    else
      new.synced_to_7eleven_by := auth.uid();
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.post_va_coordinator_seven_eleven_update_v1(
  p_work_order_id text,
  p_text text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_work public.work_orders%rowtype;
  v_author_name text;
  v_activity public.activities%rowtype;
begin
  if auth.uid() is null or not public.is_va_coordinator() then
    raise exception 'Active VA coordinator access required' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_work_order_id, '')), '') is null
     or length(p_work_order_id) > 128
     or nullif(btrim(coalesce(p_text, '')), '') is null
     or char_length(btrim(p_text)) > 4000 then
    raise exception 'Enter an update of 1 to 4000 characters' using errcode = '22023';
  end if;
  select * into v_work from public.work_orders w
  where w.id = p_work_order_id for update;
  if not found or not public.can_access_va_coordinator_work_order(p_work_order_id) then
    raise exception 'Work order is unavailable for VA updates' using errcode = '42501';
  end if;
  select p.name into v_author_name from public.profiles p
  where p.id = auth.uid() and p.role = 'va_coordinator' and p.active = true for share;
  if not found then raise exception 'Active VA coordinator access required' using errcode = '42501'; end if;

  insert into public.activities (
    work_order_id, author_id, author_name, text, type, event_key, event_data,
    activity_channel, is_staff_only, requires_7eleven_sync,
    requires_contractor_attention, is_staff_override
  ) values (
    v_work.id, auth.uid(), v_author_name, btrim(p_text), 'note', 'note', '{}'::jsonb,
    'field_note', false, true, false, false
  ) returning * into v_activity;

  return jsonb_build_object(
    'id', v_activity.id,
    'workOrderId', v_activity.work_order_id,
    'text', v_activity.text,
    'createdAt', v_activity.created_at,
    'authorName', v_activity.author_name,
    'enteredByRole', v_activity.entered_by_role,
    'syncedToSevenElevenAt', v_activity.synced_to_7eleven_at,
    'syncedById', v_activity.synced_to_7eleven_by,
    'syncedByName', null,
    'requiresSevenElevenSync', v_activity.requires_7eleven_sync
  );
end;
$$;

revoke all on function public.can_access_va_coordinator_work_order(text) from public, anon;
grant execute on function public.can_access_va_coordinator_work_order(text) to authenticated, service_role;
revoke all on function public.list_va_coordinator_work_orders_v1(text, integer, jsonb) from public, anon;
grant execute on function public.list_va_coordinator_work_orders_v1(text, integer, jsonb) to authenticated, service_role;
revoke all on function public.list_va_coordinator_technician_notes_v1(text, integer) from public, anon;
grant execute on function public.list_va_coordinator_technician_notes_v1(text, integer) to authenticated, service_role;
revoke all on function public.mark_work_order_activity_synced_v1(uuid, boolean) from public, anon;
grant execute on function public.mark_work_order_activity_synced_v1(uuid, boolean) to authenticated, service_role;
revoke all on function public.post_va_coordinator_seven_eleven_update_v1(text, text) from public, anon;
grant execute on function public.post_va_coordinator_seven_eleven_update_v1(text, text) to authenticated, service_role;

commit;
