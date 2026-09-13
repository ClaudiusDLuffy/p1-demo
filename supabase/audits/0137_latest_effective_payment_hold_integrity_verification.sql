-- Read-only approved hold-policy audit. Safe identifiers/states/counts only.
-- Do not repair, resend, delete, or reclassify rows while running this audit.
with hold_events as (
  select e.*,public.financial_notification_hold_superseder(e) as later_id
  from public.financial_notification_events e where e.source_kind='hold_event'
), findings as (
  select 'supersession_source_identity_mismatch'::text as finding,s.id as record_id
  from public.financial_notification_hold_supersessions s
  join public.financial_notification_events old_event on old_event.id=s.event_id
  join public.financial_notification_events later on later.id=s.superseding_event_id
  join public.financial_notification_deliveries d on d.id=s.delivery_id
  where old_event.source_kind<>'hold_event' or later.source_kind<>'hold_event'
    or old_event.invoice_id<>later.invoice_id or d.event_id<>old_event.id
    or later.event_sequence<=old_event.event_sequence or later.source_id<>s.superseding_source_event_id
    or later.actor_id<>s.actor_id or later.operation_id<>s.operation_id
    or s.reason<>'A later payment-hold source event committed.' or length(s.reason)>150
    or not exists(select 1 from public.contractor_invoice_payment_hold_events source
      where source.id=s.superseding_source_event_id and source.invoice_id=later.invoice_id
        and source.actor_id=s.actor_id and ('payment_hold_'||source.action)=later.family)
  union all select 'post_policy_supersession_evidence_missing',d.id
  from hold_events e join public.financial_notification_deliveries d on d.event_id=e.id
  join public.financial_notification_events later on later.id=e.later_id
  where later.created_at>=(select hold_policy_activated_at from public.financial_notification_control where singleton)
    and not exists(select 1 from public.financial_notification_hold_supersessions s where s.delivery_id=d.id)
  union all select 'grandfathered_stale_delivery_requires_release_review',d.id
  from hold_events e join public.financial_notification_deliveries d on d.event_id=e.id
  join public.financial_notification_events later on later.id=e.later_id
  where later.created_at<(select hold_policy_activated_at from public.financial_notification_control where singleton)
    and not exists(select 1 from public.financial_notification_hold_supersessions s where s.delivery_id=d.id)
  union all select 'grandfathered_newer_source_without_tracked_parent',d.id
  from hold_events e join public.financial_notification_deliveries d on d.event_id=e.id
  where e.later_id is null and e.source_id is distinct from public.financial_notification_latest_hold_source(e.invoice_id)
  union all select 'historical_hold_wrongly_projected_current_or_resendable',d.id
  from hold_events e join public.financial_notification_deliveries d on d.event_id=e.id
  where e.source_id is distinct from public.financial_notification_latest_hold_source(e.invoice_id)
    and ((public.financial_notification_safe_projection(d,false)->>'current')::boolean
      or (public.financial_notification_safe_projection(d,false)->>'canResend')::boolean
      or (public.financial_notification_safe_projection(d,false)->>'canResolve')::boolean)
  union all select 'superseded_delivery_retains_live_claim',d.id
  from public.financial_notification_deliveries d where d.state='superseded'
    and (d.claim_token is not null or d.claim_expires_at is not null)
  union all select 'claim_created_after_hold_supersession',a.id
  from public.financial_notification_hold_supersessions s
  join public.financial_notification_attempt_events a on a.delivery_id=s.delivery_id and a.phase='claimed'
  where a.created_at>s.created_at
  union all select 'stale_known_unsent_delivery_not_superseded',d.id
  from hold_events e join public.financial_notification_deliveries d on d.event_id=e.id
  join public.financial_notification_hold_supersessions s on s.delivery_id=d.id
  where e.later_id is not null and d.state in ('pending','claimed','failed','not_deliverable')
    and d.send_started_at is null
    and not exists(select 1 from public.financial_notification_operations o where o.delivery_id=d.id and o.action='manual_resolution')
  union all select 'immutable_terminal_outcome_overwritten',d.id
  from public.financial_notification_hold_supersessions s join public.financial_notification_deliveries d on d.id=s.delivery_id
  where s.original_state in ('sent','unknown') and d.state<>s.original_state
  union all select 'unknown_attempt_overwritten_or_automatically_retried',d.id
  from public.financial_notification_deliveries d
  where exists(select 1 from public.financial_notification_attempt_events a where a.delivery_id=d.id and a.state='unknown'
    and (d.state<>'unknown' or exists(select 1 from public.financial_notification_attempt_events later
      where later.delivery_id=d.id and later.sequence>a.sequence)))
  union all select 'manual_resolution_original_overwritten',d.id
  from public.financial_notification_hold_supersessions s join public.financial_notification_deliveries d on d.id=s.delivery_id
  where exists(select 1 from public.financial_notification_operations o where o.delivery_id=d.id and o.action='manual_resolution' and o.created_at<=s.created_at)
    and d.state<>s.original_state
  union all select 'old_hold_send_started_after_later_source',a.id
  from hold_events e join public.financial_notification_deliveries d on d.event_id=e.id
  join public.financial_notification_attempt_events a on a.delivery_id=d.id and a.phase='sending'
  join public.financial_notification_events later on later.id=e.later_id
  where a.created_at>=later.created_at
    and later.created_at>=(select hold_policy_activated_at from public.financial_notification_control where singleton)
  union all select 'opposite_notice_overlapping_send_start',new_start.id
  from hold_events newer join public.financial_notification_deliveries new_delivery on new_delivery.event_id=newer.id
  join public.financial_notification_attempt_events new_start on new_start.delivery_id=new_delivery.id and new_start.phase='sending'
  join hold_events older on older.invoice_id=newer.invoice_id and older.event_sequence<newer.event_sequence
  join public.financial_notification_deliveries old_delivery on old_delivery.event_id=older.id
  join public.financial_notification_attempt_events old_start on old_start.delivery_id=old_delivery.id and old_start.phase='sending'
  where old_start.created_at<new_start.created_at
    and new_start.created_at>=(select hold_policy_activated_at from public.financial_notification_control where singleton)
    and not exists(select 1 from public.financial_notification_attempt_events terminal where terminal.delivery_id=old_delivery.id
      and terminal.sequence=old_start.sequence and terminal.phase in ('completed','claim_expired') and terminal.created_at<=new_start.created_at)
  union all select 'historical_resend_after_superseding_source',o.operation_id
  from public.financial_notification_operations o join hold_events e on e.id=o.event_id
  join public.financial_notification_events later on later.id=e.later_id
  where o.action='resend' and o.created_at>=later.created_at
    and o.created_at>=(select hold_policy_activated_at from public.financial_notification_control where singleton)
  union all select 'historical_note_missing_valid_evidence',o.operation_id
  from public.financial_notification_operations o join public.financial_notification_deliveries d on d.id=o.delivery_id
  join public.financial_notification_events e on e.id=o.event_id
  where o.action='history_note' and (e.source_kind<>'hold_event' or d.event_id<>e.id
    or d.state not in ('unknown','superseded') or length(btrim(o.reason)) not between 1 and 500 or o.actor_id is null
    or not exists(select 1 from public.financial_notification_hold_supersessions s where s.delivery_id=d.id))
  union all select 'current_hold_source_disagrees_with_authoritative_hold',e.id
  from hold_events e where e.source_id=public.financial_notification_latest_hold_source(e.invoice_id)
    and ((e.family='payment_hold_placed')<>exists(select 1 from public.contractor_invoice_payment_holds h where h.invoice_id=e.invoice_id))
  union all select 'expired_send_blocks_latest_notice_until_recovery',d.id
  from hold_events e join public.financial_notification_deliveries d on d.event_id=e.id
  where e.later_id is not null and d.state='sending' and d.claim_expires_at<=clock_timestamp()
) select finding,count(*) as record_count,array_agg(record_id order by record_id) as record_ids
  from findings group by finding order by finding;

