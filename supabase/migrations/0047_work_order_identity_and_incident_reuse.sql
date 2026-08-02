-- 7-Eleven WOT numbers are canonical. Incident numbers can appear on more
-- than one WOT, so they remain searchable but are no longer unique.

begin;

alter table public.work_orders
  drop constraint if exists work_orders_incident_id_key;

drop index if exists public.work_orders_incident_id_key;
drop index if exists public.work_orders_active_incident_id_unique;

create index if not exists work_orders_incident_id_idx
  on public.work_orders(incident_id)
  where incident_id is not null;

-- Staff can audit reused incident numbers, including references on archived
-- work orders. Contractors receive no rows from this function.
create or replace function public.get_incident_reuse_warnings()
returns table (
  work_order_id text,
  incident_id text,
  related_work_order_ids text[],
  crosses_state boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with normalized_work_orders as (
    select
      work_orders.id,
      work_orders.incident_id,
      work_orders.deleted_at,
      coalesce(
        nullif(upper(trim(work_orders.store_state)), ''),
        substring(upper(coalesce(work_orders.address, '')) from ',([A-Z]{2}),'),
        substring(upper(coalesce(work_orders.city, '')) from '[, ]([A-Z]{2})$')
      ) as state_code
    from public.work_orders
    where work_orders.incident_id is not null
      and trim(work_orders.incident_id) <> ''
  )
  select
    current_work_order.id as work_order_id,
    current_work_order.incident_id,
    array_agg(other_work_order.id order by other_work_order.id) as related_work_order_ids,
    bool_or(
      current_work_order.state_code is not null
      and other_work_order.state_code is not null
      and current_work_order.state_code <> other_work_order.state_code
    ) as crosses_state
  from normalized_work_orders current_work_order
  join normalized_work_orders other_work_order
    on other_work_order.incident_id = current_work_order.incident_id
   and other_work_order.id <> current_work_order.id
  where current_work_order.deleted_at is null
    and public.get_my_role() in ('manager', 'dispatcher', 'back_office')
  group by current_work_order.id, current_work_order.incident_id;
$$;

revoke all on function public.get_incident_reuse_warnings() from public;
grant execute on function public.get_incident_reuse_warnings() to authenticated;
grant execute on function public.get_incident_reuse_warnings() to service_role;

commit;
