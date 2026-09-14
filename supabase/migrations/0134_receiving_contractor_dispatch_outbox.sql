-- Phase 5A expansion: transaction-owned receiving-contractor dispatch outbox.
-- This is intentionally a dedicated ledger; outgoing transition deliveries
-- remain a separate privacy and lifecycle domain.
begin;

create table public.contractor_receiving_dispatch_deliveries (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null references public.work_orders(id) on delete cascade,
  assignment_version integer not null check (assignment_version > 0),
  event_type text not null check (event_type in ('assignment','reassignment','duplicate_assignment')),
  recipient_profile_id uuid not null references public.profiles(id) on delete restrict,
  recipient_company_id uuid references public.organizations(id) on delete restrict,
  recipient_email_snapshot text,
  recipient_name_snapshot text not null default 'Contractor',
  status text not null default 'pending' check (status in
    ('pending','claimed','sending','sent','failed','unknown','not_deliverable','superseded','cancelled','manually_resolved')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  claim_token uuid,
  claim_expires_at timestamptz,
  send_started_at timestamptz,
  sent_at timestamptz,
  completed_at timestamptz,
  provider_status integer,
  provider_reference text,
  last_error_code text,
  last_error_at timestamptz,
  superseded_at timestamptz,
  resolution_type text,
  resolution_reason text,
  resolved_by uuid references public.profiles(id) on delete restrict,
  resolved_at timestamptz,
  created_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint receiving_dispatch_identity unique(work_order_id, assignment_version, recipient_profile_id, event_type),
  constraint receiving_dispatch_claim_shape check (
    (status in ('pending','failed') and claim_token is null and claim_expires_at is null and send_started_at is null)
    or status in ('claimed','sending','sent','unknown','not_deliverable','superseded','cancelled','manually_resolved')
  )
);
create index receiving_dispatch_claim_idx
  on public.contractor_receiving_dispatch_deliveries(status,next_attempt_at,created_at,id)
  where status in ('pending','failed');
create index receiving_dispatch_work_order_idx
  on public.contractor_receiving_dispatch_deliveries(work_order_id,created_at desc);
alter table public.contractor_receiving_dispatch_deliveries enable row level security;
revoke all on public.contractor_receiving_dispatch_deliveries from public,anon,authenticated,service_role;
grant select on public.contractor_receiving_dispatch_deliveries to authenticated;

create function public.queue_receiving_contractor_dispatch()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_recipient public.profiles%rowtype; v_event text; v_email text;
begin
  if new.contractor_id is null or (tg_op='UPDATE' and new.contractor_id is not distinct from old.contractor_id) then return new; end if;
  select p.* into strict v_recipient from public.profiles p where p.id=new.contractor_id;
  v_email:=nullif(trim(coalesce(v_recipient.email,'')), '');
  v_event:=case when tg_op='INSERT' and new.duplicated_from_work_order_id is not null then 'duplicate_assignment'
    when tg_op='INSERT' then 'assignment' else 'reassignment' end;
  insert into public.contractor_receiving_dispatch_deliveries(
    work_order_id,assignment_version,event_type,recipient_profile_id,recipient_company_id,
    recipient_email_snapshot,recipient_name_snapshot,status,last_error_code,created_by)
  values(new.id,greatest(new.contractor_assignment_version,1),v_event,v_recipient.id,
    v_recipient.contractor_organization_id,v_email,
    coalesce(nullif(trim(v_recipient.name),''),nullif(trim(v_recipient.company),''),'Contractor'),
    case when v_recipient.active and v_email is not null then 'pending' else 'not_deliverable' end,
    case when not v_recipient.active then 'RECIPIENT_INACTIVE' when v_email is null then 'RECIPIENT_EMAIL_MISSING' else null end,
    coalesce(new.created_by,auth.uid()))
  on conflict (work_order_id,assignment_version,recipient_profile_id,event_type) do nothing;
  return new;
end;
$$;
revoke all on function public.queue_receiving_contractor_dispatch() from public,anon,authenticated,service_role;
drop trigger if exists queue_receiving_contractor_dispatch_trigger on public.work_orders;
create trigger queue_receiving_contractor_dispatch_trigger
  after insert or update of contractor_id,contractor_assignment_version on public.work_orders
  for each row execute function public.queue_receiving_contractor_dispatch();

create function public.claim_receiving_dispatch_deliveries_v1(p_limit integer,p_lease_seconds integer,p_claim_token uuid)
returns setof public.contractor_receiving_dispatch_deliveries
language sql security definer set search_path=public,pg_temp as $$
  with stale as (
    update public.contractor_receiving_dispatch_deliveries d set status='superseded',superseded_at=clock_timestamp(),updated_at=clock_timestamp(),last_error_code='ASSIGNMENT_SUPERSEDED'
    where d.status in ('pending','failed') and exists(select 1 from public.work_orders w where w.id=d.work_order_id and (w.deleted_at is not null or w.contractor_id is distinct from d.recipient_profile_id or w.contractor_assignment_version is distinct from d.assignment_version))
    returning d.id
  ), undeliverable as (
    update public.contractor_receiving_dispatch_deliveries d set status='not_deliverable',completed_at=clock_timestamp(),updated_at=clock_timestamp(),last_error_code=case when p.active is distinct from true then 'RECIPIENT_INACTIVE' else 'RECIPIENT_EMAIL_MISSING' end
    from public.profiles p where d.recipient_profile_id=p.id and d.status in ('pending','failed') and (p.active is distinct from true or nullif(trim(p.email),'') is null)
    returning d.id
  ), candidates as (
    select d.id from public.contractor_receiving_dispatch_deliveries d
    join public.work_orders w on w.id=d.work_order_id and w.contractor_id=d.recipient_profile_id
      and w.contractor_assignment_version=d.assignment_version and w.deleted_at is null
    join public.profiles p on p.id=d.recipient_profile_id and p.active and nullif(trim(p.email),'') is not null
    where d.status in ('pending','failed') and d.attempt_count<3 and d.next_attempt_at<=clock_timestamp()
    order by d.next_attempt_at,d.created_at,d.id limit greatest(1,least(coalesce(p_limit,25),100)) for update skip locked
  )
  update public.contractor_receiving_dispatch_deliveries d set status='claimed',claim_token=p_claim_token,
    claim_expires_at=clock_timestamp()+make_interval(secs=>greatest(5,least(coalesce(p_lease_seconds,60),300))),
    attempt_count=d.attempt_count+1,updated_at=clock_timestamp()
  from candidates c where d.id=c.id returning d.*;
$$;
create function public.start_receiving_dispatch_delivery_v1(p_delivery_id uuid,p_claim_token uuid)
returns boolean language sql security definer set search_path=public,pg_temp as $$
  update public.contractor_receiving_dispatch_deliveries set status='sending',send_started_at=clock_timestamp(),updated_at=clock_timestamp()
  where id=p_delivery_id and claim_token=p_claim_token and status='claimed' and claim_expires_at>clock_timestamp() returning true;
$$;
create function public.complete_receiving_dispatch_delivery_v1(p_delivery_id uuid,p_claim_token uuid,p_status text,p_error_code text,p_provider_status integer,p_provider_reference text)
returns public.contractor_receiving_dispatch_deliveries language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.contractor_receiving_dispatch_deliveries%rowtype;
begin
  if p_status not in ('sent','failed','unknown','not_deliverable','superseded','manually_resolved') then
    raise exception 'Invalid receiving dispatch completion state' using errcode='22023';
  end if;
  update public.contractor_receiving_dispatch_deliveries d set status=p_status, last_error_code=nullif(left(coalesce(p_error_code,''),80),''),
    last_error_at=case when p_status in ('failed','unknown','not_deliverable') then clock_timestamp() else null end,
    provider_status=p_provider_status,provider_reference=left(p_provider_reference,200),sent_at=case when p_status='sent' then clock_timestamp() else null end,
    completed_at=clock_timestamp(),claim_token=null,claim_expires_at=null,
    next_attempt_at=case when p_status='failed' then clock_timestamp()+interval '5 minutes' else d.next_attempt_at end,
    updated_at=clock_timestamp()
  where d.id=p_delivery_id and d.claim_token=p_claim_token and d.status in ('claimed','sending') returning d.* into v;
  if not found then raise exception 'Receiving dispatch claim is stale' using errcode='PT409'; end if;
  return v;
end;
$$;
create function public.resolve_receiving_dispatch_delivery_v1(p_delivery_id uuid,p_resolution_type text,p_reason text,p_actor uuid)
returns public.contractor_receiving_dispatch_deliveries language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.contractor_receiving_dispatch_deliveries%rowtype;
begin
  if p_resolution_type not in ('manually_resolved','contacted_out_of_band') or nullif(btrim(p_reason),'') is null or length(p_reason)>500 then
    raise exception 'A bounded reconciliation reason is required' using errcode='22023';
  end if;
  update public.contractor_receiving_dispatch_deliveries set status='manually_resolved',resolution_type=p_resolution_type,
    resolution_reason=left(btrim(p_reason),500),resolved_by=p_actor,resolved_at=clock_timestamp(),updated_at=clock_timestamp()
  where id=p_delivery_id and status in ('unknown','not_deliverable','failed') returning * into v;
  if not found then raise exception 'Receiving dispatch is not unresolved' using errcode='PT409'; end if;
  return v;
end;
$$;
revoke all on function public.claim_receiving_dispatch_deliveries_v1(integer,integer,uuid),public.start_receiving_dispatch_delivery_v1(uuid,uuid),public.complete_receiving_dispatch_delivery_v1(uuid,uuid,text,text,integer,text),public.resolve_receiving_dispatch_delivery_v1(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.claim_receiving_dispatch_deliveries_v1(integer,integer,uuid),public.start_receiving_dispatch_delivery_v1(uuid,uuid),public.complete_receiving_dispatch_delivery_v1(uuid,uuid,text,text,integer,text),public.resolve_receiving_dispatch_delivery_v1(uuid,text,text,uuid) to service_role;

commit;
