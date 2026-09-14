-- Batch 3C.1: narrowly approved, never-started source recurrence.
-- No prior delivery, attempt, operation, or migration is rewritten.
begin;
lock table public.p1_parts_alert_deliveries,public.p1_parts_sms_attempt_events in share row exclusive mode;
create table public.p1_parts_sms_source_generations (
 id uuid primary key default gen_random_uuid(),
 recipient_id uuid not null references public.p1_parts_alert_recipients(id) on delete restrict,
 local_date date not null,generation integer not null check(generation>0),
 request_signature text not null check(request_signature ~ '^[a-f0-9]{64}$'),
 previous_generation_id uuid references public.p1_parts_sms_source_generations(id) on delete restrict,
 timezone text not null,configuration_version bigint not null,
 source_kind text not null check(source_kind in ('snapshot','owned_delivery_evidence')),
 basis_delivery_id uuid references public.p1_parts_alert_deliveries(id) on delete restrict,
 observed_at timestamptz not null default clock_timestamp(),
 check((generation=1)=(previous_generation_id is null)),
 check(source_kind<>'owned_delivery_evidence' or basis_delivery_id is not null),
 unique(recipient_id,local_date,generation)
);
create index p1_parts_sms_generation_latest on public.p1_parts_sms_source_generations(recipient_id,local_date,generation desc);
create index p1_parts_sms_generation_signature on public.p1_parts_sms_source_generations(recipient_id,local_date,request_signature,generation desc);
create unique index p1_parts_sms_generation_basis on public.p1_parts_sms_source_generations(basis_delivery_id) where basis_delivery_id is not null and source_kind='owned_delivery_evidence';
alter table public.p1_parts_sms_source_generations enable row level security;
revoke all on public.p1_parts_sms_source_generations from public,anon,authenticated,service_role;
create trigger parts_sms_generation_guard before insert or update or delete on public.p1_parts_sms_source_generations
 for each row execute function public.guard_parts_sms_records();
create trigger parts_sms_truncate_guard before truncate on public.p1_parts_sms_source_generations
 for each statement execute function public.guard_parts_sms_truncate();
alter table public.p1_parts_alert_deliveries
 add column delivery_origin text check(delivery_origin in ('initial','explicit_resend','source_recurrence')),
 add column source_generation_id uuid references public.p1_parts_sms_source_generations(id) on delete restrict,
 add column prior_same_generation_id uuid references public.p1_parts_sms_source_generations(id) on delete restrict,
 add column intervening_generation_id uuid references public.p1_parts_sms_source_generations(id) on delete restrict;
alter table public.p1_parts_alert_deliveries add constraint p1_parts_sms_recurrence_shape check(
 delivery_origin is distinct from 'source_recurrence' or (
 provenance='owned_v1' and parent_delivery_id is not null and source_generation_id is not null
 and prior_same_generation_id is not null and intervening_generation_id is not null));
create unique index p1_parts_sms_recurrence_once on public.p1_parts_alert_deliveries(source_generation_id)
 where delivery_origin='source_recurrence';
alter table public.p1_parts_sms_attempt_events drop constraint p1_parts_sms_attempt_events_phase_check;
alter table public.p1_parts_sms_attempt_events add constraint p1_parts_sms_attempt_events_phase_check
 check(phase in ('claimed','send_started','completed','expired','cancelled','provider_status','source_recurrence'));

create function public.parts_sms_origin(p_delivery public.p1_parts_alert_deliveries)
returns text language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(p_delivery.delivery_origin,case when p_delivery.parent_delivery_id is null then 'initial' else 'explicit_resend' end);
$$;
create function public.parts_sms_delivery_generation(p_delivery public.p1_parts_alert_deliveries)
returns uuid language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce(p_delivery.source_generation_id,(select g.id from public.p1_parts_sms_source_generations g
   where g.basis_delivery_id=p_delivery.id and g.source_kind='owned_delivery_evidence' limit 1));
$$;
create function public.parts_sms_append_generation(p_recipient uuid,p_date date,p_signature text,p_timezone text,p_version bigint,p_basis uuid default null)
returns public.p1_parts_sms_source_generations language plpgsql security definer set search_path=pg_catalog,public as $$
declare prior public.p1_parts_sms_source_generations%rowtype;g public.p1_parts_sms_source_generations%rowtype;v_id uuid:=gen_random_uuid();
begin
 select * into prior from public.p1_parts_sms_source_generations where recipient_id=p_recipient and local_date=p_date order by generation desc limit 1;
 if found and prior.request_signature=p_signature and prior.timezone=p_timezone then return prior;end if;
 perform public.parts_sms_cap('p1_parts_sms_source_generations',v_id);
 insert into public.p1_parts_sms_source_generations(id,recipient_id,local_date,generation,request_signature,previous_generation_id,
   timezone,configuration_version,source_kind,basis_delivery_id)
 values(v_id,p_recipient,p_date,coalesce(prior.generation,0)+1,p_signature,prior.id,p_timezone,p_version,
   case when p_basis is null then 'snapshot' else 'owned_delivery_evidence' end,p_basis) returning * into g;
 return g;
