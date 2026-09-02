-- Keep contractor field completion independent from invoicing without moving
-- a work order backwards after an invoice has entered a billing/review queue.

begin;

-- Extend the existing guarded-reopen boundary so a raw pause/update cannot
-- reverse field completion. The authorized reopen RPC already creates the
-- transaction-local permit checked here and increments workflow_cycle.
create or replace function public.prevent_direct_work_order_reopen()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_guarded boolean := false;
  v_reverses_completion boolean := false;
begin
  v_reverses_completion := old.functional_status::text = 'Completed'
    and new.functional_status::text is distinct from 'Completed';

  if new.workflow_cycle is not distinct from old.workflow_cycle
     and not (
       old.status = 'closed'
       and new.status <> 'closed'
     )
     and not v_reverses_completion then
    return new;
  end if;

  if coalesce(auth.role(), '') in ('service_role', '') then
    return new;
  end if;

  select exists (
    select 1
    from public.work_order_reopen_transition_guards transition_guard
    where transition_guard.transaction_id = txid_current()
      and transition_guard.work_order_id = new.id
      and transition_guard.actor_id = auth.uid()
  ) into v_guarded;

  if new.workflow_cycle is distinct from old.workflow_cycle
     and not v_guarded then
    raise exception 'Work-order workflow cycle can only change during reopen'
      using errcode = '42501';
  end if;

  if old.status = 'closed'
     and new.status <> 'closed'
     and not v_guarded then
    raise exception 'Closed work orders must be reopened through the reopen workflow'
      using errcode = '42501';
  end if;

  if v_reverses_completion and not v_guarded then
    raise exception 'Completed field work must be reopened before its status can regress'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_direct_work_order_reopen()
  from public, anon, authenticated;

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
  v_result_status public.wo_status;
  v_activity_id uuid;
  v_visits_closed integer := 0;
begin
  if v_actor_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  select profile.name, profile.role::text
  into v_actor_name, v_actor_role
  from public.profiles profile
  where profile.id = v_actor_id
    and profile.active = true;

  if not found then
    raise exception 'Active portal profile required'
      using errcode = '42501';
  end if;

  select *
  into v_work_order
  from public.work_orders work_order
  where work_order.id = p_work_order_id
    and work_order.deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found';
  end if;

  if v_actor_role not in ('manager', 'dispatcher', 'back_office')
     and not (
       v_actor_role = 'contractor'
       and public.can_access_contractor_work_order(p_work_order_id)
     ) then
    raise exception 'Work order completion is not permitted'
      using errcode = '42501';
  end if;

  if v_actor_role in ('manager', 'dispatcher', 'back_office')
     and public.profile_has_staff_permission(
       v_actor_id,
       'invoice_controller'
     ) then
    raise exception 'Operational staff access required'
      using errcode = '42501';
  end if;

  select activity.id
  into v_activity_id
  from public.activities activity
  where activity.work_order_id = p_work_order_id
    and activity.event_key = 'job_completed'
    and activity.deleted_at is null
    and activity.contractor_assignment_version
      = v_work_order.contractor_assignment_version
    and activity.workflow_cycle = v_work_order.workflow_cycle
    and (
      public.is_staff()
      or (
        v_work_order.contractor_assignment_started_at is not null
        and activity.created_at >= v_work_order.contractor_assignment_started_at
      )
    )
  order by activity.created_at desc
  limit 1;

  if v_activity_id is not null
     or v_work_order.functional_status::text = 'Completed'
     or v_work_order.status = 'completed' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_completed',
      'activityId', v_activity_id,
      'workOrderStatus', v_work_order.status
    );
  end if;

  if v_work_order.billing_only
     or v_work_order.status::text not in (
    'wip',
    'pending_invoice',
    'pending_approval',
    'pending_payment'
     ) then
    raise exception 'This work order cannot be completed from its current status';
  end if;

  if p_completed_at is null then
    raise exception 'Completion time is required'
      using errcode = '22023';
  end if;

  if nullif(trim(coalesce(p_asset_make, '')), '') is null
     or nullif(trim(coalesce(p_asset_model, '')), '') is null
     or nullif(trim(coalesce(p_asset_serial, '')), '') is null then
    raise exception 'Equipment make, model, and serial number are required'
      using errcode = '22023';
  end if;

  v_result_status := case
    when v_work_order.status::text in (
      'pending_invoice',
      'pending_approval',
      'pending_payment'
    ) then v_work_order.status
    else 'completed'::public.wo_status
  end;

  update public.work_orders
  set status = v_result_status,
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

  update public.work_order_visits visit
  set check_out_at = p_completed_at,
      checked_out_by = v_actor_id,
      updated_at = now()
  where visit.work_order_id = p_work_order_id
    and visit.contractor_id = v_work_order.contractor_id
    and visit.check_out_at is null
    and (
      public.is_staff()
      or visit.created_at >= v_work_order.contractor_assignment_started_at
    );
  get diagnostics v_visits_closed = row_count;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    is_staff_override,
    event_key,
    event_data,
    workflow_cycle
  ) values (
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
      'closingNotes', nullif(trim(coalesce(p_resolution_notes, '')), ''),
      'preservedWorkOrderStatus', v_result_status
    ),
    v_work_order.workflow_cycle
  )
  returning id into v_activity_id;

  return jsonb_build_object(
    'applied', true,
    'activityId', v_activity_id,
    'visitsClosed', v_visits_closed,
    'workOrderStatus', v_result_status
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

comment on function public.complete_work_order_once(
  text,
  timestamptz,
  text,
  text,
  text,
  integer,
  text,
  text,
  text
) is
  'Completes field work once while preserving invoice-driven work-order status.';

commit;
