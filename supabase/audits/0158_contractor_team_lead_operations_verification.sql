-- Run after migration 0158. This script is read-only and returns structural
-- booleans only; it does not expose profiles, work orders, visits, or files.
with routines as (
  select procedure.oid,
    procedure.oid::regprocedure::text as identity,
    procedure.prosecdef,
    procedure.provolatile,
    procedure.proconfig,
    pg_get_functiondef(procedure.oid) as definition
  from pg_proc procedure
  where procedure.oid in (
    to_regprocedure('public.is_contractor_team_lead(uuid)'),
    to_regprocedure('public.can_lead_contractor_team()'),
    to_regprocedure('public.contractor_team_lead_can_manage_profile(uuid,uuid)'),
    to_regprocedure('public.can_access_contractor_work_order(text)'),
    to_regprocedure('public.can_manage_work_order_technician(text)'),
    to_regprocedure('public.get_my_contractor_scope()'),
    to_regprocedure('public.directory_scope_v1(text,uuid)'),
    to_regprocedure('public.directory_candidates_v1(text,uuid,text,uuid,integer,text,uuid,timestamp with time zone)'),
    to_regprocedure('public.assign_contractor_technician(text,uuid)'),
    to_regprocedure('public.protect_work_order_visit()'),
    to_regprocedure('public.insert_work_order_lifecycle_activity(text,uuid,text,jsonb)'),
    to_regprocedure('public.begin_work_order_visit_command(text,integer,integer,bigint,uuid,timestamp with time zone,text,boolean)'),
    to_regprocedure('public.correct_work_order_visit_lc_core(uuid,timestamp with time zone,timestamp with time zone,text)'),
    to_regprocedure('public.private_object_actor_access(uuid,text,boolean)')
  )
), checks as (
  select
    exists (
      select 1
      from information_schema.columns column_definition
      where column_definition.table_schema = 'public'
        and column_definition.table_name = 'work_order_visits'
        and column_definition.column_name = 'technician_profile_id'
        and column_definition.data_type = 'uuid'
    ) as visit_technician_subject_installed,
    to_regclass('public.work_order_visits_technician_time') is not null
      as visit_technician_time_index_installed,
    (select count(*) = 14 from routines) as all_routines_installed,
    coalesce((
      select bool_and(routine.prosecdef and routine.provolatile = 's')
      from routines routine
      where routine.identity in (
        'is_contractor_team_lead(uuid)',
        'can_lead_contractor_team()',
        'contractor_team_lead_can_manage_profile(uuid,uuid)',
        'can_access_contractor_work_order(text)',
        'can_manage_work_order_technician(text)',
        'get_my_contractor_scope()',
        'directory_scope_v1(text,uuid)',
        'private_object_actor_access(uuid,text,boolean)'
      )
    ), false) as stable_security_definers_installed,
    coalesce((
      select bool_and(routine.prosecdef)
      from routines routine
      where routine.identity in (
        'assign_contractor_technician(text,uuid)',
        'protect_work_order_visit()',
        'insert_work_order_lifecycle_activity(text,uuid,text,jsonb)',
        'begin_work_order_visit_command(text,integer,integer,bigint,uuid,timestamp with time zone,text,boolean)',
        'correct_work_order_visit_lc_core(uuid,timestamp with time zone,timestamp with time zone,text)'
      )
    ), false) as command_security_definers_installed,
    coalesce((
      select bool_and(
        routine.proconfig @> array['search_path=public, pg_temp']
        or routine.proconfig @> array['search_path=pg_catalog, public']
      )
      from routines routine
    ), false) as fixed_search_paths_installed,
    coalesce(has_function_privilege(
      'authenticated',
      to_regprocedure('public.can_lead_contractor_team()'),
      'EXECUTE'
    ), false)
      and not coalesce(has_function_privilege(
        'anon',
        to_regprocedure('public.can_lead_contractor_team()'),
        'EXECUTE'
      ), false) as team_capability_execute_surface_correct,
    coalesce(has_function_privilege(
      'authenticated',
      to_regprocedure('public.assign_contractor_technician(text,uuid)'),
      'EXECUTE'
    ), false)
      and not coalesce(has_function_privilege(
        'anon',
        to_regprocedure('public.assign_contractor_technician(text,uuid)'),
        'EXECUTE'
      ), false) as assignment_execute_surface_correct,
    not coalesce(has_function_privilege(
      'authenticated',
      to_regprocedure('public.contractor_team_lead_can_manage_profile(uuid,uuid)'),
      'EXECUTE'
    ), false)
      and not coalesce(has_function_privilege(
        'authenticated',
        to_regprocedure('public.begin_work_order_visit_command(text,integer,integer,bigint,uuid,timestamp with time zone,text,boolean)'),
        'EXECUTE'
      ), false)
      and not coalesce(has_function_privilege(
        'service_role',
        to_regprocedure('public.private_object_actor_access(uuid,text,boolean)'),
        'EXECUTE'
      ), false) as private_helpers_not_directly_executable,
    coalesce((
      select routine.definition ilike '%target.dispatcher_id = lead.id%'
        and routine.definition ilike '%membership.is_active = true%'
      from routines routine
      where routine.identity = 'contractor_team_lead_can_manage_profile(uuid,uuid)'
    ), false) as team_membership_is_bounded,
    coalesce((
      select routine.definition ilike '%contractor_team_lead_can_manage_profile%'
        and routine.definition ilike '%assigned_technician_profile_id%'
      from routines routine
      where routine.identity = 'can_access_contractor_work_order(text)'
    ), false) as work_order_access_uses_team_boundary,
    coalesce((
      select routine.definition ilike '%A team lead may assign only an active member of their own team%'
        and routine.definition ilike '%p_technician_profile_id is null%'
      from routines routine
      where routine.identity = 'assign_contractor_technician(text,uuid)'
    ), false) as team_assignment_is_guarded,
    coalesce((
      select routine.definition ilike '%technician_profile_id%'
        and routine.definition ilike '%checked_in_by%'
        and routine.definition ilike '%acting lead%'
      from routines routine
      where routine.identity = 'protect_work_order_visit()'
    ), false) as visit_actor_and_subject_are_separate,
    coalesce((
      select routine.definition ilike '%coalesce(v_work.assigned_technician_profile_id, auth.uid())%'
      from routines routine
      where routine.identity = 'begin_work_order_visit_command(text,integer,integer,bigint,uuid,timestamp with time zone,text,boolean)'
    ), false) as lifecycle_records_assigned_technician,
    coalesce((
      select routine.definition ilike '%onBehalfOfTechnician%'
        and routine.definition ilike '%actedByProfileId%'
        and routine.definition ilike '%technicianProfileId%'
      from routines routine
      where routine.identity = 'insert_work_order_lifecycle_activity(text,uuid,text,jsonb)'
    ), false) as lifecycle_audit_attribution_installed,
    coalesce((
      select routine.definition ilike '%coalesce(other.technician_profile_id, other.checked_in_by)%'
        and routine.definition ilike '%contractor_team_lead_can_manage_profile%'
        and routine.definition ilike '%onBehalfOfTechnician%'
      from routines routine
      where routine.identity = 'correct_work_order_visit_lc_core(uuid,timestamp with time zone,timestamp with time zone,text)'
    ), false) as correction_uses_technician_identity,
    coalesce((
      select routine.definition ilike '%target.dispatcher_id = actor.id%'
        and routine.definition ilike '%not p_invoice_capable%'
        and routine.definition ilike '%actor.contractor_access_level = ''invoice''%'
      from routines routine
      where routine.identity = 'private_object_actor_access(uuid,text,boolean)'
    ), false) as photos_follow_team_wall_without_invoice_grant,
    coalesce((
      select trigger_row.tgenabled in ('O', 'A')
        and trigger_row.tgfoid = to_regprocedure('public.protect_work_order_visit()')
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.work_order_visits'::regclass
        and trigger_row.tgname = 'protect_work_order_visit_trigger'
        and not trigger_row.tgisinternal
    ), false) as visit_guard_trigger_enabled
)
select
  case when
    visit_technician_subject_installed
    and visit_technician_time_index_installed
    and all_routines_installed
    and stable_security_definers_installed
    and command_security_definers_installed
    and fixed_search_paths_installed
    and team_capability_execute_surface_correct
    and assignment_execute_surface_correct
    and private_helpers_not_directly_executable
    and team_membership_is_bounded
    and work_order_access_uses_team_boundary
    and team_assignment_is_guarded
    and visit_actor_and_subject_are_separate
    and lifecycle_records_assigned_technician
    and lifecycle_audit_attribution_installed
    and correction_uses_technician_identity
    and photos_follow_team_wall_without_invoice_grant
    and visit_guard_trigger_enabled
  then 'PASS_0158_INSTALLED'
  else 'FAIL_0158_NEEDS_REVIEW'
  end as deployment_status,
  checks.*
from checks;
