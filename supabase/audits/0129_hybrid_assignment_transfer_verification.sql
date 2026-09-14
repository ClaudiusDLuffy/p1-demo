-- Read-only: hybrid transfer enforcement and safe anomaly counts/identifiers.
-- Run after 0128 in the controlled rollout; never repair history implicitly.
with checks as (
  select
    has_function_privilege('authenticated',
      'public.administrative_close_visit_and_transfer_v1(text,uuid,integer,integer,bigint,uuid,text,boolean)','EXECUTE')
      and not has_function_privilege('anon',
      'public.administrative_close_visit_and_transfer_v1(text,uuid,integer,integer,bigint,uuid,text,boolean)','EXECUTE')
      and not has_function_privilege('service_role',
      'public.administrative_close_visit_and_transfer_v1(text,uuid,integer,integer,bigint,uuid,text,boolean)','EXECUTE') as deliberate_command_grants,
    exists(select 1 from pg_proc p where p.oid=
      'public.administrative_close_visit_and_transfer_v1(text,uuid,integer,integer,bigint,uuid,text,boolean)'::regprocedure
      and p.proconfig @> array['search_path=public, pg_temp']) as command_search_path,
    exists(select 1 from pg_trigger where tgrelid='public.work_order_visits'::regclass
      and tgname='aaa_protect_administrative_transfer_visit' and tgenabled='O') as visit_provenance_guard,
    exists(select 1 from pg_trigger where tgrelid='public.activities'::regclass
      and tgname='zzzzz_protect_administrative_transfer_activity' and tgenabled='O') as administrative_event_guard,
    exists(select 1 from pg_trigger where tgrelid='public.work_orders'::regclass
      and tgname='zz_preserve_pending_assignment_transfer' and tgenabled='O') as parent_transfer_guard,
    not exists(select 1 from public.work_order_assignment_command_guards) as no_leaked_capabilities,
    not exists(select 1 from pg_proc p where p.oid in (
      'public.assign_pending_transferred_work_order(text,uuid)'::regprocedure,
      'public.protect_administrative_transfer_visit()'::regprocedure,
      'public.protect_administrative_transfer_activity()'::regprocedure,
      'public.protect_pending_assignment_transfer()'::regprocedure)
      and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
        or has_function_privilege('service_role',p.oid,'EXECUTE'))) as private_helpers_inaccessible
)
select *,deliberate_command_grants and command_search_path and visit_provenance_guard and administrative_event_guard
  and parent_transfer_guard and no_leaked_capabilities and private_helpers_inaccessible as all_checks_pass from checks;

with anomalies as (
  select 'administrative_visit_missing_evidence'::text issue,v.work_order_id
    from public.work_order_visits v where v.closure_kind='administrative_transfer' and not exists(
      select 1 from public.activities a where a.id=v.check_out_activity_id
        and a.work_order_id=v.work_order_id and a.event_key='visit_administratively_closed_for_transfer'
        and a.administrative_transfer_operation_id=v.administrative_transfer_operation_id
        and a.author_id=v.administrative_closed_by and a.deleted_at is null)
  union all select 'administrative_visit_missing_review_or_provenance',v.work_order_id
    from public.work_order_visits v where v.closure_kind='administrative_transfer' and (
      not v.duration_review_required or v.administrative_closed_at is null or v.administrative_closed_by is null
      or v.administrative_close_reason is null or v.administrative_transfer_operation_id is null or v.check_out_at is null)
  union all select 'administrative_visit_without_accepted_transfer',v.work_order_id
    from public.work_order_visits v left join public.work_order_assignment_operations o
      on o.operation_id=v.administrative_transfer_operation_id where v.closure_kind='administrative_transfer'
      and (o.result is null or o.work_order_id is distinct from v.work_order_id
        or o.payload->>'transferMode' is distinct from 'administrative_close'
        or o.result->>'administrativeClosedVisitId' is distinct from v.id::text)
  union all select 'administrative_event_without_visit',a.work_order_id from public.activities a
    where a.event_key='visit_administratively_closed_for_transfer' and not exists(
      select 1 from public.work_order_visits v where v.check_out_activity_id=a.id
        and v.administrative_transfer_operation_id=a.administrative_transfer_operation_id)
  union all select 'pending_receiving_visit_without_transfer',w.id from public.work_orders w
    where w.assignment_transfer_pending_visit and not exists(select 1 from public.work_order_assignment_operations o
      where o.operation_id=w.assignment_transfer_operation_id and o.work_order_id=w.id
        and o.result is not null and o.payload->>'transferMode'='administrative_close')
  union all select 'pending_receiving_visit_inconsistent_state',w.id from public.work_orders w
    where w.assignment_transfer_pending_visit and (w.status<>'wip' or w.functional_status<>'Work in Progress'
      or w.deleted_at is not null or exists(select 1 from public.work_order_visits v where v.work_order_id=w.id and v.check_out_at is null))
  union all select 'legacy_active_visit_belongs_to_prior_contractor',w.id from public.work_orders w
    join public.work_order_visits v on v.work_order_id=w.id where v.check_out_at is null and v.contractor_id is distinct from w.contractor_id
)
select issue,count(*) as anomaly_count,
  (array_agg(distinct work_order_id order by work_order_id))[1:100] as work_order_ids
from anomalies group by issue order by issue;
