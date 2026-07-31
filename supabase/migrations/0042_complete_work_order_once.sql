-- Complete a work order, close its open visit, and append the completion
-- activity in one transaction. Replayed completion requests become no-ops.

with ranked_completions as (
  select
    id,
    row_number() over (
      partition by work_order_id
      order by created_at, id
    ) as completion_number
  from public.activities
  where event_key = 'job_completed'
    and deleted_at is null
)
update public.activities activity
set deleted_at = now()
from ranked_completions duplicate
where activity.id = duplicate.id
  and duplicate.completion_number > 1;

create unique index if not exists activities_one_job_completion_per_work_order
  on public.activities(work_order_id)
  where event_key = 'job_completed'
    and deleted_at is null;

create or replace function public.complete_work_order_once(
  p_work_order_id text,
  p_completed_at timestamptz,
  p_asset_make text,
  p_asset_model text,
  p_asset_serial text,
  p_asset_year integer,
  p_resolution_code text,
  p_resolution_notes text,
  p_activity_text text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_actor_role text;
  v_work_order public.work_orders%rowtype;
  v_activity_id uuid;
  v_visits_closed integer := 0;
begin
  if v_actor_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  select p.name, p.role::text
  into v_actor_name, v_actor_role
  from public.profiles p
  where p.id = v_actor_id;

  select *
  into v_work_order
  from public.work_orders
  where id = p_work_order_id
    and deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found';
  end if;

  if v_actor_role not in ('manager', 'dispatcher', 'back_office')
     and not (
       v_actor_role = 'contractor'
       and v_work_order.contractor_id = v_actor_id
     ) then
    raise exception 'Work order completion is not permitted'
      using errcode = '42501';
  end if;

  select a.id
  into v_activity_id
  from public.activities a
  where a.work_order_id = p_work_order_id
    and a.event_key = 'job_completed'
    and a.deleted_at is null
  order by a.created_at desc
  limit 1;

  if v_activity_id is not null or v_work_order.status = 'completed' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_completed',
      'activityId', v_activity_id
    );
  end if;

  if v_work_order.status in ('closed', 'capital') then
    raise exception 'This work order cannot be completed from its current status';
  end if;

  update public.work_orders
  set
    status = 'completed',
    functional_status = 'Completed',
    asset_make = nullif(trim(coalesce(p_asset_make, '')), ''),
    asset_model = nullif(trim(coalesce(p_asset_model, '')), ''),
    asset_serial = nullif(trim(coalesce(p_asset_serial, '')), ''),
    asset_year = p_asset_year,
    end_time = p_completed_at,
    resolution_code = nullif(trim(coalesce(p_resolution_code, '')), ''),
    resolution_notes = nullif(trim(coalesce(p_resolution_notes, '')), ''),
    updated_at = now()
  where id = p_work_order_id;

  update public.work_order_visits
  set
    check_out_at = p_completed_at,
    checked_out_by = v_actor_id,
    updated_at = now()
  where work_order_id = p_work_order_id
    and check_out_at is null;
  get diagnostics v_visits_closed = row_count;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    is_staff_override,
    event_key,
    event_data
  )
  values (
    p_work_order_id,
    v_actor_id,
    coalesce(v_actor_name, 'Portal user'),
    p_activity_text,
    'note',
    v_actor_role in ('manager', 'dispatcher', 'back_office'),
    'job_completed',
    jsonb_build_object(
      'clockedOutAt', p_completed_at,
      'resolution', nullif(trim(coalesce(p_resolution_code, '')), ''),
      'closingNotes', nullif(trim(coalesce(p_resolution_notes, '')), '')
    )
  )
  returning id into v_activity_id;

  return jsonb_build_object(
    'applied', true,
    'activityId', v_activity_id,
    'visitsClosed', v_visits_closed
  );
end;
$$;

revoke all on function public.complete_work_order_once(
  text,
  timestamptz,
  text,
  text,
  text,
  integer,
  text,
  text,
  text
) from public, anon;

grant execute on function public.complete_work_order_once(
  text,
  timestamptz,
  text,
  text,
  text,
  integer,
  text,
  text,
  text
) to authenticated, service_role;