end;
$$;
-- Bootstrap only explicit owned evidence with strictly ordered server times.
-- Ambiguous/capped history is NOT invented. A genuine current observation still
-- starts a safe new observation chain; future distinct observations can prove
-- a recurrence without claiming a complete historical reconstruction.
create function public.parts_sms_observe_source(p_recipient uuid,p_snapshot jsonb)
returns public.p1_parts_sms_source_generations language plpgsql security definer set search_path=pg_catalog,public as $$
declare g public.p1_parts_sms_source_generations%rowtype;d public.p1_parts_alert_deliveries%rowtype;v_count integer;v_valid boolean;
begin
 if p_snapshot->>'status' not in ('ready','nothing_to_send') then return null;end if;
 select * into g from public.p1_parts_sms_source_generations where recipient_id=p_recipient and local_date=(p_snapshot->>'localDate')::date
   order by generation desc limit 1;
 if not found then
   with evidence as materialized(select * from public.p1_parts_alert_deliveries where recipient_id=p_recipient
     and local_date=(p_snapshot->>'localDate')::date and provenance='owned_v1' and parent_delivery_id is null
     order by created_at,id limit 101)
   select count(*),count(*)<=100 and count(distinct created_at)=count(*) and bool_and(
     timezone=p_snapshot->>'timezone' and (status<>'superseded' or exists(select 1 from public.p1_parts_sms_attempt_events a
       where a.delivery_id=evidence.id and a.phase='cancelled' and a.state='superseded' and a.created_at>=evidence.created_at)))
     into v_count,v_valid from evidence;
   if v_count>0 and v_valid then
     for d in select * from public.p1_parts_alert_deliveries where recipient_id=p_recipient
       and local_date=(p_snapshot->>'localDate')::date and provenance='owned_v1' and parent_delivery_id is null
       order by created_at,id limit 100 loop
       g:=public.parts_sms_append_generation(p_recipient,d.local_date,d.request_signature,d.timezone,d.configuration_version,d.id);
     end loop;
   end if;
 end if;
 return public.parts_sms_append_generation(p_recipient,(p_snapshot->>'localDate')::date,p_snapshot->>'requestSignature',
   p_snapshot->>'timezone',(p_snapshot->>'configurationVersion')::bigint);
end;
$$;

-- The creation barrier inspects the ENTIRE recipient/local-date chain, including
-- journal facts no longer present in a cached row. The optional exemption is
-- solely for an already-created recurrence child's proven known-unsent retry.
create function public.parts_sms_recurrence_barrier(p_recipient uuid,p_date date,p_retry_delivery uuid default null)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare v_ignore uuid;
begin
 if exists(select 1 from public.p1_parts_alert_deliveries d where d.recipient_id=p_recipient and d.local_date=p_date and d.provenance='legacy') then
   return 'proof_incomplete';end if;
 if exists(select 1 from public.p1_parts_alert_deliveries d where d.recipient_id=p_recipient and d.local_date=p_date and (
   d.provider_message_id is not null or d.provider_status is not null or d.status in ('accepted','sent','delivered','unknown') or d.status_claim_token is not null
   or exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.id and o.action='manual_resolution')
   or exists(select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=d.id and
     (a.provider_message_id is not null or a.outcome='accepted' or a.state in ('accepted','sent','delivered','unknown') or a.provider_status is not null)))) then return 'daily_outcome';end if;
 if p_retry_delivery is not null and exists(select 1 from public.p1_parts_alert_deliveries d where d.id=p_retry_delivery
   and d.recipient_id=p_recipient and d.local_date=p_date and d.delivery_origin='source_recurrence' and d.status in ('pending','claimed','failed')
   and not exists(select 1 from public.p1_parts_sms_attempt_events started where started.delivery_id=d.id and started.phase='send_started'
     and not exists(select 1 from public.p1_parts_sms_attempt_events completed where completed.delivery_id=d.id
       and completed.claim_token=started.claim_token and completed.phase='completed'
       and completed.outcome in ('known_unsent_retryable','known_unsent_terminal')))) then v_ignore:=p_retry_delivery;end if;
 if exists(select 1 from public.p1_parts_alert_deliveries d where d.recipient_id=p_recipient and d.local_date=p_date
   and (d.status='sending' or (d.send_started_at is not null and d.id is distinct from v_ignore)
     or exists(select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=d.id and (a.phase='send_started' or a.state='sending') and d.id is distinct from v_ignore))) then
   return 'send_started';end if;
 if exists(select 1 from public.p1_parts_alert_deliveries d where d.recipient_id=p_recipient and d.local_date=p_date and (
   (d.status='superseded' and not exists(select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=d.id and a.phase='cancelled' and a.state='superseded'))
   or (d.status='failed' and not exists(select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=d.id and a.phase='completed'
     and a.sequence=d.attempt_count and a.outcome in ('known_unsent_retryable','known_unsent_terminal')))
   or (d.attempt_count>0 and not exists(select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=d.id and a.phase='claimed' and a.sequence=d.attempt_count))
   or (d.status='not_deliverable' and d.attempt_count>0 and not exists(select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=d.id
     and a.sequence=d.attempt_count and ((a.phase='completed' and a.outcome='known_unsent_terminal') or (a.phase='cancelled' and a.state='not_deliverable')))))) then
   return 'proof_incomplete';end if;
 return null;
end;
$$;
create function public.parts_sms_recurrence_candidate(p_delivery public.p1_parts_alert_deliveries,p_snapshot jsonb)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select p_snapshot->>'status'='ready' and p_delivery.local_date::text=p_snapshot->>'localDate'
   and p_delivery.timezone=p_snapshot->>'timezone' and p_delivery.request_signature=p_snapshot->>'requestSignature'
   and not exists(select 1 from public.p1_parts_alert_deliveries child where child.parent_delivery_id=p_delivery.id)
   and (p_delivery.status='superseded' or exists(select 1 from public.p1_parts_sms_source_generations g
     where g.recipient_id=p_delivery.recipient_id and g.local_date=p_delivery.local_date and g.request_signature<>p_delivery.request_signature
       and g.generation>coalesce((select own.generation from public.p1_parts_sms_source_generations own where own.id=public.parts_sms_delivery_generation(p_delivery)),0)));
$$;
create function public.parts_sms_recurrence_block_category(p_delivery public.p1_parts_alert_deliveries,p_snapshot jsonb)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare g public.p1_parts_sms_source_generations%rowtype;prior public.p1_parts_sms_source_generations%rowtype;v_block text;
begin
 if not public.parts_sms_recurrence_candidate(p_delivery,p_snapshot) then return null;end if;
 v_block:=public.parts_sms_recurrence_barrier(p_delivery.recipient_id,p_delivery.local_date);
 if v_block is not null then return v_block;end if;
 select * into g from public.p1_parts_sms_source_generations where recipient_id=p_delivery.recipient_id and local_date=p_delivery.local_date
   order by generation desc limit 1;
 select * into prior from public.p1_parts_sms_source_generations where recipient_id=p_delivery.recipient_id and local_date=p_delivery.local_date
   and request_signature=p_delivery.request_signature and generation<g.generation order by generation desc limit 1;
 if g.id is null or (g.request_signature=p_delivery.request_signature and (prior.id is null or g.previous_generation_id=prior.id))
   or not public.parts_sms_recipient_current(p_delivery) then return 'proof_incomplete';end if;
 if (select count(*) from (select d.id from public.p1_parts_alert_deliveries d where d.recipient_id=p_delivery.recipient_id and d.local_date=p_delivery.local_date
   and d.status in ('pending','claimed','failed') limit 26) active)>25 then return 'active_attempt';end if;
 return null;
