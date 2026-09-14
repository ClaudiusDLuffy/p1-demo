-- Read-only Batch 3B release audit. IDs/states/counts only: no recipient,
-- invoice number, source reason, message context, provider response or token.
-- Run after the queue-aware candidate and 0136; investigate, do not repair.
with source_events as (
  select 'review_activity'::text as kind,a.id,a.created_at
  from public.activities a where a.event_key in ('invoice_rejected','invoice_rejection_retracted') and a.deleted_at is null
  union all select 'hold_event',h.id,h.created_at from public.contractor_invoice_payment_hold_events h
), findings as (
  select 'post_contraction_source_missing_intent'::text as finding,s.id as record_id from source_events s
    where s.created_at>=(select contracted_at from public.financial_notification_control where singleton)
      and not exists(select 1 from public.financial_notification_events e where e.source_kind=s.kind and e.source_id=s.id)
  union all select 'legacy_source_before_contraction_untracked',s.id from source_events s
    where s.created_at<(select contracted_at from public.financial_notification_control where singleton)
      and not exists(select 1 from public.financial_notification_events e where e.source_kind=s.kind and e.source_id=s.id)
  union all select 'duplicate_source_identity',min(e.id::text)::uuid from public.financial_notification_events e group by e.source_kind,e.source_id having count(*)>1
  union all select 'event_without_recipient_or_placeholder',e.id from public.financial_notification_events e
    where not exists(select 1 from public.financial_notification_deliveries d where d.event_id=e.id)
  union all select 'event_without_owning_operation',e.id from public.financial_notification_events e
    where not exists(select 1 from public.financial_notification_mutation_operations o where o.operation_id=e.operation_id)
  union all select 'current_hold_source_head_mismatch',head.invoice_id from public.financial_notification_hold_heads head
    where not exists(select 1 from public.contractor_invoice_payment_hold_events h where h.id=head.source_id and h.invoice_id=head.invoice_id)
  union all select 'source_binding_mismatch',e.id from public.financial_notification_events e
    where (e.source_kind='review_activity' and not exists(select 1 from public.activities a where a.id=e.source_id and a.event_key=e.family
      and a.event_data->>'invoiceId'=e.invoice_id::text and a.event_data->>'revision'=e.review_revision::text and a.author_id=e.actor_id))
      or (e.source_kind='hold_event' and not exists(select 1 from public.contractor_invoice_payment_hold_events h where h.id=e.source_id
        and h.invoice_id=e.invoice_id and h.actor_id=e.actor_id and ('payment_hold_'||h.action)=e.family))
  union all select 'expired_claim_before_send',d.id from public.financial_notification_deliveries d where d.state='claimed' and d.claim_expires_at<clock_timestamp()
  union all select 'expired_claim_after_send',d.id from public.financial_notification_deliveries d where d.state='sending' and d.claim_expires_at<clock_timestamp()
  union all select 'sent_without_confirmation_evidence',d.id from public.financial_notification_deliveries d where d.state='sent'
    and not exists(select 1 from public.financial_notification_attempt_events a where a.delivery_id=d.id and a.phase='completed' and a.state='sent')
  union all select 'unknown_original_overwritten',d.id from public.financial_notification_deliveries d
    where exists(select 1 from public.financial_notification_attempt_events a where a.delivery_id=d.id and a.state='unknown') and d.state<>'unknown'
  union all select 'unknown_original_automatically_retried',d.id from public.financial_notification_deliveries d
    where exists(select 1 from public.financial_notification_attempt_events a join public.financial_notification_attempt_events later
      on later.delivery_id=a.delivery_id and later.sequence>a.sequence where a.delivery_id=d.id and a.state='unknown')
  union all select 'explicit_child_without_reasoned_operation',d.id from public.financial_notification_deliveries d where d.parent_delivery_id is not null
    and not exists(select 1 from public.financial_notification_operations o where o.delivery_id=d.parent_delivery_id and o.event_id=d.event_id and o.action='resend'
      and o.actor_id is not null and length(btrim(o.reason)) between 1 and 500)
  union all select 'manual_resolution_falsely_claims_sent',o.operation_id from public.financial_notification_operations o
    join public.financial_notification_deliveries d on d.id=o.delivery_id where o.action='manual_resolution' and d.state='sent'
  union all select 'placeholder_manually_resolved',o.operation_id from public.financial_notification_operations o
    join public.financial_notification_deliveries d on d.id=o.delivery_id where o.action='manual_resolution' and d.recipient_profile_id is null
  union all select 'not_deliverable_missing_safe_reason',d.id from public.financial_notification_deliveries d where d.state='not_deliverable' and d.last_error_code is null
  union all select 'pending_no_longer_current',d.id from public.financial_notification_deliveries d join public.financial_notification_events e on e.id=d.event_id
    where d.state in ('pending','claimed') and not public.financial_notification_event_current(e)
  union all select 'unresolved_older_than_proposed_15_minutes',d.id from public.financial_notification_deliveries d join public.financial_notification_events e on e.id=d.event_id
    where public.financial_notification_actionable(d) and public.financial_notification_event_current(e) and d.created_at<clock_timestamp()-interval '15 minutes'
      and not exists(select 1 from public.financial_notification_operations o where o.delivery_id=d.id)
  union all select 'recipient_no_longer_deliverable',d.id from public.financial_notification_deliveries d where d.state in ('pending','claimed','sending') and not public.financial_notification_recipient_valid(d)
) select finding,count(*) as record_count,array_agg(record_id order by record_id) as record_ids from findings group by finding order by finding;

