-- Attempt each contractor activity email at most once. A transport error may
-- occur after Graph accepts the message, so unknown outcomes are terminal and
-- are never automatically retried.
-- The portal attention flag remains the durable in-app notification; this
-- table only coordinates the external email side effect.

begin;

create table if not exists public.contractor_activity_alert_deliveries (
  activity_id uuid primary key
    references public.activities(id) on delete cascade,
  work_order_id text not null
    references public.work_orders(id) on delete cascade,
  contractor_id uuid not null
    references public.profiles(id) on delete restrict,
  contractor_assignment_version integer not null,
  status text not null default 'claimed'
    check (status in ('claimed', 'sent', 'unknown')),
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text,
  constraint contractor_activity_alert_completion_check check (
    (status = 'claimed' and completed_at is null)
    or (status = 'sent' and completed_at is not null and error_message is null)
    or (
      status = 'unknown'
      and completed_at is not null
      and error_message is not null
    )
  )
);

comment on table public.contractor_activity_alert_deliveries is
  'Service-only idempotency ledger for contractor portal-email alerts, keyed by the originating activity.';

create index if not exists idx_contractor_activity_alert_deliveries_status
  on public.contractor_activity_alert_deliveries(status, claimed_at);

alter table public.contractor_activity_alert_deliveries enable row level security;

revoke all on public.contractor_activity_alert_deliveries
  from public, anon, authenticated;
grant all on public.contractor_activity_alert_deliveries
  to service_role;

create or replace function public.claim_contractor_activity_alert_delivery(
  p_activity_id uuid,
  p_work_order_id text,
  p_actor_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target record;
  delivery public.contractor_activity_alert_deliveries%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.profiles actor
    where actor.id = p_actor_id
      and actor.active = true
      and actor.role in ('manager', 'dispatcher', 'back_office')
  ) then
    raise exception 'Active staff actor required' using errcode = '42501';
  end if;

  select
    activity.work_order_id,
    work_order.contractor_id,
    work_order.contractor_assignment_version
  into target
  from public.activities activity
  join public.work_orders work_order
    on work_order.id = activity.work_order_id
  join public.profiles contractor
    on contractor.id = work_order.contractor_id
  where activity.id = p_activity_id
    and activity.work_order_id = p_work_order_id
    and activity.deleted_at is null
    and activity.requires_contractor_attention = true
    and activity.activity_channel in (
      'field_note', 'contractor_message', 'legacy'
    )
    and work_order.deleted_at is null
    and work_order.contractor_id is not null
    and work_order.contractor_assignment_started_at is not null
    and activity.contractor_assignment_version
      = work_order.contractor_assignment_version
    and activity.created_at >= work_order.contractor_assignment_started_at
    and contractor.active = true
    and contractor.role = 'contractor'
    and nullif(trim(coalesce(contractor.email, '')), '') is not null;

  if not found then
    raise exception 'Current contractor alert target not found'
      using errcode = 'P0002';
  end if;

  insert into public.contractor_activity_alert_deliveries (
    activity_id,
    work_order_id,
    contractor_id,
    contractor_assignment_version
  ) values (
    p_activity_id,
    target.work_order_id,
    target.contractor_id,
    target.contractor_assignment_version
  )
  on conflict (activity_id) do nothing
  returning * into delivery;

  if found then
    return 'new_claim';
  end if;

  select *
  into delivery
  from public.contractor_activity_alert_deliveries existing_delivery
  where existing_delivery.activity_id = p_activity_id
  for update;

  if delivery.contractor_id is distinct from target.contractor_id
     or delivery.contractor_assignment_version
       is distinct from target.contractor_assignment_version then
    raise exception 'Contractor alert assignment changed'
      using errcode = '40001';
  end if;

  -- Every existing row is terminal for automatic sending. A claimed delivery
  -- may still be in flight or its final outcome may have been lost after a
  -- process interruption, so reclaiming it could send a duplicate email.
  if delivery.status = 'sent' then
    return 'already_sent';
  end if;
  if delivery.status = 'unknown' then
    return 'delivery_unknown';
  end if;
  return 'pending_or_unknown';
end;
$$;

create or replace function public.complete_contractor_activity_alert_delivery(
  p_activity_id uuid,
  p_status text,
  p_error_message text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;

  if p_status not in ('sent', 'unknown') then
    raise exception 'Delivery status must be sent or unknown'
      using errcode = '22023';
  end if;

  update public.contractor_activity_alert_deliveries
  set
    status = p_status,
    completed_at = now(),
    error_message = case
      when p_status = 'unknown'
        then nullif(left(trim(coalesce(p_error_message, '')), 1000), '')
      else null
    end
  where activity_id = p_activity_id
    and status = 'claimed';

  if not found then
    raise exception 'Claimed contractor activity alert not found'
      using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.claim_contractor_activity_alert_delivery(
  uuid,
  text,
  uuid
) from public, anon, authenticated;
revoke all on function public.complete_contractor_activity_alert_delivery(
  uuid,
  text,
  text
) from public, anon, authenticated;

grant execute on function public.claim_contractor_activity_alert_delivery(
  uuid,
  text,
  uuid
) to service_role;
grant execute on function public.complete_contractor_activity_alert_delivery(
  uuid,
  text,
  text
) to service_role;

commit;
