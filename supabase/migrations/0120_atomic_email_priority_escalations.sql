-- Apply trusted 7-Eleven email priority escalations atomically, keep stale or
-- repeated messages from changing current state, and queue one internal alert.
-- SLA deadlines are supplied by the server-side canonical TypeScript policy;
-- this RPC validates their shape and the unchanged SLA anchor under row lock.

begin;

alter table public.work_orders
  add column if not exists priority_source_message_id text,
  add column if not exists priority_source_received_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.work_orders'::regclass
      and conname = 'work_orders_priority_source_shape_check'
  ) then
    alter table public.work_orders
      add constraint work_orders_priority_source_shape_check check (
        (
          priority_source_message_id is null
          and priority_source_received_at is null
        )
        or (
          nullif(trim(priority_source_message_id), '') is not null
          and length(priority_source_message_id) <= 2048
          and priority_source_received_at is not null
        )
      );
  end if;
end;
$$;

create or replace function public.work_order_priority_rank(
  p_priority public.wo_priority
)
returns smallint
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select case p_priority::text
    when 'p1' then 1
    when 'p2' then 2
    when 'p3' then 3
    when 'p4' then 4
    when 'p5' then 5
  end::smallint;
$$;

revoke all on function public.work_order_priority_rank(public.wo_priority)
  from public, anon, authenticated;
grant execute on function public.work_order_priority_rank(public.wo_priority)
  to service_role;

