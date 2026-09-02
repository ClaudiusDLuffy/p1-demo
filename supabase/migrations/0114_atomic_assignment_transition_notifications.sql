-- Make contractor assignment changes atomic and preserve an idempotent,
-- service-only notification target for the contractor whose field assignment
-- ended. The delivery snapshot deliberately contains no receiving-contractor
-- identity: an outgoing contractor is told only that P1 removed or continued
-- the field assignment.

begin;

create table if not exists public.contractor_assignment_transition_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  work_order_id text not null
    constraint catd_work_order_fkey
    references public.work_orders(id) on delete cascade,
  related_work_order_id text
    constraint catd_related_work_order_fkey
    references public.work_orders(id) on delete restrict,
  external_work_order_id text not null,
  outgoing_contractor_id uuid not null
    constraint catd_outgoing_contractor_fkey
    references public.profiles(id) on delete restrict,
  outgoing_assignment_version integer not null
    check (outgoing_assignment_version > 0),
  outgoing_contractor_name text not null,
  outgoing_contractor_company text,
  outgoing_contractor_email text,
  transition_type text not null
    check (transition_type in (
      'reassigned',
      'unassigned',
      'duplicated_for_reassignment'
  )),
  initiated_by uuid
    constraint catd_initiated_by_fkey
    references public.profiles(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'sent', 'unknown', 'skipped')),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  error_message text,
  constraint contractor_assignment_transition_shape_check check (
    (
      transition_type in ('reassigned', 'unassigned')
      and related_work_order_id is null
      and event_key = 'assignment:'
        || work_order_id
        || ':'
        || outgoing_assignment_version::text
    )
    or (
      transition_type = 'duplicated_for_reassignment'
      and related_work_order_id is not null
      and event_key = 'duplicate:' || related_work_order_id
    )
  ),
  constraint contractor_assignment_transition_delivery_state_check check (
    (
      status = 'pending'
      and claimed_at is null
      and completed_at is null
      and error_message is null
      and nullif(trim(coalesce(outgoing_contractor_email, '')), '') is not null
    )
    or (
      status = 'claimed'
      and claimed_at is not null
      and completed_at is null
      and error_message is null
      and nullif(trim(coalesce(outgoing_contractor_email, '')), '') is not null
    )
    or (
      status = 'sent'
      and claimed_at is not null
      and completed_at is not null
      and error_message is null
      and nullif(trim(coalesce(outgoing_contractor_email, '')), '') is not null
    )
    or (
      status = 'unknown'
      and claimed_at is not null
      and completed_at is not null
      and nullif(trim(coalesce(error_message, '')), '') is not null
      and nullif(trim(coalesce(outgoing_contractor_email, '')), '') is not null
    )
    or (
      status = 'skipped'
      and claimed_at is null
      and completed_at is not null
      and nullif(trim(coalesce(error_message, '')), '') is not null
      and nullif(trim(coalesce(outgoing_contractor_email, '')), '') is null
    )
  )
);

comment on table public.contractor_assignment_transition_deliveries is
  'Service-only outbox and terminal idempotency ledger for outgoing-contractor field-assignment notices. Receiving-contractor identity is intentionally absent.';

create index if not exists idx_contractor_assignment_transition_delivery_status
  on public.contractor_assignment_transition_deliveries(status, created_at);

create index if not exists idx_contractor_assignment_transition_delivery_work_order
  on public.contractor_assignment_transition_deliveries(
    work_order_id,
    created_at desc
  );

alter table public.contractor_assignment_transition_deliveries
  enable row level security;

revoke all on public.contractor_assignment_transition_deliveries
  from public, anon, authenticated;
grant all on public.contractor_assignment_transition_deliveries
  to service_role;

-- Capture the outgoing target from OLD inside the same transaction that moves
-- the assignment. The existing protect_work_order_assignment_boundary and
-- clear_technician_on_contractor_change triggers continue to own assignment
-- history, receiving-contractor isolation, and technician cleanup.
create or replace function public.queue_contractor_assignment_transition_delivery()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_outgoing public.profiles%rowtype;
  v_email text;
  v_now timestamptz := clock_timestamp();
