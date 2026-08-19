-- Capital quotes and final invoices are separate linked billing documents.
-- Submitting the quote parks the work order until installation is complete;
-- completing the capital work then creates the normal Ready-to-Bill handoff.

begin;

alter table public.invoices
  add column if not exists document_kind text not null default 'invoice',
  add column if not exists source_capital_quote_id uuid
    references public.invoices(id) on delete restrict;

alter table public.invoices
  drop constraint if exists invoices_document_kind_check;
alter table public.invoices
  add constraint invoices_document_kind_check
  check (document_kind in ('invoice', 'capital_quote'));

create index if not exists idx_invoices_document_kind
  on public.invoices(document_kind, state)
  where deleted_at is null;

create unique index if not exists invoices_active_capital_quote_final_unique
  on public.invoices(source_capital_quote_id)
  where source_capital_quote_id is not null
    and deleted_at is null;

-- Identify quotes already sent under the previous workflow from their
-- immutable audit event. The fallback covers the same state if an old event
-- was removed before this migration.
update public.invoices invoice
set document_kind = 'capital_quote'
where invoice.invoice_type = 'staff'
  and invoice.deleted_at is null
  and (
    exists (
      select 1
      from public.activities activity
      where activity.work_order_id = invoice.work_order_id
        and activity.event_key = 'capital_invoice_sent'
        and activity.event_data ->> 'invoiceId' = invoice.id::text
    )
    or exists (
      select 1
      from public.work_orders work_order
      where work_order.id = invoice.work_order_id
        and work_order.deleted_at is null
        and work_order.is_capital = true
        and work_order.status in ('capital', 'pending_capital_completion')
        and invoice.state in ('draft', 'submitted', 'approved')
    )
  );

-- Remove the retired approval wording from work orders already parked by the
-- previous capital flow. They are waiting for installation/completion, not a
-- second approval step.
update public.work_orders
set functional_status = case
      when status = 'pending_capital_completion'
        then 'Pending Capital Completion'::public.fsm_functional_status
      else 'Work in Progress'::public.fsm_functional_status
    end,
    capital_status = case
      when capital_status = 'Pending approval' then null
      else capital_status
    end,
    updated_at = now()
where deleted_at is null
  and is_capital = true
  and status in ('capital', 'pending_capital_completion')
  and (
    functional_status = 'Pending Capital Approval'
    or capital_status = 'Pending approval'
  );

create or replace function public.classify_staff_billing_document()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_work_order public.work_orders%rowtype;
  v_quote_id uuid;
begin
  if new.invoice_type <> 'staff' then
    new.document_kind := 'invoice';
    new.source_capital_quote_id := null;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.document_kind is distinct from old.document_kind
       or new.source_capital_quote_id is distinct from old.source_capital_quote_id then
      raise exception 'Billing document classification is immutable'
        using errcode = '42501';
    end if;
    if old.document_kind = 'capital_quote'
       and new.work_order_id is distinct from old.work_order_id then
      raise exception 'A capital quote cannot be moved to another work order'
        using errcode = '23514';
    end if;
    return new;
  end if;

  new.document_kind := 'invoice';
  new.source_capital_quote_id := null;

  if new.work_order_id is null then
    return new;
  end if;

  select * into v_work_order
  from public.work_orders work_order
  where work_order.id = new.work_order_id
    and work_order.deleted_at is null;

  if not found or not coalesce(v_work_order.is_capital, false) then
    return new;
  end if;

  if v_work_order.status = 'capital' then
    new.document_kind := 'capital_quote';
    return new;
  end if;

  if v_work_order.status = 'pending_capital_completion' then
    raise exception 'Mark the capital work completed before creating its final invoice'
      using errcode = '23514';
  end if;

  if v_work_order.status = 'pending_invoice' then
    select quote.id into v_quote_id
    from public.invoices quote
    where quote.work_order_id = new.work_order_id
      and quote.invoice_type = 'staff'
      and quote.document_kind = 'capital_quote'
      and quote.state in ('approved', 'paid')
      and quote.deleted_at is null
    order by quote.updated_at desc, quote.id desc
    limit 1;

    if v_quote_id is null then
      raise exception 'An approved capital quote is required before final billing'
        using errcode = '23514';
    end if;
    new.source_capital_quote_id := v_quote_id;
  end if;

  return new;
