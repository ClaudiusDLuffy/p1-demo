-- Read-only Batch 3C.1 audit. No send, repair, provider lookup or historical
-- mutation. IDs, counts, safe origin/generation/category values only.
-- 0138 remains a historical audit: its child_missing_reasoned_operation query
-- intentionally predates system recurrence children. Use this origin-aware
-- replacement; never manufacture a staff operation to satisfy the old query.
with findings as (
 select 'duplicate_recurrence_unit'::text as finding,min(d.id::text)::uuid as id
 from public.p1_parts_alert_deliveries d where d.delivery_origin='source_recurrence'
 group by d.source_generation_id having count(*)>1
 union all select 'recurrence_missing_or_mismatched_proof',d.id from public.p1_parts_alert_deliveries d
 left join public.p1_parts_sms_source_generations g on g.id=d.source_generation_id
 left join public.p1_parts_sms_source_generations prior on prior.id=d.prior_same_generation_id
 left join public.p1_parts_sms_source_generations intervening on intervening.id=d.intervening_generation_id
 left join public.p1_parts_alert_deliveries parent on parent.id=d.parent_delivery_id
 where d.delivery_origin='source_recurrence' and (
  g.id is null or prior.id is null or intervening.id is null or parent.id is null
  or g.recipient_id<>d.recipient_id or g.local_date<>d.local_date or g.request_signature<>d.request_signature
  or prior.recipient_id<>d.recipient_id or prior.local_date<>d.local_date or prior.request_signature<>d.request_signature
  or intervening.recipient_id<>d.recipient_id or intervening.local_date<>d.local_date or intervening.request_signature=d.request_signature
  or g.previous_generation_id<>intervening.id or prior.generation>=intervening.generation or intervening.generation>=g.generation
  or parent.recipient_id<>d.recipient_id or parent.local_date<>d.local_date or parent.request_signature<>d.request_signature
  or parent.recipient_profile_id<>d.recipient_profile_id or d.root_delivery_id<>coalesce(parent.root_delivery_id,parent.id))
 union all select 'recurrence_without_immutable_queued_evidence',d.id from public.p1_parts_alert_deliveries d
 where d.delivery_origin='source_recurrence' and not exists(select 1 from public.p1_parts_sms_attempt_events a
  where a.delivery_id=d.id and a.phase='source_recurrence' and a.state='pending' and a.sequence=0
    and a.provider_message_id is null and a.provider_status is null and a.code='PARTS_SOURCE_RECURRENCE_QUEUED')
 union all select 'recurrence_after_prior_send_start',d.id from public.p1_parts_alert_deliveries d
 where d.delivery_origin='source_recurrence' and exists(select 1 from public.p1_parts_alert_deliveries earlier
  where earlier.recipient_id=d.recipient_id and earlier.local_date=d.local_date and earlier.id<>d.id and (
    (earlier.send_started_at is not null and earlier.send_started_at<=d.created_at)
    or exists(select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=earlier.id and a.created_at<=d.created_at
      and (a.phase='send_started' or a.state='sending'))))
 union all select 'recurrence_after_daily_outcome_or_legacy',d.id from public.p1_parts_alert_deliveries d
 where d.delivery_origin='source_recurrence' and exists(select 1 from public.p1_parts_alert_deliveries earlier
  where earlier.recipient_id=d.recipient_id and earlier.local_date=d.local_date and earlier.id<>d.id and (
    (earlier.provenance='legacy' and earlier.created_at<=d.created_at)
    or exists(select 1 from public.p1_parts_sms_operations o where o.delivery_id=earlier.id and o.action='manual_resolution' and o.created_at<=d.created_at)
    or exists(select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=earlier.id and a.created_at<=d.created_at
      and (a.provider_message_id is not null or a.provider_status is not null or a.outcome='accepted' or a.state in ('accepted','sent','delivered','unknown')))))
 union all select 'cached_provider_reference_without_journal_proof',d.id from public.p1_parts_alert_deliveries d
 where d.provenance='owned_v1' and d.provider_message_id is not null and not exists(select 1 from public.p1_parts_sms_attempt_events a
  where a.delivery_id=d.id and a.provider_message_id=d.provider_message_id)
 union all select 'cached_provider_outcome_without_journal_proof',d.id from public.p1_parts_alert_deliveries d
 where d.provenance='owned_v1' and (d.provider_status is not null or d.status in ('accepted','sent','delivered','unknown'))
  and not exists(select 1 from public.p1_parts_sms_attempt_events a where a.delivery_id=d.id
    and (a.provider_status is not null or a.state in ('accepted','sent','delivered','unknown')))
 union all select 'recurrence_created_before_old_claim_closed',d.id from public.p1_parts_alert_deliveries d
 where d.delivery_origin='source_recurrence' and exists(select 1 from public.p1_parts_alert_deliveries earlier
  join public.p1_parts_sms_attempt_events claim on claim.delivery_id=earlier.id and claim.phase='claimed' and claim.created_at<=d.created_at
  where earlier.recipient_id=d.recipient_id and earlier.local_date=d.local_date and earlier.id<>d.id
   and not exists(select 1 from public.p1_parts_sms_attempt_events closed where closed.delivery_id=earlier.id
     and closed.created_at>=claim.created_at and closed.created_at<=d.created_at
     and closed.phase in ('completed','cancelled','expired') and closed.sequence=claim.sequence))
 union all select 'recurrence_created_before_old_retry_cancelled',d.id from public.p1_parts_alert_deliveries d
 where d.delivery_origin='source_recurrence' and exists(select 1 from public.p1_parts_alert_deliveries earlier
  join public.p1_parts_sms_attempt_events retry on retry.delivery_id=earlier.id and retry.phase='completed'
   and retry.outcome='known_unsent_retryable' and retry.sequence<3 and retry.created_at<=d.created_at
  where earlier.recipient_id=d.recipient_id and earlier.local_date=d.local_date and earlier.id<>d.id
   and not exists(select 1 from public.p1_parts_sms_attempt_events closed where closed.delivery_id=earlier.id
     and closed.created_at>=retry.created_at and closed.created_at<=d.created_at and (
       (closed.phase='cancelled' and closed.state in ('superseded','not_deliverable'))
       or (closed.phase='completed' and closed.sequence>=retry.sequence and (
         closed.outcome='known_unsent_terminal' or (closed.outcome='known_unsent_retryable' and closed.sequence>=3))))))
 union all select 'explicit_resend_missing_reasoned_operation',d.id from public.p1_parts_alert_deliveries d
 where public.parts_sms_origin(d)='explicit_resend' and not exists(select 1 from public.p1_parts_sms_operations o
  where o.delivery_id=d.parent_delivery_id and o.action='resend' and o.actor_id is not null and length(btrim(o.reason)) between 1 and 500)
 union all select 'system_recurrence_falsely_claims_staff_resend',d.id from public.p1_parts_alert_deliveries d
 where d.delivery_origin='source_recurrence' and exists(select 1 from public.p1_parts_sms_operations o
  where o.delivery_id=d.parent_delivery_id and o.action='resend')
 union all select 'historical_superseded_reset',d.id from public.p1_parts_alert_deliveries d
 where d.status<>'superseded' and exists(select 1 from public.p1_parts_sms_attempt_events a
  where a.delivery_id=d.id and a.phase='cancelled' and a.state='superseded')
 union all select 'generation_chain_identity_or_order_mismatch',g.id from public.p1_parts_sms_source_generations g
 left join public.p1_parts_sms_source_generations previous on previous.id=g.previous_generation_id
 where (g.generation>1 and (previous.id is null or previous.generation<>g.generation-1 or previous.recipient_id<>g.recipient_id or previous.local_date<>g.local_date))
   or (g.generation=1 and previous.id is not null)
 union all select 'historical_generation_missing_owned_basis',g.id from public.p1_parts_sms_source_generations g
 where g.source_kind='owned_delivery_evidence' and not exists(select 1 from public.p1_parts_alert_deliveries d
  where d.id=g.basis_delivery_id and d.provenance='owned_v1' and d.recipient_id=g.recipient_id and d.local_date=g.local_date
    and d.request_signature=g.request_signature and d.timezone=g.timezone)
 union all select 'superseded_token_still_owned',d.id from public.p1_parts_alert_deliveries d where d.status='superseded'
   and (d.claim_token is not null or d.claim_expires_at is not null or d.next_attempt_at is not null)
), ranked as(select finding,id,row_number() over(partition by finding order by id) as position from findings)
select finding,count(*) as record_count,array_agg(id order by id) filter(where position<=25) as sample_record_ids
from ranked group by finding order by finding;