begin
  if old.contractor_id is null
     or new.contractor_id is not distinct from old.contractor_id then
    return new;
  end if;

  select profile.*
  into v_outgoing
  from public.profiles profile
  where profile.id = old.contractor_id;

  if not found then
    raise exception 'Outgoing contractor profile not found'
      using errcode = 'P0002';
  end if;

  v_email := nullif(trim(coalesce(v_outgoing.email, '')), '');

  insert into public.contractor_assignment_transition_deliveries (
    event_key,
    work_order_id,
    related_work_order_id,
    external_work_order_id,
    outgoing_contractor_id,
    outgoing_assignment_version,
    outgoing_contractor_name,
    outgoing_contractor_company,
    outgoing_contractor_email,
    transition_type,
    initiated_by,
    status,
    created_at,
    completed_at,
    error_message
  ) values (
    'assignment:'
      || old.id
      || ':'
      || greatest(old.contractor_assignment_version, 1)::text,
    old.id,
    null,
    coalesce(old.duplicate_root_work_order_id, old.id),
    old.contractor_id,
    greatest(old.contractor_assignment_version, 1),
    coalesce(nullif(trim(v_outgoing.name), ''), 'Contractor'),
    nullif(trim(coalesce(v_outgoing.company, '')), ''),
    v_email,
    case
      when new.contractor_id is null then 'unassigned'
      else 'reassigned'
    end,
    auth.uid(),
    case when v_email is null then 'skipped' else 'pending' end,
    v_now,
    case when v_email is null then v_now else null end,
    case
      when v_email is null then 'Outgoing contractor has no email address'
      else null
    end
  )
  on conflict (event_key) do nothing;

  return new;
end;
$$;

revoke all on function public.queue_contractor_assignment_transition_delivery()
  from public, anon, authenticated;

drop trigger if exists queue_contractor_assignment_transition_delivery_trigger
  on public.work_orders;
create trigger queue_contractor_assignment_transition_delivery_trigger
  after update of contractor_id on public.work_orders
  for each row
  when (
    old.contractor_id is not null
    and old.contractor_id is distinct from new.contractor_id
  )
  execute function public.queue_contractor_assignment_transition_delivery();

-- Creating a clean root-N continuation does not move the original record.
-- Still queue a distinct notice so the source contractor knows P1 is
-- continuing field service separately while their original remains available
-- for incurred-cost invoicing.
create or replace function public.queue_duplicate_reassignment_transition_delivery()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source public.work_orders%rowtype;
  v_outgoing public.profiles%rowtype;
  v_email text;
  v_now timestamptz := clock_timestamp();
begin
  if new.duplicated_from_work_order_id is null then
    return new;
  end if;

  select work_order.*
  into v_source
  from public.work_orders work_order
  where work_order.id = new.duplicated_from_work_order_id
    and work_order.deleted_at is null
  for share;

  if not found
     or v_source.contractor_id is null
     or v_source.contractor_assignment_version <= 0 then
    raise exception 'Duplicate source must retain its contractor assignment'
      using errcode = '23514';
  end if;

  select profile.*
  into v_outgoing
  from public.profiles profile
  where profile.id = v_source.contractor_id;

  if not found then
    raise exception 'Source contractor profile not found'
      using errcode = 'P0002';
  end if;

  v_email := nullif(trim(coalesce(v_outgoing.email, '')), '');

  insert into public.contractor_assignment_transition_deliveries (
    event_key,
    work_order_id,
    related_work_order_id,
    external_work_order_id,
    outgoing_contractor_id,
    outgoing_assignment_version,
    outgoing_contractor_name,
    outgoing_contractor_company,
    outgoing_contractor_email,
    transition_type,
    initiated_by,
    status,
    created_at,
    completed_at,
    error_message
  ) values (
    'duplicate:' || new.id,
    v_source.id,
    new.id,
    coalesce(v_source.duplicate_root_work_order_id, v_source.id),
    v_source.contractor_id,
    v_source.contractor_assignment_version,
    coalesce(nullif(trim(v_outgoing.name), ''), 'Contractor'),
    nullif(trim(coalesce(v_outgoing.company, '')), ''),
    v_email,
    'duplicated_for_reassignment',
    coalesce(new.created_by, auth.uid()),
    case when v_email is null then 'skipped' else 'pending' end,
    v_now,
    case when v_email is null then v_now else null end,
    case
      when v_email is null then 'Outgoing contractor has no email address'
      else null
    end
  )
  on conflict (event_key) do nothing;

  return new;
