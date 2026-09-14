-- Batch 3B expansion. Existing unversioned callers retain their old business
-- behavior until 0136. Only the versioned commands open the private source
-- capability and create delivery intent. Pause review/hold actions and drain
-- during candidate cutover; never overlap old direct sends with this worker.
begin;

create table public.financial_notification_control (
  singleton boolean primary key default true check(singleton),
  contracted boolean not null default false,
  expanded_at timestamptz not null default clock_timestamp(),
  contracted_at timestamptz
);
insert into public.financial_notification_control default values;
create table public.financial_notification_events (
  id uuid primary key default gen_random_uuid(),
  event_sequence bigint generated always as identity unique,
  source_kind text not null check(source_kind in ('review_activity','hold_event')),
  source_id uuid not null,
  family text not null check(family in ('invoice_rejected','invoice_rejection_retracted','payment_hold_placed','payment_hold_released')),
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  work_order_id text references public.work_orders(id) on delete restrict,
  contractor_id uuid references public.profiles(id) on delete restrict,
  contractor_company_id uuid references public.organizations(id) on delete restrict,
  creator_id uuid references public.profiles(id) on delete restrict,
  assignment_version integer,
  review_revision integer,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  operation_id uuid not null,
  message_context jsonb not null check(jsonb_typeof(message_context)='object' and octet_length(message_context::text)<=16384),
  created_at timestamptz not null default clock_timestamp(),
  unique(source_kind,source_id),
  check((source_kind='review_activity')=(family in ('invoice_rejected','invoice_rejection_retracted')))
);
create index financial_notification_event_invoice on public.financial_notification_events(invoice_id,created_at desc,id desc);
create table public.financial_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.financial_notification_events(id) on delete restrict,
  recipient_profile_id uuid references public.profiles(id) on delete restrict,
  recipient_company_id uuid references public.organizations(id) on delete restrict,
  recipient_kind text not null check(recipient_kind in ('contractor','creator','handoff','missing')),
  recipient_email_snapshot text check(length(recipient_email_snapshot)<=320),
  parent_delivery_id uuid references public.financial_notification_deliveries(id) on delete restrict,
  root_delivery_id uuid references public.financial_notification_deliveries(id) on delete restrict,
  state text not null default 'pending' check(state in ('pending','claimed','sending','sent','failed','unknown','not_deliverable','superseded')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  claim_token uuid,
  claim_expires_at timestamptz,
  send_started_at timestamptz,
  completed_at timestamptz,
  last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,80}$'),
  provider_status integer check(provider_status between 100 and 599),
  provider_reference text check(length(provider_reference)<=200),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check((recipient_kind='missing')=(recipient_profile_id is null)),
  check((parent_delivery_id is null)=(root_delivery_id is null)),
  check(parent_delivery_id is null or (parent_delivery_id<>id and root_delivery_id<>id)),
  check((state in ('claimed','sending'))=(claim_token is not null and claim_expires_at is not null)),
  check(state not in ('pending','failed') or send_started_at is null)
);
create unique index financial_notification_original_recipient on public.financial_notification_deliveries(event_id,recipient_profile_id) nulls not distinct where parent_delivery_id is null;
create unique index financial_notification_child_recipient on public.financial_notification_deliveries(parent_delivery_id,recipient_profile_id) nulls not distinct where parent_delivery_id is not null;
create index financial_notification_claim on public.financial_notification_deliveries(next_attempt_at,created_at,id) where state in ('pending','failed');
create index financial_notification_expired on public.financial_notification_deliveries(claim_expires_at,id) where state in ('claimed','sending');
create index financial_notification_unresolved on public.financial_notification_deliveries(created_at desc,id desc) where state in ('unknown','not_deliverable','failed');
create index financial_notification_event_deliveries on public.financial_notification_deliveries(event_id,created_at desc,id desc);
create table public.financial_notification_attempt_events (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.financial_notification_deliveries(id) on delete restrict,
  sequence integer not null check(sequence>0),
  phase text not null check(phase in ('claimed','sending','completed','claim_expired')),
  state text not null check(state in ('pending','claimed','sending','sent','failed','unknown','not_deliverable','superseded')),
  claim_token uuid not null,
  code text check(code is null or code ~ '^[A-Z0-9_]{1,80}$'),
  provider_status integer check(provider_status between 100 and 599),
  provider_reference text check(length(provider_reference)<=200),
  retry_after_seconds integer check(retry_after_seconds between 0 and 86400),
  created_at timestamptz not null default clock_timestamp(),
  unique(delivery_id,sequence,phase),
  unique(delivery_id,claim_token,phase)
);
create index financial_notification_attempt_history on public.financial_notification_attempt_events(delivery_id,created_at desc,id desc);
create table public.financial_notification_operations (
  operation_id uuid primary key,
  event_id uuid not null references public.financial_notification_events(id) on delete restrict,
  delivery_id uuid not null unique references public.financial_notification_deliveries(id) on delete restrict,
  action text not null check(action in ('resend','manual_resolution')),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  reason text not null check(reason=btrim(reason) and length(reason) between 1 and 500),
  created_at timestamptz not null default clock_timestamp()
);
create table public.financial_notification_mutation_operations (
  operation_id uuid primary key,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  command_kind text not null,
  payload jsonb not null,
  result jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create table public.financial_notification_record_guards (
  transaction_id bigint not null, relation_name text not null, target_id uuid not null,
  primary key(transaction_id,relation_name,target_id)
);
create table public.financial_notification_source_guards (
  transaction_id bigint not null,invoice_id uuid not null,actor_id uuid not null,operation_id uuid not null,
  primary key(transaction_id,invoice_id)
);
-- Current source identity, not a second event ledger. The source trigger also
-- advances this head for old callers during expansion, before gated queueing.
-- Existing history is untouched; only subsequent committed sources populate it.
create table public.financial_notification_hold_heads (
  invoice_id uuid primary key references public.invoices(id) on delete restrict,
  source_id uuid not null references public.contractor_invoice_payment_hold_events(id) on delete restrict
);
alter table public.financial_notification_control enable row level security;
alter table public.financial_notification_events enable row level security;
alter table public.financial_notification_deliveries enable row level security;
alter table public.financial_notification_attempt_events enable row level security;
alter table public.financial_notification_operations enable row level security;
alter table public.financial_notification_mutation_operations enable row level security;
alter table public.financial_notification_record_guards enable row level security;
alter table public.financial_notification_source_guards enable row level security;
alter table public.financial_notification_hold_heads enable row level security;
revoke all on public.financial_notification_control,public.financial_notification_events,public.financial_notification_deliveries,
  public.financial_notification_attempt_events,public.financial_notification_operations,public.financial_notification_mutation_operations,
  public.financial_notification_record_guards,public.financial_notification_source_guards,public.financial_notification_hold_heads from public,anon,authenticated,service_role;

create function public.financial_notification_cap(p_relation text,p_id uuid)
returns void language sql security definer set search_path=pg_catalog,public as $$
  insert into public.financial_notification_record_guards values(txid_current(),p_relation,p_id) on conflict do nothing;
$$;
create function public.financial_notification_clear_caps()
returns void language sql security definer set search_path=pg_catalog,public as $$
  delete from public.financial_notification_record_guards where transaction_id=txid_current();
$$;
create function public.guard_financial_notification_records()
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
        or v_old->>'state' in ('sent','unknown','not_deliverable','superseded') then raise exception 'NOTIFICATION_HISTORY_IMMUTABLE' using errcode='42501'; end if;
    else raise exception 'NOTIFICATION_HISTORY_IMMUTABLE' using errcode='42501'; end if;
  end if;
  return new;
end;
$$;
create trigger financial_notification_event_guard before insert or update or delete on public.financial_notification_events for each row execute function public.guard_financial_notification_records();
create trigger financial_notification_delivery_guard before insert or update or delete on public.financial_notification_deliveries for each row execute function public.guard_financial_notification_records();
create trigger financial_notification_attempt_guard before insert or update or delete on public.financial_notification_attempt_events for each row execute function public.guard_financial_notification_records();
create trigger financial_notification_operation_guard before insert or update or delete on public.financial_notification_operations for each row execute function public.guard_financial_notification_records();
create trigger financial_notification_mutation_guard before insert or update or delete on public.financial_notification_mutation_operations for each row execute function public.guard_financial_notification_records();
create trigger financial_notification_head_guard before insert or update or delete on public.financial_notification_hold_heads for each row execute function public.guard_financial_notification_records();

create function public.require_financial_notification_service()
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if current_setting('role')<>'service_role' or auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode='42501'; end if;
end;
$$;
create function public.require_financial_notification_actor(p_family text,p_action boolean default false,p_actor_id uuid default null)
returns public.profiles language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.profiles%rowtype;v_id uuid:=coalesce(p_actor_id,auth.uid());
begin
  if p_actor_id is not null then perform public.require_financial_notification_service();
    if auth.uid() is not null and auth.uid()<>p_actor_id then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  end if;
  select * into p from public.profiles where id=v_id and active=true and role in ('manager','dispatcher','back_office') for share;
  if not found or (p_family in ('invoice_rejected','invoice_rejection_retracted') and public.profile_has_staff_permission(p.id,'invoice_controller'))
    or (p_action and p_family='payment_hold_released' and not public.profile_has_staff_permission(p.id,'quickbooks_handoff')) then
    raise exception 'FORBIDDEN' using errcode='42501'; end if;
  return p;
end;
$$;
create function public.financial_notification_email_valid(p_email text)
returns boolean language sql immutable set search_path=pg_catalog,public as $$
  select length(btrim(coalesce(p_email,''))) between 3 and 320 and btrim(p_email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
$$;
-- Identity selection follows the existing two notification families. Email
-- addresses are reloaded only for these identities, never supplied by clients.
create function public.financial_notification_recipients(p_event public.financial_notification_events)
returns table(profile_id uuid,company_id uuid,kind text,email text)
language sql stable security definer set search_path=pg_catalog,public as $$
  with candidates as (
    select p.id,p.contractor_organization_id as company_id,'contractor'::text as kind,lower(btrim(p.email)) as email,0 as rank
    from public.profiles p where p.id=p_event.contractor_id and p_event.source_kind='review_activity'
      and p.role='contractor' and p.active and p.contractor_organization_id is not distinct from p_event.contractor_company_id
      and public.contractor_account_id_for_profile(p.id)=p.id
    union all
    select p.id,p.contractor_organization_id,'creator',lower(btrim(p.email)),1
    from public.profiles p join public.profiles c on c.id=p_event.contractor_id
    where p_event.source_kind='review_activity' and p.id=p_event.creator_id and p.id<>p_event.contractor_id
      and c.active and c.role='contractor' and public.contractor_account_id_for_profile(c.id)=c.id
      and p.role='contractor' and p.active and p.contractor_organization_id=p_event.contractor_company_id
      and c.contractor_organization_id=p_event.contractor_company_id
      and (p.contractor_access_level='company_admin' or (p.contractor_access_level='invoice' and exists(
        select 1 from public.contractor_technicians t where t.profile_id=p.id and t.contractor_id=c.id and t.is_active)))
    union all
    select p.id,null,'handoff',lower(btrim(p.email)),0
    from public.profiles p where p_event.source_kind='hold_event' and public.profile_has_staff_permission(p.id,'quickbooks_handoff')
  ), chosen as (
    select distinct on (case when public.financial_notification_email_valid(email) then email else id::text end) *
    from candidates order by case when public.financial_notification_email_valid(email) then email else id::text end,rank,id
  ) select id,company_id,kind,email from chosen order by rank,id;
$$;
create function public.financial_notification_recipient_valid(p_delivery public.financial_notification_deliveries)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.financial_notification_events e, lateral public.financial_notification_recipients(e) r
    where e.id=p_delivery.event_id and r.profile_id=p_delivery.recipient_profile_id
      and r.company_id is not distinct from p_delivery.recipient_company_id and r.kind=p_delivery.recipient_kind
      and public.financial_notification_email_valid(r.email));
$$;
create function public.financial_notification_event_current(p_event public.financial_notification_events)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.invoices i left join public.work_orders w on w.id=i.work_order_id
    where i.id=p_event.invoice_id and i.invoice_type='contractor' and i.deleted_at is null
      and (case when p_event.source_kind='review_activity' then coalesce(i.contractor_id,i.created_by) else i.contractor_id end) is not distinct from p_event.contractor_id
      and i.work_order_id is not distinct from p_event.work_order_id
      and ((p_event.source_kind='hold_event' and exists(select 1 from public.contractor_invoice_payment_hold_events h
        where h.id=p_event.source_id and h.invoice_id=i.id and ('payment_hold_'||h.action)=p_event.family and h.actor_id=p_event.actor_id))
        or (p_event.source_kind='review_activity' and i.review_revision=p_event.review_revision
        and ((p_event.family='invoice_rejected' and i.state='rejected') or (p_event.family='invoice_rejection_retracted' and i.state='approved'))
        and exists(select 1 from public.activities a where a.id=p_event.source_id and a.event_key=p_event.family and a.deleted_at is null
          and a.event_data->>'invoiceId'=i.id::text and a.event_data->>'revision'=p_event.review_revision::text and a.author_id=p_event.actor_id))));