create or replace function public.work_order_accepts_email_priority_escalation(
  p_status public.wo_status,
  p_functional_status public.fsm_functional_status
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_status::text in (
    'unassigned',
    'assigned',
    'wip',
    'parts',
    'capital',
    'pending_capital_completion'
  )
  and p_functional_status::text is distinct from 'Completed'
  and p_functional_status::text is distinct from 'Cancelled';
$$;

revoke all on function public.work_order_accepts_email_priority_escalation(
  public.wo_status,
  public.fsm_functional_status
) from public, anon, authenticated;
grant execute on function public.work_order_accepts_email_priority_escalation(
  public.wo_status,
  public.fsm_functional_status
) to service_role;

create table if not exists public.email_priority_escalation_events (
  id uuid primary key default gen_random_uuid(),
  source_message_id text not null unique
    check (
      nullif(trim(source_message_id), '') is not null
      and length(source_message_id) <= 2048
    ),
  source_received_at timestamptz not null,
  source_subject text not null default ''
    check (length(source_subject) <= 500),
  work_order_id text not null
    constraint email_priority_escalation_work_order_fkey
    references public.work_orders(id) on delete cascade,
  external_work_order_id text not null,
  previous_priority public.wo_priority not null,
  reported_priority public.wo_priority not null,
  work_order_status public.wo_status not null,
  functional_status public.fsm_functional_status,
  outcome text not null
    check (outcome in (
      'escalated',
      'unchanged',
      'not_escalation',
      'stale',
      'non_operational'
    )),
  activity_id uuid
    constraint email_priority_escalation_activity_fkey
    references public.activities(id) on delete restrict,
  incident_id text,
  store_number text,
  store_state text,
  city text,
  address text,
  summary text,
  contractor_name text,
  delivery_status text not null default 'not_required'
    check (delivery_status in (
      'not_required',
      'pending',
      'claimed',
      'sent',
      'unknown',
      'failed'
    )),
  delivery_attempt_count smallint not null default 0
    check (delivery_attempt_count between 0 and 3),
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  error_message text,
  constraint email_priority_escalation_outcome_shape_check check (
    (
      outcome = 'escalated'
      and public.work_order_priority_rank(reported_priority)
        < public.work_order_priority_rank(previous_priority)
      and activity_id is not null
      and delivery_status in (
        'pending', 'claimed', 'sent', 'unknown', 'failed'
      )
    )
    or (
      outcome = 'unchanged'
      and reported_priority = previous_priority
      and activity_id is null
      and delivery_status = 'not_required'
    )
    or (
      outcome = 'not_escalation'
      and public.work_order_priority_rank(reported_priority)
        > public.work_order_priority_rank(previous_priority)
      and activity_id is null
      and delivery_status = 'not_required'
    )
    or (
      outcome = 'stale'
      and activity_id is null
      and delivery_status = 'not_required'
    )
    or (
      outcome = 'non_operational'
      and activity_id is null
      and delivery_status = 'not_required'
    )
  ),
  constraint email_priority_escalation_eligibility_shape_check check (
    (
      outcome = 'non_operational'
      and not public.work_order_accepts_email_priority_escalation(
        work_order_status,
        functional_status
      )
    )
    or (
      outcome <> 'non_operational'
      and public.work_order_accepts_email_priority_escalation(
        work_order_status,
        functional_status
      )
    )
  ),
  constraint email_priority_escalation_delivery_shape_check check (
    (
      delivery_status = 'not_required'
      and delivery_attempt_count = 0
      and next_attempt_at is null
      and claimed_at is null
      and completed_at is not null
      and error_message is null
    )
    or (
      delivery_status = 'pending'
      and delivery_attempt_count between 0 and 2
      and next_attempt_at is not null
      and claimed_at is null
      and completed_at is null
      and (
        (delivery_attempt_count = 0 and error_message is null)
        or (delivery_attempt_count > 0 and error_message is not null)
      )
    )
    or (
      delivery_status = 'claimed'
      and delivery_attempt_count between 1 and 3
      and next_attempt_at is null
      and claimed_at is not null
      and completed_at is null
      and error_message is null
    )
    or (
      delivery_status = 'sent'
      and delivery_attempt_count between 1 and 3
      and next_attempt_at is null
      and claimed_at is not null
      and completed_at is not null
      and error_message is null
    )
    or (
      delivery_status = 'unknown'
      and delivery_attempt_count between 1 and 3
      and next_attempt_at is null
      and claimed_at is not null
      and completed_at is not null
      and nullif(trim(coalesce(error_message, '')), '') is not null
    )
    or (
      delivery_status = 'failed'
      and delivery_attempt_count between 1 and 3
      and next_attempt_at is null
      and claimed_at is not null
      and completed_at is not null
      and nullif(trim(coalesce(error_message, '')), '') is not null
    )
  )
);

comment on table public.email_priority_escalation_events is
  'Service-only receipt ledger and at-most-once internal email outbox for trusted 7-Eleven priority escalation messages.';

create index if not exists idx_email_priority_escalation_delivery
  on public.email_priority_escalation_events(
    delivery_status,
    next_attempt_at,
    created_at,
    id
  )
  where delivery_status in ('pending', 'claimed');

create index if not exists idx_email_priority_escalation_work_order
  on public.email_priority_escalation_events(work_order_id, created_at desc);

alter table public.email_priority_escalation_events
  enable row level security;

revoke all on public.email_priority_escalation_events
  from public, anon, authenticated;
grant all on public.email_priority_escalation_events
  to service_role;

-- The legacy staff work-order INSERT policy is intentionally broad. Keep the
-- reassignment provenance shape private to the owning notified RPC so a raw
-- client INSERT cannot allocate an arbitrary high root-N sequence and become
-- the family head. Rows live only for the duration of the wrapper transaction.
create table if not exists public.work_order_priority_family_transition_guards (
  transaction_id bigint not null
    check (transaction_id > 0),
  duplicate_root_work_order_id text not null
    check (nullif(trim(duplicate_root_work_order_id), '') is not null),
  source_work_order_id text not null
    check (nullif(trim(source_work_order_id), '') is not null),
  actor_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (
    transaction_id,
    duplicate_root_work_order_id,
    source_work_order_id,
    actor_id
  )
);

alter table public.work_order_priority_family_transition_guards
  enable row level security;
revoke all on public.work_order_priority_family_transition_guards
  from public, anon, authenticated, service_role;

create or replace function public.protect_work_order_priority_email_provenance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_active_continuation public.work_orders%rowtype;
  v_priority_family_id text;
  v_guard_consumed integer := 0;
begin
  if coalesce(auth.role(), '') not in ('service_role', '')
     and (
       (
         tg_op = 'INSERT'
         and (
           new.priority_source_message_id is not null
           or new.priority_source_received_at is not null
         )
       )
       or (
         tg_op = 'UPDATE'
         and (
           new.priority_source_message_id is distinct from
             old.priority_source_message_id
           or new.priority_source_received_at is distinct from
             old.priority_source_received_at
         )
       )
     ) then
    raise exception 'Priority email provenance is service-managed'
      using errcode = '42501';
  end if;

  -- Staff retain a legacy direct-insert policy on work_orders. Guard every
  -- reassignment copy at the database boundary so that callers cannot bypass
  -- family serialization or create a new head with stale priority/SLA data.
  if tg_op = 'INSERT'
     and new.duplicated_from_work_order_id is not null then
    if new.duplicate_root_work_order_id is null then
      raise exception 'Reassignment copy root is required'
        using errcode = '23514';
    end if;

    if new.created_by is distinct from auth.uid() then
      raise exception 'Reassignment copies must be created through the notified duplication workflow'
        using errcode = '42501';
    end if;

    delete from public.work_order_priority_family_transition_guards transition_guard
    where transition_guard.transaction_id = txid_current()
      and transition_guard.duplicate_root_work_order_id =
        new.duplicate_root_work_order_id
      and transition_guard.source_work_order_id =
        new.duplicated_from_work_order_id
      and transition_guard.actor_id = auth.uid();
    get diagnostics v_guard_consumed = row_count;

    if v_guard_consumed <> 1 then
      raise exception 'Reassignment copies must be created through the notified duplication workflow'
        using errcode = '42501';
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(
        'work-order-priority:' || new.duplicate_root_work_order_id,
        0
      )
    );

    select family.*
    into v_active_continuation
    from public.work_orders family
    where family.deleted_at is null
      and (
        family.id = new.duplicate_root_work_order_id
        or family.duplicate_root_work_order_id =
          new.duplicate_root_work_order_id
      )
    order by
      coalesce(family.duplicate_sequence, 0) desc,
      family.id desc
    limit 1
    for share;

    if not found
       or new.duplicated_from_work_order_id is distinct from
         v_active_continuation.id then
      raise exception 'Reassignment copy must use the current active continuation'
        using errcode = 'PT409';
    end if;

    if new.priority is distinct from v_active_continuation.priority
       or new.sla_started_at is distinct from
         v_active_continuation.sla_started_at
       or new.response_breach_at is distinct from
         v_active_continuation.response_breach_at
       or new.resolution_breach_at is distinct from
         v_active_continuation.resolution_breach_at
       or new.priority_source_message_id is not null
       or new.priority_source_received_at is not null then
      raise exception 'Reassignment copy priority or SLA state is stale'
        using errcode = 'PT409';
    end if;
  end if;

  if tg_op = 'UPDATE'
     and coalesce(auth.role(), '') not in ('service_role', '')
     and (
       new.priority is distinct from old.priority
       or new.sla_started_at is distinct from old.sla_started_at
       or new.response_breach_at is distinct from old.response_breach_at
       or new.resolution_breach_at is distinct from old.resolution_breach_at
     ) then
    if not (
      public.is_staff()
      and not public.is_invoice_controller()
    ) then
      raise exception 'Active operational P1 staff required to change priority or SLA fields'
        using errcode = '42501';
    end if;

    -- UPDATE already holds the target tuple lock. A concurrent duplicate must
    -- therefore either copy these fresh values, or commit its child first and
    -- make this formerly-current source fail the head check after the wait.
    -- Do not take the family advisory lock here: row -> family would invert the
    -- wrapper's family -> row lock order.
    v_priority_family_id := coalesce(
      old.duplicate_root_work_order_id,
      old.id
    );
    select family.*
    into v_active_continuation
    from public.work_orders family
    where family.deleted_at is null
      and (
        family.id = v_priority_family_id
        or family.duplicate_root_work_order_id = v_priority_family_id
      )
    order by
      coalesce(family.duplicate_sequence, 0) desc,
      family.id desc
    limit 1;

    if not found or v_active_continuation.id is distinct from old.id then
      raise exception 'A newer reassignment continuation exists; refresh before changing priority or SLA fields'
        using errcode = 'PT409';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.protect_work_order_priority_email_provenance()
  from public, anon, authenticated;

