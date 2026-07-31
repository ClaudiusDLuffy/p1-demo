-- Separate "ready for 7-Eleven" from the explicit billed transition and
-- persist the territory used by QuickBooks exports.

alter table public.invoices
  add column if not exists territory text;

create index if not exists idx_staff_invoices_territory
  on public.invoices(territory)
  where invoice_type = 'staff'
    and territory is not null
    and deleted_at is null;

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
  v_work_order_closed boolean := false;
  v_visits_closed integer := 0;
  v_transitioned boolean := false;
begin
  select p.name, p.role::text
  into v_actor_name, v_actor_role
  from public.profiles p
  where p.id = p_actor_id;

  if v_actor_role not in ('manager', 'dispatcher', 'back_office') then
    raise exception 'Staff access required'
      using errcode = '42501';
  end if;

  select *
  into v_invoice
  from public.invoices
  where id = p_invoice_id
    and invoice_type = 'staff'
    and deleted_at is null
  for update;

  if not found then
    raise exception 'Billing invoice not found';
  end if;

  if v_invoice.state not in ('submitted', 'approved') then
    raise exception 'Only an invoice ready for 7-Eleven can be marked billed';
  end if;

  if v_invoice.state = 'submitted' then
    update public.invoices
    set
      state = 'approved',
      updated_at = v_now
    where id = v_invoice.id;
    v_transitioned := true;
  end if;

  if v_invoice.work_order_id is not null then
    update public.work_order_visits
    set
      check_out_at = v_now,
      checked_out_by = p_actor_id,
      updated_at = v_now
    where work_order_id = v_invoice.work_order_id
      and check_out_at is null;
    get diagnostics v_visits_closed = row_count;

    update public.work_orders
    set
      status = 'closed',
      closed_at = coalesce(closed_at, v_now),
      updated_at = v_now
    where id = v_invoice.work_order_id
      and deleted_at is null
      and (status <> 'closed' or closed_at is null);
    v_work_order_closed := found;

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
      )
      values (
        v_invoice.work_order_id,
        p_actor_id,
        coalesce(v_actor_name, 'P1 staff'),
        format(
          'P1 invoice #%s billed to 7-Eleven. Work order closed.',
          v_invoice.num
        ),
        'system',
        false,
        true,
        'staff_billing',
        jsonb_build_object(
          'action', 'billed_to_7_eleven',
          'invoiceId', v_invoice.id,
          'invoiceNum', v_invoice.num
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'invoiceId', v_invoice.id,
    'workOrderId', v_invoice.work_order_id,
    'transitioned', v_transitioned,
    'workOrderClosed', v_work_order_closed,
    'visitsClosed', v_visits_closed
  );
end;
$$;

revoke all on function public.mark_staff_invoice_billed(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_staff_invoice_billed(uuid, uuid)
  to service_role;

