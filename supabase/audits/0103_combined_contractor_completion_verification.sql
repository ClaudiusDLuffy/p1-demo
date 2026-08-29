-- Run after migration 0103. Deployment is complete only when every column
-- and all_checks_pass return true.

with definition as (
  select
    coalesce(pg_get_functiondef(function_row.oid), '') as source,
    function_row.prosecdef as security_definer,
    coalesce(function_row.proconfig, array[]::text[]) as settings
  from pg_proc function_row
  where function_row.oid = to_regprocedure(
    'public.complete_contractor_work_and_invoicing(text,timestamptz,text,text,text,integer,text,text,text)'
  )
),
checks as (
  select
    exists (select 1 from definition)
      as combined_completion_rpc_present,

    coalesce((select security_definer from definition), false)
      as security_definer_preserved,

    coalesce((
      select settings @> array['search_path=public, pg_temp']::text[]
      from definition
    ), false) as search_path_pinned,

    coalesce((
      select source like '%profile.active = true%'
        and source like '%profile.role = ''contractor''%'
      from definition
    ), false) as active_contractor_required,

    coalesce((
      select source like '%can_invoice_for_contractor%'
        and source like '%can_access_contractor_work_order%'
        and source like '%contractor_id is distinct from v_account_id%'
      from definition
    ), false) as assignment_and_invoice_scope_required,

    coalesce((
      select source like '%''assigned''%'
        and source like '%''parts''%'
        and source like '%''closed''%'
        and source like '%''capital''%'
        and source like '%''pending_capital_completion''%'
      from definition
    ), false) as valid_work_state_required,

    coalesce((
      select source like '%for update%'
        and position('complete_work_order_once' in source) > 0
        and position('finish_contractor_invoicing' in source)
          > position('complete_work_order_once' in source)
      from definition
    ), false) as atomic_composition_present,

    coalesce(has_function_privilege(
      'authenticated',
      'public.complete_contractor_work_and_invoicing(text,timestamptz,text,text,text,integer,text,text,text)',
      'EXECUTE'
    ), false) as authenticated_execute_enabled,

    not coalesce(has_function_privilege(
      'anon',
      'public.complete_contractor_work_and_invoicing(text,timestamptz,text,text,text,integer,text,text,text)',
      'EXECUTE'
    ), false) as anonymous_execute_blocked,

    to_regprocedure('public.close_work_order_without_invoice(text)') is not null
      as staff_no_invoice_close_preserved
)
select
  combined_completion_rpc_present,
  security_definer_preserved,
  search_path_pinned,
  active_contractor_required,
  assignment_and_invoice_scope_required,
  valid_work_state_required,
  atomic_composition_present,
  authenticated_execute_enabled,
  anonymous_execute_blocked,
  staff_no_invoice_close_preserved,
  combined_completion_rpc_present
    and security_definer_preserved
    and search_path_pinned
    and active_contractor_required
    and assignment_and_invoice_scope_required
    and valid_work_state_required
    and atomic_composition_present
    and authenticated_execute_enabled
    and anonymous_execute_blocked
    and staff_no_invoice_close_preserved
    as all_checks_pass
from checks;
