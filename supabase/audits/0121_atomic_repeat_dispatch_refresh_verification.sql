-- Read-only catalog verification; pair with runtime fixture tests and the
-- 0120 audit. This does not prove Graph delivery or two-session concurrency.
with definition as (
  select procedure.oid,
    procedure.prosecdef,
    procedure.proconfig,
    pg_get_functiondef(procedure.oid) body
  from pg_proc procedure
  where procedure.oid = to_regprocedure(
    'public.refresh_email_work_order_dispatch(text,text,text,timestamptz,text,timestamptz,timestamptz,timestamptz,jsonb,text)'
  )
), removal_claim as (
  select procedure.oid, procedure.prosecdef, procedure.proconfig,
    pg_get_functiondef(procedure.oid) body
  from pg_proc procedure
  where procedure.oid = to_regprocedure('public.claim_email_assignment_removal_delivery(uuid)')
), checks as (
  select
    exists(select 1 from definition) as refresh_function_present,
    coalesce((select prosecdef and proconfig @> array['search_path=public, pg_temp']
      and body like '%Service role required%' from definition), false)
      as refresh_function_guarded,
    coalesce((select not has_function_privilege('anon', oid, 'EXECUTE')
      and not has_function_privilege('authenticated', oid, 'EXECUTE')
      and has_function_privilege('service_role', oid, 'EXECUTE')
      from definition), false) as refresh_execute_surface_correct,
    coalesce((select body like '%apply_email_work_order_priority_escalation(%'
      and body like '%for update%'
      and body like '%jsonb_populate_record(v_work_order, p_intake_patch)%'
      and body like '%work_order_afm_contacts%'
      from definition), false) as priority_and_metadata_atomic,
    coalesce((select body like '%replayed%metadataRefreshed%false%'
      and body like '%stale%non_operational%'
      from definition), false) as replay_and_history_guarded,
    coalesce((select body like '%jsonb_object_keys(p_intake_patch)%'
      and body like '%octet_length(p_intake_patch::text) > 262144%'
      and body like '%Lifecycle fields require a billing-only dispatch%'
      and body like '%Dispatch refresh cannot clear billing-only status%'
      from definition), false) as refresh_patch_guarded,
    coalesce((select body like '%set contractor_id = null%contractor_id is not null;%set status = ''pending_invoice''%'
      and body like '%functional_status = ''Completed''%'
      and body like '%straight_to_billing%'
      from definition), false) as billing_only_assignment_order_guarded,
    coalesce((select prosecdef and proconfig @> array['search_path=public, pg_temp']
      and body like '%Service role required%'
      and body like '%event.assignment_removal_delivery_id = delivery.id%'
      and body like '%event.work_order_id = delivery.work_order_id%'
      and body like '%delivery.initiated_by is null%'
      and body like '%for update%'
      and not has_function_privilege('anon', oid, 'EXECUTE')
      and not has_function_privilege('authenticated', oid, 'EXECUTE')
      and has_function_privilege('service_role', oid, 'EXECUTE')
      from removal_claim), false) as intake_removal_claim_guarded,
    exists(select 1 from pg_constraint
      where conrelid = 'public.email_priority_escalation_events'::regclass
        and conname = 'email_priority_escalation_assignment_removal_delivery_fkey'
        and contype = 'f' and confdeltype = 'r' and convalidated)
      as intake_removal_provenance_constrained
)
select checks.*,
  refresh_function_present and refresh_function_guarded
  and refresh_execute_surface_correct and priority_and_metadata_atomic
  and replay_and_history_guarded and refresh_patch_guarded
  and billing_only_assignment_order_guarded and intake_removal_claim_guarded
  and intake_removal_provenance_constrained as all_checks_pass
from checks;
