-- Read-only Batch 2B catalog and anomaly report. Run after 0129 and again
-- after 0130. Raw-write contraction checks intentionally fail at expansion.
-- No customer text, email/message identifiers or automatic repair output.
with checks as (
  select
    exists(select 1 from pg_proc routine where routine.oid='public.get_my_role()'::regprocedure
      and routine.proconfig @> array['search_path=public, pg_temp']
      and pg_get_functiondef(routine.oid) like '%profile.active = true%') as active_role_helper,
    exists(select 1 from pg_policies policy where policy.schemaname='public'
      and policy.tablename='email_intake_log' and policy.policyname='email_intake_log_read'
      and policy.cmd='SELECT' and policy.qual='is_staff()') as active_intake_read_policy,
    exists(select 1 from pg_policies policy where policy.schemaname='public'
      and policy.tablename='wo_parts' and policy.policyname='wo_parts_delete'
      and policy.cmd='DELETE' and policy.qual='is_staff()') as active_parts_delete_policy,
    exists(select 1 from pg_proc routine where routine.oid='public.get_incident_reuse_warnings()'::regprocedure
      and routine.proconfig @> array['search_path=public, pg_temp']
      and pg_get_functiondef(routine.oid) like '%public.is_staff()%'
      and pg_get_functiondef(routine.oid) not like '%get_my_role%') as active_incident_rpc,
    not exists(select 1 from pg_proc routine join pg_namespace namespace on namespace.oid=routine.pronamespace
      where namespace.nspname='public' and routine.prokind='f'
        and routine.proname<>'get_my_role' and pg_get_functiondef(routine.oid) like '%get_my_role()%')
      and not exists(select 1 from pg_policies policy where policy.schemaname in ('public','storage')
        and (coalesce(policy.qual,'') like '%get_my_role%' or coalesce(policy.with_check,'') like '%get_my_role%'))
      as no_legacy_role_authorization_consumers,
    not has_function_privilege('anon','public.get_my_role()','EXECUTE')
      and has_function_privilege('authenticated','public.get_my_role()','EXECUTE')
      and not has_function_privilege('anon','public.get_incident_reuse_warnings()','EXECUTE')
      and has_function_privilege('authenticated','public.get_incident_reuse_warnings()','EXECUTE')
      as deliberate_read_routine_grants,
    has_function_privilege('service_role','public.record_email_intake_result_v1(uuid,text,jsonb)','EXECUTE')
      and not has_function_privilege('authenticated','public.record_email_intake_result_v1(uuid,text,jsonb)','EXECUTE')
      and not has_function_privilege('anon','public.record_email_intake_result_v1(uuid,text,jsonb)','EXECUTE')
      as service_only_command,
    exists(select 1 from pg_proc routine where routine.oid='public.record_email_intake_result_v1(uuid,text,jsonb)'::regprocedure
      and routine.proconfig @> array['search_path=public, pg_temp']) as command_search_path,
    not exists(select 1 from unnest(array['anon','authenticated','service_role']) role_name
      cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES']) privilege
      where has_table_privilege(role_name,'public.email_intake_log',privilege)) as raw_log_mutations_denied,
    not exists(select 1 from pg_policies policy where policy.schemaname='public'
      and policy.tablename='email_intake_log' and policy.cmd in ('INSERT','UPDATE','DELETE','ALL'))
      as no_raw_write_policies,
    exists(select 1 from pg_trigger trigger where trigger.tgrelid='public.email_intake_log'::regclass
      and trigger.tgname='protect_email_intake_log_provenance_trigger' and trigger.tgenabled='O') as immutable_provenance_guard,
    exists(select 1 from pg_index index where index.indexrelid='public.email_intake_log_event_id_unique'::regclass
      and index.indisunique and index.indisvalid) as unique_event_identity,
    exists(select 1 from pg_class relation where relation.oid='public.email_intake_log_write_guards'::regclass
      and relation.relrowsecurity)
      and not exists(select 1 from unnest(array['anon','authenticated','service_role']) role_name
        cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES']) privilege
        where has_table_privilege(role_name,'public.email_intake_log_write_guards',privilege))
      and not exists(select 1 from unnest(array['anon','authenticated','service_role']) role_name
        where has_function_privilege(role_name,'public.protect_email_intake_log_provenance()','EXECUTE'))
      as private_capability_inaccessible,
    not exists(select 1 from public.email_intake_log_write_guards) as no_leaked_capabilities
)
select checks.*,not exists(select 1 from jsonb_each(to_jsonb(checks)) field where field.value<>'true'::jsonb)
  as all_checks_pass from checks;

