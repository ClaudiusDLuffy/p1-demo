-- Approved latest-effective payment-hold notice policy; forward-only.
-- Pause financial actions/drain for application cutover. No historical backfill,
-- email send, source rewrite, or receiving/review policy change occurs here.
begin;
lock table public.invoices, public.financial_notification_events,
  public.financial_notification_deliveries in share row exclusive mode;

-- Release boundary metadata only; no business/source/delivery history backfill.
alter table public.financial_notification_control add column hold_policy_activated_at timestamptz
  not null default clock_timestamp();

create table public.financial_notification_hold_supersessions (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null unique references public.financial_notification_deliveries(id) on delete restrict,
  event_id uuid not null references public.financial_notification_events(id) on delete restrict,
  superseding_event_id uuid not null references public.financial_notification_events(id) on delete restrict,
  superseding_source_event_id uuid not null references public.contractor_invoice_payment_hold_events(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  operation_id uuid not null,
  original_state text not null check(original_state in ('pending','claimed','sending','sent','failed','unknown','not_deliverable','superseded')),
  original_error_code text,
  original_completed_at timestamptz,
  original_provider_status integer,
  original_provider_reference text,
  classification text not null check(classification in ('notification_no_longer_required','superseded_by_later_hold_state')),
  reason text not null default 'A later payment-hold source event committed.'
    check(reason='A later payment-hold source event committed.' and length(reason)<=150),
  created_at timestamptz not null default clock_timestamp(),
  check(event_id<>superseding_event_id)
);
alter table public.financial_notification_hold_supersessions enable row level security;
revoke all on public.financial_notification_hold_supersessions from public,anon,authenticated,service_role;
create index financial_notification_hold_supersession_history
  on public.financial_notification_hold_supersessions(event_id,created_at desc,id desc);
create index financial_notification_hold_source_order
  on public.financial_notification_events(invoice_id,event_sequence) where source_kind='hold_event';
create trigger financial_notification_hold_supersession_guard before insert or update or delete
  on public.financial_notification_hold_supersessions for each row execute function public.guard_financial_notification_records();

-- Notes append to the existing operation history. They never replace a prior
-- resend/contact operation and do not invent a one-note-per-delivery cap.
alter table public.financial_notification_operations drop constraint financial_notification_operations_action_check;
alter table public.financial_notification_operations add constraint financial_notification_operations_action_check
  check(action in ('resend','manual_resolution','history_note'));
alter table public.financial_notification_operations drop constraint financial_notification_operations_delivery_id_key;
create unique index financial_notification_one_operational_resolution
  on public.financial_notification_operations(delivery_id) where action in ('resend','manual_resolution');
create index financial_notification_operation_history
  on public.financial_notification_operations(event_id,created_at desc,operation_id desc);

-- First later committed source is the immutable superseding link. event_sequence
-- is established by the serialized invoice command, not client timestamps.
create function public.financial_notification_hold_superseder(p_event public.financial_notification_events)
returns uuid language sql stable security definer set search_path=pg_catalog,public as $$
  select later.id from public.financial_notification_events later
  where p_event.source_kind='hold_event' and later.source_kind='hold_event'
    and later.invoice_id=p_event.invoice_id and later.event_sequence>p_event.event_sequence
  order by later.event_sequence,later.source_id limit 1;
$$;

-- Caller already owns the invoice lock for source changes/prepare/completion.
-- Claim recovery may call this for its locked delivery without taking an invoice
-- lock: it only uses already committed immutable sources, avoiding lock inversion.
create function public.supersede_financial_notification_hold_delivery(p_delivery_id uuid,p_superseding_event_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.financial_notification_deliveries%rowtype;e public.financial_notification_events%rowtype;
  later public.financial_notification_events%rowtype;v_id uuid:=gen_random_uuid();v_manual boolean;v_unsent boolean;
begin
  select * into strict d from public.financial_notification_deliveries where id=p_delivery_id for update;
  select * into strict e from public.financial_notification_events where id=d.event_id;
  select * into strict later from public.financial_notification_events where id=p_superseding_event_id;
  if e.source_kind<>'hold_event' or later.source_kind<>'hold_event' or e.invoice_id<>later.invoice_id
    or later.event_sequence<=e.event_sequence or not exists(select 1 from public.contractor_invoice_payment_hold_events h
      where h.id=later.source_id and h.invoice_id=later.invoice_id and h.actor_id=later.actor_id and ('payment_hold_'||h.action)=later.family) then
    raise exception 'HOLD_NOTIFICATION_SUPERSEDED' using errcode='PT409'; end if;
  v_manual:=exists(select 1 from public.financial_notification_operations o where o.delivery_id=d.id and o.action='manual_resolution');
  v_unsent:=not v_manual and (d.state in ('pending','failed','not_deliverable') or (d.state='claimed' and d.send_started_at is null));
  if not exists(select 1 from public.financial_notification_hold_supersessions s where s.delivery_id=d.id) then
    perform public.financial_notification_cap('financial_notification_hold_supersessions',v_id);
    insert into public.financial_notification_hold_supersessions(id,delivery_id,event_id,superseding_event_id,superseding_source_event_id,
      actor_id,operation_id,original_state,original_error_code,original_completed_at,original_provider_status,original_provider_reference,classification)
      values(v_id,d.id,e.id,later.id,later.source_id,later.actor_id,later.operation_id,d.state,d.last_error_code,d.completed_at,d.provider_status,d.provider_reference,
        case when v_unsent then 'notification_no_longer_required' else 'superseded_by_later_hold_state' end);
  end if;
  if v_unsent then
    if d.state='claimed' then perform public.financial_notification_record_attempt(d,'completed','superseded','HOLD_NOTIFICATION_SUPERSEDED'); end if;
    perform public.financial_notification_cap('financial_notification_deliveries',d.id);
    update public.financial_notification_deliveries set state='superseded',last_error_code='HOLD_NOTIFICATION_SUPERSEDED',
      claim_token=null,claim_expires_at=null,completed_at=coalesce(completed_at,clock_timestamp()),updated_at=clock_timestamp() where id=d.id;
  end if;
end;
$$;
create function public.capture_financial_notification_hold_supersession()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare d record;
begin
  if new.source_kind<>'hold_event' then return new; end if;
  perform 1 from public.invoices where id=new.invoice_id for update;
  for d in select delivery.id,public.financial_notification_hold_superseder(earlier) as superseder_id
    from public.financial_notification_deliveries delivery
    join public.financial_notification_events earlier on earlier.id=delivery.event_id
    where earlier.invoice_id=new.invoice_id and earlier.source_kind='hold_event'
      and earlier.event_sequence<new.event_sequence
      and (not exists(select 1 from public.financial_notification_hold_supersessions s where s.delivery_id=delivery.id)
        or (delivery.state in ('pending','claimed','failed','not_deliverable')
          and delivery.send_started_at is null
          and not exists(select 1 from public.financial_notification_operations o where o.delivery_id=delivery.id and o.action='manual_resolution')))
    order by earlier.event_sequence,delivery.id loop
    perform public.supersede_financial_notification_hold_delivery(d.id,d.superseder_id);
  end loop;
  return new;
end;
$$;
create trigger financial_notification_hold_supersession after insert on public.financial_notification_events
  for each row execute function public.capture_financial_notification_hold_supersession();

create or replace function public.guard_financial_notification_records()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_new jsonb;v_old jsonb;v_id uuid;
begin
  if public.lifecycle_is_owner_maintenance() then return case when tg_op='DELETE' then old else new end; end if;
  if tg_op='DELETE' then raise exception 'NOTIFICATION_HISTORY_IMMUTABLE' using errcode='42501'; end if;
  v_new:=to_jsonb(new);v_id:=case when tg_table_name in ('financial_notification_operations','financial_notification_mutation_operations') then (v_new->>'operation_id')::uuid
    when tg_table_name='financial_notification_hold_heads' then (v_new->>'invoice_id')::uuid else (v_new->>'id')::uuid end;
  if not exists(select 1 from public.financial_notification_record_guards g where g.transaction_id=txid_current()
    and g.relation_name=tg_table_name and g.target_id=v_id) then raise exception 'NOTIFICATION_COMMAND_REQUIRED' using errcode='42501'; end if;
  if tg_op='UPDATE' then
    v_old:=to_jsonb(old);
    if tg_table_name='financial_notification_hold_heads' then
      if v_new->'invoice_id' is distinct from v_old->'invoice_id' then raise exception 'NOTIFICATION_HISTORY_IMMUTABLE' using errcode='42501'; end if;
    elsif tg_table_name='financial_notification_mutation_operations' then
      if v_old->'result'<>'null'::jsonb or v_new-'result' is distinct from v_old-'result' then raise exception 'NOTIFICATION_HISTORY_IMMUTABLE' using errcode='42501'; end if;
    elsif tg_table_name='financial_notification_deliveries' then
      if (v_new-array['state','attempt_count','next_attempt_at','claim_token','claim_expires_at','send_started_at','completed_at','last_error_code','provider_status','provider_reference','updated_at'])
        is distinct from (v_old-array['state','attempt_count','next_attempt_at','claim_token','claim_expires_at','send_started_at','completed_at','last_error_code','provider_status','provider_reference','updated_at'])
        or (v_old->>'state' in ('sent','unknown','not_deliverable','superseded') and not (
          v_old->>'state'='not_deliverable' and v_new->>'state'='superseded'
          and v_new-array['state','last_error_code','completed_at','updated_at'] is not distinct from
              v_old-array['state','last_error_code','completed_at','updated_at']
          and exists(select 1 from public.financial_notification_hold_supersessions s where s.delivery_id=v_id)
        )) then raise exception 'NOTIFICATION_HISTORY_IMMUTABLE' using errcode='42501'; end if;
    else raise exception 'NOTIFICATION_HISTORY_IMMUTABLE' using errcode='42501'; end if;
  end if;
  return new;
end;
$$;

create or replace function public.financial_notification_event_current(p_event public.financial_notification_events)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.invoices i left join public.work_orders w on w.id=i.work_order_id
    where i.id=p_event.invoice_id and i.invoice_type='contractor' and i.deleted_at is null
      and (case when p_event.source_kind='review_activity' then coalesce(i.contractor_id,i.created_by) else i.contractor_id end) is not distinct from p_event.contractor_id
      and i.work_order_id is not distinct from p_event.work_order_id
      and ((p_event.source_kind='hold_event' and p_event.source_id=public.financial_notification_latest_hold_source(i.id)
        and ((p_event.family='payment_hold_placed')=exists(select 1 from public.contractor_invoice_payment_holds active_hold where active_hold.invoice_id=i.id))
        and exists(select 1 from public.contractor_invoice_payment_hold_events h
        where h.id=p_event.source_id and h.invoice_id=i.id and ('payment_hold_'||h.action)=p_event.family and h.actor_id=p_event.actor_id))
        or (p_event.source_kind='review_activity' and i.review_revision=p_event.review_revision
        and ((p_event.family='invoice_rejected' and i.state='rejected') or (p_event.family='invoice_rejection_retracted' and i.state='approved'))
        and exists(select 1 from public.activities a where a.id=p_event.source_id and a.event_key=p_event.family and a.deleted_at is null
          and a.event_data->>'invoiceId'=i.id::text and a.event_data->>'revision'=p_event.review_revision::text and a.author_id=p_event.actor_id))));
$$;

-- A newer notice waits only for an older durable send-start, across the whole
-- invoice. Pending old notices are superseded; terminal unknown never blocks
-- the current corrective notice. No transaction spans Graph network I/O.
create or replace function public.financial_notification_predecessor_pending(p_delivery public.financial_notification_deliveries)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.financial_notification_events current_event
    join public.financial_notification_events earlier on earlier.invoice_id=current_event.invoice_id
      and earlier.source_kind='hold_event' and earlier.event_sequence<current_event.event_sequence
    join public.financial_notification_deliveries d on d.event_id=earlier.id
    where current_event.id=p_delivery.event_id and current_event.source_kind='hold_event'
      and d.state in ('claimed','sending') and d.send_started_at is not null);