end;
$$;
create or replace function public.parts_sms_recurrence_blocked(p_delivery public.p1_parts_alert_deliveries,p_snapshot jsonb)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select public.parts_sms_recurrence_candidate(p_delivery,p_snapshot);
$$;

create function public.parts_sms_insert_delivery(p_recipient public.p1_parts_alert_recipients,p_snapshot jsonb,p_origin text,
 p_parent uuid,p_root uuid,p_generation uuid,p_prior uuid default null,p_intervening uuid default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid:=gen_random_uuid();v_valid boolean;d public.p1_parts_alert_deliveries%rowtype;
begin
 v_valid:=exists(select 1 from public.profiles p where p.id=p_recipient.profile_id and p.active and p.role in ('manager','dispatcher','back_office'));
 perform public.parts_sms_cap('p1_parts_alert_deliveries',v_id);
 insert into public.p1_parts_alert_deliveries(id,recipient_id,local_date,request_signature,status,attempt_count,provenance,
  recipient_profile_id,phone_snapshot,timezone,configuration_version,parent_delivery_id,root_delivery_id,next_attempt_at,last_error_code,
  delivery_origin,source_generation_id,prior_same_generation_id,intervening_generation_id)
 values(v_id,p_recipient.id,(p_snapshot->>'localDate')::date,p_snapshot->>'requestSignature',
  case when v_valid then 'pending' else 'not_deliverable' end,0,'owned_v1',p_recipient.profile_id,p_recipient.phone_e164,
  p_snapshot->>'timezone',(p_snapshot->>'configurationVersion')::bigint,p_parent,p_root,
  case when v_valid then clock_timestamp() else null end,case when v_valid then null else 'RECIPIENT_NOT_DELIVERABLE' end,
  p_origin,p_generation,p_prior,p_intervening) returning * into d;
 if p_origin='source_recurrence' then perform public.parts_sms_record(d,'source_recurrence','pending','PARTS_SOURCE_RECURRENCE_QUEUED');end if;
 return v_id;
end;
$$;
create or replace function public.parts_sms_add_delivery(p_recipient public.p1_parts_alert_recipients,p_snapshot jsonb,p_parent uuid default null,p_root uuid default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare g public.p1_parts_sms_source_generations%rowtype;
begin
 select * into g from public.p1_parts_sms_source_generations where recipient_id=p_recipient.id and local_date=(p_snapshot->>'localDate')::date
  and request_signature=p_snapshot->>'requestSignature' and timezone=p_snapshot->>'timezone' order by generation desc limit 1;
 return public.parts_sms_insert_delivery(p_recipient,p_snapshot,case when p_parent is null then 'initial' else 'explicit_resend' end,p_parent,p_root,g.id);
end;
$$;
-- Sole automatic recurrence creation command, private to the service evaluator.
-- Returns NULL on a conservative block; no compensating network action exists.
create function public.parts_sms_queue_recurrence(p_recipient public.p1_parts_alert_recipients,p_snapshot jsonb,
 p_generation public.p1_parts_sms_source_generations,p_parent public.p1_parts_alert_deliveries)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare prior public.p1_parts_sms_source_generations%rowtype;intervening public.p1_parts_sms_source_generations%rowtype;
 d public.p1_parts_alert_deliveries%rowtype;v_id uuid;v_superseded int:=0;
begin
 if public.parts_sms_recurrence_barrier(p_recipient.id,(p_snapshot->>'localDate')::date) is not null
   or not public.parts_sms_recipient_current(p_parent) then return null;end if;
 select * into prior from public.p1_parts_sms_source_generations where recipient_id=p_recipient.id and local_date=p_generation.local_date
   and request_signature=p_generation.request_signature and generation<p_generation.generation order by generation desc limit 1;
 select * into intervening from public.p1_parts_sms_source_generations where id=p_generation.previous_generation_id;
 if prior.id is null or intervening.id is null or prior.generation>=intervening.generation
   or intervening.request_signature=p_generation.request_signature
   or p_parent.request_signature<>p_generation.request_signature or p_parent.local_date<>p_generation.local_date
   or p_parent.status not in ('pending','claimed','failed','not_deliverable','superseded')
   or exists(select 1 from public.p1_parts_alert_deliveries child where child.parent_delivery_id=p_parent.id)
   then return null;end if;
 if (select count(*) from (select id from public.p1_parts_alert_deliveries where recipient_id=p_recipient.id and local_date=p_generation.local_date
   and status in ('pending','claimed','failed') limit 26) bounded)>25 then return null;end if;
 -- Atomically invalidate even a still-live PRE-START token before making a
 -- different owner discoverable. Started attempts were rejected above.
 for d in select * from public.p1_parts_alert_deliveries where recipient_id=p_recipient.id and local_date=p_generation.local_date
   and status in ('pending','claimed','failed') order by created_at,id limit 25 for update loop
   perform public.parts_sms_cancel(d,'superseded','PARTS_DIGEST_CHANGED');v_superseded:=v_superseded+1;
 end loop;
 perform 1 from public.profiles where id=p_recipient.profile_id for share;
 perform 1 from public.p1_parts_alert_recipients where id=p_recipient.id for share;
 if not public.parts_sms_recipient_current(p_parent) then raise exception 'RECIPIENT_NOT_DELIVERABLE' using errcode='PT409';end if;
 v_id:=public.parts_sms_insert_delivery(p_recipient,p_snapshot,'source_recurrence',p_parent.id,coalesce(p_parent.root_delivery_id,p_parent.id),
   p_generation.id,prior.id,intervening.id);
 return jsonb_build_object('deliveryId',v_id,'superseded',v_superseded);
end;
$$;
create or replace function public.enqueue_parts_sms_deliveries_v1(p_force boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare snap jsonb;r public.p1_parts_alert_recipients%rowtype;d public.p1_parts_alert_deliveries%rowtype;other public.p1_parts_alert_deliveries%rowtype;
 g public.p1_parts_sms_source_generations%rowtype;v_queued int:=0;v_skipped int:=0;v_superseded int:=0;v_recipients int:=0;
 v_id uuid;v_recurrence int:=0;v_recurrence_queued int:=0;v_prior boolean;v_result jsonb;
begin
 perform public.parts_sms_service();perform public.parts_sms_lock();snap:=public.parts_sms_snapshot(p_force);
 if snap->>'status' in ('ready','nothing_to_send') then
  if (select count(*) from(select id from public.p1_parts_alert_recipients where active limit 26) bounded)>25 then
   return jsonb_build_object('status','capacity_exceeded','localDate',snap->>'localDate','queued',0,'skipped',0,'superseded',0,
    'recurrenceBlocked',0,'recurrenceQueued',0,'parts',snap->'parts','workOrders',snap->'workOrders');end if;
  for r in select * from public.p1_parts_alert_recipients where active order by created_at,id limit 25 loop
   v_recipients:=v_recipients+1;g:=public.parts_sms_observe_source(r.id,snap);
   if snap->>'status'='nothing_to_send' then continue;end if;
   select * into d from public.p1_parts_alert_deliveries candidate where candidate.recipient_id=r.id
    and candidate.local_date=(snap->>'localDate')::date and candidate.request_signature=snap->>'requestSignature'
    and not exists(select 1 from public.p1_parts_alert_deliveries child where child.parent_delivery_id=candidate.id)
    order by candidate.created_at desc,candidate.id desc limit 1 for update;
   if found then
    v_prior:=exists(select 1 from public.p1_parts_sms_source_generations prior where prior.recipient_id=r.id and prior.local_date=g.local_date
     and prior.request_signature=g.request_signature and prior.generation<g.generation);
    if d.source_generation_id=g.id and d.delivery_origin='source_recurrence' and d.status<>'superseded' then v_skipped:=v_skipped+1;continue;end if;
    if v_prior or d.status='superseded' then
     v_result:=public.parts_sms_queue_recurrence(r,snap,g,d);
     if v_result is null then v_recurrence:=v_recurrence+1;v_skipped:=v_skipped+1;
     else v_queued:=v_queued+1;v_recurrence_queued:=v_recurrence_queued+1;v_superseded:=v_superseded+(v_result->>'superseded')::integer;end if;
     continue;
    end if;
   end if;
   if public.parts_sms_daily_blocked(r.id,(snap->>'localDate')::date) then v_skipped:=v_skipped+1;continue;end if;
   for other in select * from public.p1_parts_alert_deliveries where recipient_id=r.id and local_date=(snap->>'localDate')::date
     and request_signature<>snap->>'requestSignature' and provenance='owned_v1' and status in ('pending','claimed','failed')
     and send_started_at is null order by created_at,id limit 25 for update loop
     perform public.parts_sms_cancel(other,'superseded','PARTS_DIGEST_CHANGED');v_superseded:=v_superseded+1;
   end loop;
   if exists(select 1 from public.p1_parts_alert_deliveries where recipient_id=r.id and local_date=(snap->>'localDate')::date
     and request_signature<>snap->>'requestSignature' and provenance='owned_v1' and status in ('pending','claimed','failed') and send_started_at is null)
     then v_skipped:=v_skipped+1;continue;end if;
   if d.id is not null then v_skipped:=v_skipped+1;continue;end if;
   v_id:=public.parts_sms_add_delivery(r,snap);v_queued:=v_queued+1;
  end loop;
 end if;
 perform public.parts_sms_clear();
 return jsonb_build_object('status',case when snap->>'status'<>'ready' then snap->>'status' when v_recipients=0 then 'no_recipients' else 'queued' end,
  'localDate',snap->>'localDate','queued',v_queued,'skipped',v_skipped,'superseded',v_superseded,
  'recurrenceBlocked',v_recurrence,'recurrenceQueued',v_recurrence_queued,'parts',coalesce(snap->'parts','0'::jsonb),'workOrders',coalesce(snap->'workOrders','0'::jsonb));
end;
$$;

create or replace function public.claim_parts_sms_delivery_v1(p_claim_token uuid,p_force boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.p1_parts_alert_deliveries%rowtype;snap jsonb;v_before int:=0;v_unknown int:=0;v_superseded int:=0;v_not int:=0;v_claim jsonb:=null;g public.p1_parts_sms_source_generations%rowtype;v_generation uuid;
begin
  perform public.parts_sms_service();perform public.parts_sms_lock();
  if p_claim_token is null then raise exception 'VALIDATION_FAILED' using errcode='PT422';end if;
  for d in select * from public.p1_parts_alert_deliveries where provenance='owned_v1' and status in ('claimed','sending') and claim_expires_at<=clock_timestamp()
    order by claim_expires_at,id limit 100 for update skip locked loop
    perform public.parts_sms_record(d,'expired',case when d.send_started_at is null then 'pending' else 'unknown' end,
      case when d.send_started_at is null then 'CLAIM_EXPIRED_BEFORE_SEND' else 'SMS_OUTCOME_UNKNOWN' end);
    perform public.parts_sms_cap('p1_parts_alert_deliveries',d.id);
    update public.p1_parts_alert_deliveries set status=case when d.send_started_at is null then 'pending' else 'unknown' end,
      claim_token=null,claim_expires_at=null,next_attempt_at=case when d.send_started_at is null then clock_timestamp() else null end,
      completed_at=case when d.send_started_at is null then null else clock_timestamp() end,
      last_error_code=case when d.send_started_at is null then 'CLAIM_EXPIRED_BEFORE_SEND' else 'SMS_OUTCOME_UNKNOWN' end where id=d.id;
    if d.send_started_at is null then v_before:=v_before+1;else v_unknown:=v_unknown+1;end if;
  end loop;
  snap:=public.parts_sms_snapshot(p_force);
  if snap->>'status' not in ('disabled','unscheduled','before_cutoff','capacity_exceeded') then
    select candidate.* into d from public.p1_parts_alert_deliveries candidate where candidate.provenance='owned_v1'
      and (candidate.status='pending' or public.parts_sms_retry_pending(candidate)) and candidate.next_attempt_at<=clock_timestamp()
      and not exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=candidate.id)
      order by candidate.next_attempt_at,candidate.created_at,candidate.id limit 1 for update skip locked;
    if found then
      g:=public.parts_sms_observe_source(d.recipient_id,snap);v_generation:=public.parts_sms_delivery_generation(d);
      if snap->>'status'<>'ready' or d.local_date::text<>snap->>'localDate' or d.timezone<>snap->>'timezone'
        or d.request_signature<>snap->>'requestSignature'
        or (public.parts_sms_origin(d)<>'explicit_resend' and v_generation is not null and g.id is distinct from v_generation) then
        perform public.parts_sms_cancel(d,'superseded','PARTS_DIGEST_CHANGED');v_superseded:=1;
      elsif d.delivery_origin='source_recurrence' and public.parts_sms_recurrence_barrier(d.recipient_id,d.local_date,d.id) is not null then
        perform public.parts_sms_cancel(d,'superseded','PARTS_SOURCE_RECURRENCE_REVIEW');v_superseded:=1;
      elsif not public.parts_sms_recipient_valid(d) then perform public.parts_sms_cancel(d,'not_deliverable','RECIPIENT_NOT_DELIVERABLE');v_not:=1;
      else
        if exists(select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=d.id and a.claim_token=p_claim_token) then
          raise exception 'OPERATION_REUSED' using errcode='PT409';end if;
        perform public.parts_sms_cap('p1_parts_alert_deliveries',d.id);
        update public.p1_parts_alert_deliveries set status='claimed',attempt_count=attempt_count+1,claim_token=p_claim_token,
          claimed_at=clock_timestamp(),claim_expires_at=clock_timestamp()+interval '60 seconds',send_started_at=null,completed_at=null,next_attempt_at=null,last_error_code=null
          where id=d.id returning * into d;
        perform public.parts_sms_record(d,'claimed','claimed');v_claim:=jsonb_build_object('id',d.id);
      end if;
    end if;
  end if;
  perform public.parts_sms_clear();return jsonb_build_object('claim',v_claim,'recoveredBeforeSend',v_before,'recoveredUnknown',v_unknown,'superseded',v_superseded,'notDeliverable',v_not);
end;
$$;

create or replace function public.prepare_parts_sms_send_v1(p_delivery_id uuid,p_claim_token uuid,p_force boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.p1_parts_alert_deliveries%rowtype;snap jsonb;g public.p1_parts_sms_source_generations%rowtype;v_generation uuid;
begin
  perform public.parts_sms_service();perform public.parts_sms_lock();
  select * into d from public.p1_parts_alert_deliveries where id=p_delivery_id for update;
  if not found or d.provenance<>'owned_v1' or d.status<>'claimed' or d.claim_token is distinct from p_claim_token or d.claim_expires_at<=clock_timestamp() then return null;end if;
  snap:=public.parts_sms_snapshot(p_force);
  if snap->>'status' in ('disabled','unscheduled','before_cutoff','capacity_exceeded') then return null;end if;
  g:=public.parts_sms_observe_source(d.recipient_id,snap);v_generation:=public.parts_sms_delivery_generation(d);
  if snap->>'status'<>'ready' or d.local_date::text<>snap->>'localDate' or d.timezone<>snap->>'timezone' or d.request_signature<>snap->>'requestSignature'
    or (public.parts_sms_origin(d)<>'explicit_resend' and v_generation is not null and g.id is distinct from v_generation) then
    perform public.parts_sms_cancel(d,'superseded','PARTS_DIGEST_CHANGED');perform public.parts_sms_clear();return jsonb_build_object('status','superseded');end if;
  if d.delivery_origin='source_recurrence' and public.parts_sms_recurrence_barrier(d.recipient_id,d.local_date,d.id) is not null then
    perform public.parts_sms_cancel(d,'superseded','PARTS_SOURCE_RECURRENCE_REVIEW');perform public.parts_sms_clear();return jsonb_build_object('status','superseded');end if;
  perform 1 from public.profiles where id=d.recipient_profile_id for share;
  perform 1 from public.p1_parts_alert_recipients where id=d.recipient_id for share;
  if not public.parts_sms_recipient_valid(d) then
    perform public.parts_sms_cancel(d,'not_deliverable','RECIPIENT_NOT_DELIVERABLE');perform public.parts_sms_clear();return jsonb_build_object('status','not_deliverable');end if;
  perform public.parts_sms_cap('p1_parts_alert_deliveries',d.id);
  update public.p1_parts_alert_deliveries set status='sending',send_started_at=clock_timestamp() where id=d.id returning * into d;
  perform public.parts_sms_record(d,'send_started','sending');perform public.parts_sms_clear();
  return jsonb_build_object('id',d.id,'phoneE164',d.phone_snapshot,'localDate',d.local_date,'requestSignature',d.request_signature,
    'parts',snap->'parts','workOrders',snap->'workOrders','previewIds',snap->'previewIds');
end;
$$;

create or replace function public.parts_sms_projection(p_delivery public.p1_parts_alert_deliveries,p_snapshot jsonb)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 with flags as(select
   p_delivery.provenance='owned_v1' and p_snapshot->>'status'='ready' and p_delivery.local_date::text=p_snapshot->>'localDate'
     and p_delivery.timezone=p_snapshot->>'timezone' and p_delivery.request_signature=p_snapshot->>'requestSignature'
     and p_delivery.status<>'superseded' and public.parts_sms_recipient_current(p_delivery)
     and not exists(select 1 from public.p1_parts_alert_deliveries child where child.parent_delivery_id=p_delivery.id)
     and not public.parts_sms_recurrence_candidate(p_delivery,p_snapshot) as current,
   exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=p_delivery.id and o.action='manual_resolution') as manual,
   exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=p_delivery.id) as operated,
   p_delivery.status in ('unknown','not_deliverable') or (p_delivery.status='failed' and not coalesce(public.parts_sms_retry_pending(p_delivery),false))
     or (p_delivery.provenance='legacy' and p_delivery.status='claimed') as actionable)
 select jsonb_build_object('id',p_delivery.id,'rootId',coalesce(p_delivery.root_delivery_id,p_delivery.id),'recipientId',p_delivery.recipient_id,
   'origin',public.parts_sms_origin(p_delivery),
   'recurrenceGeneration',(select generation from public.p1_parts_sms_source_generations where id=p_delivery.source_generation_id),
   'recurrenceBlockCategory',public.parts_sms_recurrence_block_category(p_delivery,p_snapshot),
   'recipientName',(select left(p.name,160) from public.p1_parts_alert_recipients r join public.profiles p on p.id=r.profile_id where r.id=p_delivery.recipient_id),
   'localDate',p_delivery.local_date,'timezone',coalesce(p_delivery.timezone,(select timezone from public.p1_parts_alert_settings where singleton)),
   'state',case when manual then 'manually_resolved' when p_delivery.provenance='legacy' and p_delivery.status in ('failed','claimed') then 'unknown' else p_delivery.status end,
   'providerState',p_delivery.provider_status,'legacy',p_delivery.provenance='legacy','current',coalesce(current,false),
   'attemptCount',p_delivery.attempt_count,'createdAt',p_delivery.created_at,
   'lastAttemptAt',case when p_delivery.provenance='legacy' then p_delivery.claimed_at else (select a.created_at from public.p1_parts_sms_attempt_events a where a.delivery_id=p_delivery.id order by a.created_at desc,a.id desc limit 1) end,
   'completedAt',coalesce((select o.created_at from public.p1_parts_sms_operations o where o.delivery_id=p_delivery.id and o.action='manual_resolution'),p_delivery.completed_at),
   'code',case when p_delivery.provenance='legacy' and p_delivery.status in ('failed','claimed') then 'LEGACY_OUTCOME_UNVERIFIED'
     when public.parts_sms_recurrence_blocked(p_delivery,p_snapshot) then 'PARTS_SOURCE_RECURRENCE_REVIEW'
     when p_delivery.status in ('claimed','sending') and p_delivery.claim_expires_at<=clock_timestamp() then 'CLAIM_EXPIRED_REVIEW'
     when (p_delivery.status='pending' and p_delivery.created_at<clock_timestamp()-interval '6 minutes')
       or (public.parts_sms_retry_pending(p_delivery) and p_delivery.next_attempt_at<clock_timestamp()-interval '6 minutes') then 'PENDING_WORKER_DELAY'
     else public.parts_sms_safe_code(p_delivery.last_error_code) end,
   'nextAttemptAt',p_delivery.next_attempt_at,'statusCheckStale',p_delivery.status_check_stale,
   'canResend',coalesce(current,false) and actionable and not operated
     and not (p_delivery.status='unknown' and p_delivery.provider_message_id is not null)
     and not (p_delivery.delivery_origin='source_recurrence' and exists(select 1 from public.p1_parts_alert_deliveries other
       where other.recipient_id=p_delivery.recipient_id and other.local_date=p_delivery.local_date and other.id<>p_delivery.id
         and (exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=other.id and o.action='manual_resolution' and o.created_at>=p_delivery.created_at)
           or exists(select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=other.id and a.created_at>=p_delivery.created_at
             and (a.provider_message_id is not null or a.outcome='accepted' or a.state in ('accepted','sent','delivered','unknown')))))),
   'canResolve',((actionable or p_delivery.status_check_stale) and not operated and p_delivery.status not in ('pending','claimed','sending','delivered','superseded')
      or (p_delivery.provenance='legacy' and p_delivery.status='claimed' and not operated))
      and (p_delivery.status_claim_token is null or p_delivery.status_claim_expires_at<=clock_timestamp())
      and (not public.parts_sms_recurrence_candidate(p_delivery,p_snapshot) or p_delivery.status in ('unknown','accepted','sent')))
 from flags;
$$;

create or replace function public.get_parts_sms_history_v1(p_delivery_id uuid,p_cursor jsonb default null,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_root uuid;v_recipient uuid;v_date date;v_at timestamptz;v_id text;v_snapshot timestamptz:=clock_timestamp();v_items jsonb;v_more boolean;v_next jsonb;
begin
  perform public.parts_sms_actor();select coalesce(root_delivery_id,id),recipient_id,local_date into v_root,v_recipient,v_date from public.p1_parts_alert_deliveries where id=p_delivery_id;
  if not found then raise exception 'DELIVERY_NOT_FOUND' using errcode='PT404';end if;
  if p_limit is null or p_limit not between 1 and 50 then raise exception 'VALIDATION_FAILED' using errcode='PT422';end if;
  if p_cursor is not null then begin
    if jsonb_typeof(p_cursor)<>'object' or p_cursor-array['version','deliveryId','createdAt','id','snapshotAt']<>'{}'
      or not(p_cursor ?& array['version','deliveryId','createdAt','id','snapshotAt']) or p_cursor->>'version' is distinct from '1'
      or p_cursor->>'deliveryId' is distinct from p_delivery_id::text then raise exception 'bad';end if;
    v_at:=(p_cursor->>'createdAt')::timestamptz;v_id:=p_cursor->>'id';v_snapshot:=(p_cursor->>'snapshotAt')::timestamptz;
    if v_at is null or v_id is null or v_id !~* '^(delivery|attempt|operation|status):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      or v_snapshot is null or not isfinite(v_at) or not isfinite(v_snapshot) or v_at>v_snapshot or v_snapshot>clock_timestamp() then raise exception 'bad';end if;
  exception when others then raise exception 'INVALID_CURSOR' using errcode='PT422';end;end if;
  with family as(select * from public.p1_parts_alert_deliveries where recipient_id=v_recipient and local_date=v_date),
  history as (
    select 'delivery:'||d.id as id,'delivery'::text as kind,case when d.provenance='legacy' and d.status in ('failed','claimed') then 'unknown' else d.status end as state,
      d.provider_status,d.created_at,d.completed_at,null::text as reason,0 as sequence,
      case when d.provenance='legacy' then 'LEGACY_OUTCOME_UNVERIFIED' else public.parts_sms_safe_code(d.last_error_code) end as code from family d
    union all select case when a.phase='provider_status' then 'status:' else 'attempt:' end||a.id,
      case when a.phase='provider_status' then 'provider_status' when a.phase='source_recurrence' then 'source_recurrence' else 'attempt' end,a.state,
      case when a.provider_status='unknown' then null else a.provider_status end,a.created_at,
      case when a.phase in ('completed','expired','cancelled','provider_status') then a.created_at else null end,
      case when a.phase='source_recurrence' then 'Source signature became current again before any SMS send started.' else null end,a.sequence,public.parts_sms_safe_code(a.code)
      from public.p1_parts_sms_attempt_events a join family d on d.id=a.delivery_id
    union all select 'operation:'||o.operation_id,case when o.action='resend' then 'resend' else 'manual_resolution' end,
      case when o.action='resend' then 'pending' else 'manually_resolved' end,null,o.created_at,o.created_at,o.reason,0,null
      from public.p1_parts_sms_operations o join family d on d.id=o.delivery_id
  ),candidates as(select * from history where created_at<=v_snapshot and (v_at is null or (created_at,id)<(v_at,v_id)) order by created_at desc,id desc limit p_limit+1),
  page as(select * from candidates order by created_at desc,id desc limit p_limit)
  select coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'state',p.state,'providerState',p.provider_status,'createdAt',p.created_at,
    'completedAt',p.completed_at,'reason',p.reason,'sequence',p.sequence,'code',p.code) order by p.created_at desc,p.id desc) from page p),'[]'),
    (select count(*)>p_limit from candidates),(select jsonb_build_object('version',1,'deliveryId',p_delivery_id,'createdAt',p.created_at,'id',p.id,'snapshotAt',v_snapshot)
      from page p order by p.created_at,p.id limit 1) into v_items,v_more,v_next;
  return jsonb_build_object('items',v_items,'hasMore',v_more,'nextCursor',case when v_more then v_next else null end);
