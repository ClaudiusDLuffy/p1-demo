-- Read-only Batch 1B verification. No customer text, document contents or
-- profile data is returned. Structural success is NOT a historical-data
-- repair approval. Review the separate anomaly counts before contraction.
with expected_commands(signature) as (values
  ('public.set_work_order_eta_v1(text,integer,integer,bigint,uuid,timestamp with time zone)'),
  ('public.start_work_order_visit_v1(text,integer,integer,bigint,uuid,timestamp with time zone,text)'),
  ('public.resume_work_order_visit_v1(text,integer,integer,bigint,uuid,timestamp with time zone,text)'),
  ('public.pause_work_order_for_parts_v1(text,integer,integer,bigint,uuid,timestamp with time zone,text,jsonb,text,text,date)'),
  ('public.complete_work_order_field_v1(text,integer,integer,bigint,uuid,timestamp with time zone,text,text,text,integer,text,text)'),
  ('public.mark_work_order_activity_synced_v1(uuid,boolean)'),
  ('public.flag_work_order_capital_v1(text,integer,integer,bigint)')
), expected_helpers(signature) as (values
  ('public.lifecycle_parent_snapshot(public.work_orders)'),
  ('public.lifecycle_visit_snapshot(uuid)'),
  ('public.lifecycle_part_snapshot(public.wo_parts)'),
  ('public.lifecycle_is_owner_maintenance()'),
  ('public.require_work_order_lifecycle_actor(text)'),
  ('public.begin_work_order_lifecycle_command(text,integer,integer,bigint,uuid,text,jsonb)'),
  ('public.finish_work_order_lifecycle_command(text,uuid,uuid,uuid,jsonb)'),
  ('public.insert_work_order_lifecycle_activity(text,uuid,text,jsonb)'),
  ('public.begin_work_order_visit_command(text,integer,integer,bigint,uuid,timestamp with time zone,text,boolean)'),
  ('public.protect_work_order_lifecycle_fields()'),
  ('public.protect_work_order_lifecycle_activity()'),
  ('public.protect_work_order_lifecycle_visit()')
), commands as (
  select e.signature,p.* from expected_commands e left join pg_proc p on p.oid=to_regprocedure(e.signature)
), helpers as (
  select e.signature,p.* from expected_helpers e left join pg_proc p on p.oid=to_regprocedure(e.signature)
), private_tables as (
  select c.oid,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('work_order_lifecycle_control',
    'work_order_lifecycle_operations','work_order_lifecycle_transition_guards')
), structure as (
  select
    (select count(*)=3 and bool_and(relrowsecurity) from private_tables) private_tables_rls_enabled,
    not exists(select 1 from private_tables t cross join (values('anon'),('authenticated'),('service_role')) r(role_name)
      where has_table_privilege(r.role_name,t.oid,'SELECT,INSERT,UPDATE,DELETE')) private_tables_client_inaccessible,
    (select bool_and(oid is not null and prosecdef and proconfig @> array['search_path=public, pg_temp']) from commands) commands_present_and_pinned,
    (select bool_and(oid is not null and has_function_privilege('authenticated',oid,'EXECUTE')
      and not has_function_privilege('anon',oid,'EXECUTE')
      and not has_function_privilege('service_role',oid,'EXECUTE')) from commands) command_execute_surface_correct,
    exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.record_email_capital_pending_v1(text)')
      and p.prosecdef and p.proconfig @> array['search_path=public, pg_temp']
      and has_function_privilege('service_role',p.oid,'EXECUTE')
      and not has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not has_function_privilege('anon',p.oid,'EXECUTE')) email_capital_command_service_only,
    (select bool_and(oid is not null and proconfig @> array['search_path=public, pg_temp']
      and not has_function_privilege('anon',oid,'EXECUTE')
      and not has_function_privilege('authenticated',oid,'EXECUTE')
      and not has_function_privilege('service_role',oid,'EXECUTE')) from helpers) helpers_private_and_pinned,
    (select count(*)=11 and bool_and(not has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not has_function_privilege('service_role',p.oid,'EXECUTE'))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in (
        'move_work_order_straight_to_billing_lc_core','resume_capital_work_lc_core',
        'complete_capital_work_lc_core','decline_capital_work_order_lc_core',
        'close_work_order_without_invoice_lc_core','close_reopened_work_order_without_additional_billing_lc_core',
        'correct_work_order_visit_lc_core','mark_staff_invoice_billed_lc_core',
        'refresh_email_work_order_dispatch_lc_core','set_activity_contractor_attention_lc_core',
        'acknowledge_contractor_attention_lc_core')) compatibility_cores_private,
    (select count(*)=3 from pg_trigger where not tgisinternal and tgenabled='O'
      and tgname in ('zzz_protect_work_order_lifecycle_fields','zzz_protect_work_order_lifecycle_activity',
        'zzz_protect_work_order_lifecycle_visit')) lifecycle_guards_enabled,
    exists(select 1 from pg_indexes where schemaname='public' and indexname='activities_one_lifecycle_operation'
      and indexdef ilike '%unique%') operation_event_unique,
    exists(select 1 from pg_indexes where schemaname='public' and indexname='activities_one_job_completion_per_workflow_cycle'
      and indexdef ilike '%lifecycle_operation_id is not null%') owned_completion_cycle_unique,
    not exists(select 1 from (values
      ('public.complete_work_order_once(text,timestamp with time zone,text,text,text,integer,text,text,text)'),
      ('public.complete_contractor_work_and_invoicing(text,timestamp with time zone,text,text,text,integer,text,text,text)')
    ) legacy(signature) cross join (values('anon'),('authenticated'),('service_role')) r(role_name)
      where to_regprocedure(legacy.signature) is null
        or has_function_privilege(r.role_name,to_regprocedure(legacy.signature),'EXECUTE')) unversioned_completion_entries_private,
    coalesce((select contracted from public.work_order_lifecycle_control where singleton),false) contraction_enabled
), anomalies as (
  select
    (select count(*) from public.work_order_lifecycle_transition_guards) unresolved_capability_count,
    (select count(*) from public.work_order_lifecycle_operations o where o.result is null) unfinished_operation_count,
    (select count(*) from public.activities a where a.lifecycle_operation_id is not null
      and not exists(select 1 from public.work_order_lifecycle_operations o where o.operation_id=a.lifecycle_operation_id
        and o.work_order_id=a.work_order_id and o.actor_id=a.author_id
        and o.assignment_version=a.contractor_assignment_version and o.workflow_cycle=a.workflow_cycle
        and o.result->>'activityId'=a.id::text
        and (o.result->>'lifecycleVersion')::bigint=a.lifecycle_version)) owned_event_identity_issue_count,
    (select count(*) from (select work_order_id from public.work_order_visits
      where check_out_at is null group by work_order_id having count(*)>1) duplicate_visits) multiple_active_visit_count,
    (select count(*) from public.work_order_visits v join public.work_orders w on w.id=v.work_order_id
      where v.check_out_at is null and (w.status='closed' or w.functional_status::text='Completed')) terminal_active_visit_count,
    (select count(*) from public.activities a join public.work_orders w on w.id=a.work_order_id
      where a.event_key='job_completed' and a.deleted_at is null
        and a.contractor_assignment_version=w.contractor_assignment_version and a.workflow_cycle=w.workflow_cycle
        and w.functional_status::text is distinct from 'Completed') completion_event_parent_conflict_count,
    (select count(*) from (select lifecycle_operation_id from public.activities where lifecycle_operation_id is not null
      group by lifecycle_operation_id having count(*)>1) duplicate_events) duplicate_owned_operation_event_count,
    (select count(*) from public.activities a where a.event_key in (
      'eta_updated','check_in','check_out','job_paused','job_completed','visit_time_corrected')
      and a.lifecycle_operation_id is null and a.event_key<>'visit_time_corrected') legacy_events_requiring_review_count,
    (select count(*) from public.work_orders w where w.deleted_at is null and not w.billing_only
      and w.functional_status::text='Completed'
      and not exists(select 1 from public.activities a where a.work_order_id=w.id and a.deleted_at is null
        and a.contractor_assignment_version=w.contractor_assignment_version and a.workflow_cycle=w.workflow_cycle
        and (a.event_key in ('job_completed','capital_completed','work_order_follow_up_closed_without_additional_billing',
          'work_order_closed_without_invoice') or (a.event_key='staff_billing' and a.event_data->>'action'='billed_to_7_eleven'))))
      completed_without_completion_evidence_count,
    (select count(*) from public.work_orders w where w.deleted_at is null and w.functional_status::text='Work in Progress'
      and not exists(select 1 from public.work_order_visits v where v.work_order_id=w.id and v.check_out_at is null)
      and exists(select 1 from public.work_order_visits v where v.work_order_id=w.id and v.check_out_at is not null))
      open_state_with_only_closed_visits_review_count,
    (select count(*) from public.activities a where a.event_key in ('eta_updated','check_in','check_out','job_paused','job_completed')
      and (a.author_id is null or a.entered_by_role not in ('contractor','manager','dispatcher','back_office')))
      reserved_actor_review_count
)
select structure.*,anomalies.*,
  (select bool_and(value='true'::jsonb) from jsonb_each(to_jsonb(structure)))
    and unresolved_capability_count=0 and unfinished_operation_count=0
    and owned_event_identity_issue_count=0 and duplicate_owned_operation_event_count=0 as all_checks_pass
from structure cross join anomalies;
