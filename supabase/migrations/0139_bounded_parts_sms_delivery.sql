-- Phase 5C: command-owned daily parts SMS and immutable delivery history.
-- Pause the SMS scheduler for migration/candidate cutover. Legacy rows remain
-- legacy/unverified; never infer that an old failed/claimed send was unaccepted.
begin;
lock table public.p1_parts_alert_settings,public.p1_parts_alert_recipients,
  public.p1_parts_alert_deliveries in share row exclusive mode;
alter table public.p1_parts_alert_settings add column configuration_version bigint not null default 1;
alter table public.p1_parts_alert_recipients drop constraint p1_parts_alert_recipients_profile_id_fkey;
alter table public.p1_parts_alert_recipients add constraint p1_parts_alert_recipients_profile_id_fkey
  foreign key(profile_id) references public.profiles(id) on delete restrict;
alter table public.p1_parts_alert_deliveries drop constraint p1_parts_alert_deliveries_recipient_id_fkey;
alter table public.p1_parts_alert_deliveries add constraint p1_parts_alert_deliveries_recipient_id_fkey
  foreign key(recipient_id) references public.p1_parts_alert_recipients(id) on delete restrict;
alter table public.p1_parts_alert_deliveries
  add column provenance text not null default 'legacy' check(provenance in ('legacy','owned_v1')),
  add column recipient_profile_id uuid references public.profiles(id) on delete restrict,
  add column phone_snapshot text,
  add column timezone text,
  add column configuration_version bigint,
  add column parent_delivery_id uuid references public.p1_parts_alert_deliveries(id) on delete restrict,
  add column root_delivery_id uuid references public.p1_parts_alert_deliveries(id) on delete restrict,
  add column created_at timestamptz not null default clock_timestamp(),
  add column next_attempt_at timestamptz,
  add column claim_token uuid,
  add column claim_expires_at timestamptz,
  add column send_started_at timestamptz,
  add column last_error_code text,
  add column provider_status text,
  add column next_status_at timestamptz,
  add column status_check_count integer not null default 0,
  add column status_claim_token uuid,
  add column status_claim_expires_at timestamptz,
  add column status_check_stale boolean not null default false;
-- Derive only newly added metadata from existing server claim evidence. No
-- historical delivery/attempt outcome or old column is rewritten.
update public.p1_parts_alert_deliveries set created_at=claimed_at where claimed_at is not null;
alter table public.p1_parts_alert_deliveries drop constraint p1_parts_alert_deliveries_status_check;
alter table public.p1_parts_alert_deliveries add constraint p1_parts_alert_deliveries_status_check
  check(status in ('pending','claimed','sending','accepted','sent','delivered','failed','unknown','not_deliverable','superseded'));
alter table public.p1_parts_alert_deliveries drop constraint p1_parts_alert_deliveries_attempt_count_check;
alter table public.p1_parts_alert_deliveries add constraint p1_parts_alert_deliveries_attempt_count_check check(attempt_count>=0);
alter table public.p1_parts_alert_deliveries drop constraint p1_parts_alert_deliveries_recipient_id_local_date_key;
create unique index p1_parts_sms_original_event on public.p1_parts_alert_deliveries(recipient_id,local_date,request_signature)
  where parent_delivery_id is null;
create unique index p1_parts_sms_explicit_child on public.p1_parts_alert_deliveries(parent_delivery_id) where parent_delivery_id is not null;
-- Legacy provider references were not validated and are not rewritten/indexed.
create unique index p1_parts_sms_owned_provider_sid on public.p1_parts_alert_deliveries(provider_message_id)
  where provenance='owned_v1' and provider_message_id is not null;
create index p1_parts_sms_daily_identity on public.p1_parts_alert_deliveries(recipient_id,local_date,created_at,id);
create index p1_parts_sms_due on public.p1_parts_alert_deliveries(next_attempt_at,created_at,id)
  where provenance='owned_v1' and status in ('pending','failed');
create index p1_parts_sms_status_due on public.p1_parts_alert_deliveries(next_status_at,id)
  where provenance='owned_v1' and provider_message_id is not null and not status_check_stale;
create index p1_parts_sms_unresolved on public.p1_parts_alert_deliveries(created_at desc,id desc);
create index p1_parts_sms_oldest_pending on public.p1_parts_alert_deliveries(created_at,id)
  where provenance='owned_v1' and status in ('pending','failed');
alter table public.p1_parts_alert_deliveries add constraint p1_parts_sms_owned_shape check(provenance='legacy' or (
  recipient_profile_id is not null and phone_snapshot is not null and phone_snapshot ~ '^\+[1-9][0-9]{7,14}$' and timezone is not null
  and configuration_version is not null and request_signature ~ '^[a-f0-9]{64}$'
  and ((parent_delivery_id is null)=(root_delivery_id is null))
  and ((status in ('claimed','sending'))=(claim_token is not null and claim_expires_at is not null))
  and (provider_message_id is null or provider_message_id ~ '^(SM|MM)[0-9a-fA-F]{32}$')
  and (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,80}$')
));
create table public.p1_parts_sms_attempt_events (
  id uuid primary key default gen_random_uuid(),delivery_id uuid not null references public.p1_parts_alert_deliveries(id) on delete restrict,
  sequence integer not null check(sequence>=0),phase text not null check(phase in ('claimed','send_started','completed','expired','cancelled','provider_status')),
  claim_token uuid,state text not null,code text,provider_message_id text,provider_status text,
  outcome text,retry_after_seconds integer check(retry_after_seconds between 0 and 3600),
  created_at timestamptz not null default clock_timestamp(),
  unique(delivery_id,claim_token,phase)
);
create index p1_parts_sms_attempt_history on public.p1_parts_sms_attempt_events(delivery_id,created_at desc,id desc);
create table public.p1_parts_sms_operations (
  operation_id uuid primary key,delivery_id uuid not null unique references public.p1_parts_alert_deliveries(id) on delete restrict,
  action text not null check(action in ('resend','manual_resolution')),actor_id uuid not null references public.profiles(id) on delete restrict,
  reason text not null check(reason=btrim(reason) and length(reason) between 1 and 500),created_at timestamptz not null default clock_timestamp()
);
create table public.p1_parts_sms_runs (
  id uuid primary key,release text not null check(length(release)<=80),started_at timestamptz not null default clock_timestamp(),
  settings_enabled boolean not null,settings_timezone text not null,settings_cutoff_time time,local_date date not null,
  trigger_source text not null default 'service_cron_or_manual' check(trigger_source='service_cron_or_manual'),
  completed_at timestamptz,summary jsonb,result_code text
);
create index p1_parts_sms_runs_recent on public.p1_parts_sms_runs(started_at desc,id desc);
create index p1_parts_sms_runs_completed on public.p1_parts_sms_runs(completed_at desc,id desc) where completed_at is not null;
create index p1_parts_sms_runs_successful on public.p1_parts_sms_runs(completed_at desc,id desc) where completed_at is not null and result_code='RUN_COMPLETE';
create table public.p1_parts_sms_guards (transaction_id bigint not null,relation_name text not null,target_id uuid not null,primary key(transaction_id,relation_name,target_id));
alter table public.p1_parts_sms_attempt_events enable row level security;
alter table public.p1_parts_sms_operations enable row level security;
alter table public.p1_parts_sms_runs enable row level security;
alter table public.p1_parts_sms_guards enable row level security;
revoke all on public.p1_parts_alert_settings,public.p1_parts_alert_recipients,public.p1_parts_alert_deliveries,
  public.p1_parts_sms_attempt_events,public.p1_parts_sms_operations,public.p1_parts_sms_runs,public.p1_parts_sms_guards from public,anon,authenticated,service_role;