end;
$$;

drop trigger if exists classify_staff_billing_document_trigger
  on public.invoices;
create trigger classify_staff_billing_document_trigger
  before insert or update on public.invoices
  for each row execute function public.classify_staff_billing_document();

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
  v_is_capital_quote boolean := false;
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
    raise exception 'Only a billing document ready for 7-Eleven can be submitted'
      using errcode = '23514';
  end if;

  v_is_capital_quote := v_invoice.document_kind = 'capital_quote';

  if v_invoice.work_order_id is not null then
    select * into v_work_order
    from public.work_orders work_order
    where work_order.id = v_invoice.work_order_id
      and work_order.deleted_at is null
    for update;
  end if;

  if v_is_capital_quote
     and (v_work_order.id is null or not coalesce(v_work_order.is_capital, false)) then
    raise exception 'Capital quote is not linked to an active capital work order'
      using errcode = '23514';
  end if;

  if v_invoice.state = 'submitted' then
    update public.invoices
    set state = 'approved',
        updated_at = v_now
    where id = v_invoice.id;
    v_transitioned := true;
  end if;

  if v_invoice.work_order_id is not null and v_work_order.id is not null then
    if v_is_capital_quote then
      update public.work_orders
      set status = 'pending_capital_completion',
          functional_status = 'Pending Capital Completion',
          capital_status = case
            when capital_status = 'Pending approval' then null
            else capital_status
          end,
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
          when v_is_capital_quote then format(
            'Capital quote #%s submitted to 7-Eleven. Work order remains open pending capital completion.',
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
          when v_is_capital_quote then 'capital_quote_submitted'
          else 'staff_billing'
        end,
        jsonb_build_object(
          'action', case
            when v_is_capital_quote then 'capital_quote_submitted'
            else 'billed_to_7_eleven'
          end,
          'documentKind', v_invoice.document_kind,
          'invoiceId', v_invoice.id,
          'invoiceNum', v_invoice.num,
          'workOrderStatus', case
            when v_is_capital_quote then 'pending_capital_completion'
            else 'closed'
          end
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'invoiceId', v_invoice.id,
    'documentKind', v_invoice.document_kind,
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

create or replace function public.complete_capital_work(
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
  v_quote_id uuid;
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
    raise exception 'Work order is not pending capital completion'
      using errcode = '23514';
  end if;

  select quote.id into v_quote_id
  from public.invoices quote
  where quote.work_order_id = v_work_order.id
    and quote.invoice_type = 'staff'
    and quote.document_kind = 'capital_quote'
    and quote.state in ('approved', 'paid')
    and quote.deleted_at is null
  order by quote.updated_at desc, quote.id desc
  limit 1;

  if v_quote_id is null then
    raise exception 'An approved capital quote is required before completion'
      using errcode = '23514';
  end if;

  update public.work_orders
  set status = 'pending_invoice',
      functional_status = 'Completed',
      capital_status = 'Installed',
      is_capital = true,
      billing_ready_at = now(),
      billing_ready_by = v_actor.id,
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
      'Capital work marked completed by %s and moved to final billing.',
      v_actor.name
    ),
    'system',
    false,
    true,
    'capital_completed',
    jsonb_build_object(
      'action', 'capital_completed',
      'capitalQuoteInvoiceId', v_quote_id,
      'workOrderStatus', v_work_order.status,
      'capitalStatus', v_work_order.capital_status
    )
  );

  return v_work_order;
end;
$$;

revoke all on function public.mark_staff_invoice_billed(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_capital_work(text)
  from public, anon;
revoke all on function public.resume_capital_work(text)
  from public, anon, authenticated, service_role;
grant execute on function public.mark_staff_invoice_billed(uuid, uuid)
  to service_role;
grant execute on function public.complete_capital_work(text)
  to authenticated, service_role;

commit;