end;
$$;

create or replace function public.get_parts_sms_worker_health_v1()
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.p1_parts_sms_runs%rowtype;s public.p1_parts_alert_settings%rowtype;snap jsonb;
begin
  perform public.parts_sms_actor();select * into r from public.p1_parts_sms_runs order by started_at desc,id desc limit 1;
  select * into strict s from public.p1_parts_alert_settings where singleton;
  snap:=public.parts_sms_snapshot(true);
  return jsonb_build_object('enabled',s.enabled,'timezone',s.timezone,'cutoffTime',s.cutoff_time,'lastStartedAt',r.started_at,
    'lastCompletedAt',(select completed_at from public.p1_parts_sms_runs where completed_at is not null order by completed_at desc,id desc limit 1),
    'lastSuccessfulAt',(select completed_at from public.p1_parts_sms_runs where completed_at is not null and result_code='RUN_COMPLETE' order by completed_at desc,id desc limit 1),'lastResultCode',r.result_code,
    'stale',r.started_at is null or r.started_at<clock_timestamp()-interval '6 minutes','cadenceMinutes',3,'currentRunIncomplete',r.id is not null and r.completed_at is null,
    'oldestPendingAt',(select created_at from public.p1_parts_alert_deliveries d where d.provenance='owned_v1' and (d.status='pending' or public.parts_sms_retry_pending(d)) order by created_at,id limit 1),
    'countsCap',1000,
    'lastRunRecurrenceQueued',coalesce((select (summary->>'recurrenceQueued')::integer from public.p1_parts_sms_runs where completed_at is not null order by completed_at desc,id desc limit 1),0),
    'lastRunRecurrenceBlocked',coalesce((select (summary->>'recurrenceBlocked')::integer from public.p1_parts_sms_runs where completed_at is not null order by completed_at desc,id desc limit 1),0),
    'sourceRecurrenceCount',(select count(*) from (select d.id from public.p1_parts_alert_deliveries d where public.parts_sms_recurrence_blocked(d,snap) limit 1000) bounded_recurrence),
    'unknownCount',(select count(*) from (select d.id from public.p1_parts_alert_deliveries d where (d.status='unknown' or(d.provenance='legacy' and d.status in ('claimed','failed')))
      and not exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.id) and not exists(select 1 from public.p1_parts_alert_deliveries child where child.parent_delivery_id=d.id) limit 1000) bounded_unknown),
    'notDeliverableCount',(select count(*) from (select d.id from public.p1_parts_alert_deliveries d where d.status='not_deliverable'
      and not exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.id)
      and not exists(select 1 from public.p1_parts_alert_deliveries child where child.parent_delivery_id=d.id) limit 1000) bounded_undeliverable),
    'staleStatusCount',(select count(*) from (select d.id from public.p1_parts_alert_deliveries d where d.status_check_stale and not exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.id) limit 1000) bounded_status),
    'expiredClaimCount',(select count(*) from (select id from public.p1_parts_alert_deliveries where provenance='owned_v1' and status in ('claimed','sending') and claim_expires_at<=clock_timestamp() limit 1000) bounded_expired));