drop trigger if exists protect_work_order_priority_email_provenance_trigger
  on public.work_orders;
create trigger protect_work_order_priority_email_provenance_trigger
  before insert or update
  on public.work_orders
  for each row
  execute function public.protect_work_order_priority_email_provenance();

-- Keep the user-visible system audit aligned with the private immutable event
-- ledger. Operational staff may edit ordinary notes, but cannot fabricate,
-- relabel, rewrite, or soft-delete a trusted provider escalation event.
create or replace function public.protect_work_order_priority_escalation_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_protected boolean := false;
  v_new_protected boolean := false;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old_protected := old.event_key = 'work_order_priority_escalated';
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new_protected := new.event_key = 'work_order_priority_escalated';
  end if;

  if (v_old_protected or v_new_protected)
     and coalesce(auth.role(), '') not in ('service_role', '') then
    raise exception 'Priority escalation activity is service-managed and immutable'
      using errcode = '42501';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.protect_work_order_priority_escalation_activity()
  from public, anon, authenticated;

drop trigger if exists protect_work_order_priority_escalation_activity_trigger
  on public.activities;
create trigger protect_work_order_priority_escalation_activity_trigger
  before insert or update or delete
  on public.activities
  for each row
  execute function public.protect_work_order_priority_escalation_activity();

