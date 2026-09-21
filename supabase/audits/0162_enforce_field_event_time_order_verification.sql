-- Run after migration 0162. Read-only structural verification; it does not
-- inspect or mutate customer work orders or visits.
with routines as (
  select
    procedure.proname,
    procedure.prosecdef,
    procedure.proconfig,
    pg_get_userbyid(procedure.proowner) as owner_name,
    replace(procedure.prosrc, chr(13), '') as source,
    procedure.oid::regprocedure as identity
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.oid in (
      to_regprocedure('public.begin_work_order_visit_command(text,integer,integer,bigint,uuid,timestamp with time zone,text,boolean)'),
      to_regprocedure('public.pause_work_order_for_parts_v1(text,integer,integer,bigint,uuid,timestamp with time zone,text,jsonb,text,text,date)'),
      to_regprocedure('public.complete_work_order_field_v1(text,integer,integer,bigint,uuid,timestamp with time zone,text,text,text,integer,text,text)')
    )
), checks as (
  select
    (select count(*) = 3 from routines) as all_functions_exist,
    coalesce((select bool_and(prosecdef and owner_name = 'postgres'
      and proconfig = array['search_path=public, pg_temp']) from routines), false) as security_preserved,
    coalesce((select source like '%clock_timestamp() + interval ''5 minutes''%'
      and source like '%Check-in time cannot be in the future%'
      from routines where proname = 'begin_work_order_visit_command'), false) as arrival_policy_installed,
    coalesce((select source like '%clock_timestamp() + interval ''5 minutes''%'
      and source like '%Checkout time cannot be in the future%'
      and source like '%Checkout time cannot be before active visit check-in%'
      and source like '%capitalStagePreserved%'
      from routines where proname = 'pause_work_order_for_parts_v1'), false) as checkout_policy_installed,
    coalesce((select source like '%clock_timestamp() + interval ''5 minutes''%'
      and source like '%Completion time cannot be in the future%'
      and source like '%Completion time cannot be before active visit check-in%'
      and source like '%pending_invoice%pending_approval%pending_payment%'
      from routines where proname = 'complete_work_order_field_v1'), false) as completion_policy_installed,
    not coalesce(has_function_privilege('authenticated',
      to_regprocedure('public.begin_work_order_visit_command(text,integer,integer,bigint,uuid,timestamp with time zone,text,boolean)'), 'EXECUTE'), false)
      and coalesce(has_function_privilege('authenticated',
        to_regprocedure('public.pause_work_order_for_parts_v1(text,integer,integer,bigint,uuid,timestamp with time zone,text,jsonb,text,text,date)'), 'EXECUTE'), false)
      and coalesce(has_function_privilege('authenticated',
        to_regprocedure('public.complete_work_order_field_v1(text,integer,integer,bigint,uuid,timestamp with time zone,text,text,text,integer,text,text)'), 'EXECUTE'), false)
      and not coalesce(has_function_privilege('anon',
        to_regprocedure('public.pause_work_order_for_parts_v1(text,integer,integer,bigint,uuid,timestamp with time zone,text,jsonb,text,text,date)'), 'EXECUTE'), false)
      and not coalesce(has_function_privilege('service_role',
        to_regprocedure('public.complete_work_order_field_v1(text,integer,integer,bigint,uuid,timestamp with time zone,text,text,text,integer,text,text)'), 'EXECUTE'), false)
      as execute_surface_preserved
)
select
  case when all_functions_exist and security_preserved
      and arrival_policy_installed and checkout_policy_installed
      and completion_policy_installed and execute_surface_preserved
    then 'PASS_0162_INSTALLED'
    else 'FAIL_0162_NEEDS_REVIEW'
  end as deployment_status,
  checks.*
from checks;
