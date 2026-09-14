-- Batch 3A.1. Forward-only operator closeout; 0133 and its existing rows are
-- preserved. The original event remains the delivery identity. Explicit
-- resends are child events; worker transitions and operator decisions append
-- immutable evidence. No historical delivery is rewritten during migration.
begin;

alter table public.contractor_receiving_dispatch_deliveries
  add column parent_delivery_id uuid references public.contractor_receiving_dispatch_deliveries(id) on delete restrict,
  add column root_delivery_id uuid references public.contractor_receiving_dispatch_deliveries(id) on delete restrict;
alter table public.contractor_receiving_dispatch_deliveries
  drop constraint receiving_dispatch_identity,
  drop constraint contractor_receiving_dispatch_deliveries_event_type_check;
alter table public.contractor_receiving_dispatch_deliveries add constraint receiving_dispatch_event_family
  check ((event_type in ('assignment','reassignment','duplicate_assignment') and parent_delivery_id is null and root_delivery_id is null)
    or (event_type='explicit_resend' and parent_delivery_id is not null and root_delivery_id is not null and parent_delivery_id<>id and root_delivery_id<>id));
create unique index receiving_dispatch_original_identity
  on public.contractor_receiving_dispatch_deliveries(work_order_id,assignment_version,recipient_profile_id,event_type)
  where parent_delivery_id is null;
create unique index receiving_dispatch_one_child on public.contractor_receiving_dispatch_deliveries(parent_delivery_id)
  where parent_delivery_id is not null;
create index receiving_dispatch_root_history
  on public.contractor_receiving_dispatch_deliveries(root_delivery_id,created_at desc,id desc)
  where root_delivery_id is not null;
create index receiving_dispatch_current_identity
  on public.contractor_receiving_dispatch_deliveries(work_order_id,assignment_version,recipient_profile_id,created_at desc,id desc);
create index receiving_dispatch_unresolved_page
  on public.contractor_receiving_dispatch_deliveries(created_at desc,id desc)
  where status in ('unknown','not_deliverable','failed');
create index receiving_dispatch_expired_lease
  on public.contractor_receiving_dispatch_deliveries(claim_expires_at,id)
  where status in ('claimed','sending');

create table public.receiving_dispatch_operations (
  operation_id uuid primary key,
  delivery_id uuid not null unique references public.contractor_receiving_dispatch_deliveries(id) on delete restrict,
  action text not null check(action in ('resend','manual_resolution')),
  child_delivery_id uuid unique references public.contractor_receiving_dispatch_deliveries(id) on delete restrict,
  assignment_version integer not null check(assignment_version>0),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  reason text not null check(length(btrim(reason)) between 1 and 500 and reason=btrim(reason)),
  created_at timestamptz not null default clock_timestamp(),
  check((action='resend')=(child_delivery_id is not null))
);
create table public.receiving_dispatch_attempt_events (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.contractor_receiving_dispatch_deliveries(id) on delete restrict,
  sequence integer not null check(sequence>0),
  phase text not null check(phase in ('claimed','sending','completed','claim_expired')),
  state text not null check(state in ('claimed','sending','sent','failed','unknown','not_deliverable','superseded','pending')),
  claim_token uuid not null,
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  unique(delivery_id,sequence,phase),
  check(error_code is null or error_code ~ '^[A-Z0-9_]{1,80}$')
);
create index receiving_dispatch_attempt_history on public.receiving_dispatch_attempt_events(delivery_id,created_at desc,id desc);
create table public.receiving_dispatch_transition_guards (
  transaction_id bigint not null, relation_name text not null, target_id uuid not null,
  primary key(transaction_id,relation_name,target_id)
);
create table public.receiving_dispatch_control (
  singleton boolean primary key default true check(singleton),
  closeout_enforced_at timestamptz not null default clock_timestamp()
);
insert into public.receiving_dispatch_control default values;
alter table public.receiving_dispatch_operations enable row level security;
alter table public.receiving_dispatch_attempt_events enable row level security;
alter table public.receiving_dispatch_transition_guards enable row level security;
alter table public.receiving_dispatch_control enable row level security;
revoke all on public.contractor_receiving_dispatch_deliveries,public.receiving_dispatch_operations,
  public.receiving_dispatch_attempt_events,public.receiving_dispatch_transition_guards,public.receiving_dispatch_control
  from public,anon,authenticated,service_role;

create function public.receiving_dispatch_cap(p_relation text,p_id uuid)
returns void language sql security definer set search_path=pg_catalog,public as $$
  insert into public.receiving_dispatch_transition_guards values(txid_current(),p_relation,p_id)
  on conflict do nothing;
$$;
create function public.receiving_dispatch_clear_caps()
returns void language sql security definer set search_path=pg_catalog,public as $$
  delete from public.receiving_dispatch_transition_guards where transaction_id=txid_current();