create or replace function public.apply_email_work_order_priority_escalation(
  p_work_order_id text,
  p_reported_priority text,
  p_source_message_id text,
  p_source_received_at timestamptz,
  p_source_subject text,
  p_expected_sla_started_at timestamptz,
  p_response_breach_at timestamptz,
  p_resolution_breach_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_work_order public.work_orders%rowtype;
  v_requested_work_order public.work_orders%rowtype;
  v_existing public.email_priority_escalation_events%rowtype;
  v_event public.email_priority_escalation_events%rowtype;
  v_reported_priority public.wo_priority;
  v_outcome text;
  v_activity_id uuid;
  v_contractor_name text;
  v_current_priority public.wo_priority;
  v_is_fresh boolean;
  v_priority_family_id text;
  v_family_source_message_id text;
  v_family_source_received_at timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required'
      using errcode = '42501';
  end if;

  if nullif(trim(coalesce(p_work_order_id, '')), '') is null
     or nullif(trim(coalesce(p_source_message_id, '')), '') is null
     or length(trim(p_source_message_id)) > 2048
     or p_source_received_at is null then
    raise exception 'Work order, source message, and received time are required'
      using errcode = '22023';
  end if;

  if lower(trim(coalesce(p_reported_priority, ''))) not in (
    'p1', 'p2', 'p3', 'p4', 'p5'
  ) then
    raise exception 'Reported priority is invalid'
      using errcode = '22023';
  end if;

  v_reported_priority := lower(trim(p_reported_priority))::public.wo_priority;

  -- Serialize by immutable provider message ID even if overlapping intake
  -- cycles happen to resolve a canonical WOT to different continuations.
  perform pg_advisory_xact_lock(
    hashtextextended(trim(p_source_message_id), 0)
  );

  select event.*
  into v_existing
  from public.email_priority_escalation_events event
  where event.source_message_id = trim(p_source_message_id);

  if found then
    if v_existing.reported_priority is distinct from v_reported_priority
       or v_existing.source_received_at is distinct from p_source_received_at
       or v_existing.source_subject is distinct from left(
         coalesce(p_source_subject, ''),
         500
       ) then
      raise exception 'Priority source message payload changed'
        using errcode = '23514';
    end if;

    select work_order.*
    into v_requested_work_order
    from public.work_orders work_order
    where work_order.id = trim(p_work_order_id);

    if not found then
      raise exception 'Priority source message work order changed'
        using errcode = '23514';
    end if;

    v_priority_family_id := coalesce(
      v_requested_work_order.duplicate_root_work_order_id,
      v_requested_work_order.id
    );
    if v_priority_family_id is distinct from
         v_existing.external_work_order_id then
      raise exception 'Priority source message work order changed'
        using errcode = '23514';
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended('work-order-priority:' || v_priority_family_id, 0)
    );

    select family.*
    into v_work_order
    from public.work_orders family
    where family.deleted_at is null
      and (
        family.id = v_priority_family_id
        or family.duplicate_root_work_order_id = v_priority_family_id
      )
    order by
      coalesce(family.duplicate_sequence, 0) desc,
      family.id desc
    limit 1
    for share;

    if not found then
      raise exception 'Active work-order continuation not found'
        using errcode = 'P0002';
    end if;

    v_current_priority := v_work_order.priority;

    return jsonb_build_object(
      'applied', v_existing.outcome = 'escalated',
      'replayed', true,
      'outcome', v_existing.outcome,
      'eventId', v_existing.id,
      'workOrderId', v_work_order.id,
      'externalWorkOrderId', v_existing.external_work_order_id,
      'previousPriority', v_existing.previous_priority,
      'reportedPriority', v_existing.reported_priority,
      'currentPriority', coalesce(v_current_priority, v_existing.reported_priority),
      'deliveryStatus', v_existing.delivery_status
    );
  end if;

  select work_order.*
  into v_work_order
  from public.work_orders work_order
  where work_order.id = trim(p_work_order_id)
    and work_order.deleted_at is null;

  if not found then
    raise exception 'Active work order not found'
      using errcode = 'P0002';
  end if;

  -- Reassignment continuations retain the canonical external WOT identity.
  -- Serialize and compare provenance across the entire family so a child with
  -- initially null provenance cannot accept an older source message.
  v_priority_family_id := coalesce(
    v_work_order.duplicate_root_work_order_id,
    v_work_order.id
  );
  perform pg_advisory_xact_lock(
    hashtextextended('work-order-priority:' || v_priority_family_id, 0)
  );

  -- The email matcher runs before this transaction. Resolve the active family
  -- head again while holding the same family lock used by reassignment-copy
  -- creation, so a concurrent duplicate cannot receive stale priority/SLA
  -- data or leave this update on the former continuation.
  select family.*
  into v_work_order
  from public.work_orders family
  where family.deleted_at is null
    and (
      family.id = v_priority_family_id
      or family.duplicate_root_work_order_id = v_priority_family_id
    )
  order by
    coalesce(family.duplicate_sequence, 0) desc,
    family.id desc
  limit 1
  for update;

  if not found then
    raise exception 'Active work-order continuation not found'
      using errcode = 'P0002';
  end if;

  select
    family.priority_source_message_id,
    family.priority_source_received_at
  into
    v_family_source_message_id,
    v_family_source_received_at
  from public.work_orders family
  where (
      family.id = v_priority_family_id
      or family.duplicate_root_work_order_id = v_priority_family_id
    )
    and family.priority_source_received_at is not null
  order by
    family.priority_source_received_at desc,
    family.priority_source_message_id desc nulls last,
    family.id desc
  limit 1;

  v_is_fresh := v_family_source_received_at is null
    or p_source_received_at > v_family_source_received_at
    or (
      p_source_received_at = v_family_source_received_at
      and trim(p_source_message_id) > coalesce(
        v_family_source_message_id,
        ''
      )
    );

  if not public.work_order_accepts_email_priority_escalation(
    v_work_order.status,
    v_work_order.functional_status
  ) then
    -- Priority changes after field completion/cancellation or during billing
    -- are recorded as receipts, but cannot rewrite operational SLA history.
    v_outcome := 'non_operational';
  elsif not v_is_fresh then
    v_outcome := 'stale';
  elsif v_reported_priority = v_work_order.priority then
    v_outcome := 'unchanged';
  elsif public.work_order_priority_rank(v_reported_priority)
      < public.work_order_priority_rank(v_work_order.priority) then
    v_outcome := 'escalated';
  else
    -- Automatic intake is intentionally escalation-only. A newer lower-
    -- urgency notice advances provenance so an older escalation cannot replay,
    -- but lowering an operational priority remains a deliberate staff action.
    v_outcome := 'not_escalation';
  end if;

  if v_is_fresh then
    if v_outcome = 'escalated' then
      if v_work_order.sla_started_at is distinct from
           p_expected_sla_started_at then
        raise exception 'Work-order SLA anchor changed; retry intake'
          using errcode = 'PT409';
      end if;

      if v_work_order.sla_started_at is null then
        if p_response_breach_at is not null
           or p_resolution_breach_at is not null then
          raise exception 'SLA deadlines require an SLA start time'
            using errcode = '22023';
        end if;
      elsif p_response_breach_at is null
         or p_resolution_breach_at is null
         or p_response_breach_at <= v_work_order.sla_started_at
         or p_resolution_breach_at < p_response_breach_at then
        raise exception 'Escalated SLA deadlines are invalid'
          using errcode = '22023';
      end if;
    end if;

    update public.work_orders work_order
    set priority = case
          when v_outcome = 'escalated' then v_reported_priority
          else work_order.priority
        end,
        response_breach_at = case
          when v_outcome = 'escalated' then p_response_breach_at
          else work_order.response_breach_at
        end,
        resolution_breach_at = case
          when v_outcome = 'escalated' then p_resolution_breach_at
          else work_order.resolution_breach_at
        end,
        priority_source_message_id = trim(p_source_message_id),
        priority_source_received_at = p_source_received_at
    where work_order.id = v_work_order.id
      and work_order.deleted_at is null
    returning work_order.priority into v_current_priority;

    if not found then
      raise exception 'Work-order priority update conflicted'
        using errcode = 'PT409';
    end if;
  else
    v_current_priority := v_work_order.priority;
  end if;

  select nullif(trim(coalesce(profile.name, '')), '')
  into v_contractor_name
  from public.profiles profile
  where profile.id = v_work_order.contractor_id;

  if v_outcome = 'escalated' then
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
      v_work_order.id,
      null,
      'System',
      format(
        '7-Eleven priority escalated from %s to %s.',
        upper(v_work_order.priority::text),
        upper(v_reported_priority::text)
      ),
      'system',
      'system_event',
      'system',
      false,
      true,
      false,
      false,
      'work_order_priority_escalated',
      jsonb_build_object(
        'action', 'priority_escalated',
        'previousPriority', v_work_order.priority,
        'newPriority', v_reported_priority,
        'source', '7_eleven_email',
        'sourceMessageId', trim(p_source_message_id),
        'sourceReceivedAt', p_source_received_at,
        'slaStartedAt', v_work_order.sla_started_at,
        'responseBreachAt', p_response_breach_at,
        'resolutionBreachAt', p_resolution_breach_at
      ),
      v_work_order.contractor_assignment_version,
      v_work_order.workflow_cycle,
      v_now
    )
    returning id into v_activity_id;
  end if;

  insert into public.email_priority_escalation_events (
    source_message_id,
    source_received_at,
    source_subject,
    work_order_id,
    external_work_order_id,
    previous_priority,
    reported_priority,
    work_order_status,
    functional_status,
    outcome,
    activity_id,
    incident_id,
    store_number,
    store_state,
    city,
    address,
    summary,
    contractor_name,
    delivery_status,
    next_attempt_at,
    created_at,
    completed_at
  ) values (
    trim(p_source_message_id),
    p_source_received_at,
    left(coalesce(p_source_subject, ''), 500),
    v_work_order.id,
    v_priority_family_id,
    v_work_order.priority,
    v_reported_priority,
    v_work_order.status,
    v_work_order.functional_status,
    v_outcome,
    v_activity_id,
    v_work_order.incident_id,
    v_work_order.store_number,
    v_work_order.store_state,
    v_work_order.city,
    v_work_order.address,
    v_work_order.summary,
    v_contractor_name,
    case when v_outcome = 'escalated' then 'pending' else 'not_required' end,
    case when v_outcome = 'escalated' then v_now else null end,
    v_now,
    case when v_outcome = 'escalated' then null else v_now end
  )
  returning * into v_event;

  return jsonb_build_object(
    'applied', v_outcome = 'escalated',
    'replayed', false,
    'outcome', v_outcome,
    'eventId', v_event.id,
    'workOrderId', v_event.work_order_id,
    'externalWorkOrderId', v_event.external_work_order_id,
    'previousPriority', v_event.previous_priority,
    'reportedPriority', v_event.reported_priority,
    'currentPriority', v_current_priority,
    'deliveryStatus', v_event.delivery_status
  );