select table_name,grantee,privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name in ('financial_notification_events','financial_notification_deliveries','financial_notification_attempt_events',
  'financial_notification_operations','financial_notification_mutation_operations','financial_notification_source_guards','financial_notification_record_guards','financial_notification_hold_heads')
  and grantee in ('PUBLIC','anon','authenticated','service_role') order by table_name,grantee,privilege_type;

select p.oid::regprocedure as function_signature,p.prosecdef,p.proconfig,
  has_function_privilege('anon',p.oid,'EXECUTE') as anonymous_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and (p.proname like '%financial_notification%' or p.proname like '%_with_notification_v1') order by p.proname;

select p.oid::regprocedure as bounded_read_signature,
  position('p_limit not between 1 and 50' in pg_get_functiondef(p.oid))>0 as bounded_page_cap,
  position('created_at desc' in pg_get_functiondef(p.oid))>0 as keyset_created_at_order,
  position('id desc' in pg_get_functiondef(p.oid))>0 as unique_tie_breaker
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and p.proname in ('financial_notification_page','get_financial_notification_history_v1');

select contracted,expanded_at,contracted_at from public.financial_notification_control where singleton;

-- Proposed operational thresholds, not configured alerts. Worker heartbeat is
-- the content-free financial_notification_drain structured log; operations
-- must investigate silence beyond two three-minute schedule intervals.
select count(*) filter(where d.state='pending' or public.financial_notification_retry_pending(d)) as pending_or_retry_count,
  min(d.created_at) filter(where d.state='pending' or public.financial_notification_retry_pending(d)) as oldest_pending_created_at,
  count(*) filter(where (d.state='pending' or public.financial_notification_retry_pending(d)) and d.created_at<clock_timestamp()-interval '15 minutes') as pending_over_proposed_15_minutes,
  count(*) filter(where d.state='unknown') as unknown_count,
  count(*) filter(where d.state='not_deliverable') as not_deliverable_count
from public.financial_notification_deliveries d join public.financial_notification_events e on e.id=d.event_id
where public.financial_notification_event_current(e)
  and not exists(select 1 from public.financial_notification_operations o where o.delivery_id=d.id)
  and not exists(select 1 from public.financial_notification_deliveries child where child.parent_delivery_id=d.id);
