-- Sending a capital quote to 7-Eleven must not close the work order. Park it
-- in a named waiting state until approval arrives, then let staff resume work.

begin;

create or replace function public.mark_staff_invoice_billed(
  p_invoice_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_actor_name text;
  v_actor_role text;
  v_invoice public.invoices%rowtype;
  v_work_order public.work_orders%rowtype;
  v_requires_capital_authorization boolean := false;
  v_work_order_closed boolean := false;
  v_pending_capital_completion boolean := false;
  v_visits_closed integer := 0;
  v_transitioned boolean := false;
begin
  select profile.name, profile.role::text
  into v_actor_name, v_actor_role
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.active = true;

  if v_actor_role not in ('manager', 'dispatcher', 'back_office') then
    raise exception 'Staff access required' using errcode = '42501';
  end if;
  if public.profile_has_staff_permission(p_actor_id, 'invoice_controller') then
    raise exception 'Operational staff access required' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices invoice
  where invoice.id = p_invoice_id
    and invoice.invoice_type = 'staff'
    and invoice.deleted_at is null
  for update;

  if not found then
    raise exception 'Billing invoice not found' using errcode = 'P0002';
  end if;
  if v_invoice.state not in ('submitted', 'approved') then
    raise exception 'Only an invoice ready for 7-Eleven can be marked billed'
      using errcode = '23514';
  end if;

  if v_invoice.work_order_id is not null then
    select * into v_work_order
    from public.work_orders work_order
    where work_order.id = v_invoice.work_order_id
      and work_order.deleted_at is null
    for update;

    if found then
      v_requires_capital_authorization := (
        coalesce(v_work_order.is_capital, false)
        and (
          v_work_order.status in ('capital', 'pending_capital_completion')
          or v_work_order.capital_status = 'Pending approval'
        )
      );
    end if;
  end if;

  if v_invoice.state = 'submitted' then
    update public.invoices
    set state = 'approved',
        updated_at = v_now
    where id = v_invoice.id;
    v_transitioned := true;
  end if;

  if v_invoice.work_order_id is not null and v_work_order.id is not null then
    if v_requires_capital_authorization then
      update public.work_orders
      set status = 'pending_capital_completion',
          functional_status = 'Pending Capital Approval',
          capital_status = 'Pending approval',
          is_capital = true,
          closed_at = null,
          updated_at = v_now
      where id = v_work_order.id
        and deleted_at is null;
      v_pending_capital_completion := true;
    else
      update public.work_order_visits
      set check_out_at = v_now,
          checked_out_by = p_actor_id,
          updated_at = v_now
      where work_order_id = v_invoice.work_order_id
        and check_out_at is null;
      get diagnostics v_visits_closed = row_count;

      update public.work_orders
      set status = 'closed',
          closed_at = coalesce(closed_at, v_now),
          updated_at = v_now
      where id = v_invoice.work_order_id
        and deleted_at is null
        and (status <> 'closed' or closed_at is null);
      v_work_order_closed := found;
    end if;

    if v_transitioned then
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
        v_invoice.work_order_id,
        p_actor_id,
        coalesce(v_actor_name, 'P1 staff'),
        case
          when v_requires_capital_authorization then format(
            'P1 capital invoice #%s sent to 7-Eleven. Waiting for capital approval before work resumes.',
            v_invoice.num
          )
          else format(
            'P1 invoice #%s billed to 7-Eleven. Work order closed.',
            v_invoice.num
          )
        end,
        'system',
        false,
        true,
        case
          when v_requires_capital_authorization then 'capital_invoice_sent'
          else 'staff_billing'
        end,
        jsonb_build_object(
          'action', case
            when v_requires_capital_authorization then 'awaiting_capital_approval'
            else 'billed_to_7_eleven'
          end,
          'invoiceId', v_invoice.id,
          'invoiceNum', v_invoice.num,
          'workOrderStatus', case
            when v_requires_capital_authorization then 'pending_capital_completion'
            else 'closed'
          end
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'invoiceId', v_invoice.id,
    'workOrderId', v_invoice.work_order_id,
    'transitioned', v_transitioned,
    'workOrderClosed', v_work_order_closed,
    'pendingCapitalCompletion', v_pending_capital_completion,
    'workOrderStatus', case
      when v_pending_capital_completion then 'pending_capital_completion'
      when v_work_order_closed then 'closed'
      else null
    end,
    'visitsClosed', v_visits_closed
  );
end;
$$;

create or replace function public.resume_capital_work(
  p_work_order_id text
)
returns public.work_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_work_order public.work_orders%rowtype;
begin
  select * into v_actor
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office');

  if not found then
    raise exception 'Active P1 staff access required' using errcode = '42501';
  end if;
  if public.profile_has_staff_permission(v_actor.id, 'invoice_controller') then
    raise exception 'Operational staff access required' using errcode = '42501';
  end if;

  select * into v_work_order
  from public.work_orders work_order
  where work_order.id = p_work_order_id
    and work_order.deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  if v_work_order.status <> 'pending_capital_completion' then
    raise exception 'Work order is not waiting for capital approval'
      using errcode = '23514';
  end if;

  update public.work_orders
  set status = case
        when contractor_id is null then 'unassigned'::public.wo_status
        else 'assigned'::public.wo_status
      end,
      functional_status = case
        when contractor_id is null then 'New'::public.fsm_functional_status
        else 'Dispatched'::public.fsm_functional_status
      end,
      capital_status = 'Approved - work authorized',
      is_capital = true,
      closed_at = null,
      updated_at = now()
  where id = v_work_order.id
  returning * into v_work_order;

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
    format(
      'Capital work authorized by 7-Eleven and resumed by %s.',
      v_actor.name
    ),
    'system',
    false,
    true,
    'capital_work_authorized',
    jsonb_build_object(
      'action', 'capital_work_authorized',
      'workOrderStatus', v_work_order.status,
      'capitalStatus', v_work_order.capital_status
    )
  );

  return v_work_order;
end;
$$;

revoke all on function public.mark_staff_invoice_billed(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.resume_capital_work(text)
  from public, anon;
grant execute on function public.mark_staff_invoice_billed(uuid, uuid)
  to service_role;
grant execute on function public.resume_capital_work(text)
  to authenticated, service_role;

commit;