grant select on public.p1_parts_alert_settings,public.p1_parts_alert_recipients to service_role;

create function public.parts_sms_service()
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if current_setting('role')<>'service_role' or auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode='42501';end if;
end;
$$;
create function public.parts_sms_actor(p_actor_id uuid default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid:=coalesce(p_actor_id,auth.uid());
begin
  if p_actor_id is not null then perform public.parts_sms_service();end if;
  perform 1 from public.profiles p where p.id=v_id and p.active and p.role in ('manager','dispatcher','back_office') for share;
  if not found or public.profile_has_staff_permission(v_id,'invoice_controller') then raise exception 'FORBIDDEN' using errcode='42501';end if;
  return v_id;
end;
$$;
create function public.parts_sms_lock() returns void language sql security definer set search_path=pg_catalog,public as $$
  select pg_advisory_xact_lock(hashtextextended('p1-parts-sms-command',0));
$$;
create function public.parts_sms_cap(p_table text,p_id uuid) returns void language sql security definer set search_path=pg_catalog,public as $$
  insert into public.p1_parts_sms_guards values(txid_current(),p_table,p_id) on conflict do nothing;
$$;
create function public.parts_sms_clear() returns void language sql security definer set search_path=pg_catalog,public as $$
  delete from public.p1_parts_sms_guards where transaction_id=txid_current();
$$;
create function public.guard_parts_sms_records()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;v_new jsonb;v_old jsonb;
begin
  if public.lifecycle_is_owner_maintenance() then return case when tg_op='DELETE' then old else new end;end if;
  if tg_op='DELETE' then raise exception 'SMS_HISTORY_IMMUTABLE' using errcode='42501';end if;
  v_new:=to_jsonb(new);v_id:=case when tg_table_name='p1_parts_alert_settings' then '00000000-0000-0000-0000-000000000001'::uuid
    when tg_table_name='p1_parts_sms_operations' then (v_new->>'operation_id')::uuid else (v_new->>'id')::uuid end;
  if not exists(select 1 from public.p1_parts_sms_guards g where g.transaction_id=txid_current() and g.relation_name=tg_table_name and g.target_id=v_id) then
    raise exception 'SMS_COMMAND_REQUIRED' using errcode='42501';end if;
  if tg_op='UPDATE' then
    v_old:=to_jsonb(old);
    if tg_table_name='p1_parts_alert_deliveries' then
      if old.provenance='legacy' or
        v_new-array['status','attempt_count','claimed_at','completed_at','next_attempt_at','claim_token','claim_expires_at','send_started_at',
          'last_error_code','provider_status','provider_message_id','next_status_at','status_check_count','status_claim_token','status_claim_expires_at','status_check_stale']
        is distinct from v_old-array['status','attempt_count','claimed_at','completed_at','next_attempt_at','claim_token','claim_expires_at','send_started_at',
          'last_error_code','provider_status','provider_message_id','next_status_at','status_check_count','status_claim_token','status_claim_expires_at','status_check_stale'] then
        raise exception 'SMS_HISTORY_IMMUTABLE' using errcode='42501';end if;
      if old.status in ('delivered','superseded','not_deliverable') and v_new<>v_old then raise exception 'SMS_HISTORY_IMMUTABLE' using errcode='42501';end if;
      if old.status='unknown' and new.status<>'unknown' and not(old.provider_message_id is not null and new.status in ('accepted','sent','delivered','failed')) then
        raise exception 'SMS_UNKNOWN_QUARANTINED' using errcode='42501';end if;
    elsif tg_table_name='p1_parts_alert_recipients' then
      if v_new-array['active','phone_e164','updated_at'] is distinct from v_old-array['active','phone_e164','updated_at'] then raise exception 'SMS_HISTORY_IMMUTABLE' using errcode='42501';end if;
    elsif tg_table_name='p1_parts_alert_settings' then
      if new.singleton is distinct from old.singleton then raise exception 'SMS_HISTORY_IMMUTABLE' using errcode='42501';end if;
    elsif tg_table_name='p1_parts_sms_runs' then
      if old.completed_at is not null or v_new-array['completed_at','summary','result_code'] is distinct from v_old-array['completed_at','summary','result_code'] then
        raise exception 'SMS_HISTORY_IMMUTABLE' using errcode='42501';end if;
    else raise exception 'SMS_HISTORY_IMMUTABLE' using errcode='42501';end if;
  end if;
  return new;
end;
$$;
create trigger parts_sms_settings_guard before insert or update or delete on public.p1_parts_alert_settings for each row execute function public.guard_parts_sms_records();
create trigger parts_sms_recipient_guard before insert or update or delete on public.p1_parts_alert_recipients for each row execute function public.guard_parts_sms_records();
create trigger parts_sms_delivery_guard before insert or update or delete on public.p1_parts_alert_deliveries for each row execute function public.guard_parts_sms_records();
create trigger parts_sms_attempt_guard before insert or update or delete on public.p1_parts_sms_attempt_events for each row execute function public.guard_parts_sms_records();
create trigger parts_sms_operation_guard before insert or update or delete on public.p1_parts_sms_operations for each row execute function public.guard_parts_sms_records();
create trigger parts_sms_run_guard before insert or update or delete on public.p1_parts_sms_runs for each row execute function public.guard_parts_sms_records();

create function public.parts_sms_record(p_delivery public.p1_parts_alert_deliveries,p_phase text,p_state text,p_code text default null,p_outcome text default null,p_sid text default null,p_provider_status text default null,p_retry integer default null,p_token uuid default null)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid:=gen_random_uuid();
begin
  perform public.parts_sms_cap('p1_parts_sms_attempt_events',v_id);
  insert into public.p1_parts_sms_attempt_events(id,delivery_id,sequence,phase,claim_token,state,code,outcome,provider_message_id,provider_status,retry_after_seconds)
    values(v_id,p_delivery.id,p_delivery.attempt_count,p_phase,coalesce(p_token,p_delivery.claim_token),p_state,p_code,p_outcome,p_sid,p_provider_status,p_retry);
end;
$$;

create or replace function public.configure_p1_parts_alerts(p_actor_id uuid,p_enabled boolean,p_timezone text,p_cutoff_time time,p_recipients jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_actor uuid;item jsonb;r public.p1_parts_alert_recipients%rowtype;v_profile uuid;v_phone text;v_active boolean;v_count integer;v_id uuid;
begin
  v_actor:=public.parts_sms_actor(p_actor_id);perform public.parts_sms_lock();
  if p_enabled is null or p_timezone is null or length(p_timezone)>100
    or not exists(select 1 from pg_timezone_names where name=p_timezone) or jsonb_typeof(p_recipients) is distinct from 'array'
    or (p_enabled and p_cutoff_time is null) then raise exception 'VALIDATION_FAILED' using errcode='PT422';end if;
  if jsonb_array_length(p_recipients)>25 or (p_enabled and jsonb_array_length(p_recipients)=0) then raise exception 'VALIDATION_FAILED' using errcode='PT422';end if;
  if exists(select 1 from jsonb_array_elements(p_recipients) j where jsonb_typeof(j)<>'object' or j-array['profileId','phoneE164','active']<>'{}'::jsonb
    or jsonb_typeof(j->'profileId') is distinct from 'string' or jsonb_typeof(j->'phoneE164') is distinct from 'string'
    or (j ? 'active' and jsonb_typeof(j->'active') is distinct from 'boolean')) then raise exception 'VALIDATION_FAILED' using errcode='PT422';end if;
  begin
    if (select count(distinct (j->>'profileId')::uuid) from jsonb_array_elements(p_recipients) j)<>jsonb_array_length(p_recipients) then raise exception 'invalid';end if;
    for item in select * from jsonb_array_elements(p_recipients) loop
      v_profile:=(item->>'profileId')::uuid;v_phone:=btrim(item->>'phoneE164');
      if v_profile is null or v_phone !~ '^\+[1-9][0-9]{7,14}$' or not exists(select 1 from public.profiles p
        where p.id=v_profile and p.active and p.role in ('manager','dispatcher','back_office')) then raise exception 'invalid';end if;
    end loop;
  exception when others then raise exception 'VALIDATION_FAILED' using errcode='PT422';end;
  select count(*) into v_count from jsonb_array_elements(p_recipients) j where coalesce((j->>'active')::boolean,true);
  perform public.parts_sms_cap('p1_parts_alert_settings','00000000-0000-0000-0000-000000000001');
  update public.p1_parts_alert_settings set enabled=p_enabled,timezone=p_timezone,cutoff_time=p_cutoff_time,
    updated_by=v_actor,updated_at=clock_timestamp(),configuration_version=configuration_version+1 where singleton;
  for r in select * from public.p1_parts_alert_recipients where active and not exists(
    select 1 from jsonb_array_elements(p_recipients) j where (j->>'profileId')::uuid=r.profile_id and coalesce((j->>'active')::boolean,true)) loop
    perform public.parts_sms_cap('p1_parts_alert_recipients',r.id);
    update public.p1_parts_alert_recipients set active=false,updated_at=clock_timestamp() where id=r.id;
  end loop;
  for item in select * from jsonb_array_elements(p_recipients) loop
    v_profile:=(item->>'profileId')::uuid;v_phone:=btrim(item->>'phoneE164');v_active:=coalesce((item->>'active')::boolean,true);
    select id into v_id from public.p1_parts_alert_recipients where profile_id=v_profile;v_id:=coalesce(v_id,gen_random_uuid());
    perform public.parts_sms_cap('p1_parts_alert_recipients',v_id);
    insert into public.p1_parts_alert_recipients(id,profile_id,phone_e164,active,added_by) values(v_id,v_profile,v_phone,v_active,v_actor)
      on conflict(profile_id) do update set phone_e164=excluded.phone_e164,active=excluded.active,updated_at=clock_timestamp();
  end loop;
  perform public.parts_sms_clear();return jsonb_build_object('enabled',p_enabled,'timezone',p_timezone,'cutoffTime',p_cutoff_time,'recipientCount',v_count);
end;
$$;

-- Bounded SQL snapshot, not a PostgREST default-limit client collector.
-- Timestamp text follows PostgREST UTC ISO formatting, retaining fractional
-- precision without trailing zeroes. Legacy daily suppression is independent
-- of any signature representation difference.
create function public.parts_sms_snapshot(p_force boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare settings public.p1_parts_alert_settings%rowtype;v_local timestamp;v_parts integer;v_orders integer;v_signature text;v_preview jsonb;v_status text;
begin
  select * into strict settings from public.p1_parts_alert_settings where singleton;
  if not exists(select 1 from pg_timezone_names where name=settings.timezone) then return jsonb_build_object('status','unscheduled','localDate',null);end if;
  v_local:=clock_timestamp() at time zone settings.timezone;
  v_status:=case when not settings.enabled then 'disabled' when settings.cutoff_time is null then 'unscheduled'
    when not coalesce(p_force,false) and to_char(v_local,'HH24:MI')<left(settings.cutoff_time::text,5) then 'before_cutoff' else 'ready' end;
  if v_status<>'ready' then return jsonb_build_object('status',v_status,'localDate',v_local::date,'timezone',settings.timezone);end if;
  with eligible as materialized (
    select part.id,part.work_order_id,part.p1_requested_at,coalesce(part.updated_at,part.p1_requested_at) as stamp
    from public.wo_parts part join public.work_orders w on w.id=part.work_order_id
    where part.ordering_responsibility='p1' and part.p1_order_status='requested' and w.deleted_at is null
      and w.status not in ('closed','capital','pending_capital_completion')
    order by part.id limit 10001
  ), first_orders as (
    select distinct on(work_order_id) work_order_id,p1_requested_at,id from eligible
    order by work_order_id,p1_requested_at nulls last,id
  ) select (select count(*) from eligible),(select count(*) from first_orders),
    (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(string_agg(id::text||':'||case when stamp is null then '' else
      rtrim(rtrim(to_char(stamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),'0'),'.')||'+00:00' end,'|' order by id),''),'UTF8')),'hex') from eligible),
    (select coalesce(jsonb_agg(work_order_id order by p1_requested_at nulls last,id),'[]') from
      (select * from first_orders order by p1_requested_at nulls last,id limit 8) preview)
    into v_parts,v_orders,v_signature,v_preview;
  return jsonb_build_object('status',case when v_parts>10000 then 'capacity_exceeded' when v_parts=0 then 'nothing_to_send' else 'ready' end,
    'localDate',v_local::date,'timezone',settings.timezone,'configurationVersion',settings.configuration_version,
    'requestSignature',v_signature,'parts',v_parts,'workOrders',v_orders,'previewIds',v_preview);