$$;
create function public.financial_notification_latest_hold_source(p_invoice_id uuid)
returns uuid language sql stable security definer set search_path=pg_catalog,public as $$
  select coalesce((select head.source_id from public.financial_notification_hold_heads head where head.invoice_id=p_invoice_id),
    (select h.id from public.contractor_invoice_payment_hold_events h where h.invoice_id=p_invoice_id order by h.created_at desc,h.id desc limit 1));
$$;
create function public.financial_notification_retry_pending(p_delivery public.financial_notification_deliveries)
returns boolean language sql immutable set search_path=pg_catalog,public as $$
  select p_delivery.state='failed' and p_delivery.attempt_count<3 and p_delivery.last_error_code in ('GRAPH_RATE_LIMITED','GRAPH_AUTH_RETRYABLE');
$$;
create function public.financial_notification_actionable(p_delivery public.financial_notification_deliveries)
returns boolean language sql immutable set search_path=pg_catalog,public as $$
  select p_delivery.state in ('unknown','not_deliverable') or (p_delivery.state='failed' and not coalesce(public.financial_notification_retry_pending(p_delivery),false));
$$;
create function public.financial_notification_add_delivery(p_event_id uuid,p_profile_id uuid,p_company_id uuid,p_kind text,p_email text,p_parent uuid default null,p_root uuid default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid:=gen_random_uuid();v_valid boolean:=coalesce(public.financial_notification_email_valid(p_email),false);
begin
  perform public.financial_notification_cap('financial_notification_deliveries',v_id);
  insert into public.financial_notification_deliveries(id,event_id,recipient_profile_id,recipient_company_id,recipient_kind,recipient_email_snapshot,parent_delivery_id,root_delivery_id,state,last_error_code)
    values(v_id,p_event_id,p_profile_id,p_company_id,p_kind,case when length(p_email)<=320 then p_email else null end,p_parent,p_root,
      case when v_valid and p_profile_id is not null then 'pending' else 'not_deliverable' end,
      case when p_profile_id is null then 'NO_ELIGIBLE_RECIPIENT' when not v_valid then 'RECIPIENT_NOT_DELIVERABLE' else null end);
  return v_id;
end;
$$;

create function public.capture_financial_notification_source()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_invoice uuid;v_actor uuid;v_operation uuid;v_family text;v_id uuid:=gen_random_uuid();v_count int:=0;
  i public.invoices%rowtype;w public.work_orders%rowtype;c public.profiles%rowtype;e public.financial_notification_events%rowtype;r record;v_context jsonb;
begin
  if tg_table_name='activities' then
    if new.event_key not in ('invoice_rejected','invoice_rejection_retracted') then return new; end if;
    v_invoice:=(new.event_data->>'invoiceId')::uuid;v_actor:=new.author_id;v_family:=new.event_key;
  else v_invoice:=new.invoice_id;v_actor:=new.actor_id;v_family:=case when new.action='placed' then 'payment_hold_placed' else 'payment_hold_released' end;
    perform public.financial_notification_cap('financial_notification_hold_heads',v_invoice);
    insert into public.financial_notification_hold_heads(invoice_id,source_id) values(v_invoice,new.id)
      on conflict(invoice_id) do update set source_id=excluded.source_id;
  end if;
  select operation_id into v_operation from public.financial_notification_source_guards
    where transaction_id=txid_current() and invoice_id=v_invoice and actor_id=v_actor;
  if not found then perform public.financial_notification_clear_caps();return new; end if;
  select * into strict i from public.invoices where id=v_invoice;
  select * into w from public.work_orders where id=i.work_order_id;
  select * into c from public.profiles where id=case when tg_table_name='activities' then coalesce(i.contractor_id,i.created_by) else i.contractor_id end;
  v_context:=jsonb_build_object('num',i.num,'workOrderId',i.work_order_id,'externalWorkOrderId',coalesce(w.duplicate_root_work_order_id,w.id),
    'storeNumber',i.store_number,'contractorName',coalesce(c.company,c.name),'total',i.total,
    'actorName',(select name from public.profiles where id=v_actor));
  perform public.financial_notification_cap('financial_notification_events',v_id);
  insert into public.financial_notification_events(id,source_kind,source_id,family,invoice_id,work_order_id,contractor_id,contractor_company_id,
    creator_id,assignment_version,review_revision,actor_id,operation_id,message_context)
  values(v_id,case when tg_table_name='activities' then 'review_activity' else 'hold_event' end,new.id,v_family,i.id,i.work_order_id,c.id,
    c.contractor_organization_id,i.created_by,w.contractor_assignment_version,case when tg_table_name='activities' then i.review_revision else null end,
    v_actor,v_operation,v_context) returning * into e;
  for r in select * from public.financial_notification_recipients(e) loop
    perform public.financial_notification_add_delivery(e.id,r.profile_id,r.company_id,r.kind,r.email);v_count:=v_count+1;
  end loop;
  if v_count=0 then perform public.financial_notification_add_delivery(e.id,null,null,'missing',null); end if;
  return new;
end;
$$;
create trigger financial_notification_review_source after insert on public.activities for each row execute function public.capture_financial_notification_source();
create trigger financial_notification_hold_source after insert on public.contractor_invoice_payment_hold_events for each row execute function public.capture_financial_notification_source();

-- Reserve exact review evidence while retaining acknowledgement-only updates
-- made by the existing resubmission/retraction/attention commands.
create function public.guard_financial_notification_source()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_invoice uuid;v_actor uuid;v_owned boolean;v_contracted boolean;v_new jsonb;v_old jsonb;
begin
  if public.lifecycle_is_owner_maintenance() then return case when tg_op='DELETE' then old else new end; end if;
  select contracted into v_contracted from public.financial_notification_control where singleton;
  if tg_table_name='activities' then
    v_owned:=(tg_op<>'DELETE' and new.event_key in ('invoice_rejected','invoice_rejection_retracted'))
      or (tg_op<>'INSERT' and old.event_key in ('invoice_rejected','invoice_rejection_retracted'));
    if not coalesce(v_owned,false) then return case when tg_op='DELETE' then old else new end; end if;
    v_new:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
    v_invoice:=(v_new->'event_data'->>'invoiceId')::uuid;v_actor:=(v_new->>'author_id')::uuid;
    if tg_op='UPDATE' then
      v_old:=to_jsonb(old);
      if v_new-array['requires_contractor_attention','contractor_attention_acknowledged_at','contractor_attention_acknowledged_by','updated_at']
        is not distinct from v_old-array['requires_contractor_attention','contractor_attention_acknowledged_at','contractor_attention_acknowledged_by','updated_at'] then return new; end if;
    end if;
    if tg_op<>'INSERT' and (v_contracted or exists(select 1 from public.financial_notification_events e where e.source_kind='review_activity' and e.source_id=(v_new->>'id')::uuid)) then
      raise exception 'NOTIFICATION_SOURCE_IMMUTABLE' using errcode='42501'; end if;
    if tg_op='INSERT' and v_contracted and not public.invoice_financial_guard_exists(v_invoice,new.work_order_id,'event',new.event_key) then
      raise exception 'NOTIFICATION_SOURCE_COMMAND_REQUIRED' using errcode='42501'; end if;
  else
    v_new:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
    v_invoice:=(v_new->>'invoice_id')::uuid;
    if v_contracted and not exists(select 1 from public.financial_notification_source_guards g where g.transaction_id=txid_current() and g.invoice_id=v_invoice) then
      raise exception 'NOTIFICATION_SOURCE_COMMAND_REQUIRED' using errcode='42501'; end if;
    if tg_table_name='contractor_invoice_payment_hold_events' and tg_op<>'INSERT' and (v_contracted or exists(
      select 1 from public.financial_notification_events e where e.source_kind='hold_event' and e.source_id=(v_new->>'id')::uuid)) then
      raise exception 'NOTIFICATION_SOURCE_IMMUTABLE' using errcode='42501'; end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
create trigger financial_notification_review_evidence_guard before insert or update or delete on public.activities for each row execute function public.guard_financial_notification_source();
create trigger financial_notification_hold_evidence_guard before insert or update or delete on public.contractor_invoice_payment_hold_events for each row execute function public.guard_financial_notification_source();
create trigger financial_notification_current_hold_guard before insert or update or delete on public.contractor_invoice_payment_holds for each row execute function public.guard_financial_notification_source();

-- Private compatibility cores retain all existing financial/business rules.
alter function public.review_contractor_invoice(uuid,text,text) rename to review_contractor_invoice_pre_notification;
alter function public.retract_contractor_invoice_rejection(uuid) rename to retract_contractor_invoice_rejection_pre_notification;
alter function public.place_contractor_invoice_payment_hold(uuid,uuid,text) rename to place_contractor_invoice_payment_hold_pre_notification;
alter function public.release_contractor_invoice_payment_hold(uuid,uuid,text) rename to release_contractor_invoice_payment_hold_pre_notification;
alter function public.review_contractor_invoice_pre_notification(uuid,text,text) set search_path=pg_catalog,public;
alter function public.retract_contractor_invoice_rejection_pre_notification(uuid) set search_path=pg_catalog,public;
alter function public.place_contractor_invoice_payment_hold_pre_notification(uuid,uuid,text) set search_path=pg_catalog,public;
alter function public.release_contractor_invoice_payment_hold_pre_notification(uuid,uuid,text) set search_path=pg_catalog,public;

create function public.execute_financial_notification_mutation(p_invoice_id uuid,p_kind text,p_action text,p_reason text,p_operation_id uuid,p_expected_revision integer,p_expected_source_event_id uuid,p_actor_id uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.profiles%rowtype;i public.invoices%rowtype;v_work text;v_family text;v_payload jsonb;o public.financial_notification_mutation_operations%rowtype;
  v_result jsonb;v_notifications jsonb;v_latest uuid;v_reason text:=nullif(btrim(p_reason),'');
begin
  v_family:=case when p_kind='review' then 'invoice_rejected' when p_kind='retraction' then 'invoice_rejection_retracted'
    when p_action='place' then 'payment_hold_placed' else 'payment_hold_released' end;
  a:=public.require_financial_notification_actor(v_family,true,p_actor_id);
  if p_invoice_id is null or p_operation_id is null or p_kind not in ('review','retraction','hold')
    or (p_kind='review' and (p_action not in ('approve','reject') or p_expected_revision is null or p_expected_revision<1))
    or (p_kind='retraction' and (p_expected_revision is null or p_expected_revision<1))
    or (p_kind='hold' and p_action not in ('place','release'))
    or (p_kind='hold' and v_reason is not null and length(v_reason)>500)
    or ((p_kind='hold' or (p_kind='review' and p_action='reject')) and v_reason is null) then
    raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  v_payload:=jsonb_build_object('invoiceId',p_invoice_id,'kind',p_kind,'action',p_action,'reason',v_reason,'revision',p_expected_revision,'sourceEventId',p_expected_source_event_id);
  perform pg_advisory_xact_lock(hashtextextended('financial-notification-operation:'||p_operation_id,0));
  select * into o from public.financial_notification_mutation_operations where operation_id=p_operation_id;
  if found then
    if o.actor_id<>a.id or o.command_kind<>p_kind or o.payload<>v_payload then raise exception 'OPERATION_REUSED' using errcode='PT409'; end if;
    return o.result||jsonb_build_object('replayed',true);
  end if;
  if exists(select 1 from public.financial_notification_operations where operation_id=p_operation_id) then raise exception 'OPERATION_REUSED' using errcode='PT409'; end if;
  select work_order_id into v_work from public.invoices where id=p_invoice_id;
  perform 1 from public.work_orders where id=v_work for update;
  select * into i from public.invoices where id=p_invoice_id and invoice_type='contractor' and deleted_at is null for update;
  if not found then raise exception 'INVOICE_NOT_FOUND' using errcode='PT404'; end if;
  if i.work_order_id is distinct from v_work then raise exception 'INVOICE_NOT_CURRENT' using errcode='PT409'; end if;
  if p_kind in ('review','retraction') and i.review_revision<>p_expected_revision then raise exception 'STALE_REVIEW' using errcode='PT409'; end if;
  if p_kind='hold' then
    v_latest:=public.financial_notification_latest_hold_source(i.id);
    if v_latest is distinct from p_expected_source_event_id then raise exception 'STALE_HOLD' using errcode='PT409'; end if;
  end if;
  perform public.financial_notification_cap('financial_notification_mutation_operations',p_operation_id);
  insert into public.financial_notification_mutation_operations(operation_id,actor_id,command_kind,payload) values(p_operation_id,a.id,p_kind,v_payload);
  insert into public.financial_notification_source_guards values(txid_current(),i.id,a.id,p_operation_id);
  if p_kind='review' then v_result:=public.review_contractor_invoice_pre_notification(i.id,p_action,v_reason);
  elsif p_kind='retraction' then v_result:=public.retract_contractor_invoice_rejection_pre_notification(i.id);
  elsif p_action='place' then v_result:=public.place_contractor_invoice_payment_hold_pre_notification(i.id,a.id,v_reason);
  else v_result:=public.release_contractor_invoice_payment_hold_pre_notification(i.id,a.id,v_reason); end if;
  select coalesce(jsonb_agg(jsonb_build_object('eventId',e.id,'sourceEventId',e.source_id,'family',e.family,'status',
    case when exists(select 1 from public.financial_notification_deliveries d where d.event_id=e.id and d.state='pending') then 'queued' else 'not_deliverable' end)), '[]'::jsonb)
    into v_notifications from public.financial_notification_events e where e.operation_id=p_operation_id;
  v_result:=v_result||jsonb_build_object('operationId',p_operation_id,'replayed',false,'notifications',v_notifications,
    'notificationStatus',case when jsonb_array_length(v_notifications)=0 then 'not_required' when v_notifications->0->>'status'='queued' then 'queued' else 'not_deliverable' end);
  update public.financial_notification_mutation_operations set result=v_result where operation_id=p_operation_id;
  delete from public.financial_notification_source_guards where transaction_id=txid_current() and invoice_id=i.id;
  perform public.financial_notification_clear_caps();return v_result;
end;
$$;
create function public.review_contractor_invoice_with_notification_v1(p_invoice_id uuid,p_action text,p_reason text,p_operation_id uuid,p_expected_revision integer)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$
  select public.execute_financial_notification_mutation(p_invoice_id,'review',lower(btrim(p_action)),p_reason,p_operation_id,p_expected_revision,null);
$$;
create function public.retract_contractor_invoice_rejection_with_notification_v1(p_invoice_id uuid,p_operation_id uuid,p_expected_revision integer)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$
  select public.execute_financial_notification_mutation(p_invoice_id,'retraction',null,null,p_operation_id,p_expected_revision,null);
$$;
create function public.set_contractor_invoice_payment_hold_with_notification_v1(p_invoice_id uuid,p_action text,p_reason text,p_operation_id uuid,p_expected_source_event_id uuid default null)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$
  select public.execute_financial_notification_mutation(p_invoice_id,'hold',p_action,p_reason,p_operation_id,null,p_expected_source_event_id);
$$;
create function public.review_contractor_invoices_with_notification_v1(p_invoice_ids uuid[],p_action text,p_reason text,p_operation_id uuid,p_expected_revisions jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.profiles%rowtype;v_ids uuid[];v_id uuid;v_child uuid;v_results jsonb:='[]';v_result jsonb;v_payload jsonb;o public.financial_notification_mutation_operations%rowtype;
begin
  a:=public.require_financial_notification_actor('invoice_rejected',true);
  select array_agg(distinct x order by x) into v_ids from unnest(p_invoice_ids) x;
  if p_operation_id is null or cardinality(v_ids) is null or cardinality(v_ids) not between 1 and 100
    or array_position(v_ids,null) is not null or jsonb_typeof(p_expected_revisions) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_expected_revisions))<>cardinality(v_ids) then raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  v_payload:=jsonb_build_object('ids',v_ids,'action',lower(btrim(p_action)),'reason',nullif(btrim(p_reason),''),'revisions',p_expected_revisions);
  perform pg_advisory_xact_lock(hashtextextended('financial-notification-operation:'||p_operation_id,0));
  select * into o from public.financial_notification_mutation_operations where operation_id=p_operation_id;
  if found then if o.actor_id<>a.id or o.command_kind<>'batch_review' or o.payload<>v_payload then raise exception 'OPERATION_REUSED' using errcode='PT409'; end if;
    return o.result||jsonb_build_object('replayed',true); end if;
  if exists(select 1 from public.financial_notification_operations where operation_id=p_operation_id) then raise exception 'OPERATION_REUSED' using errcode='PT409'; end if;
  perform 1 from public.work_orders w where w.id in(select i.work_order_id from public.invoices i where i.id=any(v_ids)) order by w.id for update;
  perform 1 from public.invoices where id=any(v_ids) order by id for update;
  perform public.financial_notification_cap('financial_notification_mutation_operations',p_operation_id);
  insert into public.financial_notification_mutation_operations(operation_id,actor_id,command_kind,payload) values(p_operation_id,a.id,'batch_review',v_payload);
  foreach v_id in array v_ids loop
    if coalesce(p_expected_revisions->>v_id::text,'') !~ '^[1-9][0-9]{0,8}$' then raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
    v_child:=md5(p_operation_id::text||':'||v_id::text)::uuid;
    v_result:=public.review_contractor_invoice_with_notification_v1(v_id,p_action,p_reason,v_child,(p_expected_revisions->>v_id::text)::integer);
    v_results:=v_results||jsonb_build_array(v_result);
  end loop;
  v_result:=jsonb_build_object('action',lower(btrim(p_action)),'count',cardinality(v_ids),'invoiceIds',v_ids,'results',v_results,'operationId',p_operation_id,'replayed',false);
  perform public.financial_notification_cap('financial_notification_mutation_operations',p_operation_id);
  update public.financial_notification_mutation_operations set result=v_result where operation_id=p_operation_id;
  perform public.financial_notification_clear_caps();return v_result;
end;
$$;

-- Expansion-only legacy wrappers. 0136 replaces these with tracked delegates.
create function public.review_contractor_invoice(p_invoice_id uuid,p_action text,p_reason text default null)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$ select public.review_contractor_invoice_pre_notification(p_invoice_id,p_action,p_reason); $$;
create function public.retract_contractor_invoice_rejection(p_invoice_id uuid)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$ select public.retract_contractor_invoice_rejection_pre_notification(p_invoice_id); $$;
create function public.place_contractor_invoice_payment_hold(p_invoice_id uuid,p_actor_id uuid,p_reason text)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$ select public.place_contractor_invoice_payment_hold_pre_notification(p_invoice_id,p_actor_id,p_reason); $$;
create function public.release_contractor_invoice_payment_hold(p_invoice_id uuid,p_actor_id uuid,p_reason text)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$ select public.release_contractor_invoice_payment_hold_pre_notification(p_invoice_id,p_actor_id,p_reason); $$;

create function public.financial_notification_record_attempt(p_delivery public.financial_notification_deliveries,p_phase text,p_state text,p_code text default null,p_provider_status integer default null,p_provider_reference text default null,p_retry_after_seconds integer default null)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid:=gen_random_uuid();
begin
  perform public.financial_notification_cap('financial_notification_attempt_events',v_id);
  insert into public.financial_notification_attempt_events(id,delivery_id,sequence,phase,state,claim_token,code,provider_status,provider_reference,retry_after_seconds)
    values(v_id,p_delivery.id,p_delivery.attempt_count,p_phase,p_state,p_delivery.claim_token,p_code,p_provider_status,p_provider_reference,p_retry_after_seconds);
end;
$$;
-- Hold/release notices are event notices. Preserve source order per invoice
-- and recipient while a prior send remains owned by the automatic worker.
-- Unknown is quarantined, but cannot indefinitely suppress a newer financial
-- decision. Every historical source remains independently visible.
create function public.financial_notification_predecessor_pending(p_delivery public.financial_notification_deliveries)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.financial_notification_events current_event
    join public.financial_notification_events earlier on earlier.invoice_id=current_event.invoice_id
      and earlier.source_kind='hold_event' and earlier.event_sequence<current_event.event_sequence
    join public.financial_notification_deliveries d on d.event_id=earlier.id
    where current_event.id=p_delivery.event_id and current_event.source_kind='hold_event'
      and (d.recipient_profile_id=p_delivery.recipient_profile_id or d.recipient_profile_id is null)
      and (d.state in ('pending','claimed','sending') or public.financial_notification_retry_pending(d))
      and not exists(select 1 from public.financial_notification_deliveries child where child.parent_delivery_id=d.id)
      and not exists(select 1 from public.financial_notification_operations o where o.delivery_id=d.id and o.action='manual_resolution'));
