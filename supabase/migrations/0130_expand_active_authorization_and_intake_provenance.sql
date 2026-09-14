-- Batch 2B expansion. Existing service INSERTs remain legacy/unverified until
-- the processor is cut over; 0130 removes all raw mutation grants. No history
-- is rewritten or treated retrospectively as trusted service evidence.
begin;

create or replace function public.get_my_role()
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select profile.role::text
  from public.profiles profile
  where profile.id = auth.uid() and profile.active = true
$$;
revoke all on function public.get_my_role() from public, anon;
grant execute on function public.get_my_role() to authenticated, service_role;

drop policy if exists email_intake_log_read on public.email_intake_log;
create policy email_intake_log_read on public.email_intake_log
  for select to authenticated using (public.is_staff());

-- The old DELETE predicate read only the caller's role. A bare SQL DELETE
-- needs no SELECT policy and was executable by inactive staff. Preserve the
-- same active staff (including controller) matrix, not a new parts workflow.
drop policy if exists wo_parts_delete on public.wo_parts;
create policy wo_parts_delete on public.wo_parts
  for delete using (public.is_staff());

-- Preserve the existing result shape, archived-sibling visibility and active
-- staff/controller read semantics. Actorless service callers still get no rows.
create or replace function public.get_incident_reuse_warnings()
returns table (
  work_order_id text,
  incident_id text,
  related_work_order_ids text[],
  crosses_state boolean
)
language sql stable security definer
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
  where current_work_order.deleted_at is null and public.is_staff()
  group by current_work_order.id, current_work_order.incident_id;
$$;
revoke all on function public.get_incident_reuse_warnings() from public, anon;
grant execute on function public.get_incident_reuse_warnings() to authenticated, service_role;

alter table public.email_intake_log
  add column event_id uuid,
  add column source_message_id text,
  add column provenance text not null default 'legacy_unverified';
alter table public.email_intake_log
  add constraint email_intake_log_provenance_shape check (
    (provenance = 'legacy_unverified' and event_id is null and source_message_id is null)
    or (provenance = 'trusted_service_v1' and event_id is not null
      and source_message_id is not null
      and length(source_message_id) between 1 and 2048)
  );
create unique index email_intake_log_event_id_unique
  on public.email_intake_log(event_id) where event_id is not null;
create index email_intake_log_source_event_lookup
  on public.email_intake_log(source_message_id, processed_at, id)
  where source_message_id is not null;

create table public.email_intake_log_write_guards (
  transaction_id bigint not null,
  event_id uuid not null,
  primary key (transaction_id, event_id)
);
alter table public.email_intake_log_write_guards enable row level security;
revoke all on public.email_intake_log_write_guards from public, anon, authenticated, service_role;

create function public.protect_email_intake_log_provenance()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  -- Owner maintenance is the existing actual-owner/no-JWT boundary, never a
  -- raw service-role exemption. No historical repair is performed here.
  if public.lifecycle_is_owner_maintenance() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op <> 'INSERT' then
    if old.provenance = 'trusted_service_v1'
       or (tg_op = 'UPDATE' and (
         new.event_id is distinct from old.event_id
         or new.source_message_id is distinct from old.source_message_id
         or new.provenance is distinct from old.provenance
       )) then
      raise exception 'Intake evidence is immutable' using errcode = '42501';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if new.provenance = 'legacy_unverified'
     and new.event_id is null and new.source_message_id is null then
    return new;
  end if;
  if new.provenance <> 'trusted_service_v1'
     or auth.role() is distinct from 'service_role'
     or auth.uid() is not null
     or not exists (
       select 1 from public.email_intake_log_write_guards permit
       where permit.transaction_id = txid_current() and permit.event_id = new.event_id
     ) then
    raise exception 'Intake evidence requires its owning command' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_email_intake_log_provenance() from public, anon, authenticated, service_role;
create trigger protect_email_intake_log_provenance_trigger
  before insert or update or delete on public.email_intake_log
  for each row execute function public.protect_email_intake_log_provenance();