end;
$$;

revoke all on function public.queue_duplicate_reassignment_transition_delivery()
  from public, anon, authenticated;

drop trigger if exists queue_duplicate_reassignment_transition_delivery_trigger
  on public.work_orders;
create trigger queue_duplicate_reassignment_transition_delivery_trigger
  after insert on public.work_orders
  for each row
  when (new.duplicated_from_work_order_id is not null)
  execute function public.queue_duplicate_reassignment_transition_delivery();

create or replace function public.transition_work_order_contractor(
  p_work_order_id text,
  p_new_contractor_id uuid,
  p_expected_assignment_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_work_order public.work_orders%rowtype;
  v_updated public.work_orders%rowtype;
  v_outgoing_name text;
  v_new_contractor public.profiles%rowtype;
  v_delivery public.contractor_assignment_transition_deliveries%rowtype;
  v_transition_reason text;
  v_activity_text text;
  v_event_key text;
  v_now timestamptz := clock_timestamp();
begin
  if nullif(trim(coalesce(p_work_order_id, '')), '') is null then
    raise exception 'Work order is required'
      using errcode = '22023';
  end if;

  if p_expected_assignment_version is null
     or p_expected_assignment_version < 0 then
    raise exception 'Expected assignment version is required'
      using errcode = '22023';
  end if;

  select profile.*
  into v_actor
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office')
    and not public.profile_has_staff_permission(
      profile.id,
      'invoice_controller'
    );

  if not found then
    raise exception 'Active operational P1 staff required'
      using errcode = '42501';
  end if;

  select work_order.*
  into v_work_order
  from public.work_orders work_order
  where work_order.id = trim(p_work_order_id)
    and work_order.deleted_at is null
  for update;

  if not found then
    raise exception 'Active work order not found'
      using errcode = 'P0002';
  end if;

  if v_work_order.contractor_assignment_version
       <> p_expected_assignment_version then
    raise exception 'Work-order assignment changed; refresh and try again'
      using errcode = 'PT409';
  end if;

  if v_work_order.contractor_id is not distinct from p_new_contractor_id then
    raise exception 'Work order is already in that assignment state'
      using errcode = 'PT409';
  end if;

  if v_work_order.billing_only
     or coalesce(v_work_order.is_capital, false) then
    raise exception 'Billing-only and capital work orders cannot be dispatched'
      using errcode = 'PT409';
  end if;

  if v_work_order.contractor_id is null then
    if p_new_contractor_id is null
       or v_work_order.status::text <> 'unassigned'
       or v_work_order.functional_status::text <> 'New' then
      raise exception 'Only a new unassigned work order can be assigned'
        using errcode = 'PT409';
    end if;
  elsif v_work_order.status::text not in ('assigned', 'wip', 'parts') then
    raise exception 'Only an active field work order can be reassigned or unassigned'
      using errcode = 'PT409';
  end if;

  if p_new_contractor_id is not null then
    select profile.*
    into v_new_contractor
    from public.profiles profile
    where profile.id = p_new_contractor_id
      and profile.role = 'contractor'
      and profile.active = true
      and profile.is_assignable = true;

    if not found then
      raise exception 'Active assignable contractor not found'
        using errcode = 'P0002';
    end if;
  end if;

  if v_work_order.contractor_id is null then
    v_transition_reason := 'assigned';
    v_activity_text := format(
      'Dispatched to %s%s.',
      v_new_contractor.name,
      case
        when nullif(trim(coalesce(v_new_contractor.company, '')), '') is null
          then ''
        else ' (' || trim(v_new_contractor.company) || ')'
      end
    );
  else
    select coalesce(nullif(trim(profile.name), ''), 'Contractor')
    into v_outgoing_name
    from public.profiles profile
    where profile.id = v_work_order.contractor_id;

    if p_new_contractor_id is null then
      v_transition_reason := 'unassigned';
      v_activity_text := format(
        'Work order unassigned by %s.',
        v_actor.name
      );
    else
      v_transition_reason := 'reassigned';
      v_activity_text := format(
        'Reassigned from %s to %s by %s.',
        coalesce(v_outgoing_name, 'Contractor'),
        v_new_contractor.name,
        v_actor.name
      );
    end if;
  end if;

  update public.work_orders work_order
  set contractor_id = p_new_contractor_id,
      updated_at = v_now
  where work_order.id = v_work_order.id
    and work_order.deleted_at is null
  returning work_order.* into v_updated;

  if not found then
    raise exception 'Work-order assignment conflicted with another change'
      using errcode = 'PT409';
  end if;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    activity_channel,
    entered_by_role,
    is_staff_override,
    is_staff_only,
    requires_7eleven_sync,
    requires_contractor_attention,
    event_key,
    event_data,
    contractor_assignment_version,
    workflow_cycle,
    created_at
  ) values (
    v_updated.id,
    v_actor.id,
    v_actor.name,
    v_activity_text,
    'system',
    'system_event',
    v_actor.role::text,
    false,
    true,
    false,
    false,
    case v_transition_reason
      when 'assigned' then 'work_order_assignment'
      when 'reassigned' then 'work_order_reassigned'
      else 'work_order_unassigned'
    end,
    jsonb_build_object(
      'action', v_transition_reason,
      'previousContractorId', v_work_order.contractor_id,
      'newContractorId', p_new_contractor_id,
      'assignmentVersion', v_updated.contractor_assignment_version,
      'changedBy', v_actor.id
    ),
    v_updated.contractor_assignment_version,
    v_updated.workflow_cycle,
    v_now
  );

  if v_work_order.contractor_id is not null then
    v_event_key := 'assignment:'
      || v_work_order.id
      || ':'
      || greatest(v_work_order.contractor_assignment_version, 1)::text;

    select delivery.*
    into v_delivery
    from public.contractor_assignment_transition_deliveries delivery
    where delivery.event_key = v_event_key;

    if not found then
      raise exception 'Outgoing contractor notification was not queued'
        using errcode = '23514';
    end if;
  end if;

  return jsonb_build_object(
    'applied', true,
    'reason', v_transition_reason,
    'workOrderId', v_updated.id,
    'contractorId', v_updated.contractor_id,
    'assignmentVersion', v_updated.contractor_assignment_version,
    'deliveryId', v_delivery.id,
    'deliveryStatus', v_delivery.status
  );