$$;
create function public.claim_financial_notification_deliveries_v1(p_limit integer,p_lease_seconds integer,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.financial_notification_deliveries%rowtype;e public.financial_notification_events%rowtype;
  v_state text;v_code text;v_result jsonb:='[]';v_not_deliverable int:=0;v_superseded int:=0;v_recovered int:=0;v_unknown int:=0;
begin
  perform public.require_financial_notification_service();
  if p_limit is null or p_limit not between 1 and 25 or p_lease_seconds is null or p_lease_seconds not between 5 and 300 or p_claim_token is null then
    raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  for d in select * from public.financial_notification_deliveries where state in ('claimed','sending') and claim_expires_at<=clock_timestamp()
    order by claim_expires_at,id limit 100 for update skip locked loop
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
create function public.prepare_financial_notification_send_v1(p_delivery_id uuid,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.financial_notification_deliveries%rowtype;e public.financial_notification_events%rowtype;
  v_email text;v_state text;v_code text;v_reason text;v_invoice jsonb;
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
  if not public.financial_notification_event_current(e) then v_state:='superseded';v_code:='EVENT_SUPERSEDED';
  elsif not public.financial_notification_recipient_valid(d) then v_state:='not_deliverable';v_code:='RECIPIENT_NOT_DELIVERABLE';
  elsif public.financial_notification_predecessor_pending(d) then v_state:='failed';v_code:='PREDECESSOR_UNRESOLVED';end if;
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
create function public.complete_financial_notification_delivery_v1(p_delivery_id uuid,p_claim_token uuid,p_status text,p_error_code text,p_provider_status integer,p_provider_reference text,p_retry_after_seconds integer default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.financial_notification_deliveries%rowtype;a public.financial_notification_attempt_events%rowtype;
begin
  perform public.require_financial_notification_service();
  if p_delivery_id is null or p_claim_token is null or p_status is null or p_status not in ('sent','failed','unknown','not_deliverable','superseded')
    or (p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{1,80}$') or (p_provider_status is not null and p_provider_status not between 100 and 599)
    or length(p_provider_reference)>200 or (p_retry_after_seconds is not null and p_retry_after_seconds not between 0 and 86400)
    or (p_status='failed' and (p_error_code is null or p_error_code in ('GRAPH_OUTCOME_UNKNOWN','SEND_OUTCOME_UNKNOWN') or p_provider_status=408 or p_provider_status>=500))
    or (p_status='sent' and (p_error_code is not null or p_provider_status is distinct from 202)) then raise exception 'INVALID_PROVIDER_OUTCOME' using errcode='PT422'; end if;
  select * into d from public.financial_notification_deliveries where id=p_delivery_id for update;
  if not found then raise exception 'DELIVERY_NOT_FOUND' using errcode='PT404'; end if;
  select * into a from public.financial_notification_attempt_events where delivery_id=d.id and claim_token=p_claim_token and phase='completed';
  if found then
    if a.state is distinct from p_status or a.code is distinct from p_error_code or a.provider_status is distinct from p_provider_status
      or a.provider_reference is distinct from p_provider_reference or a.retry_after_seconds is distinct from p_retry_after_seconds then raise exception 'OPERATION_REUSED' using errcode='PT409'; end if;
    return jsonb_build_object('id',d.id,'state',d.state,'replayed',true);
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
  perform public.financial_notification_clear_caps();return jsonb_build_object('id',d.id,'state',p_status,'replayed',false);
end;
$$;

create function public.financial_notification_safe_code(p_code text)
returns text language sql immutable set search_path=pg_catalog,public as $$
  select case when p_code in ('NO_ELIGIBLE_RECIPIENT','RECIPIENT_NOT_DELIVERABLE','EVENT_SUPERSEDED','GRAPH_RATE_LIMITED','GRAPH_AUTH_RETRYABLE',
    'GRAPH_SEND_REJECTED','GRAPH_CONFIG_UNAVAILABLE','GRAPH_OUTCOME_UNKNOWN','GRAPH_SEND_FAILED','CLAIM_EXPIRED_BEFORE_SEND','SEND_OUTCOME_UNKNOWN',
    'PREDECESSOR_UNRESOLVED','GRAPH_RETRY_WINDOW_EXCEEDED') then p_code when p_code is not null then 'DELIVERY_FAILED' else null end;
$$;
create function public.financial_notification_safe_projection(p_delivery public.financial_notification_deliveries,p_labels boolean default false)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('id',p_delivery.id,'eventId',e.id,'rootId',coalesce(p_delivery.root_delivery_id,p_delivery.id),'invoiceId',e.invoice_id,
    'workOrderId',e.work_order_id,'family',e.family,'sourceEventId',e.source_id,'reviewRevision',e.review_revision,'recipientKind',p_delivery.recipient_kind,
    'recipientLabel',case when p_labels then (select left(case when p_delivery.recipient_kind='contractor'
      then coalesce(nullif(btrim(p.company),''),nullif(btrim(p.name),''),'Contractor')
      else coalesce(nullif(btrim(p.name),''),nullif(btrim(p.company),''),'Recipient') end,160)
      from public.profiles p where p.id=p_delivery.recipient_profile_id) else null end,
    'current',public.financial_notification_event_current(e),
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
    from public.financial_notification_events e where e.id=p_delivery.event_id;
$$;

create function public.financial_notification_page(p_invoice_id uuid,p_family text,p_state text,p_search text,p_cursor jsonb,p_limit integer,p_unresolved boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.profiles%rowtype;v_controller boolean;v_search text:=btrim(coalesce(p_search,''));v_at timestamptz;v_id uuid;
  v_snapshot timestamptz:=clock_timestamp();v_items jsonb;v_more boolean;v_next jsonb;v_latest uuid;
begin
  a:=public.require_financial_notification_actor(null);v_controller:=public.profile_has_staff_permission(a.id,'invoice_controller');
  if p_limit is null or p_limit not between 1 and 50 or length(v_search)>100
    or (p_family is not null and p_family not in ('invoice_rejected','invoice_rejection_retracted','payment_hold_placed','payment_hold_released'))
    or (p_state is not null and p_state not in ('unknown','not_deliverable','failed')) then raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  if v_controller and p_family in ('invoice_rejected','invoice_rejection_retracted') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_invoice_id is not null and not exists(select 1 from public.invoices where id=p_invoice_id and invoice_type='contractor' and deleted_at is null) then
    raise exception 'INVOICE_NOT_FOUND' using errcode='PT404'; end if;
  if p_cursor is not null then
    begin
      if jsonb_typeof(p_cursor)<>'object' or p_cursor-array['version','invoiceId','family','state','search','unresolved','createdAt','id','snapshotAt']<>'{}'::jsonb
        or not (p_cursor ?& array['version','invoiceId','family','state','search','unresolved','createdAt','id','snapshotAt'])
        or p_cursor->>'version' is distinct from '1' or p_cursor->>'invoiceId' is distinct from p_invoice_id::text
        or p_cursor->>'family' is distinct from p_family or p_cursor->>'state' is distinct from p_state or p_cursor->>'search' is distinct from v_search
        or p_cursor->>'unresolved' is distinct from p_unresolved::text then raise exception 'bad'; end if;
      v_at:=(p_cursor->>'createdAt')::timestamptz;v_id:=(p_cursor->>'id')::uuid;v_snapshot:=(p_cursor->>'snapshotAt')::timestamptz;
      if v_at is null or v_id is null or v_snapshot is null or not isfinite(v_at) or not isfinite(v_snapshot) or v_at>v_snapshot or v_snapshot>clock_timestamp() then raise exception 'bad'; end if;
    exception when others then raise exception 'INVALID_CURSOR' using errcode='PT422'; end;
  end if;
  with candidates as (
    select d.* from public.financial_notification_deliveries d join public.financial_notification_events e on e.id=d.event_id
    where (p_invoice_id is null or e.invoice_id=p_invoice_id) and (p_family is null or e.family=p_family)
      and (not v_controller or e.source_kind='hold_event') and (p_state is null or d.state=p_state)
      and (v_search='' or strpos(lower(coalesce(e.work_order_id,'')),lower(v_search))>0 or strpos(e.invoice_id::text,lower(v_search))>0)
      and (not p_unresolved or (public.financial_notification_actionable(d) and public.financial_notification_event_current(e)
        and not exists(select 1 from public.financial_notification_operations o where o.delivery_id=d.id)))
      and not exists(select 1 from public.financial_notification_deliveries child where child.parent_delivery_id=d.id)
      and d.created_at<=v_snapshot and (v_at is null or (d.created_at,d.id)<(v_at,v_id))
    order by d.created_at desc,d.id desc limit p_limit+1
  ), page as (select * from candidates order by created_at desc,id desc limit p_limit)
  select coalesce((select jsonb_agg(public.financial_notification_safe_projection(p,p_invoice_id is not null) order by p.created_at desc,p.id desc) from page p),'[]'::jsonb),
    (select count(*)>p_limit from candidates),(select jsonb_build_object('version',1,'invoiceId',p_invoice_id,'family',p_family,'state',p_state,
      'search',v_search,'unresolved',p_unresolved,'createdAt',p.created_at,'id',p.id,'snapshotAt',v_snapshot) from page p order by p.created_at,p.id limit 1)
    into v_items,v_more,v_next;
  if p_invoice_id is not null then v_latest:=public.financial_notification_latest_hold_source(p_invoice_id);end if;
  return jsonb_build_object('items',v_items,'hasMore',v_more,'nextCursor',case when v_more then v_next else null end,'latestHoldSourceEventId',v_latest);
end;
$$;
create function public.get_financial_notification_status_v1(p_invoice_id uuid,p_cursor jsonb default null,p_limit integer default 25)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if p_invoice_id is null then raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  return public.financial_notification_page(p_invoice_id,null,null,'',p_cursor,p_limit,false);
end;
$$;
create function public.list_financial_notification_unresolved_v1(p_family text default null,p_state text default null,p_search text default '',p_cursor jsonb default null,p_limit integer default 25)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$
  select public.financial_notification_page(null,p_family,p_state,p_search,p_cursor,p_limit,true);
$$;

create function public.get_financial_notification_history_v1(p_event_id uuid,p_cursor jsonb default null,p_limit integer default 20)
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
      if v_at is null or v_id is null or v_id !~* '^(delivery|attempt|operation):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or v_snapshot is null or not isfinite(v_at) or not isfinite(v_snapshot) or v_at>v_snapshot or v_snapshot>clock_timestamp() then raise exception 'bad'; end if;
    exception when others then raise exception 'INVALID_CURSOR' using errcode='PT422'; end;
  end if;
  with history as (
    select 'delivery:'||d.id as id,'delivery'::text as kind,d.state,d.created_at,d.completed_at,null::text as reason,0 as sequence,public.financial_notification_safe_code(d.last_error_code) as code
      from public.financial_notification_deliveries d where d.event_id=e.id
    union all select 'attempt:'||a.id,'attempt',a.state,a.created_at,case when a.phase in ('completed','claim_expired') then a.created_at else null end,
      null,a.sequence,public.financial_notification_safe_code(a.code) from public.financial_notification_attempt_events a join public.financial_notification_deliveries d on d.id=a.delivery_id where d.event_id=e.id
    union all select 'operation:'||o.operation_id,case when o.action='resend' then 'resend' else 'manual_resolution' end,
      case when o.action='resend' then 'pending' else 'manually_resolved' end,o.created_at,o.created_at,o.reason,0,null
      from public.financial_notification_operations o where o.event_id=e.id
  ), candidates as (select * from history where created_at<=v_snapshot and (v_at is null or (created_at,id)<(v_at,v_id)) order by created_at desc,id desc limit p_limit+1),
  page as (select * from candidates order by created_at desc,id desc limit p_limit)
  select coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'state',p.state,'createdAt',p.created_at,'completedAt',p.completed_at,
    'reason',p.reason,'sequence',p.sequence,'code',p.code) order by p.created_at desc,p.id desc) from page p),'[]'::jsonb),
    (select count(*)>p_limit from candidates),(select jsonb_build_object('version',1,'eventId',p_event_id,'createdAt',p.created_at,'id',p.id,'snapshotAt',v_snapshot) from page p order by p.created_at,p.id limit 1)
    into v_items,v_more,v_next;
  return jsonb_build_object('items',v_items,'hasMore',v_more,'nextCursor',case when v_more then v_next else null end);
end;
$$;

create function public.financial_notification_staff_action(p_event_id uuid,p_delivery_id uuid,p_operation_id uuid,p_reason text,p_action text)
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
  if not public.financial_notification_event_current(e) then raise exception 'EVENT_NOT_CURRENT' using errcode='PT409'; end if;
  -- A new deliberate duplicate of an older accounting decision could present
  -- superseded payment guidance. Fail closed pending an approved historical
  -- resend/template policy; original event delivery and manual evidence remain.
  if p_action='resend' and e.source_kind='hold_event' and e.source_id is distinct from public.financial_notification_latest_hold_source(e.invoice_id) then
    raise exception 'HOLD_RESEND_POLICY_REQUIRED' using errcode='PT409'; end if;
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
create function public.request_financial_notification_resend_v1(p_event_id uuid,p_delivery_id uuid,p_operation_id uuid,p_reason text)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$ select public.financial_notification_staff_action(p_event_id,p_delivery_id,p_operation_id,p_reason,'resend'); $$;
create function public.resolve_financial_notification_out_of_band_v1(p_event_id uuid,p_delivery_id uuid,p_operation_id uuid,p_reason text)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$ select public.financial_notification_staff_action(p_event_id,p_delivery_id,p_operation_id,p_reason,'manual_resolution'); $$;

create function public.get_financial_notification_review_compatibility_v1(p_invoice_id uuid,p_event text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare e public.financial_notification_events%rowtype;v_family text;v_status text;v_count int;
begin
  perform public.require_financial_notification_actor('invoice_rejected');
  if p_invoice_id is null or p_event is null or p_event not in ('rejected','retraction') then raise exception 'VALIDATION_FAILED' using errcode='PT422'; end if;
  v_family:=case when p_event='rejected' then 'invoice_rejected' else 'invoice_rejection_retracted' end;
  select candidate.* into e from public.financial_notification_events candidate where candidate.invoice_id=p_invoice_id and candidate.family=v_family
    and public.financial_notification_event_current(candidate) order by candidate.created_at desc,candidate.id desc limit 1;
  if not found then raise exception 'DELIVERY_NOT_FOUND' using errcode='PT404'; end if;
  with leaves as (
    select d.*,exists(select 1 from public.financial_notification_operations o where o.delivery_id=d.id and o.action='manual_resolution') as resolved
    from public.financial_notification_deliveries d where d.event_id=e.id
      and not exists(select 1 from public.financial_notification_deliveries child where child.parent_delivery_id=d.id)
  ) select count(*) filter(where recipient_profile_id is not null),
    case when bool_or(state='unknown' and not resolved) then 'unknown'
      when bool_or(state='not_deliverable' and not resolved) then 'not_deliverable'
      when bool_or(state in ('claimed','sending') and not resolved) then 'processing'
      when bool_or(state='pending' or (state='failed' and attempt_count<3 and last_error_code in ('GRAPH_RATE_LIMITED','GRAPH_AUTH_RETRYABLE'))) then 'queued'
      when bool_or(state='failed' and not resolved) then 'failed'
      when bool_and(state='sent') then 'sent'
      when bool_or(resolved) then 'manually_resolved' else 'superseded' end into v_count,v_status from leaves;
  return jsonb_build_object('success',true,'recipientCount',v_count,'notification',jsonb_build_object('status',v_status,'eventId',e.id));
end;
$$;

-- Every new private capability/helper is uncallable by browser/service roles.
do $grants$
declare f record;
begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'financial_notification_%' or p.proname like 'guard_financial_notification_%'
      or p.proname like 'require_financial_notification_%' or p.proname='capture_financial_notification_source'
      or p.proname like '%_pre_notification' or p.proname='execute_financial_notification_mutation') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  end loop;
end;
$grants$;
revoke all on function public.review_contractor_invoice_with_notification_v1(uuid,text,text,uuid,integer),public.review_contractor_invoices_with_notification_v1(uuid[],text,text,uuid,jsonb),
  public.retract_contractor_invoice_rejection_with_notification_v1(uuid,uuid,integer),public.set_contractor_invoice_payment_hold_with_notification_v1(uuid,text,text,uuid,uuid),
  public.get_financial_notification_status_v1(uuid,jsonb,integer),public.list_financial_notification_unresolved_v1(text,text,text,jsonb,integer),public.get_financial_notification_history_v1(uuid,jsonb,integer),
  public.get_financial_notification_review_compatibility_v1(uuid,text),
  public.request_financial_notification_resend_v1(uuid,uuid,uuid,text),public.resolve_financial_notification_out_of_band_v1(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.review_contractor_invoice_with_notification_v1(uuid,text,text,uuid,integer),public.review_contractor_invoices_with_notification_v1(uuid[],text,text,uuid,jsonb),
  public.retract_contractor_invoice_rejection_with_notification_v1(uuid,uuid,integer),public.set_contractor_invoice_payment_hold_with_notification_v1(uuid,text,text,uuid,uuid),
  public.get_financial_notification_status_v1(uuid,jsonb,integer),public.list_financial_notification_unresolved_v1(text,text,text,jsonb,integer),public.get_financial_notification_history_v1(uuid,jsonb,integer),
  public.get_financial_notification_review_compatibility_v1(uuid,text),
  public.request_financial_notification_resend_v1(uuid,uuid,uuid,text),public.resolve_financial_notification_out_of_band_v1(uuid,uuid,uuid,text) to authenticated;
revoke all on function public.claim_financial_notification_deliveries_v1(integer,integer,uuid),public.prepare_financial_notification_send_v1(uuid,uuid),
  public.complete_financial_notification_delivery_v1(uuid,uuid,text,text,integer,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_financial_notification_deliveries_v1(integer,integer,uuid),public.prepare_financial_notification_send_v1(uuid,uuid),
  public.complete_financial_notification_delivery_v1(uuid,uuid,text,text,integer,text,integer) to service_role;
revoke all on function public.review_contractor_invoice(uuid,text,text),public.retract_contractor_invoice_rejection(uuid),
  public.place_contractor_invoice_payment_hold(uuid,uuid,text),public.release_contractor_invoice_payment_hold(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.review_contractor_invoice(uuid,text,text),public.retract_contractor_invoice_rejection(uuid) to authenticated,service_role;
grant execute on function public.place_contractor_invoice_payment_hold(uuid,uuid,text),public.release_contractor_invoice_payment_hold(uuid,uuid,text) to service_role;
revoke all on sequence public.financial_notification_events_event_sequence_seq from public,anon,authenticated,service_role;

commit;
