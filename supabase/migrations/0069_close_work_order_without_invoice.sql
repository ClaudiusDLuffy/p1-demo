-- Give operational staff an explicit, atomic way to close a work order that
-- will not be invoiced. Existing invoice-backed close and capital workflows
-- remain unchanged.

begin;

create or replace function public.close_work_order_without_invoice(
  p_work_order_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_work_order public.work_orders%rowtype;
  v_now timestamptz := now();
  v_invoice_count integer := 0;
  v_visits_closed integer := 0;
begin
  select *
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

  select *
  into v_work_order
  from public.work_orders work_order
  where work_order.id = p_work_order_id
    and work_order.deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found'
      using errcode = 'P0002';
  end if;

  if v_work_order.status = 'closed' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_closed',
      'workOrderId', v_work_order.id,
      'workOrderStatus', v_work_order.status,
      'closedAt', v_work_order.closed_at,
      'visitsClosed', 0
    );
  end if;

  -- The work-order row lock serializes this check against the atomic
  -- contractor submission function, which locks the same row first.
  select count(*)::integer
  into v_invoice_count
  from public.invoices invoice
  where invoice.work_order_id = v_work_order.id
    and invoice.deleted_at is null;

  if v_invoice_count > 0 then
    raise exception 'This work order has % active invoice(s); use the normal close workflow',
      v_invoice_count
      using errcode = '23514';
  end if;

  update public.work_order_visits visit
  set check_out_at = v_now,
      checked_out_by = v_actor.id,
      updated_at = v_now
  where visit.work_order_id = v_work_order.id
    and visit.check_out_at is null;
  get diagnostics v_visits_closed = row_count;

  update public.work_orders work_order
  set status = 'closed',
      closed_at = v_now,
      updated_at = v_now
  where work_order.id = v_work_order.id
    and work_order.deleted_at is null;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    is_staff_override,
    is_staff_only,
    event_key,
    event_data
  ) values (
    v_work_order.id,
    v_actor.id,
    v_actor.name,
    format('Work order closed without an invoice by %s.', v_actor.name),
    'system',
    false,
    true,
    'work_order_closed_without_invoice',
    jsonb_build_object(
      'action', 'closed_without_invoice',
      'workOrderStatus', 'closed',
      'visitsClosed', v_visits_closed
    )
  );

  return jsonb_build_object(
    'applied', true,
    'reason', 'closed_without_invoice',
    'workOrderId', v_work_order.id,
    'workOrderStatus', 'closed',
    'closedAt', v_now,
    'visitsClosed', v_visits_closed
  );
end;
$$;

-- A closed work order must stay closed even if an authenticated contractor
-- calls the raw invoice API instead of using the UI. A staff invoice is also
-- blocked when this explicit no-invoice close is the current terminal event;
-- reopening the work order makes normal billing available again. Taking a
-- row lock here serializes direct draft creation with the close transaction.
-- Service-role maintenance remains available for controlled recovery/imports.
create or replace function public.prevent_invoice_on_closed_work_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status public.wo_status;
  v_closed_at timestamptz;
  v_closed_without_invoice boolean := false;
begin
  if new.work_order_id is null
     or coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  select work_order.status, work_order.closed_at
  into v_status, v_closed_at
  from public.work_orders work_order
  where work_order.id = new.work_order_id
    and work_order.deleted_at is null
  for key share;

  if not found or v_status <> 'closed' then
    return new;
  end if;

  if new.invoice_type = 'staff' then
    select exists (
      select 1
      from public.activities activity
      where activity.work_order_id = new.work_order_id
        and activity.event_key = 'work_order_closed_without_invoice'
        and activity.deleted_at is null
        and (
          v_closed_at is null
          or activity.created_at >= v_closed_at
        )
    ) into v_closed_without_invoice;
  end if;

  if new.invoice_type = 'contractor' or v_closed_without_invoice then
    raise exception 'Invoices cannot be created for this closed work order; reopen it first'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_invoice_on_closed_work_order_trigger
  on public.invoices;
create trigger prevent_invoice_on_closed_work_order_trigger
  before insert on public.invoices
  for each row execute function public.prevent_invoice_on_closed_work_order();

revoke all on function public.close_work_order_without_invoice(text)
  from public, anon;
grant execute on function public.close_work_order_without_invoice(text)
  to authenticated, service_role;

revoke all on function public.prevent_invoice_on_closed_work_order()
  from public, anon, authenticated;

commit;
