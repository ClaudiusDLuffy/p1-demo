-- Read-only Batch 2A verification. Execute using an approved read-only audit
-- identity after expansion, before contraction, and again after contraction.
-- Counts/identifiers only: no customer text, profile contact data or repair.

with checks as (
  select
    coalesce((select contracted from public.work_order_assignment_control where singleton),false) as contraction_enabled,
    exists(select 1 from pg_trigger where tgrelid='public.work_orders'::regclass
      and tgname='aaa_protect_assignment_archive_input' and tgenabled='O') as protected_parent_trigger,
    exists(select 1 from pg_trigger where tgrelid='public.activities'::regclass
      and tgname='zzzz_protect_assignment_activity' and tgenabled='O') as authoritative_activity_trigger,
    not has_table_privilege('authenticated','public.work_order_assignment_history','INSERT,UPDATE,DELETE') as history_browser_dml_denied,
    not has_table_privilege('service_role','public.contractor_assignment_transition_deliveries','INSERT,UPDATE,DELETE') as delivery_raw_service_dml_denied,
    not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname in ('work_order_assignment_control','work_order_assignment_operations',
        'work_order_assignment_command_guards') and (not c.relrowsecurity
        or has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')
        or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE')
        or has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE'))) as private_tables_inaccessible,
    not exists(select 1 from pg_proc p where p.oid in (
      'public.require_work_order_assignment_actor()'::regprocedure,
      'public.require_assignable_contractor(uuid)'::regprocedure,
      'public.begin_work_order_assignment_command(text,integer,integer,bigint,uuid,text,jsonb)'::regprocedure,
      'public.finish_work_order_assignment_command(uuid,jsonb)'::regprocedure,
      'public.create_work_order_assignment_core(uuid,jsonb,boolean)'::regprocedure,
      'public.transition_work_order_contractor_assignment_core(text,uuid,integer)'::regprocedure,
      'public.reject_unassigned_work_order_assignment_core(text,text)'::regprocedure,
      'public.duplicate_work_order_notified_assignment_core(text)'::regprocedure)
      and (has_function_privilege('anon',p.oid,'EXECUTE')
        or has_function_privilege('authenticated',p.oid,'EXECUTE')
        or has_function_privilege('service_role',p.oid,'EXECUTE'))) as private_helpers_inaccessible,
    not has_function_privilege('authenticated','public.reject_unassigned_work_order(text,text)','EXECUTE')
      and not has_function_privilege('authenticated','public.duplicate_work_order_for_reassignment_notified(text)','EXECUTE') as unversioned_entries_retired,
    not exists(select 1 from pg_proc p where p.oid in (
      'public.transition_work_order_contractor_v1(text,uuid,integer,integer,bigint,uuid)'::regprocedure,
      'public.reject_unassigned_work_order_v1(text,text,integer,integer,bigint,uuid)'::regprocedure,
      'public.duplicate_work_order_for_reassignment_v1(text,integer,integer,bigint,uuid)'::regprocedure,
      'public.create_work_order_with_assignment_v1(uuid,jsonb)'::regprocedure,
      'public.create_email_work_order_with_assignment_v1(uuid,jsonb)'::regprocedure)
      and (not coalesce(p.proconfig @> array['search_path=public, pg_temp'],false)
        or has_function_privilege('anon',p.oid,'EXECUTE'))) as command_search_paths_and_anon_denial,
    not exists(select 1 from public.work_order_assignment_command_guards) as no_leaked_capabilities
)
select *,contraction_enabled and protected_parent_trigger and authoritative_activity_trigger
  and history_browser_dml_denied and delivery_raw_service_dml_denied and private_tables_inaccessible
  and private_helpers_inaccessible and unversioned_entries_retired and command_search_paths_and_anon_denial
  and no_leaked_capabilities as all_checks_pass from checks;

-- Legacy review counts do not become an implicit repair/backfill instruction.
with anomalies as (
  select 'inactive_assigned_profile'::text issue,w.id work_order_id from public.work_orders w
    join public.profiles p on p.id=w.contractor_id where w.deleted_at is null and p.active is not true
  union all select 'wrong_role_assigned_profile',w.id from public.work_orders w
    join public.profiles p on p.id=w.contractor_id where w.deleted_at is null and p.role<>'contractor'
  union all select 'noncanonical_or_ineligible_assigned_profile',w.id from public.work_orders w
    join public.profiles p on p.id=w.contractor_id where w.deleted_at is null and p.role='contractor'
      and (p.is_assignable is not true or public.contractor_account_id_for_profile(p.id) is distinct from p.id)
  union all select 'missing_assigned_profile',w.id from public.work_orders w left join public.profiles p on p.id=w.contractor_id
    where w.contractor_id is not null and p.id is null
  union all select 'assigned_without_current_assignment_evidence',w.id from public.work_orders w
    where w.contractor_id is not null and not exists(select 1 from public.activities a where a.work_order_id=w.id
      and a.contractor_assignment_version=w.contractor_assignment_version
      and a.event_key in ('work_order_assignment','work_order_reassigned') and a.deleted_at is null)
  union all select 'assignment_version_or_timestamp_invalid',w.id from public.work_orders w
    where w.contractor_id is not null and (w.contractor_assignment_version<1 or w.contractor_assignment_started_at is null)
  union all select 'unassigned_retains_assignment_timestamp',w.id from public.work_orders w
    where w.contractor_id is null and w.contractor_assignment_started_at is not null
  union all select 'history_version_not_before_current',w.id from public.work_orders w join public.work_order_assignment_history h
    on h.work_order_id=w.id where h.assignment_version>=w.contractor_assignment_version
  union all select 'duplicate_ended_assignment_history',h.work_order_id from public.work_order_assignment_history h
    group by h.work_order_id,h.assignment_version having count(*)>1
  union all select 'last_history_next_contractor_mismatch',w.id from public.work_orders w
    join lateral(select h.* from public.work_order_assignment_history h where h.work_order_id=w.id
      order by h.assignment_version desc,h.assignment_ended_at desc,h.id desc limit 1) h on true
    where h.assignment_version=w.contractor_assignment_version-1 and h.next_contractor_id is distinct from w.contractor_id
  union all select 'outgoing_delivery_history_or_recipient_mismatch',d.work_order_id
    from public.contractor_assignment_transition_deliveries d where d.transition_type in ('reassigned','unassigned')
      and not exists(select 1 from public.work_order_assignment_history h where h.work_order_id=d.work_order_id
        and h.assignment_version=d.outgoing_assignment_version and h.contractor_id=d.outgoing_contractor_id)
  union all select 'duplicate_outgoing_assignment_delivery',d.work_order_id
    from public.contractor_assignment_transition_deliveries d where d.transition_type in ('reassigned','unassigned')
    group by d.work_order_id,d.outgoing_assignment_version having count(*)>1
  union all select 'rejected_without_evidence',w.id from public.work_orders w where w.deleted_at is not null
    and not exists(select 1 from public.activities a where a.work_order_id=w.id and a.event_key='work_order_rejected' and a.deleted_at is null)
  union all select 'rejected_actor_mismatch',w.id from public.work_orders w join public.activities a
    on a.work_order_id=w.id and a.event_key='work_order_rejected' and a.deleted_at is null
    where w.deleted_at is not null and w.deleted_by is distinct from a.author_id
  union all select 'rejected_with_disqualifying_history',w.id from public.work_orders w where w.deleted_at is not null and (
    w.contractor_id is not null or w.contractor_assignment_version<>0 or w.status::text<>'unassigned'
    or w.functional_status::text<>'New' or w.billing_only or coalesce(w.is_capital,false)
    or exists(select 1 from public.work_order_assignment_history h where h.work_order_id=w.id)
    or exists(select 1 from public.work_order_visits v where v.work_order_id=w.id)
    or exists(select 1 from public.invoices i where i.work_order_id=w.id)
    or exists(select 1 from public.work_reports r where r.work_order_id=w.id)
    or exists(select 1 from public.wo_parts p where p.work_order_id=w.id)
    or exists(select 1 from public.contractor_estimates e where e.work_order_id=w.id)
    or exists(select 1 from public.activities a where a.work_order_id=w.id and a.event_key in ('check_in','job_paused','job_completed')))
  union all select 'legacy_unowned_assignment_event_review',a.work_order_id from public.activities a
    where a.event_key in ('work_order_assignment','work_order_reassigned','work_order_unassigned','work_order_rejected','work_order_duplicated')
      and a.assignment_operation_id is null and not (a.event_key='work_order_unassigned' and a.event_data ? 'emailPriorityEventId')
  union all select 'duplicate_assignment_event_identity',a.work_order_id from public.activities a
    where a.event_key in ('work_order_assignment','work_order_reassigned','work_order_unassigned','work_order_rejected','work_order_duplicated')
      and a.deleted_at is null
    group by a.work_order_id,a.contractor_assignment_version,a.event_key having count(*)>1
  union all select 'owned_assignment_actor_or_operation_mismatch',a.work_order_id from public.activities a
    join public.work_order_assignment_operations o on o.operation_id=a.assignment_operation_id
    where a.author_id is distinct from o.actor_id or a.event_data->>'operationId' is distinct from o.operation_id::text
      or a.deleted_at is not null
  union all select 'owned_assignment_missing_evidence',o.work_order_id from public.work_order_assignment_operations o
    where o.result is not null and (o.command_family not in ('create','create_email') or o.result->>'contractorId' is not null)
      and not exists(select 1 from public.activities a where a.assignment_operation_id=o.operation_id and a.deleted_at is null)
  union all select 'owned_assignment_evidence_snapshot_changed',o.work_order_id from public.work_order_assignment_operations o
    where o.result is not null and o.evidence_snapshot is distinct from public.assignment_evidence_snapshot(o.operation_id)
  union all select 'incomplete_assignment_operation',o.work_order_id from public.work_order_assignment_operations o
    where o.result is null or not exists(select 1 from public.work_orders w where w.id=o.work_order_id)
  union all select 'duplicate_lineage_or_delivery_missing',w.id from public.work_orders w
    where w.duplicated_from_work_order_id is not null and (
      w.duplicate_root_work_order_id is null or w.duplicate_sequence is null
      or w.id is distinct from w.duplicate_root_work_order_id||'-'||w.duplicate_sequence::text
      or not exists(select 1 from public.contractor_assignment_transition_deliveries d
        where d.related_work_order_id=w.id and d.transition_type='duplicated_for_reassignment'))
)
select issue,count(distinct work_order_id) as work_order_count,
  (array_agg(distinct work_order_id order by work_order_id))[1:100] as review_work_order_ids,
  count(distinct work_order_id)>100 as identifiers_truncated
from anomalies group by issue order by issue;

-- Initial assignment intentionally has no ended-history row. Its new
-- acceptance is the operation and work_order_assignment event; don't require
-- a fictitious ended assignment as a "repair" to current records.
