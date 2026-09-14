-- Read-only Phase 5C promotion/operations audit. No repair, send or provider
-- lookup is performed. IDs/counts/codes only; never expose phone numbers,
-- message SIDs, recipient email, SMS body, raw legacy errors or credentials.
-- Legacy claimed/failed rows require human review, not automatic reclaim.
with snapshot as materialized(select public.parts_sms_snapshot(false) as value), findings as (
  select 'legacy_ambiguous_requires_review'::text as finding,d.id from public.p1_parts_alert_deliveries d
    where d.provenance='legacy' and d.status in ('claimed','failed')
      and not exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.id)
  union all select 'duplicate_original_event',min(d.id::text)::uuid from public.p1_parts_alert_deliveries d
    where d.parent_delivery_id is null group by d.recipient_id,d.local_date,d.request_signature having count(*)>1
  union all select 'duplicate_owned_provider_reference',min(d.id::text)::uuid from public.p1_parts_alert_deliveries d
    where d.provenance='owned_v1' and d.provider_message_id is not null group by d.provider_message_id having count(*)>1
  union all select 'current_recipient_missing_intent_or_daily_barrier',r.id from public.p1_parts_alert_recipients r cross join snapshot s
    where r.active and s.value->>'status'='ready' and not public.parts_sms_daily_blocked(r.id,(s.value->>'localDate')::date)
      and not exists(select 1 from public.p1_parts_alert_deliveries d where d.recipient_id=r.id
        and d.local_date=(s.value->>'localDate')::date and d.request_signature=s.value->>'requestSignature' and d.parent_delivery_id is null)
  union all select 'source_recurrence_requires_owner_policy',d.id from public.p1_parts_alert_deliveries d cross join snapshot s
    where public.parts_sms_recurrence_blocked(d,s.value)
  union all select 'child_missing_reasoned_operation',d.id from public.p1_parts_alert_deliveries d where d.parent_delivery_id is not null
    and not exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.parent_delivery_id and o.action='resend'
      and o.actor_id is not null and length(btrim(o.reason)) between 1 and 500)
  union all select 'child_identity_mismatch',d.id from public.p1_parts_alert_deliveries d
    join public.p1_parts_alert_deliveries p on p.id=d.parent_delivery_id
    where d.recipient_id<>p.recipient_id or d.recipient_profile_id<>p.recipient_profile_id or d.local_date<>p.local_date
      or d.request_signature<>p.request_signature or d.root_delivery_id<>coalesce(p.root_delivery_id,p.id)
  union all select 'new_automatic_digest_after_daily_barrier',d.id from public.p1_parts_alert_deliveries d
    where d.provenance='owned_v1' and d.parent_delivery_id is null and exists(
      select 1 from public.p1_parts_alert_deliveries earlier where earlier.recipient_id=d.recipient_id and earlier.local_date=d.local_date
        and earlier.id<>d.id and (
          (earlier.provenance='legacy' and earlier.claimed_at<=d.created_at)
          or exists(select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=earlier.id and a.created_at<d.created_at
            and (a.outcome='accepted' or a.state='unknown'))
          or exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=earlier.id and o.action='manual_resolution' and o.created_at<d.created_at)))
  union all select 'unknown_attempt_automatically_reclaimed',d.id from public.p1_parts_alert_deliveries d where exists(
    select 1 from public.p1_parts_sms_attempt_events a join public.p1_parts_sms_attempt_events later on later.delivery_id=a.delivery_id
      and later.created_at>a.created_at and later.phase in ('claimed','send_started') where a.delivery_id=d.id and a.state='unknown')
  union all select 'accepted_without_creation_or_status_evidence',d.id from public.p1_parts_alert_deliveries d
    where d.provenance='owned_v1' and d.status in ('accepted','sent','delivered') and (d.provider_message_id is null or not exists(
      select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=d.id and
        (a.outcome='accepted' or (a.phase='provider_status' and a.state in ('accepted','sent','delivered')))))
  union all select 'delivered_without_confirmed_delivered_evidence',d.id from public.p1_parts_alert_deliveries d
    where d.provenance='owned_v1' and d.status='delivered' and not exists(select 1 from public.p1_parts_sms_attempt_events a
      where a.delivery_id=d.id and a.state='delivered' and a.provider_status='delivered' and a.provider_message_id=d.provider_message_id
        and (a.outcome='accepted' or a.phase='provider_status'))
  union all select 'superseded_still_claimable',d.id from public.p1_parts_alert_deliveries d
    where d.provenance='owned_v1' and d.status='superseded' and (d.claim_token is not null or d.next_attempt_at is not null or d.send_started_at is not null)
  union all select 'terminal_provider_status_still_polling',d.id from public.p1_parts_alert_deliveries d
    where d.provenance='owned_v1' and d.provider_status in ('delivered','failed','undelivered')
      and (d.next_status_at is not null or d.status_claim_token is not null)
  union all select 'expired_claim_before_send',d.id from public.p1_parts_alert_deliveries d
    where d.provenance='owned_v1' and d.status='claimed' and d.claim_expires_at<=clock_timestamp()
  union all select 'expired_claim_after_send',d.id from public.p1_parts_alert_deliveries d
    where d.provenance='owned_v1' and d.status='sending' and d.claim_expires_at<=clock_timestamp()
  union all select 'expired_status_claim',d.id from public.p1_parts_alert_deliveries d
    where d.provenance='owned_v1' and d.status_claim_token is not null and d.status_claim_expires_at<=clock_timestamp()
  union all select 'stale_provider_status_requires_review',d.id from public.p1_parts_alert_deliveries d where d.status_check_stale
    and not exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.id)
  union all select 'unknown_requires_review',d.id from public.p1_parts_alert_deliveries d where d.provenance='owned_v1' and d.status='unknown'
    and not exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=d.id)
  union all select 'not_deliverable_missing_reason',d.id from public.p1_parts_alert_deliveries d
    where d.provenance='owned_v1' and d.status='not_deliverable' and d.last_error_code is null
  union all select 'pending_recipient_no_longer_eligible',d.id from public.p1_parts_alert_deliveries d
    where d.provenance='owned_v1' and d.status in ('pending','claimed') and not public.parts_sms_recipient_valid(d)
  union all select 'pending_digest_no_longer_current',d.id from public.p1_parts_alert_deliveries d cross join snapshot s
    where d.provenance='owned_v1' and (d.status in ('pending','claimed') or public.parts_sms_retry_pending(d))
      and (s.value->>'status' not in ('ready','disabled','unscheduled','before_cutoff','capacity_exceeded')
        or d.local_date::text is distinct from s.value->>'localDate'
        or (s.value->>'status'='ready' and (d.timezone is distinct from s.value->>'timezone'
          or d.request_signature is distinct from s.value->>'requestSignature')))
  union all select 'configured_recipient_phone_invalid',r.id from public.p1_parts_alert_recipients r
    where r.active and (r.phone_e164 is null or r.phone_e164 !~ '^\+[1-9][0-9]{7,14}$')
  union all select 'retry_without_known_unsent_evidence',d.id from public.p1_parts_alert_deliveries d
    where d.provenance='owned_v1' and d.status='failed' and d.next_attempt_at is not null and
      (d.attempt_count>=3 or d.last_error_code<>'TWILIO_BEFORE_SEND_CANCELLED' or not exists(
        select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=d.id and a.sequence=d.attempt_count and a.outcome='known_unsent_retryable'))
  union all select 'manual_resolution_relabels_delivered',o.operation_id from public.p1_parts_sms_operations o
    join public.p1_parts_alert_deliveries d on d.id=o.delivery_id where o.action='manual_resolution' and d.status='delivered'
  union all select 'operation_without_reason_or_actor',o.operation_id from public.p1_parts_sms_operations o
    where o.actor_id is null or length(btrim(o.reason)) not between 1 and 500
  union all select 'owned_delivery_without_bound_identity',d.id from public.p1_parts_alert_deliveries d where d.provenance='owned_v1'
    and (d.recipient_profile_id is null or d.timezone is null or d.configuration_version is null)
  union all select 'pending_exceeds_two_worker_intervals',d.id from public.p1_parts_alert_deliveries d where d.provenance='owned_v1'
    and ((d.status='pending' and d.created_at<clock_timestamp()-interval '6 minutes')
      or (public.parts_sms_retry_pending(d) and d.next_attempt_at<clock_timestamp()-interval '6 minutes'))
  union all select 'worker_run_incomplete',r.id from public.p1_parts_sms_runs r where r.completed_at is null and r.started_at<clock_timestamp()-interval '2 minutes'
), ranked as(select finding,id,row_number() over(partition by finding order by id) as position from findings)
select finding,count(*) as record_count,array_agg(id order by id) filter(where position<=25) as sample_record_ids
from ranked group by finding order by finding;

