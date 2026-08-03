-- Keep former contractors available for history while removing them from new
-- assignment choices, and add an explicit staff-only billing-ready workflow.

alter table public.profiles
  add column if not exists is_assignable boolean not null default true;

update public.profiles
set is_assignable = false,
    updated_at = now()
where lower(email) = 'plumbingdayornight@gmail.com';

create index if not exists idx_profiles_assignable_contractors
  on public.profiles(name)
  where role = 'contractor' and is_assignable = true;

alter table public.work_orders
  add column if not exists billing_only boolean not null default false,
  add column if not exists billing_ready_at timestamptz,
  add column if not exists billing_ready_by uuid
    references public.profiles(id);

create index if not exists idx_work_orders_billing_ready
  on public.work_orders(billing_ready_at desc)
  where billing_only = true
    and status = 'pending_invoice'
    and deleted_at is null;

create or replace function public.move_work_order_straight_to_billing(
  p_work_order_id text
)
returns public.work_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_name text;
  work_order public.work_orders%rowtype;
begin
  if actor_id is null or not public.is_staff() then
    raise exception 'Only P1 staff may move a work order straight to Billing'
      using errcode = '42501';
  end if;

  if public.is_invoice_controller() then
    raise exception 'The controller cannot prepare P1 billing invoices'
      using errcode = '42501';
  end if;

  select *
    into work_order
  from public.work_orders
  where id = p_work_order_id
    and deleted_at is null
  for update;

  if not found then
    raise exception 'Work order was not found'
      using errcode = 'P0002';
  end if;

  if work_order.billing_only
     and work_order.status = 'pending_invoice' then
    return work_order;
  end if;

  if work_order.status <> 'unassigned' then
    raise exception 'Only an unassigned work order can go straight to Billing'
      using errcode = '22023';
  end if;

  select name
    into actor_name
  from public.profiles
  where id = actor_id;

  update public.work_orders
  set status = 'pending_invoice',
      functional_status = 'Completed',
      contractor_id = null,
      eta = null,
      dispatched_at = null,
      billing_only = true,
      billing_ready_at = now(),
      billing_ready_by = actor_id,
      closed_at = null,
      updated_at = now()
  where id = p_work_order_id
  returning * into work_order;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    is_staff_only,
    event_key
  ) values (
    p_work_order_id,
    actor_id,
    coalesce(actor_name, 'P1 staff'),
    'Moved straight to Billing. No contractor was dispatched.',
    'system',
    true,
    'straight_to_billing'
  );

  return work_order;
end;
$$;

revoke all on function public.move_work_order_straight_to_billing(text)
  from public, anon;
grant execute on function public.move_work_order_straight_to_billing(text)
  to authenticated, service_role;