$$;
create function public.guard_receiving_dispatch_records()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;
begin
  if public.lifecycle_is_owner_maintenance() then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then raise exception 'DELIVERY_HISTORY_IMMUTABLE' using errcode='42501'; end if;
  v_id:=case when tg_table_name='receiving_dispatch_operations' then (to_jsonb(new)->>'operation_id')::uuid else (to_jsonb(new)->>'id')::uuid end;
  if not exists(select 1 from public.receiving_dispatch_transition_guards g
    where g.transaction_id=txid_current() and g.relation_name=tg_table_name and g.target_id=v_id) then
    raise exception 'DELIVERY_COMMAND_REQUIRED' using errcode='42501';
  end if;
  if tg_op='UPDATE' then
    if tg_table_name<>'contractor_receiving_dispatch_deliveries' then
      raise exception 'DELIVERY_HISTORY_IMMUTABLE' using errcode='42501';
    end if;
    if (new.id,new.work_order_id,new.assignment_version,new.event_type,new.recipient_profile_id,new.recipient_company_id,
        new.recipient_email_snapshot,new.recipient_name_snapshot,new.parent_delivery_id,new.root_delivery_id,new.created_at,new.created_by)
      is distinct from
       (old.id,old.work_order_id,old.assignment_version,old.event_type,old.recipient_profile_id,old.recipient_company_id,
        old.recipient_email_snapshot,old.recipient_name_snapshot,old.parent_delivery_id,old.root_delivery_id,old.created_at,old.created_by) then
      raise exception 'DELIVERY_IDENTITY_IMMUTABLE' using errcode='42501';
    end if;
    if old.status in ('sent','unknown','not_deliverable','superseded','cancelled','manually_resolved') then
      raise exception 'DELIVERY_OUTCOME_IMMUTABLE' using errcode='42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger receiving_dispatch_row_guard before insert or update or delete on public.contractor_receiving_dispatch_deliveries
  for each row execute function public.guard_receiving_dispatch_records();
create trigger receiving_dispatch_operation_guard before insert or update or delete on public.receiving_dispatch_operations
  for each row execute function public.guard_receiving_dispatch_records();
create trigger receiving_dispatch_attempt_guard before insert or update or delete on public.receiving_dispatch_attempt_events
  for each row execute function public.guard_receiving_dispatch_records();

create function public.require_receiving_dispatch_service()
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if current_setting('role')<>'service_role' or coalesce(auth.role(),'')<>'service_role' then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
end;
$$;
create function public.receiving_dispatch_retry_pending(p_delivery public.contractor_receiving_dispatch_deliveries)
returns boolean language sql immutable set search_path=pg_catalog,public as $$
  select p_delivery.status='failed' and p_delivery.attempt_count<3
    and p_delivery.last_error_code in ('GRAPH_RATE_LIMITED','GRAPH_AUTH_RETRYABLE');
$$;
create function public.receiving_dispatch_actionable(p_delivery public.contractor_receiving_dispatch_deliveries)
returns boolean language sql immutable set search_path=pg_catalog,public as $$
  select p_delivery.status in ('unknown','not_deliverable')
    or (p_delivery.status='failed' and not coalesce(public.receiving_dispatch_retry_pending(p_delivery),false));
$$;
create function public.receiving_dispatch_recipient_deliverable(p_delivery public.contractor_receiving_dispatch_deliveries)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.profiles p where p.id=p_delivery.recipient_profile_id
    and p.active=true and p.role='contractor' and p.is_assignable=true
    and p.contractor_organization_id is not distinct from p_delivery.recipient_company_id
    and public.contractor_account_id_for_profile(p.id)=p.id
    and length(btrim(coalesce(p.email,'')))<=320
    and btrim(coalesce(p.email,'')) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
$$;
create function public.receiving_dispatch_safe_code(p_code text)
returns text language sql immutable set search_path=pg_catalog,public as $$
  select case when p_code in ('RECIPIENT_INACTIVE','RECIPIENT_EMAIL_MISSING','RECIPIENT_NOT_DELIVERABLE',
    'ASSIGNMENT_SUPERSEDED','GRAPH_RATE_LIMITED','GRAPH_AUTH_RETRYABLE','GRAPH_SEND_REJECTED','GRAPH_CONFIG_UNAVAILABLE',
    'GRAPH_OUTCOME_UNKNOWN','GRAPH_SEND_FAILED','WORK_ORDER_NOT_FOUND','CLAIM_EXPIRED_BEFORE_SEND','SEND_OUTCOME_UNKNOWN')
    then p_code when p_code is not null then 'DELIVERY_FAILED' else null end;
$$;
create function public.receiving_dispatch_safe_projection(p_delivery public.contractor_receiving_dispatch_deliveries)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('id',p_delivery.id,'rootId',coalesce(p_delivery.root_delivery_id,p_delivery.id),
    'workOrderId',p_delivery.work_order_id,'assignmentVersion',p_delivery.assignment_version,
    'state',case when exists(select 1 from public.receiving_dispatch_operations o where o.delivery_id=p_delivery.id and o.action='manual_resolution') then 'manually_resolved' else p_delivery.status end,
    'attemptCount',p_delivery.attempt_count,'createdAt',p_delivery.created_at,
    'lastAttemptAt',coalesce((select max(e.created_at) from public.receiving_dispatch_attempt_events e where e.delivery_id=p_delivery.id),
      p_delivery.send_started_at,case when p_delivery.attempt_count>0 then p_delivery.updated_at else null end),
    'completedAt',coalesce((select o.created_at from public.receiving_dispatch_operations o where o.delivery_id=p_delivery.id and o.action='manual_resolution'),p_delivery.completed_at),
    'code',public.receiving_dispatch_safe_code(p_delivery.last_error_code),
    'canResend',public.receiving_dispatch_actionable(p_delivery) and public.receiving_dispatch_recipient_deliverable(p_delivery)
      and not exists(select 1 from public.receiving_dispatch_operations o where o.delivery_id=p_delivery.id)
      and exists(select 1 from public.work_orders w where w.id=p_delivery.work_order_id and w.deleted_at is null
        and w.contractor_id=p_delivery.recipient_profile_id and w.contractor_assignment_version=p_delivery.assignment_version),
    'canResolve',public.receiving_dispatch_actionable(p_delivery)
      and not exists(select 1 from public.receiving_dispatch_operations o where o.delivery_id=p_delivery.id)
      and exists(select 1 from public.profiles p where p.id=p_delivery.recipient_profile_id
        and p.contractor_organization_id is not distinct from p_delivery.recipient_company_id)
      and exists(select 1 from public.work_orders w where w.id=p_delivery.work_order_id and w.deleted_at is null
        and w.contractor_id=p_delivery.recipient_profile_id and w.contractor_assignment_version=p_delivery.assignment_version));