end;
$$;

comment on function public.transition_work_order_contractor(text, uuid, integer) is
  'Atomically assigns, reassigns, or unassigns an operational work order and returns the outgoing-notification delivery when one was queued.';

revoke all on function public.transition_work_order_contractor(
  text,
  uuid,
  integer
) from public, anon;
grant execute on function public.transition_work_order_contractor(
  text,
  uuid,
  integer
) to authenticated, service_role;

-- Preserve the original 0112 RPC (and its introspection audit) and expose an
-- additive app-facing wrapper that returns the delivery queued by the insert
-- trigger in the same transaction.
create or replace function public.duplicate_work_order_for_reassignment_notified(
  p_source_work_order_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_delivery public.contractor_assignment_transition_deliveries%rowtype;
begin
  v_result := public.duplicate_work_order_for_reassignment(
    p_source_work_order_id
  );

  select delivery.*
  into v_delivery
  from public.contractor_assignment_transition_deliveries delivery
  where delivery.event_key = 'duplicate:' || (v_result ->> 'workOrderId');

  if not found then
    raise exception 'Duplicate reassignment notification was not queued'
      using errcode = '23514';
  end if;

  return v_result || jsonb_build_object(
    'deliveryId', v_delivery.id,
    'deliveryStatus', v_delivery.status
  );
end;
$$;

comment on function public.duplicate_work_order_for_reassignment_notified(text) is
  'Creates a clean reassignment continuation and returns the durable notice for the source contractor, whose original remains available for invoicing.';

revoke all on function public.duplicate_work_order_for_reassignment_notified(text)
  from public, anon;
grant execute on function public.duplicate_work_order_for_reassignment_notified(text)
  to authenticated, service_role;

create or replace function public.claim_contractor_assignment_transition_delivery(
  p_delivery_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivery public.contractor_assignment_transition_deliveries%rowtype;
  v_claim_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.profiles actor
    where actor.id = p_actor_id
      and actor.active = true
      and actor.role in ('manager', 'dispatcher', 'back_office')
      and not public.profile_has_staff_permission(
        actor.id,
        'invoice_controller'
      )
  ) then
    raise exception 'Active operational P1 staff actor required'
      using errcode = '42501';
  end if;

  select delivery.*
  into v_delivery
  from public.contractor_assignment_transition_deliveries delivery
  where delivery.id = p_delivery_id
  for update;

  if not found then
    raise exception 'Assignment-transition delivery not found'
      using errcode = 'P0002';
  end if;

  if v_delivery.status = 'pending' then
    update public.contractor_assignment_transition_deliveries delivery
    set status = 'claimed',
        claimed_at = clock_timestamp()
    where delivery.id = v_delivery.id
      and delivery.status = 'pending'
    returning delivery.* into v_delivery;

    if not found then
      raise exception 'Assignment-transition delivery claim conflicted'
        using errcode = '40001';
    end if;

    v_claim_status := 'new_claim';
  elsif v_delivery.status = 'sent' then
    v_claim_status := 'already_sent';
  elsif v_delivery.status = 'unknown' then
    v_claim_status := 'delivery_unknown';
  elsif v_delivery.status = 'skipped' then
    v_claim_status := 'not_deliverable';
  else
    -- A claimed row may be in flight or may have lost its final response after
    -- the mail transport accepted the request. Never reclaim automatically.
    v_claim_status := 'pending_or_unknown';
  end if;

  return jsonb_build_object(
    'claimStatus', v_claim_status,
    'deliveryId', v_delivery.id,
    'workOrderId', v_delivery.work_order_id,
    'externalWorkOrderId', v_delivery.external_work_order_id,
    'portalWorkOrderId', v_delivery.work_order_id,
    'outgoingContractorId', v_delivery.outgoing_contractor_id,
    'outgoingContractorName', v_delivery.outgoing_contractor_name,
    'outgoingContractorCompany', v_delivery.outgoing_contractor_company,
    'outgoingContractorEmail', v_delivery.outgoing_contractor_email,
    'transitionType', v_delivery.transition_type,
    'transitionedAt', v_delivery.created_at
  );
end;
$$;

create or replace function public.complete_contractor_assignment_transition_delivery(
  p_delivery_id uuid,
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
    raise exception 'Service role required'
      using errcode = '42501';
  end if;

  if p_status not in ('sent', 'unknown') then
    raise exception 'Delivery status must be sent or unknown'
      using errcode = '22023';
  end if;

  update public.contractor_assignment_transition_deliveries delivery
  set status = p_status,
      completed_at = clock_timestamp(),
      error_message = case
        when p_status = 'unknown' then coalesce(
          nullif(left(trim(coalesce(p_error_message, '')), 1000), ''),
          'Delivery outcome unknown'
        )
        else null
      end
  where delivery.id = p_delivery_id
    and delivery.status = 'claimed';

  if not found then
    raise exception 'Claimed assignment-transition delivery not found'
      using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.claim_contractor_assignment_transition_delivery(
  uuid,
  uuid
) from public, anon, authenticated;
revoke all on function public.complete_contractor_assignment_transition_delivery(
  uuid,
  text,
  text
) from public, anon, authenticated;

grant execute on function public.claim_contractor_assignment_transition_delivery(
  uuid,
  uuid
) to service_role;
grant execute on function public.complete_contractor_assignment_transition_delivery(
  uuid,
  text,
  text
) to service_role;

commit;