create function public.record_email_intake_result_v1(
  p_event_id uuid,
  p_source_message_id text,
  p_payload jsonb
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  -- Match the JavaScript trim boundary, including tabs, line separators and
  -- Unicode spaces. PostgreSQL btrim(text) alone strips ASCII spaces only.
  v_trim_chars constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  v_source text;
  v_key text;
  v_value jsonb;
  v_email_id text;
  v_subject text;
  v_action text;
  v_work_order_id text;
  v_reason text;
  v_confidence text;
  v_contractor text;
  v_raw_subject text;
  v_raw_from text;
  v_payload jsonb;
  v_input jsonb;
  v_existing_payload jsonb;
  v_existing public.email_intake_log%rowtype;
  v_id uuid;
  v_recorded_at timestamptz;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'Trusted intake service required' using errcode = '42501';
  end if;
  v_source := btrim(p_source_message_id, v_trim_chars);
  if p_event_id is null or v_source is null or length(v_source) not between 1 and 2048
     or p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 32768 then
    raise exception 'Invalid intake result' using errcode = 'PT422';
  end if;
  for v_key, v_value in select key, value from jsonb_each(p_payload) loop
    if not (v_key = any(array[
      'email_id','subject','action','work_order_id','reason','parse_confidence',
      'contractor_assigned','raw_subject','raw_from'
    ])) or jsonb_typeof(v_value) not in ('string','null') then
      raise exception 'Invalid intake result fields' using errcode = 'PT422';
    end if;
  end loop;
  v_input := p_payload;
  -- Match the server adapter's safe summary normalization. Provider headers,
  -- documents and metadata are not accepted fields; obvious credential-like
  -- material is rejected as a backstop if a service bypasses that adapter.
  foreach v_key in array array['subject','reason','raw_subject','raw_from'] loop
    if jsonb_typeof(v_input->v_key) = 'string' then
      v_input := jsonb_set(v_input,array[v_key],to_jsonb(btrim(
        regexp_replace(v_input->>v_key,'[' || chr(1) || '-' || chr(31) || chr(127) || ']',' ','g'),
        v_trim_chars
      )));
      if (v_input->>v_key) ~* '\m(access_token|refresh_token|client_secret|authorization|api[_-]?key)[[:space:]]*[:=][[:space:]]*[^[:space:],;]+'
         or (v_input->>v_key) ~* '\mbearer[[:space:]]+[A-Za-z0-9._~+/=-]+'
         or (v_input->>v_key) ~ '\meyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\M' then
        raise exception 'Intake result must contain safe operational summaries' using errcode = 'PT422';
      end if;
    end if;
  end loop;
  v_email_id := nullif(btrim(v_input->>'email_id', v_trim_chars), '');
  v_subject := v_input->>'subject';
  v_action := p_payload->>'action';
  v_work_order_id := nullif(btrim(p_payload->>'work_order_id', v_trim_chars), '');
  v_reason := nullif(btrim(v_input->>'reason', v_trim_chars), '');
  v_confidence := p_payload->>'parse_confidence';
  v_contractor := nullif(btrim(p_payload->>'contractor_assigned', v_trim_chars), '');
  v_raw_subject := v_input->>'raw_subject';
  v_raw_from := v_input->>'raw_from';
  if (jsonb_typeof(p_payload->'work_order_id') = 'string' and v_work_order_id is null)
     or (jsonb_typeof(p_payload->'contractor_assigned') = 'string' and v_contractor is null) then
    raise exception 'Invalid intake result reference' using errcode = 'PT422';
  end if;
  if v_email_id is null or length(v_email_id) > 2048
     or v_email_id ~ ('[' || chr(1) || '-' || chr(31) || chr(127) || ']')
     or v_source ~ ('[' || chr(1) || '-' || chr(31) || chr(127) || ']')
     or v_action is null or v_action not in ('created','updated','skipped','failed')
     or v_reason is null or length(v_reason) > 2000
     or v_confidence is null or v_confidence not in ('high','medium','low')
     or length(v_subject) > 1024 or length(v_raw_subject) > 1024
     or length(v_raw_from) > 320 or length(v_work_order_id) > 128 then
    raise exception 'Invalid intake result values' using errcode = 'PT422';
  end if;
  if v_contractor is not null and (
    v_contractor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'Invalid intake contractor reference' using errcode = 'PT422';
  end if;
  if v_contractor is not null then v_contractor := (v_contractor::uuid)::text; end if;
  if v_work_order_id is not null and not exists (
    select 1 from public.work_orders work_order where work_order.id = v_work_order_id
  ) then
    raise exception 'Invalid intake work order reference' using errcode = 'PT422';
  end if;
  if v_contractor is not null and not exists (
    select 1 from public.profiles profile where profile.id = v_contractor::uuid
  ) then
    raise exception 'Invalid intake contractor reference' using errcode = 'PT422';
  end if;
  if v_action in ('created','updated') and v_work_order_id is null then
    raise exception 'Intake result requires a work order' using errcode = 'PT422';
  end if;
  v_payload := jsonb_build_object(
    'email_id',v_email_id,'subject',v_subject,'action',v_action,
    'work_order_id',v_work_order_id,'reason',v_reason,'parse_confidence',v_confidence,
    'contractor_assigned',v_contractor,'raw_subject',v_raw_subject,'raw_from',v_raw_from
  );
  -- A source can legitimately fail, be held, then succeed. Event identity is
  -- unique; source identity is deliberately NOT unique. Only equivalent
  -- normalized results replay; changed Graph aliases/content never overwrite.
  perform pg_advisory_xact_lock(hashtextextended('intake-result:' || p_event_id::text, 0));
  select * into v_existing from public.email_intake_log log
    where log.event_id = p_event_id for update;
  if found then
    v_existing_payload := jsonb_build_object(
      'email_id',v_existing.email_id,'subject',v_existing.subject,'action',v_existing.action,
      'work_order_id',v_existing.work_order_id,'reason',v_existing.reason,
      'parse_confidence',v_existing.parse_confidence,
      'contractor_assigned',v_existing.contractor_assigned,
      'raw_subject',v_existing.raw_subject,'raw_from',v_existing.raw_from
    );
    if v_existing.provenance <> 'trusted_service_v1'
       or v_existing.source_message_id is distinct from v_source
       or v_existing_payload is distinct from v_payload then
      raise exception 'Intake event identity was reused' using errcode = 'PT409';
    end if;
    return jsonb_build_object('applied',false,'reason','already_recorded',
      'logId',v_existing.id,'eventId',p_event_id,'sourceMessageId',v_source,
      'processedAt',v_existing.processed_at);
  end if;
  insert into public.email_intake_log_write_guards(transaction_id,event_id)
    values(txid_current(),p_event_id);
  v_recorded_at := clock_timestamp();
  insert into public.email_intake_log(
    email_id,subject,action,work_order_id,reason,parse_confidence,contractor_assigned,
    raw_subject,raw_from,processed_at,created_at,event_id,source_message_id,provenance
  ) values (
    v_email_id,v_subject,v_action,v_work_order_id,v_reason,v_confidence,v_contractor,
    v_raw_subject,v_raw_from,v_recorded_at,v_recorded_at,p_event_id,v_source,'trusted_service_v1'
  ) returning id into v_id;
  delete from public.email_intake_log_write_guards permit
    where permit.transaction_id = txid_current() and permit.event_id = p_event_id;
  return jsonb_build_object('applied',true,'reason','recorded','logId',v_id,
    'eventId',p_event_id,'sourceMessageId',v_source,'processedAt',v_recorded_at);
end;
$$;
revoke all on function public.record_email_intake_result_v1(uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.record_email_intake_result_v1(uuid,text,jsonb) to service_role;

commit;