$$;

-- The existing assignment trigger still owns original intent creation. The
-- replacement only uses the forward partial identity and private row permit.
create or replace function public.queue_receiving_contractor_dispatch()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_recipient public.profiles%rowtype; v_event text; v_email text; v_id uuid:=gen_random_uuid();
begin
  if new.contractor_id is null or (tg_op='UPDATE' and new.contractor_id is not distinct from old.contractor_id) then return new; end if;
  select p.* into strict v_recipient from public.profiles p where p.id=new.contractor_id;
  v_email:=nullif(btrim(coalesce(v_recipient.email,'')),'');
  v_event:=case when tg_op='INSERT' and new.duplicated_from_work_order_id is not null then 'duplicate_assignment'
    when tg_op='INSERT' then 'assignment' else 'reassignment' end;
  perform public.receiving_dispatch_cap('contractor_receiving_dispatch_deliveries',v_id);
  insert into public.contractor_receiving_dispatch_deliveries(id,work_order_id,assignment_version,event_type,
    recipient_profile_id,recipient_company_id,recipient_email_snapshot,recipient_name_snapshot,status,last_error_code,created_by)
  values(v_id,new.id,greatest(new.contractor_assignment_version,1),v_event,v_recipient.id,v_recipient.contractor_organization_id,v_email,
    coalesce(nullif(btrim(v_recipient.name),''),nullif(btrim(v_recipient.company),''),'Contractor'),
    case when v_recipient.active and v_email is not null and length(v_email)<=320 and v_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then 'pending' else 'not_deliverable' end,
    case when v_recipient.active is distinct from true then 'RECIPIENT_INACTIVE'
      when v_email is null then 'RECIPIENT_EMAIL_MISSING'
      when length(v_email)>320 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then 'RECIPIENT_NOT_DELIVERABLE' else null end,
    coalesce(auth.uid(),new.created_by))
  on conflict(work_order_id,assignment_version,recipient_profile_id,event_type) where parent_delivery_id is null do nothing;
  perform public.receiving_dispatch_clear_caps();
  return new;
end;
$$;

create function public.record_receiving_dispatch_attempt(p_delivery public.contractor_receiving_dispatch_deliveries,p_phase text,p_state text,p_code text default null)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid:=gen_random_uuid();
begin
  perform public.receiving_dispatch_cap('receiving_dispatch_attempt_events',v_id);
  insert into public.receiving_dispatch_attempt_events(id,delivery_id,sequence,phase,state,claim_token,error_code)
    values(v_id,p_delivery.id,p_delivery.attempt_count,p_phase,p_state,p_delivery.claim_token,p_code);
end;
$$;

-- Recovery is bounded independently of claims. Before-start expiry is known
-- unsent; any durable start without completion is conservatively unknown.
create or replace function public.claim_receiving_dispatch_deliveries_v1(p_limit integer,p_lease_seconds integer,p_claim_token uuid)
returns setof public.contractor_receiving_dispatch_deliveries
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v public.contractor_receiving_dispatch_deliveries%rowtype; v_status text; v_code text; v_limit integer;
begin
  perform public.require_receiving_dispatch_service();
  if p_claim_token is null or p_limit is null or p_limit<1 or p_limit>25 or p_lease_seconds is null or p_lease_seconds<5 or p_lease_seconds>300 then
    raise exception 'VALIDATION_FAILED' using errcode='PT422';
  end if;
  v_limit:=p_limit;
  for v in select d.* from public.contractor_receiving_dispatch_deliveries d
    where d.status in ('claimed','sending') and d.claim_expires_at<=clock_timestamp()
    order by d.claim_expires_at,d.id limit 100 for update of d skip locked loop
    v_status:=case when v.send_started_at is null then 'pending' else 'unknown' end;
    v_code:=case when v.send_started_at is null then 'CLAIM_EXPIRED_BEFORE_SEND' else 'SEND_OUTCOME_UNKNOWN' end;
    perform public.record_receiving_dispatch_attempt(v,'claim_expired',v_status,v_code);
    perform public.receiving_dispatch_cap('contractor_receiving_dispatch_deliveries',v.id);
    update public.contractor_receiving_dispatch_deliveries set status=v_status,claim_token=null,claim_expires_at=null,
      send_started_at=case when v_status='pending' then null else send_started_at end,
      completed_at=case when v_status='unknown' then clock_timestamp() else null end,
      last_error_code=v_code,last_error_at=clock_timestamp(),next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
      where id=v.id;
  end loop;
  for v in select d.* from public.contractor_receiving_dispatch_deliveries d
    where d.status in ('pending','failed') and (d.status='pending' or public.receiving_dispatch_retry_pending(d)) and d.next_attempt_at<=clock_timestamp()
      and not exists(select 1 from public.receiving_dispatch_operations o where o.delivery_id=d.id)
    order by d.next_attempt_at,d.created_at,d.id limit v_limit for update of d skip locked loop
    if not exists(select 1 from public.work_orders w where w.id=v.work_order_id and w.deleted_at is null
      and w.contractor_id=v.recipient_profile_id and w.contractor_assignment_version=v.assignment_version) then
      v_status:='superseded'; v_code:='ASSIGNMENT_SUPERSEDED';
    elsif not public.receiving_dispatch_recipient_deliverable(v) then
      v_status:='not_deliverable'; v_code:='RECIPIENT_NOT_DELIVERABLE';
    else v_status:='claimed'; v_code:=null;
    end if;
    perform public.receiving_dispatch_cap('contractor_receiving_dispatch_deliveries',v.id);
    update public.contractor_receiving_dispatch_deliveries set status=v_status,
      claim_token=case when v_status='claimed' then p_claim_token else null end,
      claim_expires_at=case when v_status='claimed' then clock_timestamp()+make_interval(secs=>p_lease_seconds) else null end,
      send_started_at=null,attempt_count=attempt_count+case when v_status='claimed' then 1 else 0 end,
      completed_at=case when v_status='claimed' then null else clock_timestamp() end,
      superseded_at=case when v_status='superseded' then clock_timestamp() else superseded_at end,
      last_error_code=v_code,updated_at=clock_timestamp() where id=v.id returning * into v;
    if v_status='claimed' then
      perform public.record_receiving_dispatch_attempt(v,'claimed','claimed');
      return next v;
    end if;
  end loop;
  perform public.receiving_dispatch_clear_caps();