select table_name,grantee,privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name in ('financial_notification_hold_supersessions','financial_notification_operations',
  'financial_notification_record_guards','financial_notification_deliveries','financial_notification_attempt_events')
  and grantee in ('PUBLIC','anon','authenticated','service_role') order by table_name,grantee,privilege_type;

select p.oid::regprocedure as function_signature,p.proconfig,
  has_function_privilege('anon',p.oid,'EXECUTE') as anonymous_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and (p.proname like '%financial_notification%hold%' or p.proname='annotate_financial_notification_history_v1'
  or p.proname in ('claim_financial_notification_deliveries_v1','prepare_financial_notification_send_v1',
    'complete_financial_notification_delivery_v1','financial_notification_event_current','financial_notification_staff_action'))
order by p.proname;

select p.oid::regprocedure as history_signature,
  position('p_limit not between 1 and 50' in pg_get_functiondef(p.oid))>0 as bounded_history,
  position('created_at desc' in pg_get_functiondef(p.oid))>0 as deterministic_order,
  position('id desc' in pg_get_functiondef(p.oid))>0 as unique_tie_breaker,
  position('supersession' in pg_get_functiondef(p.oid))>0 as supersession_history_present
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='get_financial_notification_history_v1';

select hold_policy_activated_at from public.financial_notification_control where singleton;