end;
$$;

create or replace function public.parts_sms_safe_code(p_code text)
returns text language sql immutable set search_path=pg_catalog,public as $$
 select case when p_code in ('TWILIO_NOT_CONFIGURED','RECIPIENT_NOT_DELIVERABLE','PARTS_SMS_MESSAGE_INVALID','TWILIO_BEFORE_SEND_CANCELLED',
 'TWILIO_UNKNOWN','TWILIO_RESPONSE_UNCONFIRMED','TWILIO_STATUS_UNAVAILABLE','SMS_PROVIDER_UNDELIVERED','SMS_OUTCOME_UNKNOWN',
 'PARTS_DIGEST_CHANGED','CLAIM_EXPIRED_BEFORE_SEND','LEGACY_OUTCOME_UNVERIFIED','CLAIM_EXPIRED_REVIEW','PENDING_WORKER_DELAY','PARTS_SOURCE_RECURRENCE_REVIEW','PARTS_SOURCE_RECURRENCE_QUEUED') then p_code when p_code is null then null else 'SMS_DELIVERY_FAILED' end;
$$;

create or replace function public.list_parts_sms_unresolved_v1(p_state text default null,p_search text default '',p_cursor jsonb default null,p_limit integer default 25)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_search text:=btrim(coalesce(p_search,''));v_at timestamptz;v_id uuid;v_snapshot timestamptz:=clock_timestamp();
  v_items jsonb;v_more boolean;v_next jsonb;snap jsonb;