-- Explicitly distinguish absence/age of the durable worker heartbeat. These
-- are proposed runbook thresholds, not a claim that external alerts exist.
select (select started_at from public.p1_parts_sms_runs order by started_at desc,id desc limit 1) as last_started_at,
  not exists(select 1 from public.p1_parts_sms_runs where started_at>=clock_timestamp()-interval '6 minutes') as worker_silent_over_two_intervals,
  (select count(*) from (select id from public.p1_parts_alert_recipients where active limit 26) bounded) as active_recipient_count_capped_26,
  (select enabled from public.p1_parts_alert_settings where singleton) as enabled,
  (select cutoff_time is not null from public.p1_parts_alert_settings where singleton) as cutoff_configured,
  (select exists(select 1 from pg_timezone_names tz where tz.name=s.timezone) from public.p1_parts_alert_settings s where singleton) as timezone_valid,
  public.parts_sms_snapshot(false)->>'status' as evaluation_state;

select table_name,grantee,privilege_type from information_schema.role_table_grants where table_schema='public'
  and table_name in ('p1_parts_alert_settings','p1_parts_alert_recipients','p1_parts_alert_deliveries','p1_parts_sms_attempt_events',
    'p1_parts_sms_operations','p1_parts_sms_runs','p1_parts_sms_guards') and grantee in ('PUBLIC','anon','authenticated','service_role')