end;
$$;

comment on function public.apply_email_work_order_priority_escalation(
  text,
  text,
  text,
  timestamptz,
  text,
  timestamptz,
  timestamptz,
  timestamptz
) is
  'Idempotently applies only fresher, more urgent 7-Eleven email priorities and atomically records the staff audit/outbox event.';

-- Serialize reassignment-copy creation with email priority changes. The core
-- 0112 function remains the single copy implementation; this app-facing
-- wrapper locks the logical family first, rejects a stale source screen, then
-- calls the core while the family priority/SLA snapshot cannot change.
create or replace function public.duplicate_work_order_for_reassignment_notified(
  p_source_work_order_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_is_operational_staff boolean;
  v_source public.work_orders%rowtype;
  v_priority_family_id text;
  v_active_continuation_id text;
  v_result jsonb;
  v_delivery public.contractor_assignment_transition_deliveries%rowtype;
begin
  if nullif(trim(coalesce(p_source_work_order_id, '')), '') is null then
    raise exception 'Source work order is required'
      using errcode = '22023';
  end if;

  select exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.active = true
      and profile.role in ('manager', 'dispatcher', 'back_office')
      and not public.profile_has_staff_permission(
        profile.id,
        'invoice_controller'
      )
  ) into v_actor_is_operational_staff;

  if not v_actor_is_operational_staff then
    raise exception 'Active operational P1 staff required'
      using errcode = '42501';
  end if;

  select work_order.*
  into v_source
  from public.work_orders work_order
  where work_order.id = trim(p_source_work_order_id)
    and work_order.deleted_at is null;

  if not found then
    raise exception 'Active source work order not found'
      using errcode = 'P0002';
  end if;

  v_priority_family_id := coalesce(
    v_source.duplicate_root_work_order_id,
    v_source.id
  );
  perform pg_advisory_xact_lock(
    hashtextextended('work-order-priority:' || v_priority_family_id, 0)
  );

  select family.id
  into v_active_continuation_id
  from public.work_orders family
  where family.deleted_at is null
    and (
      family.id = v_priority_family_id
      or family.duplicate_root_work_order_id = v_priority_family_id
    )
  order by
    coalesce(family.duplicate_sequence, 0) desc,
    family.id desc
  limit 1
  for share;

  if v_active_continuation_id is distinct from v_source.id then
    raise exception 'A newer reassignment continuation exists; refresh and duplicate the current work order'
      using errcode = 'PT409';
  end if;

  insert into public.work_order_priority_family_transition_guards (
    transaction_id,
    duplicate_root_work_order_id,
    source_work_order_id,
    actor_id
  ) values (
    txid_current(),
    v_priority_family_id,
    v_active_continuation_id,
    auth.uid()
  );

  v_result := public.duplicate_work_order_for_reassignment(
    v_active_continuation_id
  );

  if exists (
    select 1
    from public.work_order_priority_family_transition_guards transition_guard
    where transition_guard.transaction_id = txid_current()
      and transition_guard.duplicate_root_work_order_id = v_priority_family_id
      and transition_guard.source_work_order_id = v_active_continuation_id
      and transition_guard.actor_id = auth.uid()
  ) then
    raise exception 'Reassignment-copy transition guard was not consumed safely'
      using errcode = '23514';
  end if;

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
  'Creates a clean reassignment continuation from the current family head while serializing priority/SLA changes, and returns the durable source-contractor notice.';