with normalized_outcomes as (
  select log.id,log.event_id,log.source_message_id,
    btrim(log.email_id,characters.trim_chars) as normalized_email_id,
    btrim(log.source_message_id,characters.trim_chars) as normalized_source_id,
    jsonb_build_array(
      btrim(log.source_message_id,characters.trim_chars),log.action,
      btrim(log.work_order_id,characters.trim_chars),
      btrim(regexp_replace(log.reason,'[' || chr(1) || '-' || chr(31) || chr(127) || ']',' ','g'),characters.trim_chars),
      log.parse_confidence
    ) as outcome_identity
  from public.email_intake_log log
  cross join (select U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'::text trim_chars) characters
), anomalies as (
  select 'legacy_unverified_history_requires_review'::text issue,log.id
    from public.email_intake_log log where log.provenance='legacy_unverified'
  union all
  select 'missing_or_inconsistent_trusted_identity',log.id
    from public.email_intake_log log where log.provenance='trusted_service_v1'
      and (log.event_id is null or log.source_message_id is null or length(log.source_message_id) not between 1 and 2048)
  union all
  select 'duplicate_event_identity',log.id from public.email_intake_log log
    where log.event_id is not null and exists(select 1 from public.email_intake_log other
      where other.event_id=log.event_id and other.id<>log.id)
  union all
  -- Multiple DIFFERENT outcomes for one source are legitimate. Flag only the
  -- same normalized source/action/parent/reason/confidence under different
  -- event UUIDs; Graph aliases and timestamps are not outcome identity.
  select 'duplicate_normalized_outcome_different_event',outcome.id
    from normalized_outcomes outcome where outcome.source_message_id is not null
      and outcome.event_id is not null and exists(
        select 1 from normalized_outcomes other where other.id<>outcome.id
          and other.event_id is not null and other.event_id<>outcome.event_id
          and other.outcome_identity=outcome.outcome_identity)
  union all
  select 'empty_or_control_email_identity',outcome.id from normalized_outcomes outcome
    where outcome.normalized_email_id is null or outcome.normalized_email_id=''
      or outcome.normalized_email_id ~ ('[' || chr(1) || '-' || chr(31) || chr(127) || ']')
  union all
  select 'invalid_source_message_identity',outcome.id from normalized_outcomes outcome
    where outcome.source_message_id is not null and (
      outcome.normalized_source_id='' or length(outcome.source_message_id)>2048
      or outcome.normalized_source_id ~ ('[' || chr(1) || '-' || chr(31) || chr(127) || ']'))
  union all
  -- Legacy values are review findings, not retrospective constraint failures.
  select 'legacy_or_new_content_bounds_review',log.id from public.email_intake_log log
    where length(log.email_id)>2048 or length(log.work_order_id)>128
      or length(log.reason)>2000 or length(log.subject)>1024
      or length(log.raw_subject)>1024 or length(log.raw_from)>320
  union all
  select 'invalid_action_or_confidence',log.id from public.email_intake_log log
    where log.action not in ('created','updated','skipped','failed')
      or log.parse_confidence is null or log.parse_confidence not in ('high','medium','low')
  union all
  select 'successful_outcome_without_parent_reference',log.id from public.email_intake_log log
    where log.action in ('created','updated') and (log.work_order_id is null or not exists(
      select 1 from public.work_orders work_order where work_order.id=log.work_order_id))
  union all
  select 'orphan_parent_reference',log.id from public.email_intake_log log
    where log.work_order_id is not null and not exists(
      select 1 from public.work_orders work_order where work_order.id=log.work_order_id)
  union all
  select 'invalid_or_orphan_contractor_reference',log.id from public.email_intake_log log
    where log.contractor_assigned is not null and not exists(
      select 1 from public.profiles profile where profile.id::text=lower(log.contractor_assigned))
  union all
  select 'trusted_timestamp_or_content_bounds_violation',log.id from public.email_intake_log log
    where log.provenance='trusted_service_v1' and (
      log.processed_at is null or log.created_at is null or log.processed_at is distinct from log.created_at
      or length(log.email_id) not between 1 and 2048 or length(log.reason) not between 1 and 2000
      or length(log.subject)>1024 or length(log.raw_subject)>1024 or length(log.raw_from)>320)
)
select issue,count(*) as anomaly_count
  from anomalies group by issue order by issue;