with snapshot as materialized(select public.parts_sms_snapshot(false) value)
select d.id as stale_recurrence_delivery_id,d.status from public.p1_parts_alert_deliveries d cross join snapshot s
where d.delivery_origin='source_recurrence' and (d.status in ('pending','claimed') or public.parts_sms_retry_pending(d))
 and s.value->>'status'='ready' and (
   d.local_date::text<>s.value->>'localDate' or d.timezone<>s.value->>'timezone' or d.request_signature<>s.value->>'requestSignature'
   or d.source_generation_id is distinct from (select g.id from public.p1_parts_sms_source_generations g
     where g.recipient_id=d.recipient_id and g.local_date=d.local_date order by g.generation desc limit 1))
order by d.created_at,d.id limit 25;

-- A blocked recurrence is an accountable policy outcome, not proof of worker
-- outage. Eligible awaiting-evaluation rows can have a null block category.
with snapshot as materialized(select public.parts_sms_snapshot(true) value), current_review as (
 select d.id,public.parts_sms_origin(d) as origin,
  public.parts_sms_recurrence_block_category(d,s.value) as block_category
 from public.p1_parts_alert_deliveries d cross join snapshot s where public.parts_sms_recurrence_candidate(d,s.value)
), ranked as(select *,row_number() over(partition by block_category order by id) as position from current_review)
select coalesce(block_category,'awaiting_service_evaluation') as review_category,count(*) as record_count,array_agg(id order by id) filter(where position<=25) as sample_record_ids
from ranked group by block_category order by block_category;

