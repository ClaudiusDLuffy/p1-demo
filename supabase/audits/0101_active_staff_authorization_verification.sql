-- Run after migration 0101. The single row must return all_checks_pass=true.

with function_definition as (
  select lower(pg_get_functiondef('public.is_staff()'::regprocedure)) as body
), store_policy as (
  select lower(pg_get_expr(policy.polqual, policy.polrelid)) as body
  from pg_policy policy
  where policy.polrelid = 'public.stores'::regclass
    and policy.polname = 'stores_read'
), checks as (
  select
    function_definition.body like '%security definer%'
      as security_definer_preserved,
    function_definition.body like '%set search_path to ''public'', ''pg_temp''%'
      or function_definition.body like '%set search_path = public, pg_temp%'
      as search_path_pinned,
    function_definition.body like '%profile.active = true%'
      as active_profile_required,
    function_definition.body like '%profile.id = auth.uid()%'
      as caller_identity_required,
    function_definition.body like '%profile.role = any%'
      or function_definition.body like '%profile.role in (''manager'', ''dispatcher'', ''back_office'')%'
      as staff_role_required,
    has_function_privilege('authenticated', 'public.is_staff()', 'execute')
      as authenticated_execute_enabled,
    not has_function_privilege('anon', 'public.is_staff()', 'execute')
      as anonymous_execute_blocked,
    store_policy.body like '%is_staff()%'
      and store_policy.body like '%can_access_contractor_work_order%'
      and store_policy.body like '%work_order.store_number = stores.store_number%'
      and store_policy.body not like '%auth.uid() is not null%'
      as store_directory_assignment_scoped,
    not has_table_privilege('anon', 'public.stores', 'select')
      as anonymous_store_directory_blocked
  from function_definition
  cross join store_policy
)
select
  checks.*,
  security_definer_preserved
    and search_path_pinned
    and active_profile_required
    and caller_identity_required
    and staff_role_required
    and authenticated_execute_enabled
    and anonymous_execute_blocked
    and store_directory_assignment_scoped
    and anonymous_store_directory_blocked
    as all_checks_pass
from checks;
