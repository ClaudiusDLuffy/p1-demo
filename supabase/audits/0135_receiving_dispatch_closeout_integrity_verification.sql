-- Read-only Batch 3A.1 audit. IDs/counts/state only; no recipient addresses,
-- message contents, operator notes, or provider response details.
select jsonb_build_object(
  'missing_post_closeout_current_intent',(select count(*) from public.work_orders w
    where w.deleted_at is null and w.contractor_id is not null
      and greatest(w.created_at,w.contractor_assignment_started_at)>=(select closeout_enforced_at from public.receiving_dispatch_control where singleton)
      and not exists(select 1 from public.contractor_receiving_dispatch_deliveries d
        where d.work_order_id=w.id and d.assignment_version=w.contractor_assignment_version and d.recipient_profile_id=w.contractor_id)),
  'legacy_untracked_current_assignment',(select count(*) from public.work_orders w
    where w.deleted_at is null and w.contractor_id is not null
      and greatest(w.created_at,w.contractor_assignment_started_at)<(select closeout_enforced_at from public.receiving_dispatch_control where singleton)
      and not exists(select 1 from public.contractor_receiving_dispatch_deliveries d
        where d.work_order_id=w.id and d.assignment_version=w.contractor_assignment_version and d.recipient_profile_id=w.contractor_id)),
  'duplicate_original_identity',(select count(*) from (
    select work_order_id,assignment_version,recipient_profile_id,event_type
    from public.contractor_receiving_dispatch_deliveries where parent_delivery_id is null
    group by 1,2,3,4 having count(*)>1) x),
  'multiple_current_leaves',(select count(*) from (
    select d.work_order_id,d.assignment_version,d.recipient_profile_id
    from public.contractor_receiving_dispatch_deliveries d join public.work_orders w on w.id=d.work_order_id
      and w.deleted_at is null and w.contractor_id=d.recipient_profile_id and w.contractor_assignment_version=d.assignment_version
    where not exists(select 1 from public.contractor_receiving_dispatch_deliveries child where child.parent_delivery_id=d.id)
    group by 1,2,3 having count(*)>1) x),
  'unresolved_current_without_action_projection',(select count(*)
    from public.contractor_receiving_dispatch_deliveries d join public.work_orders w on w.id=d.work_order_id
      and w.deleted_at is null and w.contractor_id=d.recipient_profile_id and w.contractor_assignment_version=d.assignment_version
    where public.receiving_dispatch_actionable(d)
      and not exists(select 1 from public.receiving_dispatch_operations o where o.delivery_id=d.id)
      and not exists(select 1 from public.contractor_receiving_dispatch_deliveries child where child.parent_delivery_id=d.id)
      and (public.receiving_dispatch_safe_projection(d)->>'canResolve')::boolean is distinct from true),
  'superseded_current_leaf',(select count(*)
    from public.contractor_receiving_dispatch_deliveries d join public.work_orders w on w.id=d.work_order_id
      and w.deleted_at is null and w.contractor_id=d.recipient_profile_id and w.contractor_assignment_version=d.assignment_version
    where d.status='superseded'
      and not exists(select 1 from public.contractor_receiving_dispatch_deliveries child where child.parent_delivery_id=d.id)),
  'resend_missing_reason_or_actor',(select count(*) from public.contractor_receiving_dispatch_deliveries d
    where d.event_type='explicit_resend' and not exists(select 1 from public.receiving_dispatch_operations o
      where o.child_delivery_id=d.id and o.delivery_id=d.parent_delivery_id and o.action='resend'
        and o.actor_id is not null and length(btrim(o.reason)) between 1 and 500)),
  'resend_wrong_assignment_identity',(select count(*) from public.contractor_receiving_dispatch_deliveries child
    join public.contractor_receiving_dispatch_deliveries parent on parent.id=child.parent_delivery_id
    where (child.work_order_id,child.assignment_version,child.recipient_profile_id,child.recipient_company_id)
      is distinct from (parent.work_order_id,parent.assignment_version,parent.recipient_profile_id,parent.recipient_company_id)),
  'unknown_original_outcome_overwritten',(select count(*) from public.contractor_receiving_dispatch_deliveries d
    where d.status<>'unknown' and exists(select 1 from public.receiving_dispatch_attempt_events e
      where e.delivery_id=d.id and e.state='unknown' and e.phase in ('completed','claim_expired'))),
  'automatic_attempt_after_unknown',(select count(*) from public.receiving_dispatch_attempt_events later
    where later.phase='claimed' and exists(select 1 from public.receiving_dispatch_attempt_events uncertain
      where uncertain.delivery_id=later.delivery_id and uncertain.state='unknown' and uncertain.created_at<later.created_at)),
  'manual_resolution_with_provider_sent',(select count(*) from public.receiving_dispatch_operations o
    join public.contractor_receiving_dispatch_deliveries d on d.id=o.delivery_id
    where o.action='manual_resolution' and (d.status='sent' or d.sent_at is not null)),
  'manual_resolution_missing_reason_or_actor',(select count(*) from public.receiving_dispatch_operations o
    where o.action='manual_resolution' and (o.actor_id is null or length(btrim(o.reason)) not between 1 and 500)),
  'not_deliverable_missing_reason',(select count(*) from public.contractor_receiving_dispatch_deliveries
    where status='not_deliverable' and last_error_code is null),
  'expired_before_start',(select count(*) from public.contractor_receiving_dispatch_deliveries
    where status='claimed' and send_started_at is null and claim_expires_at<=clock_timestamp()),
  'expired_after_start',(select count(*) from public.contractor_receiving_dispatch_deliveries
    where status='sending' and claim_expires_at<=clock_timestamp())
) as receiving_dispatch_closeout_integrity;