select count(*) as historical_0138_staff_operation_check_expected_system_children
from public.p1_parts_alert_deliveries where delivery_origin='source_recurrence';

select table_name,grantee,privilege_type from information_schema.role_table_grants where table_schema='public'
 and table_name in ('p1_parts_sms_source_generations','p1_parts_alert_deliveries','p1_parts_sms_attempt_events','p1_parts_sms_operations','p1_parts_sms_guards')
 and grantee in ('PUBLIC','anon','authenticated','service_role') order by table_name,grantee,privilege_type;

select p.oid::regprocedure as function_signature,p.prosecdef,p.proconfig,
 coalesce(p.proconfig @> array['search_path=pg_catalog, public'],false) as pinned_safe_search_path,
 has_function_privilege('anon',p.oid,'EXECUTE') as anonymous_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and
 (p.proname like '%parts_sms%recurrence%' or p.proname like 'parts_sms_%generation%' or p.proname in (
  'parts_sms_observe_source','parts_sms_insert_delivery','enqueue_parts_sms_deliveries_v1','claim_parts_sms_delivery_v1','prepare_parts_sms_send_v1'))
order by p.proname;

select c.relname,c.relrowsecurity,
 has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') as unexpected_browser_mutation,
 has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') as unexpected_service_raw_mutation,
 exists(select 1 from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal and t.tgname='parts_sms_generation_guard') as immutable_command_guard
from pg_class c where c.oid='public.p1_parts_sms_source_generations'::regclass;

select indexname,indexdef from pg_indexes where schemaname='public' and indexname in (
 'p1_parts_sms_original_event','p1_parts_sms_explicit_child','p1_parts_sms_recurrence_once','p1_parts_sms_generation_latest') order by indexname;