end;
$$;
create function public.parts_sms_recipient_valid(p_delivery public.p1_parts_alert_deliveries)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.p1_parts_alert_recipients r join public.profiles p on p.id=r.profile_id
    where r.id=p_delivery.recipient_id and r.active and p.id=p_delivery.recipient_profile_id
      and p.active and p.role in ('manager','dispatcher','back_office') and r.phone_e164=p_delivery.phone_snapshot
      and r.phone_e164 ~ '^\+[1-9][0-9]{7,14}$');
$$;
create function public.parts_sms_retry_pending(p_delivery public.p1_parts_alert_deliveries)
returns boolean language sql immutable set search_path=pg_catalog,public as $$
  select p_delivery.provenance='owned_v1' and p_delivery.status='failed' and p_delivery.attempt_count<3
    and p_delivery.last_error_code='TWILIO_BEFORE_SEND_CANCELLED' and p_delivery.next_attempt_at is not null;
$$;
create function public.parts_sms_daily_blocked(p_recipient uuid,p_date date)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.p1_parts_alert_deliveries d where d.recipient_id=p_recipient and d.local_date=p_date and (
    d.provenance='legacy' or d.status in ('accepted','sent','delivered','unknown','sending')
    or exists(select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=d.id and (a.outcome='accepted' or a.state='unknown'))
    or exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.id and o.action='manual_resolution')));
