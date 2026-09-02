-- Give operational P1 staff a dispatch-time rejection action without hard
-- deleting work-order history. Only a never-assigned, untouched work order
-- can be rejected; the decision and soft removal commit atomically.

begin;

create or replace function public.guard_work_order_archive_mutations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text := coalesce(auth.role(), '');
begin
  -- Controlled imports and database recovery use the service role. Empty
  -- auth.role() is retained for trusted migration/backfill sessions.
  if v_actor_role in ('service_role', '') then
    return new;
  end if;

  -- An archived row is immutable to authenticated API callers. This prevents
  -- a concurrent assignment (or any raw client update) from reviving a work
  -- order after the rejection transaction commits.
  if old.deleted_at is not null then
    raise exception 'Archived work orders cannot be changed'
      using errcode = '23514';
  end if;

  -- RLS grants contractors UPDATE access to their assigned row. Column-level
  -- archive authority therefore needs an explicit database guard.
  if (
    new.deleted_at is distinct from old.deleted_at
    or new.deleted_by is distinct from old.deleted_by
  ) and (
    not public.is_staff()
    or public.is_invoice_controller()
  ) then
    raise exception 'Only active P1 staff can archive a work order'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_work_order_archive_mutations_trigger
  on public.work_orders;
create trigger guard_work_order_archive_mutations_trigger
  before update on public.work_orders
  for each row execute function public.guard_work_order_archive_mutations();

revoke all on function public.guard_work_order_archive_mutations()
  from public, anon, authenticated;

-- Serialize invoice attachment against rejection. A normal foreign-key check
-- does not require a lock that conflicts with a soft-delete update, so this
-- explicit parent lock closes both orders of the reject/insert race.
create or replace function public.guard_invoice_active_work_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.work_order_id is null
     or (
       tg_op = 'UPDATE'
       and new.work_order_id is not distinct from old.work_order_id
       and not (
         old.deleted_at is not null
         and new.deleted_at is null
       )
     ) then
    return new;
  end if;

  perform 1
  from public.work_orders work_order
  where work_order.id = new.work_order_id
    and work_order.deleted_at is null
  for share;

  if not found then
    raise exception 'Invoices cannot be attached to an archived work order'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_invoice_active_work_order_trigger
  on public.invoices;
create trigger guard_invoice_active_work_order_trigger
  before insert or update of work_order_id, deleted_at on public.invoices
  for each row execute function public.guard_invoice_active_work_order();

revoke all on function public.guard_invoice_active_work_order()
  from public, anon, authenticated;

create or replace function public.reject_unassigned_work_order(
  p_work_order_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_work_order public.work_orders%rowtype;
  v_reason text := trim(coalesce(p_reason, ''));
  v_now timestamptz := now();
begin
  if nullif(trim(coalesce(p_work_order_id, '')), '') is null then
    raise exception 'Work order is required'
      using errcode = '22023';
  end if;

  if char_length(v_reason) < 5 or char_length(v_reason) > 500 then
    raise exception 'Rejection reason must be between 5 and 500 characters'
      using errcode = '22023';
  end if;

  select profile.*
  into v_actor
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office');

  if not found then
    raise exception 'Active P1 staff access required'
      using errcode = '42501';
  end if;

  if public.profile_has_staff_permission(v_actor.id, 'invoice_controller') then
    raise exception 'Operational staff access required'
      using errcode = '42501';
  end if;

  select work_order.*
  into v_work_order
  from public.work_orders work_order
  where work_order.id = trim(p_work_order_id)
    and work_order.deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found'
      using errcode = 'P0002';
  end if;

  if v_work_order.status <> 'unassigned'
     or coalesce(v_work_order.functional_status::text, '') <> 'New'
     or v_work_order.contractor_id is not null
     or v_work_order.assigned_technician_profile_id is not null
     or v_work_order.technician_on_job is not null
     or v_work_order.contractor_assignment_version <> 0
     or v_work_order.contractor_assignment_started_at is not null
     or v_work_order.dispatched_at is not null
     or v_work_order.start_time is not null
     or v_work_order.end_time is not null
     or v_work_order.billing_only then
    raise exception 'Only an untouched, never-assigned work order can be rejected'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1
    from public.work_order_assignment_history history
    where history.work_order_id = v_work_order.id
  ) then
    raise exception 'A previously assigned work order cannot be rejected'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1
    from public.invoices invoice
    where invoice.work_order_id = v_work_order.id
      and invoice.deleted_at is null
  ) then
    raise exception 'A work order with an invoice cannot be rejected'
      using errcode = 'PT409';
  end if;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    activity_channel,
    is_staff_override,
    is_staff_only,
    requires_7eleven_sync,
    requires_contractor_attention,
    event_key,
    event_data,
    contractor_assignment_version,
    workflow_cycle
  ) values (
    v_work_order.id,
    v_actor.id,
    v_actor.name,
    format(
      'Work order rejected during dispatch by %s. Reason: %s',
      v_actor.name,
      v_reason
    ),
    'system',
    'system_event',
    false,
    true,
    false,
    false,
    'work_order_rejected',
    jsonb_build_object(
      'action', 'rejected_during_dispatch',
      'reason', v_reason,
      'priorStatus', v_work_order.status,
      'priorFunctionalStatus', v_work_order.functional_status,
      'priorAssignmentVersion', v_work_order.contractor_assignment_version,
      'source', v_work_order.source,
      'incidentId', v_work_order.incident_id
    ),
    v_work_order.contractor_assignment_version,
    v_work_order.workflow_cycle
  );

  update public.work_orders work_order
  set deleted_at = v_now,
      deleted_by = v_actor.id,
      updated_at = v_now
  where work_order.id = v_work_order.id
    and work_order.deleted_at is null;

  if not found then
    raise exception 'Work order rejection conflicted with another change'
      using errcode = 'PT409';
  end if;

  return jsonb_build_object(
    'applied', true,
    'reason', 'rejected',
    'workOrderId', v_work_order.id,
    'rejectedAt', v_now,
    'rejectedBy', v_actor.id
  );
end;
$$;

revoke all on function public.reject_unassigned_work_order(text, text)
  from public, anon;
grant execute on function public.reject_unassigned_work_order(text, text)
  to authenticated, service_role;

comment on function public.reject_unassigned_work_order(text, text) is
  'Atomically records and soft-removes a never-assigned work order rejected during P1 dispatch.';

commit;