-- Proposed operational attention threshold: 15 minutes. This is a review
-- signal, not an asserted production SLA or a configured alerting system.
select d.id,d.work_order_id,d.assignment_version,d.status,d.created_at,
  d.attempt_count,(d.created_at<clock_timestamp()-interval '15 minutes') as older_than_review_threshold
from public.contractor_receiving_dispatch_deliveries d
join public.work_orders w on w.id=d.work_order_id and w.deleted_at is null
  and w.contractor_id=d.recipient_profile_id and w.contractor_assignment_version=d.assignment_version
where public.receiving_dispatch_actionable(d)
  and not exists(select 1 from public.receiving_dispatch_operations o where o.delivery_id=d.id)
  and not exists(select 1 from public.contractor_receiving_dispatch_deliveries child where child.parent_delivery_id=d.id)
order by d.created_at desc,d.id desc limit 100;

select c.relname as relation_name,r.rolname as role_name,
  has_table_privilege(r.oid,c.oid,'SELECT') as raw_select,
  has_table_privilege(r.oid,c.oid,'INSERT') as raw_insert,
  has_table_privilege(r.oid,c.oid,'UPDATE') as raw_update,
  has_table_privilege(r.oid,c.oid,'DELETE') as raw_delete,
  has_table_privilege(r.oid,c.oid,'TRUNCATE') as raw_truncate
from pg_catalog.pg_class c cross join pg_catalog.pg_roles r
where c.relnamespace='public'::regnamespace and c.relname in ('contractor_receiving_dispatch_deliveries',
  'receiving_dispatch_operations','receiving_dispatch_attempt_events','receiving_dispatch_transition_guards','receiving_dispatch_control')
  and r.rolname in ('anon','authenticated','service_role') order by c.relname,r.rolname;

select p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,p.prosecdef,p.proconfig,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_catalog.pg_proc p where p.pronamespace='public'::regnamespace
  and (p.proname like '%receiving_dispatch%' or p.proname='queue_receiving_contractor_dispatch')
order by p.proname,arguments;

select
  position('limit p_limit+1' in lower(pg_get_functiondef('public.list_receiving_dispatch_unresolved_v1(text,text,jsonb,integer)'::regprocedure)))>0 as queue_has_bounded_continuation,
  position('order by d.created_at desc,d.id desc' in lower(pg_get_functiondef('public.list_receiving_dispatch_unresolved_v1(text,text,jsonb,integer)'::regprocedure)))>0 as queue_has_stable_tiebreaker,
  position('p_limit>50' in lower(pg_get_functiondef('public.list_receiving_dispatch_unresolved_v1(text,text,jsonb,integer)'::regprocedure)))>0 as queue_has_hard_page_cap,
  not (pg_get_functiondef('public.receiving_dispatch_safe_projection(public.contractor_receiving_dispatch_deliveries)'::regprocedure)
    ~ 'jsonb_build_object\([^;]*(recipientEmail|providerReference|providerStatus|description)') as projection_excludes_sensitive_fields;