begin
  perform public.parts_sms_actor();
  if p_limit is null or p_limit not between 1 and 50 or length(v_search)>100 or (p_state is not null and p_state not in ('unknown','failed','not_deliverable','status_stale','history')) then
    raise exception 'VALIDATION_FAILED' using errcode='PT422';end if;
  if p_cursor is not null then begin
    if jsonb_typeof(p_cursor)<>'object' or p_cursor-array['version','state','search','createdAt','id','snapshotAt']<>'{}'
      or not(p_cursor ?& array['version','state','search','createdAt','id','snapshotAt']) or p_cursor->>'version' is distinct from '1'
      or p_cursor->>'state' is distinct from p_state or p_cursor->>'search' is distinct from v_search then raise exception 'bad';end if;
    v_at:=(p_cursor->>'createdAt')::timestamptz;v_id:=(p_cursor->>'id')::uuid;v_snapshot:=(p_cursor->>'snapshotAt')::timestamptz;
    if v_at is null or v_id is null or v_snapshot is null or not isfinite(v_at) or not isfinite(v_snapshot) or v_at>v_snapshot or v_snapshot>clock_timestamp() then raise exception 'bad';end if;
  exception when others then raise exception 'INVALID_CURSOR' using errcode='PT422';end;end if;
  snap:=public.parts_sms_snapshot(true);
  with candidates as (
    select d.* from public.p1_parts_alert_deliveries d
    where (p_state='history' or (
      (not exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.id and o.action='manual_resolution') or public.parts_sms_recurrence_candidate(d,snap))
      and ((d.provenance='legacy' and d.status in ('claimed','failed')) or d.status in ('unknown','not_deliverable')
        or (d.status='failed' and not coalesce(public.parts_sms_retry_pending(d),false)) or d.status_check_stale
        or (d.provenance='owned_v1' and d.status in ('claimed','sending') and d.claim_expires_at<=clock_timestamp())
        or (d.status='pending' and d.created_at<clock_timestamp()-interval '6 minutes')
        or (public.parts_sms_retry_pending(d) and d.next_attempt_at<clock_timestamp()-interval '6 minutes')
        or public.parts_sms_recurrence_blocked(d,snap))
      and (p_state is null or (p_state='unknown' and (d.status='unknown' or (d.provenance='legacy' and d.status in ('claimed','failed'))))
        or (p_state='failed' and d.status='failed' and d.provenance='owned_v1') or (p_state='not_deliverable' and d.status='not_deliverable')
        or (p_state='status_stale' and d.status_check_stale))))
      and not exists(select 1 from public.p1_parts_alert_deliveries child where child.parent_delivery_id=d.id)
      and (v_search='' or strpos(d.local_date::text,v_search)>0 or strpos(d.recipient_id::text,lower(v_search))>0
        or exists(select 1 from public.p1_parts_alert_recipients r join public.profiles p on p.id=r.profile_id
          where r.id=d.recipient_id and strpos(lower(coalesce(p.name,'')),lower(v_search))>0))
      and d.created_at<=v_snapshot and (v_at is null or (d.created_at,d.id)<(v_at,v_id))
    order by d.created_at desc,d.id desc limit p_limit+1
  ), page as(select * from candidates order by created_at desc,id desc limit p_limit)
  select coalesce((select jsonb_agg(public.parts_sms_projection(p,snap) order by p.created_at desc,p.id desc) from page p),'[]'),
    (select count(*)>p_limit from candidates),
    (select jsonb_build_object('version',1,'state',p_state,'search',v_search,'createdAt',p.created_at,'id',p.id,'snapshotAt',v_snapshot) from page p order by p.created_at,p.id limit 1)
    into v_items,v_more,v_next;
  return jsonb_build_object('items',v_items,'hasMore',v_more,'nextCursor',case when v_more then v_next else null end);