create or replace function public.claim_email_priority_escalation_delivery(
  p_event_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.email_priority_escalation_events%rowtype;
  v_claim_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required'
      using errcode = '42501';
  end if;

  select event.*
  into v_event
  from public.email_priority_escalation_events event
  where event.id = p_event_id
  for update;

  if not found then
    raise exception 'Priority escalation delivery not found'
      using errcode = 'P0002';
  end if;

  if v_event.delivery_status = 'pending'
     and v_event.next_attempt_at <= clock_timestamp() then
    update public.email_priority_escalation_events event
    set delivery_status = 'claimed',
        delivery_attempt_count = event.delivery_attempt_count + 1,
        next_attempt_at = null,
        claimed_at = clock_timestamp(),
        error_message = null
    where event.id = v_event.id
      and event.delivery_status = 'pending'
    returning event.* into v_event;

    if not found then
      raise exception 'Priority escalation delivery claim conflicted'
        using errcode = '40001';
    end if;
    v_claim_status := 'new_claim';
  elsif v_event.delivery_status = 'pending' then
    v_claim_status := 'pending_or_unknown';
  elsif v_event.delivery_status = 'sent' then
    v_claim_status := 'already_sent';
  elsif v_event.delivery_status = 'unknown' then
    v_claim_status := 'delivery_unknown';
  elsif v_event.delivery_status = 'failed' then
    v_claim_status := 'delivery_failed';
  elsif v_event.delivery_status = 'not_required' then
    v_claim_status := 'not_required';
  else
    -- Never reclaim an in-flight/abandoned send automatically: Graph may have
    -- accepted it before the process lost the response.
    v_claim_status := 'pending_or_unknown';
  end if;

  return jsonb_build_object(
    'claimStatus', v_claim_status,
    'eventId', v_event.id,
    'workOrderId', v_event.work_order_id,
    'externalWorkOrderId', v_event.external_work_order_id,
    'previousPriority', v_event.previous_priority,
    'reportedPriority', v_event.reported_priority,
    'incidentId', v_event.incident_id,
    'storeNumber', v_event.store_number,
    'storeState', v_event.store_state,
    'city', v_event.city,
    'address', v_event.address,
    'summary', v_event.summary,
    'contractorName', v_event.contractor_name,
    'sourceReceivedAt', v_event.source_received_at
  );
end;
$$;

create or replace function public.complete_email_priority_escalation_delivery(
  p_event_id uuid,
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

  if p_status not in ('sent', 'unknown', 'failed') then
    raise exception 'Delivery status must be sent, unknown, or failed'
      using errcode = '22023';
  end if;

  update public.email_priority_escalation_events event
  set delivery_status = p_status,
      completed_at = clock_timestamp(),
      error_message = case
        when p_status in ('unknown', 'failed') then coalesce(
          nullif(left(trim(coalesce(p_error_message, '')), 1000), ''),
          case
            when p_status = 'failed' then 'Delivery failed'
            else 'Delivery outcome unknown'
          end
        )
        else null
      end
  where event.id = p_event_id
    and event.delivery_status = 'claimed';

  if not found then
    raise exception 'Claimed priority escalation delivery not found'
      using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.retry_email_priority_escalation_delivery(
  p_event_id uuid,
  p_error_message text,
  p_retry_after_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.email_priority_escalation_events%rowtype;
  v_error_message text;
  v_retry_after_seconds integer;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required'
      using errcode = '42501';
  end if;

  v_error_message := nullif(
    left(trim(coalesce(p_error_message, '')), 1000),
    ''
  );
  if v_error_message is null then
    raise exception 'Retry error message is required'
      using errcode = '22023';
  end if;
  v_retry_after_seconds := least(
    greatest(coalesce(p_retry_after_seconds, 30), 1),
    3600
  );

  select event.*
  into v_event
  from public.email_priority_escalation_events event
  where event.id = p_event_id
  for update;

  if not found or v_event.delivery_status <> 'claimed' then
    raise exception 'Claimed priority escalation delivery not found'
      using errcode = 'P0002';
  end if;

  if v_event.delivery_attempt_count >= 3 then
    update public.email_priority_escalation_events event
    set delivery_status = 'failed',
        completed_at = v_now,
        error_message = v_error_message
    where event.id = v_event.id
    returning event.* into v_event;
  else
    update public.email_priority_escalation_events event
    set delivery_status = 'pending',
        next_attempt_at = v_now + make_interval(
          secs => v_retry_after_seconds
        ),
        claimed_at = null,
        completed_at = null,
        error_message = v_error_message
    where event.id = v_event.id
    returning event.* into v_event;
  end if;

  return jsonb_build_object(
    'eventId', v_event.id,
    'deliveryStatus', v_event.delivery_status,
    'attemptCount', v_event.delivery_attempt_count,
    'nextAttemptAt', v_event.next_attempt_at
  );
end;
$$;

revoke all on function public.apply_email_work_order_priority_escalation(
  text,
  text,
  text,
  timestamptz,
  text,
  timestamptz,
  timestamptz,
  timestamptz
) from public, anon, authenticated;
revoke all on function public.duplicate_work_order_for_reassignment(text)
  from public, anon, authenticated, service_role;
revoke all on function public.duplicate_work_order_for_reassignment_notified(text)
  from public, anon;
revoke all on function public.claim_email_priority_escalation_delivery(uuid)
  from public, anon, authenticated;
revoke all on function public.complete_email_priority_escalation_delivery(
  uuid,
  text,
  text
) from public, anon, authenticated;
revoke all on function public.retry_email_priority_escalation_delivery(
  uuid,
  text,
  integer
) from public, anon, authenticated;

grant execute on function public.apply_email_work_order_priority_escalation(
  text,
  text,
  text,
  timestamptz,
  text,
  timestamptz,
  timestamptz,
  timestamptz
) to service_role;
grant execute on function public.duplicate_work_order_for_reassignment_notified(text)
  to authenticated, service_role;
grant execute on function public.claim_email_priority_escalation_delivery(uuid)
  to service_role;
grant execute on function public.complete_email_priority_escalation_delivery(
  uuid,
  text,
  text
) to service_role;
grant execute on function public.retry_email_priority_escalation_delivery(
  uuid,
  text,
  integer
) to service_role;

commit;