$$;
create function public.parts_sms_recurrence_blocked(p_delivery public.p1_parts_alert_deliveries,p_snapshot jsonb)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select p_delivery.provenance='owned_v1' and p_delivery.status='superseded' and p_delivery.parent_delivery_id is null
    and p_snapshot->>'status'='ready' and p_delivery.local_date::text=p_snapshot->>'localDate'
    and p_delivery.timezone=p_snapshot->>'timezone' and p_delivery.request_signature=p_snapshot->>'requestSignature'
    and not public.parts_sms_daily_blocked(p_delivery.recipient_id,p_delivery.local_date);
$$;
create function public.parts_sms_add_delivery(p_recipient public.p1_parts_alert_recipients,p_snapshot jsonb,p_parent uuid default null,p_root uuid default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid:=gen_random_uuid();v_valid boolean;
begin
  v_valid:=exists(select 1 from public.profiles p where p.id=p_recipient.profile_id and p.active and p.role in ('manager','dispatcher','back_office'));
  perform public.parts_sms_cap('p1_parts_alert_deliveries',v_id);
  insert into public.p1_parts_alert_deliveries(id,recipient_id,local_date,request_signature,status,attempt_count,provenance,
    recipient_profile_id,phone_snapshot,timezone,configuration_version,parent_delivery_id,root_delivery_id,next_attempt_at,last_error_code)
  values(v_id,p_recipient.id,(p_snapshot->>'localDate')::date,p_snapshot->>'requestSignature',
    case when v_valid then 'pending' else 'not_deliverable' end,0,'owned_v1',p_recipient.profile_id,p_recipient.phone_e164,
    p_snapshot->>'timezone',(p_snapshot->>'configurationVersion')::bigint,p_parent,p_root,
    case when v_valid then clock_timestamp() else null end,case when v_valid then null else 'RECIPIENT_NOT_DELIVERABLE' end);
  return v_id;
end;
$$;
create function public.parts_sms_cancel(p_delivery public.p1_parts_alert_deliveries,p_state text,p_code text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if p_delivery.provenance<>'owned_v1' or p_delivery.status not in ('pending','claimed','failed') or p_delivery.send_started_at is not null then
    raise exception 'DELIVERY_NOT_ACTIONABLE' using errcode='PT409';end if;
  perform public.parts_sms_record(p_delivery,'cancelled',p_state,p_code);
  perform public.parts_sms_cap('p1_parts_alert_deliveries',p_delivery.id);
  update public.p1_parts_alert_deliveries set status=p_state,last_error_code=p_code,claim_token=null,claim_expires_at=null,
    next_attempt_at=null,completed_at=clock_timestamp() where id=p_delivery.id;
end;
$$;
create function public.enqueue_parts_sms_deliveries_v1(p_force boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare snap jsonb;r public.p1_parts_alert_recipients%rowtype;d public.p1_parts_alert_deliveries%rowtype;
  v_queued integer:=0;v_skipped integer:=0;v_superseded integer:=0;v_recipients integer:=0;v_id uuid;v_recurrence integer:=0;
begin
  perform public.parts_sms_service();perform public.parts_sms_lock();snap:=public.parts_sms_snapshot(p_force);
  if snap->>'status'='ready' then
    if (select count(*) from (select id from public.p1_parts_alert_recipients where active limit 26) bounded_recipients)>25 then
      return jsonb_build_object('status','capacity_exceeded','localDate',snap->>'localDate','queued',0,'skipped',0,'superseded',0,'recurrenceBlocked',0,'parts',snap->'parts','workOrders',snap->'workOrders');end if;
    for r in select * from public.p1_parts_alert_recipients where active order by created_at,id limit 25 loop
      v_recipients:=v_recipients+1;
      if public.parts_sms_daily_blocked(r.id,(snap->>'localDate')::date) then v_skipped:=v_skipped+1;continue;end if;
      for d in select * from public.p1_parts_alert_deliveries where recipient_id=r.id and local_date=(snap->>'localDate')::date
        and request_signature<>snap->>'requestSignature' and provenance='owned_v1' and status in ('pending','claimed','failed')
        and send_started_at is null order by created_at,id limit 25 for update loop
        perform public.parts_sms_cancel(d,'superseded','PARTS_DIGEST_CHANGED');v_superseded:=v_superseded+1;
      end loop;
      -- Defer new work if bounded cleanup has more old unsent rows to classify.
      if exists(select 1 from public.p1_parts_alert_deliveries where recipient_id=r.id and local_date=(snap->>'localDate')::date
        and request_signature<>snap->>'requestSignature' and provenance='owned_v1' and status in ('pending','claimed','failed')
        and send_started_at is null) then v_skipped:=v_skipped+1;continue;end if;
      select * into d from public.p1_parts_alert_deliveries where recipient_id=r.id and local_date=(snap->>'localDate')::date
        and request_signature=snap->>'requestSignature' and parent_delivery_id is null;
      if found then
        if public.parts_sms_recurrence_blocked(d,snap) then v_recurrence:=v_recurrence+1;end if;
        v_skipped:=v_skipped+1;continue;end if;
      v_id:=public.parts_sms_add_delivery(r,snap);v_queued:=v_queued+1;
    end loop;
  end if;
  perform public.parts_sms_clear();
  return jsonb_build_object('status',case when snap->>'status'<>'ready' then snap->>'status' when v_recipients=0 then 'no_recipients' else 'queued' end,
    'localDate',snap->>'localDate','queued',v_queued,'skipped',v_skipped,'superseded',v_superseded,'recurrenceBlocked',v_recurrence,
    'parts',coalesce(snap->'parts','0'::jsonb),'workOrders',coalesce(snap->'workOrders','0'::jsonb));
end;
$$;

create function public.claim_parts_sms_delivery_v1(p_claim_token uuid,p_force boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.p1_parts_alert_deliveries%rowtype;snap jsonb;v_before int:=0;v_unknown int:=0;v_superseded int:=0;v_not int:=0;v_claim jsonb:=null;
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
      if snap->>'status'<>'ready' or d.local_date::text<>snap->>'localDate' or d.timezone<>snap->>'timezone'
        or d.request_signature<>snap->>'requestSignature' then
        perform public.parts_sms_cancel(d,'superseded','PARTS_DIGEST_CHANGED');v_superseded:=1;
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
create function public.prepare_parts_sms_send_v1(p_delivery_id uuid,p_claim_token uuid,p_force boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.p1_parts_alert_deliveries%rowtype;snap jsonb;
begin
  perform public.parts_sms_service();perform public.parts_sms_lock();
  select * into d from public.p1_parts_alert_deliveries where id=p_delivery_id for update;
  if not found or d.provenance<>'owned_v1' or d.status<>'claimed' or d.claim_token is distinct from p_claim_token or d.claim_expires_at<=clock_timestamp() then return null;end if;
  snap:=public.parts_sms_snapshot(p_force);
  if snap->>'status' in ('disabled','unscheduled','before_cutoff','capacity_exceeded') then return null;end if;
  if snap->>'status'<>'ready' or d.local_date::text<>snap->>'localDate' or d.timezone<>snap->>'timezone' or d.request_signature<>snap->>'requestSignature' then
    perform public.parts_sms_cancel(d,'superseded','PARTS_DIGEST_CHANGED');perform public.parts_sms_clear();return jsonb_build_object('status','superseded');end if;
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
create function public.complete_parts_sms_delivery_v1(p_delivery_id uuid,p_claim_token uuid,p_outcome text,p_code text,p_provider_message_id text,p_provider_status text,p_retry_after_seconds integer default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.p1_parts_alert_deliveries%rowtype;a public.p1_parts_sms_attempt_events%rowtype;v_state text;v_retry int;
begin
  perform public.parts_sms_service();perform public.parts_sms_lock();
  if p_delivery_id is null or p_claim_token is null or p_outcome is null
    or p_outcome not in ('accepted','known_unsent_retryable','known_unsent_terminal','unknown')
    or (p_code is not null and p_code !~ '^[A-Z0-9_]{1,80}$')
    or (p_provider_message_id is not null and p_provider_message_id !~ '^(SM|MM)[0-9a-fA-F]{32}$')
    or (p_provider_status is not null and p_provider_status not in ('accepted','queued','sending','sent','delivered','undelivered','failed'))
    or (p_retry_after_seconds is not null and p_retry_after_seconds not between 0 and 3600)
    or (p_outcome<>'known_unsent_retryable' and p_retry_after_seconds is not null)
    or (p_outcome='accepted' and (p_provider_message_id is null or p_provider_status is null or p_code is not null))
    or (p_outcome<>'accepted' and p_code is null)
    or (p_outcome='known_unsent_retryable' and p_code<>'TWILIO_BEFORE_SEND_CANCELLED')
    or (p_outcome='known_unsent_terminal' and p_code not in ('TWILIO_NOT_CONFIGURED','RECIPIENT_NOT_DELIVERABLE','PARTS_SMS_MESSAGE_INVALID'))
    or (p_outcome='unknown' and p_code not in ('TWILIO_UNKNOWN','TWILIO_RESPONSE_UNCONFIRMED'))
    or (p_outcome in ('known_unsent_retryable','known_unsent_terminal','unknown') and p_provider_status is not null)
    or (p_outcome in ('known_unsent_retryable','known_unsent_terminal') and p_provider_message_id is not null)
    then raise exception 'INVALID_PROVIDER_OUTCOME' using errcode='PT422';end if;
  select * into d from public.p1_parts_alert_deliveries where id=p_delivery_id for update;
  if not found then raise exception 'DELIVERY_NOT_FOUND' using errcode='PT404';end if;
  select * into a from public.p1_parts_sms_attempt_events where delivery_id=d.id and claim_token=p_claim_token and phase='completed';
  if found then
    if a.outcome is distinct from p_outcome or a.code is distinct from p_code or a.provider_message_id is distinct from p_provider_message_id
      or a.provider_status is distinct from p_provider_status or a.retry_after_seconds is distinct from p_retry_after_seconds then raise exception 'OPERATION_REUSED' using errcode='PT409';end if;
    return jsonb_build_object('id',d.id,'state',a.state,'replayed',true);end if;
  if d.provenance<>'owned_v1' or d.status not in ('claimed','sending') or d.claim_token is distinct from p_claim_token or d.claim_expires_at<=clock_timestamp()
    or (p_outcome='accepted' and d.send_started_at is null) then raise exception 'STALE_CLAIM' using errcode='PT409';end if;
  v_state:=case when p_outcome='accepted' then case when p_provider_status in ('delivered','sent') then p_provider_status
      when p_provider_status in ('failed','undelivered') then 'failed' else 'accepted' end
    when p_outcome='unknown' then 'unknown'
    when p_outcome='known_unsent_terminal' and p_code in ('TWILIO_NOT_CONFIGURED','RECIPIENT_NOT_DELIVERABLE') then 'not_deliverable' else 'failed' end;
  v_retry:=case when p_outcome='known_unsent_retryable' and d.attempt_count<3
    then least(3600,greatest(300*(2 ^ greatest(d.attempt_count-1,0))::integer,coalesce(p_retry_after_seconds,300))) else null end;
  perform public.parts_sms_record(d,'completed',v_state,p_code,p_outcome,p_provider_message_id,p_provider_status,p_retry_after_seconds);
  perform public.parts_sms_cap('p1_parts_alert_deliveries',d.id);
  update public.p1_parts_alert_deliveries set status=v_state,claim_token=null,claim_expires_at=null,completed_at=clock_timestamp(),
    send_started_at=case when p_outcome in ('known_unsent_retryable','known_unsent_terminal') then null else send_started_at end,
    provider_message_id=p_provider_message_id,provider_status=p_provider_status,last_error_code=coalesce(p_code,case when v_state='failed' then 'SMS_PROVIDER_UNDELIVERED' else null end),
    next_attempt_at=case when v_retry is null then null else clock_timestamp()+make_interval(secs=>v_retry) end,
    next_status_at=case when p_provider_message_id is not null and p_provider_status is distinct from 'delivered'
      and p_provider_status is distinct from 'failed' and p_provider_status is distinct from 'undelivered' then clock_timestamp()+interval '3 minutes' else null end
    where id=d.id;
  perform public.parts_sms_clear();return jsonb_build_object('id',d.id,'state',v_state,'replayed',false);
end;
$$;
create function public.claim_parts_sms_status_v1(p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.p1_parts_alert_deliveries%rowtype;v_claim jsonb:=null;v_stale int:=0;
begin
  perform public.parts_sms_service();perform public.parts_sms_lock();
  if p_claim_token is null then raise exception 'VALIDATION_FAILED' using errcode='PT422';end if;
  for d in select * from public.p1_parts_alert_deliveries where provenance='owned_v1' and provider_message_id is not null
    and next_status_at is not null and not status_check_stale and (status_check_count>=20 or created_at<clock_timestamp()-interval '24 hours')
    and (status_claim_token is null or status_claim_expires_at<=clock_timestamp())
    order by next_status_at,id limit 100 for update skip locked loop
    perform public.parts_sms_cap('p1_parts_alert_deliveries',d.id);
    update public.p1_parts_alert_deliveries set status_check_stale=true,next_status_at=null,status_claim_token=null,status_claim_expires_at=null where id=d.id;
    v_stale:=v_stale+1;
  end loop;
  select * into d from public.p1_parts_alert_deliveries where provenance='owned_v1' and provider_message_id is not null
    and status in ('accepted','sent','unknown') and not status_check_stale and next_status_at<=clock_timestamp()
    and (status_claim_token is null or status_claim_expires_at<=clock_timestamp()) and status_check_count<20
    and not exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=p1_parts_alert_deliveries.id and o.action='manual_resolution')
    order by next_status_at,id limit 1 for update skip locked;
  if found then
    if exists(select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=d.id and a.phase='provider_status' and a.claim_token=p_claim_token) then raise exception 'OPERATION_REUSED' using errcode='PT409';end if;
    perform public.parts_sms_cap('p1_parts_alert_deliveries',d.id);
    update public.p1_parts_alert_deliveries set status_claim_token=p_claim_token,status_claim_expires_at=clock_timestamp()+interval '60 seconds',status_check_count=status_check_count+1 where id=d.id;
    v_claim:=jsonb_build_object('id',d.id,'providerMessageId',d.provider_message_id);
  end if;
  perform public.parts_sms_clear();return jsonb_build_object('claim',v_claim,'stale',v_stale);
end;
$$;
create function public.complete_parts_sms_status_v1(p_delivery_id uuid,p_claim_token uuid,p_status text,p_code text,p_provider_message_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.p1_parts_alert_deliveries%rowtype;a public.p1_parts_sms_attempt_events%rowtype;v_state text;v_provider text;v_terminal boolean;
begin
  perform public.parts_sms_service();perform public.parts_sms_lock();
  if p_delivery_id is null or p_claim_token is null or p_status is null or p_status not in ('accepted','queued','sending','sent','delivered','undelivered','failed','unknown')
    or (p_status='unknown' and p_code is distinct from 'TWILIO_STATUS_UNAVAILABLE')
    or (p_status<>'unknown' and p_code is not null) then raise exception 'INVALID_PROVIDER_OUTCOME' using errcode='PT422';end if;
  select * into d from public.p1_parts_alert_deliveries where id=p_delivery_id for update;
  if not found or d.provider_message_id is null or d.provider_message_id is distinct from p_provider_message_id then raise exception 'DELIVERY_NOT_FOUND' using errcode='PT404';end if;
  select * into a from public.p1_parts_sms_attempt_events where delivery_id=d.id and claim_token=p_claim_token and phase='provider_status';
  if found then
    if a.provider_status is distinct from p_status or a.code is distinct from p_code or a.provider_message_id is distinct from p_provider_message_id then raise exception 'OPERATION_REUSED' using errcode='PT409';end if;
    return jsonb_build_object('id',d.id,'state',a.state,'replayed',true);end if;
  if d.provenance<>'owned_v1' or d.status not in ('accepted','sent','unknown') or d.status_claim_token is null
    or d.status_claim_expires_at is null or d.status_claim_token is distinct from p_claim_token or d.status_claim_expires_at<=clock_timestamp()
    or exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.id and o.action='manual_resolution')
    then raise exception 'STALE_CLAIM' using errcode='PT409';end if;
  v_state:=d.status;v_provider:=d.provider_status;
  if p_status='delivered' then v_state:='delivered';v_provider:=p_status;
  elsif p_status in ('failed','undelivered') then v_state:='failed';v_provider:=p_status;
  elsif p_status='sent' then v_state:='sent';v_provider:=p_status;
  elsif p_status in ('accepted','queued','sending') and d.status in ('accepted','unknown') then
    v_state:='accepted';
    if array_position(array['accepted','queued','sending'],p_status)>=coalesce(array_position(array['accepted','queued','sending'],d.provider_status),0) then v_provider:=p_status;end if;
  end if;
  v_terminal:=v_state in ('delivered','failed');
  perform public.parts_sms_record(d,'provider_status',v_state,p_code,null,p_provider_message_id,p_status,null,p_claim_token);
  perform public.parts_sms_cap('p1_parts_alert_deliveries',d.id);
  update public.p1_parts_alert_deliveries set status=v_state,provider_status=v_provider,
    completed_at=case when v_terminal then clock_timestamp() else completed_at end,
    last_error_code=case when v_state='failed' then 'SMS_PROVIDER_UNDELIVERED' when p_status='unknown' then 'TWILIO_STATUS_UNAVAILABLE' else null end,
    status_claim_token=null,status_claim_expires_at=null,
    next_status_at=case when v_terminal or d.status_check_count>=20 or d.created_at<clock_timestamp()-interval '24 hours' then null else clock_timestamp()+interval '3 minutes' end,
    status_check_stale=not v_terminal and (d.status_check_count>=20 or d.created_at<clock_timestamp()-interval '24 hours') where id=d.id;
  perform public.parts_sms_clear();return jsonb_build_object('id',d.id,'state',v_state,'replayed',false);
end;
$$;

create function public.parts_sms_safe_code(p_code text)
returns text language sql immutable set search_path=pg_catalog,public as $$
 select case when p_code in ('TWILIO_NOT_CONFIGURED','RECIPIENT_NOT_DELIVERABLE','PARTS_SMS_MESSAGE_INVALID','TWILIO_BEFORE_SEND_CANCELLED',
 'TWILIO_UNKNOWN','TWILIO_RESPONSE_UNCONFIRMED','TWILIO_STATUS_UNAVAILABLE','SMS_PROVIDER_UNDELIVERED','SMS_OUTCOME_UNKNOWN',
 'PARTS_DIGEST_CHANGED','CLAIM_EXPIRED_BEFORE_SEND','LEGACY_OUTCOME_UNVERIFIED','CLAIM_EXPIRED_REVIEW','PENDING_WORKER_DELAY','PARTS_SOURCE_RECURRENCE_REVIEW') then p_code when p_code is null then null else 'SMS_DELIVERY_FAILED' end;
$$;
create function public.parts_sms_recipient_current(p_delivery public.p1_parts_alert_deliveries)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.p1_parts_alert_recipients r join public.profiles p on p.id=r.profile_id
    where r.id=p_delivery.recipient_id and r.active and p.id=p_delivery.recipient_profile_id and p.active
      and p.role in ('manager','dispatcher','back_office') and r.phone_e164 ~ '^\+[1-9][0-9]{7,14}$');
$$;
create function public.parts_sms_projection(p_delivery public.p1_parts_alert_deliveries,p_snapshot jsonb)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 with flags as(select
   p_delivery.provenance='owned_v1' and p_snapshot->>'status'='ready' and p_delivery.local_date::text=p_snapshot->>'localDate'
     and p_delivery.timezone=p_snapshot->>'timezone' and p_delivery.request_signature=p_snapshot->>'requestSignature'
     and p_delivery.status<>'superseded' and public.parts_sms_recipient_current(p_delivery) as current,
   exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=p_delivery.id and o.action='manual_resolution') as manual,
   exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=p_delivery.id) as operated,
   p_delivery.status in ('unknown','not_deliverable') or (p_delivery.status='failed' and not coalesce(public.parts_sms_retry_pending(p_delivery),false))
     or (p_delivery.provenance='legacy' and p_delivery.status='claimed') as actionable)
 select jsonb_build_object('id',p_delivery.id,'rootId',coalesce(p_delivery.root_delivery_id,p_delivery.id),'recipientId',p_delivery.recipient_id,
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
     and not (p_delivery.status='unknown' and p_delivery.provider_message_id is not null),
   'canResolve',((actionable or p_delivery.status_check_stale) and not operated and p_delivery.status not in ('pending','claimed','sending','delivered','superseded')
      or (p_delivery.provenance='legacy' and p_delivery.status='claimed' and not operated))
      and (p_delivery.status_claim_token is null or p_delivery.status_claim_expires_at<=clock_timestamp()))
 from flags;
$$;
create function public.get_parts_sms_delivery_v1(p_delivery_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.p1_parts_alert_deliveries%rowtype;
begin
  perform public.parts_sms_actor();select * into d from public.p1_parts_alert_deliveries where id=p_delivery_id;
  if not found then raise exception 'DELIVERY_NOT_FOUND' using errcode='PT404';end if;
  return public.parts_sms_projection(d,public.parts_sms_snapshot(true));
end;
$$;
create function public.list_parts_sms_unresolved_v1(p_state text default null,p_search text default '',p_cursor jsonb default null,p_limit integer default 25)
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
      not exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.id and o.action='manual_resolution')
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
create function public.get_parts_sms_history_v1(p_delivery_id uuid,p_cursor jsonb default null,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_root uuid;v_at timestamptz;v_id text;v_snapshot timestamptz:=clock_timestamp();v_items jsonb;v_more boolean;v_next jsonb;
begin
  perform public.parts_sms_actor();select coalesce(root_delivery_id,id) into v_root from public.p1_parts_alert_deliveries where id=p_delivery_id;
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
  with family as(select * from public.p1_parts_alert_deliveries where id=v_root or root_delivery_id=v_root),
  history as (
    select 'delivery:'||d.id as id,'delivery'::text as kind,case when d.provenance='legacy' and d.status in ('failed','claimed') then 'unknown' else d.status end as state,
      d.provider_status,d.created_at,d.completed_at,null::text as reason,0 as sequence,
      case when d.provenance='legacy' then 'LEGACY_OUTCOME_UNVERIFIED' else public.parts_sms_safe_code(d.last_error_code) end as code from family d
    union all select case when a.phase='provider_status' then 'status:' else 'attempt:' end||a.id,
      case when a.phase='provider_status' then 'provider_status' else 'attempt' end,a.state,
      case when a.provider_status='unknown' then null else a.provider_status end,a.created_at,
      case when a.phase in ('completed','expired','cancelled','provider_status') then a.created_at else null end,null,a.sequence,public.parts_sms_safe_code(a.code)
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
create index p1_parts_sms_root_history on public.p1_parts_alert_deliveries(root_delivery_id,created_at desc,id desc) where root_delivery_id is not null;

create function public.parts_sms_staff_action(p_delivery_id uuid,p_operation_id uuid,p_reason text,p_action text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_actor uuid;d public.p1_parts_alert_deliveries%rowtype;r public.p1_parts_alert_recipients%rowtype;
 o public.p1_parts_sms_operations%rowtype;snap jsonb;v_id uuid;v_reason text:=btrim(p_reason);v_projection jsonb;
begin
  v_actor:=public.parts_sms_actor();perform public.parts_sms_lock();
  if p_delivery_id is null or p_operation_id is null or v_reason is null or v_reason='' then raise exception 'REASON_REQUIRED' using errcode='PT422';end if;
  if length(v_reason)>500 or p_action not in ('resend','manual_resolution') then raise exception 'VALIDATION_FAILED' using errcode='PT422';end if;
  select * into o from public.p1_parts_sms_operations where operation_id=p_operation_id;
  if found then
    if o.delivery_id<>p_delivery_id or o.actor_id<>v_actor or o.action<>p_action or o.reason<>v_reason then raise exception 'OPERATION_REUSED' using errcode='PT409';end if;
    select id into v_id from public.p1_parts_alert_deliveries where parent_delivery_id=o.delivery_id;
    return jsonb_build_object('status',case when p_action='resend' then 'queued' else 'manually_resolved' end,'deliveryId',coalesce(v_id,o.delivery_id),
      'operationId',p_operation_id,'replayed',true);end if;
  select * into d from public.p1_parts_alert_deliveries where id=p_delivery_id for update;
  if not found then raise exception 'DELIVERY_NOT_FOUND' using errcode='PT404';end if;
  snap:=public.parts_sms_snapshot(true);v_projection:=public.parts_sms_projection(d,snap);
  if p_action='resend' then
    if not (v_projection->>'current')::boolean then raise exception 'STALE_DIGEST' using errcode='PT409';end if;
    if not (v_projection->>'canResend')::boolean then raise exception 'DELIVERY_NOT_ACTIONABLE' using errcode='PT409';end if;
    select * into strict r from public.p1_parts_alert_recipients where id=d.recipient_id;
    perform 1 from public.profiles where id=r.profile_id for share;
    if not public.parts_sms_recipient_current(d) then raise exception 'RECIPIENT_NOT_DELIVERABLE' using errcode='PT409';end if;
    v_id:=public.parts_sms_add_delivery(r,snap,d.id,coalesce(d.root_delivery_id,d.id));
  elsif not (v_projection->>'canResolve')::boolean then raise exception 'DELIVERY_NOT_ACTIONABLE' using errcode='PT409';
  end if;
  perform public.parts_sms_cap('p1_parts_sms_operations',p_operation_id);
  insert into public.p1_parts_sms_operations(operation_id,delivery_id,action,actor_id,reason) values(p_operation_id,d.id,p_action,v_actor,v_reason);
  perform public.parts_sms_clear();
  return jsonb_build_object('status',case when p_action='resend' then 'queued' else 'manually_resolved' end,'deliveryId',coalesce(v_id,d.id),'operationId',p_operation_id,'replayed',false);
end;
$$;
create function public.request_parts_sms_resend_v1(p_delivery_id uuid,p_operation_id uuid,p_reason text)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$ select public.parts_sms_staff_action(p_delivery_id,p_operation_id,p_reason,'resend');$$;
create function public.resolve_parts_sms_out_of_band_v1(p_delivery_id uuid,p_operation_id uuid,p_reason text)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$ select public.parts_sms_staff_action(p_delivery_id,p_operation_id,p_reason,'manual_resolution');$$;

create function public.start_parts_sms_run_v1(p_run_id uuid,p_release text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.p1_parts_sms_runs%rowtype;s public.p1_parts_alert_settings%rowtype;v_release text:=coalesce(p_release,'');
begin
  perform public.parts_sms_service();perform public.parts_sms_lock();
  if p_run_id is null or length(v_release)>80 then raise exception 'VALIDATION_FAILED' using errcode='PT422';end if;
  select * into strict s from public.p1_parts_alert_settings where singleton;
  select * into r from public.p1_parts_sms_runs where id=p_run_id;
  if found and r.release<>v_release then raise exception 'OPERATION_REUSED' using errcode='PT409';end if;
  if not found then
    perform public.parts_sms_cap('p1_parts_sms_runs',p_run_id);
    insert into public.p1_parts_sms_runs(id,release,settings_enabled,settings_timezone,settings_cutoff_time,local_date)
      values(p_run_id,v_release,s.enabled,s.timezone,s.cutoff_time,(clock_timestamp() at time zone s.timezone)::date);
  end if;
  perform public.parts_sms_clear();return jsonb_build_object('runId',p_run_id,'enabled',s.enabled,'timezone',s.timezone,'cutoffTime',s.cutoff_time);
end;
$$;
create function public.finish_parts_sms_run_v1(p_run_id uuid,p_summary jsonb,p_result_code text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.p1_parts_sms_runs%rowtype;
begin
  perform public.parts_sms_service();perform public.parts_sms_lock();
  if p_result_code is null or p_result_code !~ '^[A-Z0-9_]{1,80}$' or jsonb_typeof(p_summary) is distinct from 'object'
    then raise exception 'VALIDATION_FAILED' using errcode='PT422';end if;
  if (select count(*) from jsonb_object_keys(p_summary))>24
    or exists(select 1 from jsonb_each(p_summary) item where item.key !~ '^[a-zA-Z][a-zA-Z0-9]{0,39}$'
      or jsonb_typeof(item.value)<>'number' or item.value::text !~ '^[0-9]{1,6}$' or (item.value::text)::integer>100000) then raise exception 'VALIDATION_FAILED' using errcode='PT422';end if;
  select * into r from public.p1_parts_sms_runs where id=p_run_id for update;
  if not found then raise exception 'RUN_NOT_FOUND' using errcode='PT404';end if;
  if r.completed_at is not null then
    if r.summary is distinct from p_summary or r.result_code is distinct from p_result_code then raise exception 'OPERATION_REUSED' using errcode='PT409';end if;
    return jsonb_build_object('runId',p_run_id,'completed',true,'replayed',true);end if;
  perform public.parts_sms_cap('p1_parts_sms_runs',p_run_id);
  update public.p1_parts_sms_runs set completed_at=clock_timestamp(),summary=p_summary,result_code=p_result_code where id=p_run_id;
  perform public.parts_sms_clear();return jsonb_build_object('runId',p_run_id,'completed',true,'replayed',false);
end;
$$;
create function public.get_parts_sms_worker_health_v1()
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
    'sourceRecurrenceCount',(select count(*) from (select d.id from public.p1_parts_alert_deliveries d where public.parts_sms_recurrence_blocked(d,snap) limit 1000) bounded_recurrence),
    'unknownCount',(select count(*) from (select d.id from public.p1_parts_alert_deliveries d where (d.status='unknown' or(d.provenance='legacy' and d.status in ('claimed','failed')))
      and not exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.id) and not exists(select 1 from public.p1_parts_alert_deliveries child where child.parent_delivery_id=d.id) limit 1000) bounded_unknown),
    'notDeliverableCount',(select count(*) from (select d.id from public.p1_parts_alert_deliveries d where d.status='not_deliverable' and not exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.id) limit 1000) bounded_undeliverable),
    'staleStatusCount',(select count(*) from (select d.id from public.p1_parts_alert_deliveries d where d.status_check_stale and not exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.id) limit 1000) bounded_status),
    'expiredClaimCount',(select count(*) from (select id from public.p1_parts_alert_deliveries where provenance='owned_v1' and status in ('claimed','sending') and claim_expires_at<=clock_timestamp() limit 1000) bounded_expired));
end;
$$;

-- A stale server instance cannot acquire an untracked/untokened send permit.
create or replace function public.claim_p1_parts_alert_delivery(p_recipient_id uuid,p_local_date date,p_request_signature text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
begin perform public.parts_sms_service();raise exception 'SMS_WORKER_REQUIRED' using errcode='PT409';end;$$;
create or replace function public.complete_p1_parts_alert_delivery(p_delivery_id uuid,p_status text,p_provider_message_id text default null,p_error_message text default null)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin perform public.parts_sms_service();raise exception 'SMS_WORKER_REQUIRED' using errcode='PT409';end;$$;

create function public.guard_parts_sms_truncate()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if not public.lifecycle_is_owner_maintenance() then raise exception 'SMS_HISTORY_IMMUTABLE' using errcode='42501';end if;
  return null;
end;
$$;
create trigger parts_sms_truncate_guard before truncate on public.p1_parts_alert_settings for each statement execute function public.guard_parts_sms_truncate();
create trigger parts_sms_truncate_guard before truncate on public.p1_parts_alert_recipients for each statement execute function public.guard_parts_sms_truncate();
create trigger parts_sms_truncate_guard before truncate on public.p1_parts_alert_deliveries for each statement execute function public.guard_parts_sms_truncate();
create trigger parts_sms_truncate_guard before truncate on public.p1_parts_sms_attempt_events for each statement execute function public.guard_parts_sms_truncate();
create trigger parts_sms_truncate_guard before truncate on public.p1_parts_sms_operations for each statement execute function public.guard_parts_sms_truncate();
create trigger parts_sms_truncate_guard before truncate on public.p1_parts_sms_runs for each statement execute function public.guard_parts_sms_truncate();

revoke all on function public.parts_sms_service(),
  public.parts_sms_actor(uuid),
  public.parts_sms_lock(),
  public.parts_sms_cap(text,uuid),
  public.parts_sms_clear(),
  public.guard_parts_sms_records(),
  public.parts_sms_record(public.p1_parts_alert_deliveries,text,text,text,text,text,text,integer,uuid),
  public.configure_p1_parts_alerts(uuid,boolean,text,time,jsonb),
  public.parts_sms_snapshot(boolean),
  public.parts_sms_recipient_valid(public.p1_parts_alert_deliveries),
  public.parts_sms_retry_pending(public.p1_parts_alert_deliveries),
  public.parts_sms_daily_blocked(uuid,date),
  public.parts_sms_recurrence_blocked(public.p1_parts_alert_deliveries,jsonb),
  public.parts_sms_add_delivery(public.p1_parts_alert_recipients,jsonb,uuid,uuid),
  public.parts_sms_cancel(public.p1_parts_alert_deliveries,text,text),
  public.enqueue_parts_sms_deliveries_v1(boolean),
  public.claim_parts_sms_delivery_v1(uuid,boolean),
  public.prepare_parts_sms_send_v1(uuid,uuid,boolean),
  public.complete_parts_sms_delivery_v1(uuid,uuid,text,text,text,text,integer),
  public.claim_parts_sms_status_v1(uuid),
  public.complete_parts_sms_status_v1(uuid,uuid,text,text,text),
  public.parts_sms_safe_code(text),
  public.parts_sms_recipient_current(public.p1_parts_alert_deliveries),
  public.parts_sms_projection(public.p1_parts_alert_deliveries,jsonb),
  public.get_parts_sms_delivery_v1(uuid),
  public.list_parts_sms_unresolved_v1(text,text,jsonb,integer),
  public.get_parts_sms_history_v1(uuid,jsonb,integer),
  public.parts_sms_staff_action(uuid,uuid,text,text),
  public.request_parts_sms_resend_v1(uuid,uuid,text),
  public.resolve_parts_sms_out_of_band_v1(uuid,uuid,text),
  public.start_parts_sms_run_v1(uuid,text),
  public.finish_parts_sms_run_v1(uuid,jsonb,text),
  public.get_parts_sms_worker_health_v1(),
  public.claim_p1_parts_alert_delivery(uuid,date,text),
  public.complete_p1_parts_alert_delivery(uuid,text,text,text),
  public.guard_parts_sms_truncate() from public,anon,authenticated,service_role;
grant execute on function public.get_parts_sms_delivery_v1(uuid),
  public.list_parts_sms_unresolved_v1(text,text,jsonb,integer),
  public.get_parts_sms_history_v1(uuid,jsonb,integer),
  public.request_parts_sms_resend_v1(uuid,uuid,text),
  public.resolve_parts_sms_out_of_band_v1(uuid,uuid,text),
  public.get_parts_sms_worker_health_v1() to authenticated;
grant execute on function public.configure_p1_parts_alerts(uuid,boolean,text,time,jsonb),
  public.enqueue_parts_sms_deliveries_v1(boolean),
  public.claim_parts_sms_delivery_v1(uuid,boolean),
  public.prepare_parts_sms_send_v1(uuid,uuid,boolean),
  public.complete_parts_sms_delivery_v1(uuid,uuid,text,text,text,text,integer),
  public.claim_parts_sms_status_v1(uuid),
  public.complete_parts_sms_status_v1(uuid,uuid,text,text,text),
  public.start_parts_sms_run_v1(uuid,text),
  public.finish_parts_sms_run_v1(uuid,jsonb,text),
  public.claim_p1_parts_alert_delivery(uuid,date,text),
  public.complete_p1_parts_alert_delivery(uuid,text,text,text) to service_role;
commit;