end;
$$;

revoke all on function public.parts_sms_origin(public.p1_parts_alert_deliveries),
  public.parts_sms_delivery_generation(public.p1_parts_alert_deliveries),
  public.parts_sms_append_generation(uuid,date,text,text,bigint,uuid),
  public.parts_sms_observe_source(uuid,jsonb),
  public.parts_sms_recurrence_barrier(uuid,date,uuid),
  public.parts_sms_recurrence_candidate(public.p1_parts_alert_deliveries,jsonb),
  public.parts_sms_recurrence_block_category(public.p1_parts_alert_deliveries,jsonb),
  public.parts_sms_recurrence_blocked(public.p1_parts_alert_deliveries,jsonb),
  public.parts_sms_insert_delivery(public.p1_parts_alert_recipients,jsonb,text,uuid,uuid,uuid,uuid,uuid),
  public.parts_sms_add_delivery(public.p1_parts_alert_recipients,jsonb,uuid,uuid),
  public.parts_sms_queue_recurrence(public.p1_parts_alert_recipients,jsonb,public.p1_parts_sms_source_generations,public.p1_parts_alert_deliveries),
  public.enqueue_parts_sms_deliveries_v1(boolean),
  public.claim_parts_sms_delivery_v1(uuid,boolean),
  public.prepare_parts_sms_send_v1(uuid,uuid,boolean),
  public.parts_sms_projection(public.p1_parts_alert_deliveries,jsonb),
  public.list_parts_sms_unresolved_v1(text,text,jsonb,integer),
  public.get_parts_sms_history_v1(uuid,jsonb,integer),
  public.get_parts_sms_worker_health_v1(),
  public.parts_sms_safe_code(text) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_parts_sms_deliveries_v1(boolean),public.claim_parts_sms_delivery_v1(uuid,boolean),public.prepare_parts_sms_send_v1(uuid,uuid,boolean) to service_role;
grant execute on function public.get_parts_sms_history_v1(uuid,jsonb,integer),public.get_parts_sms_worker_health_v1(),public.list_parts_sms_unresolved_v1(text,text,jsonb,integer) to authenticated;
commit;