end;
$$;

create function public.prepare_receiving_dispatch_send_v1(p_delivery_id uuid,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v public.contractor_receiving_dispatch_deliveries%rowtype; w public.work_orders%rowtype; p public.profiles%rowtype;
  v_status text; v_code text;
begin
  perform public.require_receiving_dispatch_service();
  if p_delivery_id is null or p_claim_token is null then raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  select * into v from public.contractor_receiving_dispatch_deliveries where id=p_delivery_id;
  if not found then return null; end if;
  select * into w from public.work_orders where id=v.work_order_id for update;
  select * into v from public.contractor_receiving_dispatch_deliveries where id=p_delivery_id for update;
  if v.claim_token is distinct from p_claim_token or v.status<>'claimed' or v.claim_expires_at<=clock_timestamp() then return null; end if;
  if w.id is null or w.deleted_at is not null or w.contractor_id is distinct from v.recipient_profile_id
    or w.contractor_assignment_version is distinct from v.assignment_version then
    v_status:='superseded';v_code:='ASSIGNMENT_SUPERSEDED';
  else
    begin
      perform public.require_assignable_contractor(v.recipient_profile_id);
      select * into p from public.profiles where id=v.recipient_profile_id for share;
      if not public.receiving_dispatch_recipient_deliverable(v) then
        v_status:='not_deliverable';v_code:='RECIPIENT_NOT_DELIVERABLE';
      end if;
    exception when sqlstate '22023' then v_status:='not_deliverable';v_code:='RECIPIENT_NOT_DELIVERABLE';
    end;
  end if;
  perform public.receiving_dispatch_cap('contractor_receiving_dispatch_deliveries',v.id);
  if v_status is not null then
    perform public.record_receiving_dispatch_attempt(v,'completed',v_status,v_code);
    update public.contractor_receiving_dispatch_deliveries set status=v_status,last_error_code=v_code,
      claim_token=null,claim_expires_at=null,completed_at=clock_timestamp(),updated_at=clock_timestamp(),
      superseded_at=case when v_status='superseded' then clock_timestamp() else null end where id=v.id;
    perform public.receiving_dispatch_clear_caps(); return null;
  end if;
  update public.contractor_receiving_dispatch_deliveries set status='sending',send_started_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=v.id returning * into v;
  perform public.record_receiving_dispatch_attempt(v,'sending','sending');
  perform public.receiving_dispatch_clear_caps();
  return jsonb_build_object('id',v.id,'workOrder',jsonb_build_object('id',w.id,'incidentId',w.incident_id,
    'storeNumber',w.store_number,'city',w.city,'state',w.store_state,'address',w.address,'priority',w.priority,
    'summary',w.summary,'description',w.description,'externalWorkOrderId',coalesce(w.duplicate_root_work_order_id,w.id)),
    'contractorEmail',btrim(p.email),'contractorName',coalesce(nullif(btrim(p.name),''),nullif(btrim(p.company),''),'Contractor'));
end;
$$;
create or replace function public.start_receiving_dispatch_delivery_v1(p_delivery_id uuid,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin return public.prepare_receiving_dispatch_send_v1(p_delivery_id,p_claim_token) is not null; end;
$$;
create function public.get_receiving_dispatch_message_v1(p_delivery_id uuid,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v public.contractor_receiving_dispatch_deliveries%rowtype; w public.work_orders%rowtype; p public.profiles%rowtype;
begin
  perform public.require_receiving_dispatch_service();
  if p_delivery_id is null or p_claim_token is null then raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  select * into v from public.contractor_receiving_dispatch_deliveries where id=p_delivery_id;
  if not found then return null; end if;
  select * into w from public.work_orders where id=v.work_order_id for share;
  select * into v from public.contractor_receiving_dispatch_deliveries where id=p_delivery_id for share;
  if v.claim_token is distinct from p_claim_token or v.status<>'sending' or v.claim_expires_at<=clock_timestamp()
    or w.deleted_at is not null or w.contractor_id is distinct from v.recipient_profile_id
    or w.contractor_assignment_version is distinct from v.assignment_version then return null; end if;
  begin perform public.require_assignable_contractor(v.recipient_profile_id);
    exception when sqlstate '22023' then return null; end;
  select * into p from public.profiles where id=v.recipient_profile_id for share;
  if not public.receiving_dispatch_recipient_deliverable(v) then return null; end if;
  return jsonb_build_object('id',v.id,'workOrder',jsonb_build_object('id',w.id,'incidentId',w.incident_id,
    'storeNumber',w.store_number,'city',w.city,'state',w.store_state,'address',w.address,'priority',w.priority,
    'summary',w.summary,'description',w.description,'externalWorkOrderId',coalesce(w.duplicate_root_work_order_id,w.id)),
    'contractorEmail',btrim(p.email),'contractorName',coalesce(nullif(btrim(p.name),''),nullif(btrim(p.company),''),'Contractor'));
end;
$$;

create or replace function public.complete_receiving_dispatch_delivery_v1(p_delivery_id uuid,p_claim_token uuid,p_status text,p_error_code text,p_provider_status integer,p_provider_reference text)
returns public.contractor_receiving_dispatch_deliveries language plpgsql security definer set search_path=pg_catalog,public as $$
declare v public.contractor_receiving_dispatch_deliveries%rowtype; e public.receiving_dispatch_attempt_events%rowtype;
begin
  perform public.require_receiving_dispatch_service();
  if p_claim_token is null or p_status is null or p_status not in ('sent','failed','unknown','not_deliverable','superseded')
    or (p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{1,80}$')
    or (p_provider_status is not null and (p_provider_status<100 or p_provider_status>599))
    or (p_provider_reference is not null and length(p_provider_reference)>200) then
    raise exception 'VALIDATION_FAILED' using errcode='PT422';
  end if;
  if (p_status='failed' and p_error_code is null)
    or (p_status='failed' and (p_error_code in ('GRAPH_OUTCOME_UNKNOWN','SEND_OUTCOME_UNKNOWN')
      or p_provider_status=408 or p_provider_status>=500))
    or (p_status='sent' and p_error_code is not null) then
    raise exception 'INVALID_PROVIDER_OUTCOME' using errcode='PT422';
  end if;
  select * into v from public.contractor_receiving_dispatch_deliveries where id=p_delivery_id for update;
  if not found then raise exception 'DELIVERY_NOT_FOUND' using errcode='PT404'; end if;
  select * into e from public.receiving_dispatch_attempt_events where delivery_id=v.id and claim_token=p_claim_token and phase='completed';
  if found then
    if e.state is distinct from p_status or e.error_code is distinct from p_error_code then
      raise exception 'OPERATION_REUSED' using errcode='PT409';
    end if;
    return v;
  end if;
  if v.claim_token is distinct from p_claim_token or v.status not in ('claimed','sending') or v.claim_expires_at<=clock_timestamp()
    or (p_status='sent' and v.status<>'sending') then
    raise exception 'STALE_CLAIM' using errcode='PT409';
  end if;
  perform public.record_receiving_dispatch_attempt(v,'completed',p_status,p_error_code);
  perform public.receiving_dispatch_cap('contractor_receiving_dispatch_deliveries',v.id);
  update public.contractor_receiving_dispatch_deliveries set status=p_status,last_error_code=p_error_code,
    last_error_at=case when p_status in ('failed','unknown','not_deliverable') then clock_timestamp() else null end,
    provider_status=p_provider_status,provider_reference=p_provider_reference,
    sent_at=case when p_status='sent' then clock_timestamp() else null end,
    completed_at=clock_timestamp(),claim_token=null,claim_expires_at=null,
    send_started_at=case when p_status='failed' then null else send_started_at end,
    next_attempt_at=case when p_status='failed' then clock_timestamp()+interval '5 minutes' else next_attempt_at end,
    superseded_at=case when p_status='superseded' then clock_timestamp() else superseded_at end,
    updated_at=clock_timestamp() where id=v.id returning * into v;
  perform public.receiving_dispatch_clear_caps();
  return v;
end;
$$;

-- The old actor-supplied service reconciliation path cannot bypass immutable
-- evidence. Staff must use the operation-bound commands below.
create or replace function public.resolve_receiving_dispatch_delivery_v1(p_delivery_id uuid,p_resolution_type text,p_reason text,p_actor uuid)
returns public.contractor_receiving_dispatch_deliveries language plpgsql security definer set search_path=pg_catalog,public as $$
begin raise exception 'REASONED_STAFF_OPERATION_REQUIRED' using errcode='42501'; end;
$$;

create function public.get_receiving_dispatch_current_v1(p_work_order_id text,p_assignment_version integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare w public.work_orders%rowtype; v public.contractor_receiving_dispatch_deliveries%rowtype; v_count integer; v_cutover timestamptz;
begin
  perform public.require_work_order_assignment_actor();
  if p_work_order_id is null or length(p_work_order_id)>160 or p_assignment_version is null or p_assignment_version<0 then
    raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  select * into w from public.work_orders where id=p_work_order_id and deleted_at is null for share;
  if not found then raise exception 'DELIVERY_NOT_FOUND' using errcode='PT404'; end if;
  if w.contractor_assignment_version<>p_assignment_version then raise exception 'STALE_ASSIGNMENT' using errcode='PT409'; end if;
  if w.contractor_id is null then return jsonb_build_object('kind','unassigned','delivery',null); end if;
  select count(*) into v_count from public.contractor_receiving_dispatch_deliveries d
    where d.work_order_id=w.id and d.assignment_version=w.contractor_assignment_version and d.recipient_profile_id=w.contractor_id
      and not exists(select 1 from public.contractor_receiving_dispatch_deliveries child where child.parent_delivery_id=d.id);
  if v_count>1 then raise exception 'DELIVERY_INTEGRITY_REVIEW' using errcode='PT409'; end if;
  select d.* into v from public.contractor_receiving_dispatch_deliveries d
    where d.work_order_id=w.id and d.assignment_version=w.contractor_assignment_version and d.recipient_profile_id=w.contractor_id
      and not exists(select 1 from public.contractor_receiving_dispatch_deliveries child where child.parent_delivery_id=d.id)
    order by d.created_at desc,d.id desc limit 1;
  if found then return jsonb_build_object('kind','current','delivery',public.receiving_dispatch_safe_projection(v)); end if;
  select closeout_enforced_at into v_cutover from public.receiving_dispatch_control where singleton;
  return jsonb_build_object('kind',case when greatest(w.created_at,w.contractor_assignment_started_at)>=v_cutover then 'missing_intent' else 'legacy_untracked' end,'delivery',null);
end;
$$;

create function public.list_receiving_dispatch_unresolved_v1(p_state text default null,p_search text default '',p_cursor jsonb default null,p_limit integer default 25)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_search text:=btrim(coalesce(p_search,'')); v_at timestamptz; v_id uuid; v_snapshot timestamptz:=clock_timestamp();
  v_items jsonb; v_more boolean; v_cursor jsonb;
begin
  perform public.require_work_order_assignment_actor();
  if p_limit is null or p_limit<1 or p_limit>50 or length(v_search)>100 or (p_state is not null and p_state not in ('unknown','not_deliverable','failed')) then
    raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  if p_cursor is not null then
    begin
      if jsonb_typeof(p_cursor)<>'object' or p_cursor-array['version','state','search','createdAt','id','snapshotAt']<>'{}'::jsonb
        or not (p_cursor ?& array['version','state','search','createdAt','id','snapshotAt'])
        or p_cursor->>'version' is distinct from '1' or p_cursor->>'state' is distinct from p_state
        or p_cursor->>'search' is distinct from v_search then raise exception 'bad cursor'; end if;
      v_at:=(p_cursor->>'createdAt')::timestamptz;v_id:=(p_cursor->>'id')::uuid;v_snapshot:=(p_cursor->>'snapshotAt')::timestamptz;
      if v_at is null or v_id is null or v_snapshot is null or not isfinite(v_at) or not isfinite(v_snapshot)
        or v_at>v_snapshot or v_snapshot>clock_timestamp() then raise exception 'bad cursor'; end if;
    exception when others then raise exception 'INVALID_CURSOR' using errcode='PT422'; end;
  end if;
  with candidates as (
    select d.* from public.contractor_receiving_dispatch_deliveries d
    join public.work_orders w on w.id=d.work_order_id and w.deleted_at is null
      and w.contractor_id=d.recipient_profile_id and w.contractor_assignment_version=d.assignment_version
    where d.status in ('unknown','not_deliverable','failed') and public.receiving_dispatch_actionable(d)
      and (p_state is null or d.status=p_state) and (v_search='' or strpos(lower(d.work_order_id),lower(v_search))>0)
      and d.created_at<=v_snapshot and (v_at is null or (d.created_at,d.id)<(v_at,v_id))
      and not exists(select 1 from public.receiving_dispatch_operations o where o.delivery_id=d.id)
      and not exists(select 1 from public.contractor_receiving_dispatch_deliveries child where child.parent_delivery_id=d.id)
    order by d.created_at desc,d.id desc limit p_limit+1
  ), page as (select * from candidates order by created_at desc,id desc limit p_limit)
  select coalesce((select jsonb_agg(public.receiving_dispatch_safe_projection(p) order by p.created_at desc,p.id desc) from page p),'[]'::jsonb),
    (select count(*)>p_limit from candidates),
    (select jsonb_build_object('version',1,'state',p_state,'search',v_search,'createdAt',p.created_at,'id',p.id,'snapshotAt',v_snapshot)
      from page p order by p.created_at,p.id limit 1)
  into v_items,v_more,v_cursor;
  return jsonb_build_object('items',v_items,'hasMore',v_more,'nextCursor',case when v_more then v_cursor else null end);
end;
$$;

create function public.get_receiving_dispatch_history_v1(p_delivery_id uuid,p_cursor jsonb default null,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_root uuid;v_at timestamptz;v_id text;v_snapshot timestamptz:=clock_timestamp();v_items jsonb;v_more boolean;v_cursor jsonb;
begin
  perform public.require_work_order_assignment_actor();
  if p_delivery_id is null or p_limit is null or p_limit<1 or p_limit>50 then raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  select coalesce(root_delivery_id,id) into v_root from public.contractor_receiving_dispatch_deliveries where id=p_delivery_id;
  if not found then raise exception 'DELIVERY_NOT_FOUND' using errcode='PT404'; end if;
  if p_cursor is not null then
    begin
      if jsonb_typeof(p_cursor)<>'object' or p_cursor-array['version','deliveryId','createdAt','id','snapshotAt']<>'{}'::jsonb
        or not (p_cursor ?& array['version','deliveryId','createdAt','id','snapshotAt'])
        or p_cursor->>'version' is distinct from '1' or p_cursor->>'deliveryId' is distinct from p_delivery_id::text then raise exception 'bad cursor'; end if;
      v_at:=(p_cursor->>'createdAt')::timestamptz;v_id:=p_cursor->>'id';v_snapshot:=(p_cursor->>'snapshotAt')::timestamptz;
      if v_at is null or v_id is null
        or v_id !~* '^(delivery|attempt|operation):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or v_snapshot is null or not isfinite(v_at) or not isfinite(v_snapshot)
        or v_at>v_snapshot or v_snapshot>clock_timestamp() then raise exception 'bad cursor'; end if;
    exception when others then raise exception 'INVALID_CURSOR' using errcode='PT422'; end;
  end if;
  with family as (select d.* from public.contractor_receiving_dispatch_deliveries d where d.id=v_root or d.root_delivery_id=v_root),
  history as (
    select 'delivery:'||d.id as id,'delivery'::text as kind,d.status as state,d.created_at,d.completed_at,null::text as reason,0 as sequence,
      public.receiving_dispatch_safe_code(d.last_error_code) as code from family d
    union all select 'attempt:'||e.id,'attempt',e.state,e.created_at,
      case when e.phase in ('completed','claim_expired') then e.created_at else null end,null,e.sequence,public.receiving_dispatch_safe_code(e.error_code)
      from public.receiving_dispatch_attempt_events e join family d on d.id=e.delivery_id
    union all select 'operation:'||o.operation_id,case when o.action='resend' then 'resend' else 'manual_resolution' end,
      case when o.action='resend' then 'pending' else 'manually_resolved' end,o.created_at,o.created_at,o.reason,0,null::text
      from public.receiving_dispatch_operations o join family d on d.id=o.delivery_id
  ), candidates as (
    select * from history where created_at<=v_snapshot and (v_at is null or (created_at,id)<(v_at,v_id))
    order by created_at desc,id desc limit p_limit+1
  ), page as (select * from candidates order by created_at desc,id desc limit p_limit)
  select coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'state',p.state,'createdAt',p.created_at,
      'completedAt',p.completed_at,'reason',p.reason,'sequence',p.sequence,'code',p.code) order by p.created_at desc,p.id desc) from page p),'[]'::jsonb),
    (select count(*)>p_limit from candidates),
    (select jsonb_build_object('version',1,'deliveryId',p_delivery_id,'createdAt',p.created_at,'id',p.id,'snapshotAt',v_snapshot)
      from page p order by p.created_at,p.id limit 1)
  into v_items,v_more,v_cursor;
  return jsonb_build_object('items',v_items,'hasMore',v_more,'nextCursor',case when v_more then v_cursor else null end);
end;
$$;

create function public.receiving_dispatch_staff_action(p_delivery_id uuid,p_assignment_version integer,p_operation_id uuid,p_reason text,p_action text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_actor public.profiles%rowtype; v public.contractor_receiving_dispatch_deliveries%rowtype;
  w public.work_orders%rowtype;p public.profiles%rowtype;o public.receiving_dispatch_operations%rowtype;
  v_reason text:=btrim(p_reason);v_child uuid:=gen_random_uuid();
begin
  v_actor:=public.require_work_order_assignment_actor();
  if v_reason is null or v_reason='' then raise exception 'REASON_REQUIRED' using errcode='PT422'; end if;
  if length(v_reason)>500 or p_operation_id is null or p_delivery_id is null or p_assignment_version is null
    or p_assignment_version<1 or p_action not in ('resend','manual_resolution') then raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  perform pg_advisory_xact_lock(hashtextextended('receiving-dispatch-operation:'||p_operation_id::text,0));
  select * into o from public.receiving_dispatch_operations where operation_id=p_operation_id;
  if found then
    if o.delivery_id is distinct from p_delivery_id or o.assignment_version is distinct from p_assignment_version
      or o.actor_id is distinct from v_actor.id or o.reason is distinct from v_reason or o.action is distinct from p_action then
      raise exception 'OPERATION_REUSED' using errcode='PT409'; end if;
    return jsonb_build_object('status',case when p_action='resend' then 'queued' else 'manually_resolved' end,
      'deliveryId',coalesce(o.child_delivery_id,o.delivery_id),'operationId',p_operation_id,'replayed',true);
  end if;
  select * into v from public.contractor_receiving_dispatch_deliveries where id=p_delivery_id;
  if not found then raise exception 'DELIVERY_NOT_FOUND' using errcode='PT404'; end if;
  select * into w from public.work_orders where id=v.work_order_id for update;
  select * into v from public.contractor_receiving_dispatch_deliveries where id=p_delivery_id for update;
  -- Match the authoritative assignment command's profile share lock: an
  -- accepted staff operation retains active actor eligibility until commit.
  perform 1 from public.profiles where id=v_actor.id for share;
  v_actor:=public.require_work_order_assignment_actor();
  if w.contractor_assignment_version is distinct from p_assignment_version or v.assignment_version is distinct from p_assignment_version then
    raise exception 'STALE_ASSIGNMENT' using errcode='PT409'; end if;
  if w.id is null or w.deleted_at is not null or w.contractor_id is distinct from v.recipient_profile_id then
    raise exception 'DELIVERY_NOT_CURRENT' using errcode='PT409'; end if;
  -- Manual contact can resolve an unavailable email/inactive account, but it
  -- still belongs to the same assignment-time profile/company identity.
  select * into p from public.profiles where id=v.recipient_profile_id for share;
  if not found or p.contractor_organization_id is distinct from v.recipient_company_id then
    raise exception 'DELIVERY_NOT_CURRENT' using errcode='PT409'; end if;
  if v.status='sent' then raise exception 'DELIVERY_ALREADY_SENT' using errcode='PT409'; end if;
  if v.status='superseded' then raise exception 'DELIVERY_SUPERSEDED' using errcode='PT409'; end if;
  if not public.receiving_dispatch_actionable(v) or exists(select 1 from public.receiving_dispatch_operations where delivery_id=v.id)
    or exists(select 1 from public.contractor_receiving_dispatch_deliveries where parent_delivery_id=v.id) then
    raise exception 'DELIVERY_NOT_ACTIONABLE' using errcode='PT409'; end if;
  if p_action='resend' then
    begin perform public.require_assignable_contractor(v.recipient_profile_id);
      exception when sqlstate '22023' then raise exception 'RECIPIENT_NOT_DELIVERABLE' using errcode='PT409'; end;
    if not public.receiving_dispatch_recipient_deliverable(v) then raise exception 'RECIPIENT_NOT_DELIVERABLE' using errcode='PT409'; end if;
    perform public.receiving_dispatch_cap('contractor_receiving_dispatch_deliveries',v_child);
    insert into public.contractor_receiving_dispatch_deliveries(id,work_order_id,assignment_version,event_type,recipient_profile_id,
      recipient_company_id,recipient_email_snapshot,recipient_name_snapshot,parent_delivery_id,root_delivery_id,created_by)
    values(v_child,v.work_order_id,v.assignment_version,'explicit_resend',v.recipient_profile_id,v.recipient_company_id,btrim(p.email),
      coalesce(nullif(btrim(p.name),''),nullif(btrim(p.company),''),'Contractor'),v.id,coalesce(v.root_delivery_id,v.id),v_actor.id);
  else v_child:=null;
  end if;
  perform public.receiving_dispatch_cap('receiving_dispatch_operations',p_operation_id);
  insert into public.receiving_dispatch_operations(operation_id,delivery_id,action,child_delivery_id,assignment_version,actor_id,reason)
    values(p_operation_id,v.id,p_action,v_child,v.assignment_version,v_actor.id,v_reason);
  perform public.receiving_dispatch_clear_caps();
  return jsonb_build_object('status',case when p_action='resend' then 'queued' else 'manually_resolved' end,
    'deliveryId',coalesce(v_child,v.id),'operationId',p_operation_id,'replayed',false);
end;
$$;
create function public.request_receiving_dispatch_resend_v1(p_delivery_id uuid,p_assignment_version integer,p_operation_id uuid,p_reason text)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$
  select public.receiving_dispatch_staff_action(p_delivery_id,p_assignment_version,p_operation_id,p_reason,'resend');
$$;
create function public.resolve_receiving_dispatch_out_of_band_v1(p_delivery_id uuid,p_assignment_version integer,p_operation_id uuid,p_reason text)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$
  select public.receiving_dispatch_staff_action(p_delivery_id,p_assignment_version,p_operation_id,p_reason,'manual_resolution');
$$;

revoke all on function public.receiving_dispatch_cap(text,uuid),public.receiving_dispatch_clear_caps(),public.guard_receiving_dispatch_records(),
  public.require_receiving_dispatch_service(),public.receiving_dispatch_retry_pending(public.contractor_receiving_dispatch_deliveries),
  public.receiving_dispatch_actionable(public.contractor_receiving_dispatch_deliveries),public.receiving_dispatch_recipient_deliverable(public.contractor_receiving_dispatch_deliveries),
  public.receiving_dispatch_safe_code(text),
  public.receiving_dispatch_safe_projection(public.contractor_receiving_dispatch_deliveries),public.queue_receiving_contractor_dispatch(),
  public.record_receiving_dispatch_attempt(public.contractor_receiving_dispatch_deliveries,text,text,text),
  public.receiving_dispatch_staff_action(uuid,integer,uuid,text,text),public.resolve_receiving_dispatch_delivery_v1(uuid,text,text,uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.get_receiving_dispatch_current_v1(text,integer),public.list_receiving_dispatch_unresolved_v1(text,text,jsonb,integer),
  public.get_receiving_dispatch_history_v1(uuid,jsonb,integer),public.request_receiving_dispatch_resend_v1(uuid,integer,uuid,text),
  public.resolve_receiving_dispatch_out_of_band_v1(uuid,integer,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.get_receiving_dispatch_current_v1(text,integer),public.list_receiving_dispatch_unresolved_v1(text,text,jsonb,integer),
  public.get_receiving_dispatch_history_v1(uuid,jsonb,integer),public.request_receiving_dispatch_resend_v1(uuid,integer,uuid,text),
  public.resolve_receiving_dispatch_out_of_band_v1(uuid,integer,uuid,text) to authenticated;
revoke all on function public.claim_receiving_dispatch_deliveries_v1(integer,integer,uuid),public.start_receiving_dispatch_delivery_v1(uuid,uuid),
  public.prepare_receiving_dispatch_send_v1(uuid,uuid),public.get_receiving_dispatch_message_v1(uuid,uuid),
  public.complete_receiving_dispatch_delivery_v1(uuid,uuid,text,text,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.claim_receiving_dispatch_deliveries_v1(integer,integer,uuid),public.start_receiving_dispatch_delivery_v1(uuid,uuid),
  public.prepare_receiving_dispatch_send_v1(uuid,uuid),public.get_receiving_dispatch_message_v1(uuid,uuid),
  public.complete_receiving_dispatch_delivery_v1(uuid,uuid,text,text,integer,text) to service_role;

commit;