$$;

create or replace function public.claim_financial_notification_deliveries_v1(p_limit integer,p_lease_seconds integer,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.financial_notification_deliveries%rowtype;e public.financial_notification_events%rowtype;
  v_state text;v_code text;v_later uuid;v_result jsonb:='[]';v_not_deliverable int:=0;v_superseded int:=0;v_recovered int:=0;v_unknown int:=0;
begin
  perform public.require_financial_notification_service();
  if p_limit is null or p_limit not between 1 and 25 or p_lease_seconds is null or p_lease_seconds not between 5 and 300 or p_claim_token is null then
    raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  for d in select * from public.financial_notification_deliveries where state in ('claimed','sending') and claim_expires_at<=clock_timestamp()
    order by claim_expires_at,id limit 100 for update skip locked loop
    select * into strict e from public.financial_notification_events where id=d.event_id;
    v_later:=public.financial_notification_hold_superseder(e);
    if d.send_started_at is null and v_later is not null then
      perform public.supersede_financial_notification_hold_delivery(d.id,v_later);
      v_superseded:=v_superseded+1;continue;
    end if;
    v_state:=case when d.send_started_at is null then 'pending' else 'unknown' end;
    v_code:=case when d.send_started_at is null then 'CLAIM_EXPIRED_BEFORE_SEND' else 'SEND_OUTCOME_UNKNOWN' end;
    if v_state='pending' then v_recovered:=v_recovered+1;else v_unknown:=v_unknown+1;end if;
    perform public.financial_notification_record_attempt(d,'claim_expired',v_state,v_code);
    perform public.financial_notification_cap('financial_notification_deliveries',d.id);
    update public.financial_notification_deliveries set state=v_state,claim_token=null,claim_expires_at=null,
      completed_at=case when v_state='unknown' then clock_timestamp() else null end,last_error_code=v_code,
      next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() where id=d.id;
  end loop;
  for d in select candidate.* from public.financial_notification_deliveries candidate
    where (candidate.state='pending' or public.financial_notification_retry_pending(candidate)) and candidate.next_attempt_at<=clock_timestamp()
      and not exists(select 1 from public.financial_notification_operations o where o.delivery_id=candidate.id)
      and not public.financial_notification_predecessor_pending(candidate)
    order by candidate.next_attempt_at,candidate.created_at,candidate.id limit p_limit for update of candidate skip locked loop
    select * into strict e from public.financial_notification_events where id=d.event_id;
    v_later:=public.financial_notification_hold_superseder(e);
    if v_later is not null then
      perform public.supersede_financial_notification_hold_delivery(d.id,v_later);
      v_superseded:=v_superseded+1;continue;
    end if;
    if not public.financial_notification_event_current(e) then v_state:='superseded';v_code:='EVENT_SUPERSEDED';
    elsif not public.financial_notification_recipient_valid(d) then v_state:='not_deliverable';v_code:='RECIPIENT_NOT_DELIVERABLE';
    else v_state:='claimed';v_code:=null;end if;
    perform public.financial_notification_cap('financial_notification_deliveries',d.id);
    update public.financial_notification_deliveries set state=v_state,
      attempt_count=attempt_count+case when v_state='claimed' then 1 else 0 end,
      claim_token=case when v_state='claimed' then p_claim_token else null end,
      claim_expires_at=case when v_state='claimed' then clock_timestamp()+make_interval(secs=>p_lease_seconds) else null end,
      send_started_at=null,completed_at=case when v_state='claimed' then null else clock_timestamp() end,
      last_error_code=v_code,updated_at=clock_timestamp() where id=d.id returning * into d;
    if v_state='not_deliverable' then v_not_deliverable:=v_not_deliverable+1;end if;
    if v_state='superseded' then v_superseded:=v_superseded+1;end if;
    if v_state='claimed' then
      perform public.financial_notification_record_attempt(d,'claimed','claimed');
      v_result:=v_result||jsonb_build_array(jsonb_build_object('id',d.id,'eventId',d.event_id));
    end if;
  end loop;
  perform public.financial_notification_clear_caps();return jsonb_build_object('claims',v_result,'notDeliverable',v_not_deliverable,
    'superseded',v_superseded,'recoveredBeforeSend',v_recovered,'recoveredUnknown',v_unknown);
end;
$$;

create or replace function public.prepare_financial_notification_send_v1(p_delivery_id uuid,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.financial_notification_deliveries%rowtype;e public.financial_notification_events%rowtype;
  v_later uuid;v_email text;v_state text;v_code text;v_reason text;v_invoice jsonb;
begin
  perform public.require_financial_notification_service();
  if p_delivery_id is null or p_claim_token is null then raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  select * into d from public.financial_notification_deliveries where id=p_delivery_id;
  if not found then return null; end if;
  select * into strict e from public.financial_notification_events where id=d.event_id;
  perform 1 from public.work_orders where id=e.work_order_id for update;
  perform 1 from public.invoices where id=e.invoice_id for update;
  select * into d from public.financial_notification_deliveries where id=p_delivery_id for update;
  if d.state<>'claimed' or d.claim_token is distinct from p_claim_token or d.claim_expires_at<=clock_timestamp() then return null; end if;
  perform 1 from public.profiles where id in(d.recipient_profile_id,e.contractor_id) order by id for share;
  perform 1 from public.organizations where id=d.recipient_company_id for share;
  perform 1 from public.staff_permission_grants where profile_id=d.recipient_profile_id and permission='quickbooks_handoff' for share;
  perform 1 from public.contractor_technicians where profile_id=d.recipient_profile_id and contractor_id=e.contractor_id for share;
  v_later:=public.financial_notification_hold_superseder(e);
  if v_later is not null then
    perform public.supersede_financial_notification_hold_delivery(d.id,v_later);
    perform public.financial_notification_clear_caps();return jsonb_build_object('status','superseded');
  end if;
  if public.financial_notification_predecessor_pending(d) then
    -- Leave the valid current claim in place; no provider attempt is admitted.
    -- After the older send closes/lease expires, this claim can be reclaimed.
    perform public.financial_notification_clear_caps();return null;
  end if;
  if not public.financial_notification_event_current(e) then v_state:='superseded';v_code:='EVENT_SUPERSEDED';
  elsif not public.financial_notification_recipient_valid(d) then v_state:='not_deliverable';v_code:='RECIPIENT_NOT_DELIVERABLE';
  end if;
  perform public.financial_notification_cap('financial_notification_deliveries',d.id);
  if v_state is not null then
    perform public.financial_notification_record_attempt(d,'completed',v_state,v_code);
    update public.financial_notification_deliveries set state=v_state,last_error_code=v_code,claim_token=null,claim_expires_at=null,
      completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=d.id;
    perform public.financial_notification_clear_caps();return jsonb_build_object('status',v_state);
  end if;
  select r.email into strict v_email from public.financial_notification_recipients(e) r where r.profile_id=d.recipient_profile_id;
  update public.financial_notification_deliveries set state='sending',send_started_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=d.id returning * into d;
  perform public.financial_notification_record_attempt(d,'sending','sending');
  perform public.financial_notification_clear_caps();
  if e.source_kind='hold_event' then select h.reason into v_reason from public.contractor_invoice_payment_hold_events h where h.id=e.source_id;
  elsif e.family='invoice_rejected' then select a.event_data->>'reason' into v_reason from public.activities a where a.id=e.source_id;end if;
  v_invoice:=(e.message_context-'actorName')||jsonb_build_object('rejectionReason',case when e.family='invoice_rejected' then v_reason else null end);
  return jsonb_build_object('id',d.id,'eventId',e.id,'family',e.family,'recipientEmail',v_email,
    'invoice',v_invoice,'actorName',e.message_context->>'actorName','reason',case when e.source_kind='hold_event' then v_reason else null end);
end;
$$;

create or replace function public.complete_financial_notification_delivery_v1(p_delivery_id uuid,p_claim_token uuid,p_status text,p_error_code text,p_provider_status integer,p_provider_reference text,p_retry_after_seconds integer default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.financial_notification_deliveries%rowtype;a public.financial_notification_attempt_events%rowtype;e public.financial_notification_events%rowtype;v_later uuid;v_delivery_state text;
begin
  perform public.require_financial_notification_service();
  if p_delivery_id is null or p_claim_token is null or p_status is null or p_status not in ('sent','failed','unknown','not_deliverable','superseded')
    or (p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{1,80}$') or (p_provider_status is not null and p_provider_status not between 100 and 599)
    or length(p_provider_reference)>200 or (p_retry_after_seconds is not null and p_retry_after_seconds not between 0 and 86400)
    or (p_status='failed' and (p_error_code is null or p_error_code in ('GRAPH_OUTCOME_UNKNOWN','SEND_OUTCOME_UNKNOWN') or p_provider_status=408 or p_provider_status>=500))
    or (p_status='sent' and (p_error_code is not null or p_provider_status is distinct from 202)) then raise exception 'INVALID_PROVIDER_OUTCOME' using errcode='PT422'; end if;
  select e0.* into e from public.financial_notification_events e0 join public.financial_notification_deliveries d0 on d0.event_id=e0.id where d0.id=p_delivery_id;
  if found then
    perform 1 from public.work_orders where id=e.work_order_id for update;
    perform 1 from public.invoices where id=e.invoice_id for update;
  end if;
  select * into d from public.financial_notification_deliveries where id=p_delivery_id for update;
  if not found then raise exception 'DELIVERY_NOT_FOUND' using errcode='PT404'; end if;
  select * into a from public.financial_notification_attempt_events where delivery_id=d.id and claim_token=p_claim_token and phase='completed';
  if found then
    if a.state is distinct from p_status or a.code is distinct from p_error_code or a.provider_status is distinct from p_provider_status
      or a.provider_reference is distinct from p_provider_reference or a.retry_after_seconds is distinct from p_retry_after_seconds then raise exception 'OPERATION_REUSED' using errcode='PT409'; end if;
    return jsonb_build_object('id',d.id,'state',a.state,'deliveryState',d.state,'replayed',true);
  end if;
  if d.state not in ('claimed','sending') or d.claim_token is distinct from p_claim_token or d.claim_expires_at<=clock_timestamp()
    or (p_status='sent' and d.state<>'sending') then raise exception 'STALE_CLAIM' using errcode='PT409'; end if;
  perform public.financial_notification_record_attempt(d,'completed',p_status,p_error_code,p_provider_status,p_provider_reference,p_retry_after_seconds);
  perform public.financial_notification_cap('financial_notification_deliveries',d.id);
  update public.financial_notification_deliveries set state=p_status,claim_token=null,claim_expires_at=null,
    send_started_at=case when p_status='failed' then null else send_started_at end,completed_at=clock_timestamp(),last_error_code=p_error_code,
    provider_status=p_provider_status,provider_reference=p_provider_reference,
    next_attempt_at=case when p_status='failed' then clock_timestamp()+make_interval(secs=>greatest(300,coalesce(p_retry_after_seconds,0))) else next_attempt_at end,
    updated_at=clock_timestamp() where id=d.id;
  v_delivery_state:=p_status;
  v_later:=public.financial_notification_hold_superseder(e);
  if v_later is not null and p_status in ('failed','not_deliverable') then
    perform public.supersede_financial_notification_hold_delivery(d.id,v_later);
    v_delivery_state:='superseded';
  end if;
  perform public.financial_notification_clear_caps();return jsonb_build_object('id',d.id,'state',p_status,'deliveryState',v_delivery_state,'replayed',false);
end;
$$;

create or replace function public.financial_notification_safe_code(p_code text)
returns text language sql immutable set search_path=pg_catalog,public as $$
  select case when p_code in ('NO_ELIGIBLE_RECIPIENT','RECIPIENT_NOT_DELIVERABLE','EVENT_SUPERSEDED','GRAPH_RATE_LIMITED','GRAPH_AUTH_RETRYABLE',
    'GRAPH_SEND_REJECTED','GRAPH_CONFIG_UNAVAILABLE','GRAPH_OUTCOME_UNKNOWN','GRAPH_SEND_FAILED','CLAIM_EXPIRED_BEFORE_SEND','SEND_OUTCOME_UNKNOWN',
    'PREDECESSOR_UNRESOLVED','GRAPH_RETRY_WINDOW_EXCEEDED','HOLD_NOTIFICATION_SUPERSEDED') then p_code when p_code is not null then 'DELIVERY_FAILED' else null end;
$$;

create or replace function public.financial_notification_safe_projection(p_delivery public.financial_notification_deliveries,p_labels boolean default false)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('id',p_delivery.id,'eventId',e.id,'rootId',coalesce(p_delivery.root_delivery_id,p_delivery.id),'invoiceId',e.invoice_id,
    'workOrderId',e.work_order_id,'family',e.family,'sourceEventId',e.source_id,'reviewRevision',e.review_revision,'recipientKind',p_delivery.recipient_kind,
    'recipientLabel',case when p_labels then (select left(case when p_delivery.recipient_kind='contractor'
      then coalesce(nullif(btrim(p.company),''),nullif(btrim(p.name),''),'Contractor')
      else coalesce(nullif(btrim(p.name),''),nullif(btrim(p.company),''),'Recipient') end,160)
      from public.profiles p where p.id=p_delivery.recipient_profile_id) else null end,
    'current',public.financial_notification_event_current(e),
    'supersededBySourceEventId',coalesce(s.superseding_source_event_id,later.source_id),
    'supersededAt',later.created_at,
    'canAnnotateHistory',e.source_kind='hold_event' and later.id is not null and p_delivery.state in ('unknown','superseded')
      and not exists(select 1 from public.financial_notification_operations o where o.delivery_id=p_delivery.id and o.action='manual_resolution')
      and exists(select 1 from public.invoices i where i.id=e.invoice_id and i.invoice_type='contractor' and i.deleted_at is null
        and i.contractor_id is not distinct from e.contractor_id and i.work_order_id is not distinct from e.work_order_id)
      and (e.family<>'payment_hold_released' or public.profile_has_staff_permission(auth.uid(),'quickbooks_handoff')),
    'state',case when exists(select 1 from public.financial_notification_operations o where o.delivery_id=p_delivery.id and o.action='manual_resolution') then 'manually_resolved' else p_delivery.state end,
    'attemptCount',p_delivery.attempt_count,'createdAt',p_delivery.created_at,
    'lastAttemptAt',(select max(a.created_at) from public.financial_notification_attempt_events a where a.delivery_id=p_delivery.id),
    'completedAt',coalesce((select o.created_at from public.financial_notification_operations o where o.delivery_id=p_delivery.id and o.action='manual_resolution'),p_delivery.completed_at),
    'code',public.financial_notification_safe_code(p_delivery.last_error_code),
    'canResend',public.financial_notification_actionable(p_delivery) and public.financial_notification_event_current(e)
      and not exists(select 1 from public.financial_notification_operations o where o.delivery_id=p_delivery.id)
      and (e.source_kind<>'hold_event' or e.source_id=public.financial_notification_latest_hold_source(e.invoice_id))
      and (e.family<>'payment_hold_released' or public.profile_has_staff_permission(auth.uid(),'quickbooks_handoff'))
      and (public.financial_notification_recipient_valid(p_delivery) or (p_delivery.recipient_kind='missing' and exists(
        select 1 from public.financial_notification_recipients(e) r where public.financial_notification_email_valid(r.email)))),
    'canResolve',p_delivery.recipient_profile_id is not null and exists(select 1 from public.financial_notification_recipients(e) r
        where r.profile_id=p_delivery.recipient_profile_id and r.company_id is not distinct from p_delivery.recipient_company_id and r.kind=p_delivery.recipient_kind)
      and public.financial_notification_actionable(p_delivery) and public.financial_notification_event_current(e)
      and not exists(select 1 from public.financial_notification_operations o where o.delivery_id=p_delivery.id)
      and (e.family<>'payment_hold_released' or public.profile_has_staff_permission(auth.uid(),'quickbooks_handoff')))
    from public.financial_notification_events e
    left join public.financial_notification_hold_supersessions s on s.delivery_id=p_delivery.id
    left join public.financial_notification_events later on later.id=coalesce(s.superseding_event_id,public.financial_notification_hold_superseder(e))
    where e.id=p_delivery.event_id;
$$;

create or replace function public.financial_notification_staff_action(p_event_id uuid,p_delivery_id uuid,p_operation_id uuid,p_reason text,p_action text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare e public.financial_notification_events%rowtype;d public.financial_notification_deliveries%rowtype;a public.profiles%rowtype;
  o public.financial_notification_operations%rowtype;v_reason text:=btrim(p_reason);v_id uuid;v_first uuid;v_count int:=0;r record;
begin
  perform public.require_financial_notification_actor(null);
  if p_event_id is null or p_delivery_id is null or p_operation_id is null or v_reason is null or v_reason='' then raise exception 'REASON_REQUIRED' using errcode='PT422'; end if;
  if length(v_reason)>500 or p_action not in ('resend','manual_resolution') then raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  select * into e from public.financial_notification_events where id=p_event_id;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode='PT404'; end if;
  a:=public.require_financial_notification_actor(e.family,true);
  perform pg_advisory_xact_lock(hashtextextended('financial-notification-operation:'||p_operation_id,0));
  select * into o from public.financial_notification_operations where operation_id=p_operation_id;
  if found then
    if o.event_id<>p_event_id or o.delivery_id<>p_delivery_id or o.actor_id<>a.id or o.reason<>v_reason or o.action<>p_action then raise exception 'OPERATION_REUSED' using errcode='PT409'; end if;
    select count(*),min(id::text)::uuid into v_count,v_first from public.financial_notification_deliveries where parent_delivery_id=o.delivery_id;
    return jsonb_build_object('status',case when p_action='resend' then 'queued' else 'manually_resolved' end,'deliveryId',coalesce(v_first,o.delivery_id),'eventId',e.id,
      'operationId',p_operation_id,'replayed',true,'deliveryCount',v_count);
  end if;
  if exists(select 1 from public.financial_notification_mutation_operations where operation_id=p_operation_id) then raise exception 'OPERATION_REUSED' using errcode='PT409'; end if;
  perform 1 from public.work_orders where id=e.work_order_id for update;
  perform 1 from public.invoices where id=e.invoice_id for update;
  select * into d from public.financial_notification_deliveries where id=p_delivery_id and event_id=e.id for update;
  if not found then raise exception 'DELIVERY_NOT_FOUND' using errcode='PT404'; end if;
  if e.source_kind='hold_event' and e.source_id is distinct from public.financial_notification_latest_hold_source(e.invoice_id) then
    raise exception 'HOLD_NOTIFICATION_SUPERSEDED' using errcode='PT409'; end if;
  if not public.financial_notification_event_current(e) then raise exception 'EVENT_NOT_CURRENT' using errcode='PT409'; end if;
  if d.state='sent' then raise exception 'DELIVERY_ALREADY_SENT' using errcode='PT409'; end if;
  if not public.financial_notification_actionable(d) or exists(select 1 from public.financial_notification_operations where delivery_id=d.id)
    or exists(select 1 from public.financial_notification_deliveries where parent_delivery_id=d.id) then raise exception 'DELIVERY_NOT_ACTIONABLE' using errcode='PT409'; end if;
  if p_action='manual_resolution' and d.recipient_profile_id is null then raise exception 'RECIPIENT_NOT_DELIVERABLE' using errcode='PT409'; end if;
  perform 1 from public.profiles where id in(d.recipient_profile_id,e.contractor_id) order by id for share;
  perform 1 from public.organizations where id=d.recipient_company_id for share;
  perform 1 from public.staff_permission_grants where profile_id=d.recipient_profile_id and permission='quickbooks_handoff' for share;
  if p_action='manual_resolution' and not exists(select 1 from public.financial_notification_recipients(e) eligible_recipient
    where eligible_recipient.profile_id=d.recipient_profile_id and eligible_recipient.company_id is not distinct from d.recipient_company_id and eligible_recipient.kind=d.recipient_kind) then
    raise exception 'RECIPIENT_NOT_DELIVERABLE' using errcode='PT409'; end if;
  if p_action='resend' then
    for r in select * from public.financial_notification_recipients(e) where public.financial_notification_email_valid(email)
      and (d.recipient_kind='missing' or (profile_id=d.recipient_profile_id and company_id is not distinct from d.recipient_company_id and kind=d.recipient_kind)) loop
      perform 1 from public.profiles where id=r.profile_id for share;
      perform 1 from public.staff_permission_grants where profile_id=r.profile_id and permission='quickbooks_handoff' for share;
      if not exists(select 1 from public.financial_notification_recipients(e) checked where checked.profile_id=r.profile_id
        and checked.company_id is not distinct from r.company_id and public.financial_notification_email_valid(checked.email)) then
        raise exception 'RECIPIENT_NOT_DELIVERABLE' using errcode='PT409'; end if;
      v_id:=public.financial_notification_add_delivery(e.id,r.profile_id,r.company_id,r.kind,r.email,d.id,coalesce(d.root_delivery_id,d.id));
      v_count:=v_count+1;if v_first is null or v_id::text<v_first::text then v_first:=v_id;end if;
    end loop;
    if v_count=0 then raise exception 'RECIPIENT_NOT_DELIVERABLE' using errcode='PT409'; end if;
  end if;
  perform public.financial_notification_cap('financial_notification_operations',p_operation_id);
  insert into public.financial_notification_operations(operation_id,event_id,delivery_id,action,actor_id,reason) values(p_operation_id,e.id,d.id,p_action,a.id,v_reason);
  perform public.financial_notification_clear_caps();
  return jsonb_build_object('status',case when p_action='resend' then 'queued' else 'manually_resolved' end,'deliveryId',coalesce(v_first,d.id),'eventId',e.id,
    'operationId',p_operation_id,'replayed',false,'deliveryCount',v_count);
end;
$$;

create function public.annotate_financial_notification_history_v1(p_event_id uuid,p_delivery_id uuid,p_operation_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare e public.financial_notification_events%rowtype;d public.financial_notification_deliveries%rowtype;
  a public.profiles%rowtype;o public.financial_notification_operations%rowtype;v_reason text:=btrim(p_reason);v_later uuid;
begin
  perform public.require_financial_notification_actor(null);
  if p_event_id is null or p_delivery_id is null or p_operation_id is null or v_reason is null or v_reason='' then
    raise exception 'REASON_REQUIRED' using errcode='PT422'; end if;
  if length(v_reason)>500 then raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  select * into e from public.financial_notification_events where id=p_event_id;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode='PT404'; end if;
  a:=public.require_financial_notification_actor(e.family,true);
  perform pg_advisory_xact_lock(hashtextextended('financial-notification-operation:'||p_operation_id,0));
  select * into o from public.financial_notification_operations where operation_id=p_operation_id;
  if found then
    if o.event_id<>p_event_id or o.delivery_id<>p_delivery_id or o.actor_id<>a.id or o.reason<>v_reason or o.action<>'history_note' then
      raise exception 'OPERATION_REUSED' using errcode='PT409'; end if;
    return jsonb_build_object('status','historical_note_recorded','deliveryId',o.delivery_id,'eventId',e.id,
      'operationId',p_operation_id,'replayed',true,'deliveryCount',0);
  end if;
  if exists(select 1 from public.financial_notification_mutation_operations where operation_id=p_operation_id) then
    raise exception 'OPERATION_REUSED' using errcode='PT409'; end if;
  perform 1 from public.work_orders where id=e.work_order_id for update;
  perform 1 from public.invoices where id=e.invoice_id for update;
  select * into d from public.financial_notification_deliveries where id=p_delivery_id and event_id=e.id for update;
  if not found then raise exception 'DELIVERY_NOT_FOUND' using errcode='PT404'; end if;
  v_later:=public.financial_notification_hold_superseder(e);
  if e.source_kind<>'hold_event' or v_later is null or d.state not in ('unknown','superseded')
    or exists(select 1 from public.financial_notification_operations previous where previous.delivery_id=d.id and previous.action='manual_resolution')
    or not exists(select 1 from public.invoices i where i.id=e.invoice_id and i.invoice_type='contractor' and i.deleted_at is null
      and i.contractor_id is not distinct from e.contractor_id and i.work_order_id is not distinct from e.work_order_id) then
    raise exception 'DELIVERY_NOT_ACTIONABLE' using errcode='PT409'; end if;
  -- Explicit historical classification does not assert contact or delivery.
  -- The system evidence binds it to the superseding source without editing the
  -- original unknown/provider facts; each staff note has its own operation UUID.
  perform public.supersede_financial_notification_hold_delivery(d.id,v_later);
  perform public.financial_notification_cap('financial_notification_operations',p_operation_id);
  insert into public.financial_notification_operations(operation_id,event_id,delivery_id,action,actor_id,reason)
    values(p_operation_id,e.id,d.id,'history_note',a.id,v_reason);
  perform public.financial_notification_clear_caps();
  return jsonb_build_object('status','historical_note_recorded','deliveryId',d.id,'eventId',e.id,
    'operationId',p_operation_id,'replayed',false,'deliveryCount',0);
end;
$$;

create or replace function public.get_financial_notification_history_v1(p_event_id uuid,p_cursor jsonb default null,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare e public.financial_notification_events%rowtype;v_at timestamptz;v_id text;v_snapshot timestamptz:=clock_timestamp();v_items jsonb;v_more boolean;v_next jsonb;
begin
  perform public.require_financial_notification_actor(null);
  select * into e from public.financial_notification_events where id=p_event_id;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode='PT404'; end if;
  perform public.require_financial_notification_actor(e.family);
  if p_limit is null or p_limit not between 1 and 50 then raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  if p_cursor is not null then
    begin
      if jsonb_typeof(p_cursor)<>'object' or p_cursor-array['version','eventId','createdAt','id','snapshotAt']<>'{}'::jsonb
        or not(p_cursor ?& array['version','eventId','createdAt','id','snapshotAt']) or p_cursor->>'version' is distinct from '1'
        or p_cursor->>'eventId' is distinct from p_event_id::text then raise exception 'bad'; end if;
      v_at:=(p_cursor->>'createdAt')::timestamptz;v_id:=p_cursor->>'id';v_snapshot:=(p_cursor->>'snapshotAt')::timestamptz;
      if v_at is null or v_id is null or v_id !~* '^(delivery|attempt|operation|supersession):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or v_snapshot is null or not isfinite(v_at) or not isfinite(v_snapshot) or v_at>v_snapshot or v_snapshot>clock_timestamp() then raise exception 'bad'; end if;
    exception when others then raise exception 'INVALID_CURSOR' using errcode='PT422'; end;
  end if;
  with history as (
    select 'delivery:'||d.id as id,'delivery'::text as kind,d.state,d.created_at,d.completed_at,null::text as reason,0 as sequence,public.financial_notification_safe_code(d.last_error_code) as code
      from public.financial_notification_deliveries d where d.event_id=e.id
    union all select 'attempt:'||a.id,'attempt',a.state,a.created_at,case when a.phase in ('completed','claim_expired') then a.created_at else null end,
      null,a.sequence,public.financial_notification_safe_code(a.code) from public.financial_notification_attempt_events a join public.financial_notification_deliveries d on d.id=a.delivery_id where d.event_id=e.id
    union all select 'operation:'||o.operation_id,case when o.action='resend' then 'resend' when o.action='history_note' then 'historical_note' else 'manual_resolution' end,
      case when o.action='resend' then 'pending' when o.action='history_note' then (select d.state from public.financial_notification_deliveries d where d.id=o.delivery_id) else 'manually_resolved' end,o.created_at,o.created_at,o.reason,0,null
      from public.financial_notification_operations o where o.event_id=e.id
    union all select 'supersession:'||s.id,case when s.classification='notification_no_longer_required' then 'system_no_longer_required' else 'supersession' end,
      s.original_state,s.created_at,s.created_at,s.reason,0,coalesce(public.financial_notification_safe_code(s.original_error_code),'HOLD_NOTIFICATION_SUPERSEDED')
      from public.financial_notification_hold_supersessions s where s.event_id=e.id
  ), candidates as (select * from history where created_at<=v_snapshot and (v_at is null or (created_at,id)<(v_at,v_id)) order by created_at desc,id desc limit p_limit+1),
  page as (select * from candidates order by created_at desc,id desc limit p_limit)
  select coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'state',p.state,'createdAt',p.created_at,'completedAt',p.completed_at,
    'reason',p.reason,'sequence',p.sequence,'code',p.code) order by p.created_at desc,p.id desc) from page p),'[]'::jsonb),
    (select count(*)>p_limit from candidates),(select jsonb_build_object('version',1,'eventId',p_event_id,'createdAt',p.created_at,'id',p.id,'snapshotAt',v_snapshot) from page p order by p.created_at,p.id limit 1)
    into v_items,v_more,v_next;
  return jsonb_build_object('items',v_items,'hasMore',v_more,'nextCursor',case when v_more then v_next else null end);
end;
$$;

revoke all on function public.financial_notification_hold_superseder(public.financial_notification_events),
  public.supersede_financial_notification_hold_delivery(uuid,uuid),public.capture_financial_notification_hold_supersession(),
  public.annotate_financial_notification_history_v1(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.annotate_financial_notification_history_v1(uuid,uuid,uuid,text) to authenticated;

-- CREATE OR REPLACE preserves existing grants. Explicitly retain the private
-- boundary for all replacements, with only already-public service/staff RPCs.
revoke all on function public.guard_financial_notification_records(),public.financial_notification_event_current(public.financial_notification_events),
  public.financial_notification_predecessor_pending(public.financial_notification_deliveries),
  public.financial_notification_safe_projection(public.financial_notification_deliveries,boolean),
  public.financial_notification_staff_action(uuid,uuid,uuid,text,text),public.financial_notification_safe_code(text)
  from public,anon,authenticated,service_role;
revoke all on function public.claim_financial_notification_deliveries_v1(integer,integer,uuid),
  public.prepare_financial_notification_send_v1(uuid,uuid),public.complete_financial_notification_delivery_v1(uuid,uuid,text,text,integer,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_financial_notification_deliveries_v1(integer,integer,uuid),
  public.prepare_financial_notification_send_v1(uuid,uuid),public.complete_financial_notification_delivery_v1(uuid,uuid,text,text,integer,text,integer) to service_role;
revoke all on function public.get_financial_notification_history_v1(uuid,jsonb,integer) from public,anon,authenticated,service_role;
grant execute on function public.get_financial_notification_history_v1(uuid,jsonb,integer) to authenticated;
commit;
