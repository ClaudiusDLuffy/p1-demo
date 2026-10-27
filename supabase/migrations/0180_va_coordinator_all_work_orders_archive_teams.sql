begin;

-- The VA list is now global, so match the same partial indexes used by the
-- portal's bounded work-order search and keyset pagination.
create index if not exists work_orders_va_coordinator_updated_cursor_idx
  on public.work_orders ((coalesce(updated_at, '1970-01-01 00:00:00+00'::timestamptz)) desc, id desc)
  where deleted_at is null;

-- VAs now have read/transfer access to every non-deleted work order. Team
-- assignments are retained as archived data and no longer control visibility.
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
    -- A finite upper bound keeps the first page on the same index-backed
    -- keyset predicate as subsequent pages.
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

revoke all on function public.can_access_va_coordinator_work_order(text) from public, anon;
grant execute on function public.can_access_va_coordinator_work_order(text) to authenticated, service_role;
revoke all on function public.list_va_coordinator_work_orders_v1(text, integer, jsonb) from public, anon;
grant execute on function public.list_va_coordinator_work_orders_v1(text, integer, jsonb) to authenticated, service_role;

create or replace function public.list_va_coordinator_technician_notes_v1(
  p_work_order_id text, p_limit integer default 100
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, va_coordinator_private, pg_temp as $$
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

create or replace function public.list_va_coordinator_photos_v1(
  p_work_order_id text, p_limit integer default 100
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, va_coordinator_private, pg_temp as $$
begin
  if not public.can_access_va_coordinator_work_order(p_work_order_id) then
    raise exception 'Work order is unavailable for VA review' using errcode = '42501';
  end if;
  if coalesce(p_limit, 0) not between 1 and 100 then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'workOrderId', p.work_order_id, 'storagePath', p.storage_path,
      'caption', p.caption, 'createdAt', p.created_at, 'uploaderName', p.uploader_name
    ) order by p.created_at desc nulls last, p.id desc), '[]'::jsonb)
    from (
      select p.id, p.work_order_id, p.storage_path, p.caption, p.created_at, p.uploader_name
      from public.photos p
      join public.work_orders w on w.id = p.work_order_id
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

-- Archive, but preserve, existing team assignments for possible future reuse.
update va_coordinator_private.teams
set active = false
where active = true;

-- The management interface is archived. Keep its definitions and data, but
-- prevent authenticated clients from reading or changing team assignments.
revoke all on function public.list_va_coordinator_team_management_v1() from public, anon, authenticated;
revoke all on function public.configure_va_coordinator_team_v1(uuid, text, uuid[], uuid[]) from public, anon, authenticated;
revoke all on function public.list_va_coordinator_team_management_v2() from public, anon, authenticated;
revoke all on function public.configure_va_coordinator_team_v2(uuid, text, uuid[], uuid[]) from public, anon, authenticated;

commit;