order by table_name,grantee,privilege_type;

select p.oid::regprocedure as function_signature,p.prosecdef,p.proconfig,
  coalesce(p.proconfig @> array['search_path=pg_catalog, public'],false) as pinned_safe_search_path,
  has_function_privilege('anon',p.oid,'EXECUTE') as anonymous_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and (p.proname like '%parts_sms%' or p.proname in ('configure_p1_parts_alerts','claim_p1_parts_alert_delivery','complete_p1_parts_alert_delivery'))
order by p.proname;

select c.relname as protected_table,c.relrowsecurity as row_level_security,
  exists(select 1 from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal and t.tgname like 'parts_sms_%guard') as command_guard_present,
  has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') as unexpected_browser_mutation_grant,
  has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') as unexpected_service_raw_mutation_grant
from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (
  'p1_parts_alert_settings','p1_parts_alert_recipients','p1_parts_alert_deliveries','p1_parts_sms_attempt_events','p1_parts_sms_operations','p1_parts_sms_runs')
order by c.relname;

select p.oid::regprocedure as staff_page_signature,
  position('p_limit not between 1 and 50' in pg_get_functiondef(p.oid))>0 as bounded_page_cap,
  position('created_at desc' in pg_get_functiondef(p.oid))>0 as stable_timestamp_order,
  position('id desc' in pg_get_functiondef(p.oid))>0 as stable_unique_tie_breaker,
  position('snapshotAt' in pg_get_functiondef(p.oid))>0 as insertion_snapshot_boundary
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and p.proname in ('list_parts_sms_unresolved_v1','get_parts_sms_history_v1');

select c.conname,c.conrelid::regclass as dependent_table,c.confrelid::regclass as referenced_table,c.confdeltype
from pg_constraint c where c.contype='f' and c.conrelid in (
  'public.p1_parts_alert_recipients'::regclass,'public.p1_parts_alert_deliveries'::regclass,
  'public.p1_parts_sms_attempt_events'::regclass,'public.p1_parts_sms_operations'::regclass)
order by dependent_table,c.conname;

select p.oid::regprocedure as legacy_compatibility_signature,
  position('SMS_WORKER_REQUIRED' in pg_get_functiondef(p.oid))>0 as direct_send_claim_fails_closed
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and p.proname in ('claim_p1_parts_alert_delivery','complete_p1_parts_alert_delivery');
