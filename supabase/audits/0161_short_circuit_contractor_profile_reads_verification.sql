-- Run after migration 0161. This is a read-only structural verification. It
-- returns metadata booleans only and does not read or expose profile rows.
with routine as (
  select
    procedure.oid,
    language.lanname,
    procedure.prosecdef,
    procedure.provolatile,
    procedure.proconfig,
    procedure.proacl,
    pg_get_userbyid(procedure.proowner) as owner_name,
    replace(procedure.prosrc, chr(13), '') as source
  from pg_proc procedure
  join pg_language language on language.oid = procedure.prolang
  where procedure.oid =
    to_regprocedure('public.can_read_contractor_profile(uuid)')
), profile_policy as (
  select
    policy.polcmd,
    policy.polpermissive,
    policy.polroles,
    pg_get_expr(policy.polqual, policy.polrelid) as expression
  from pg_policy policy
  where policy.polrelid = 'public.profiles'::regclass
    and policy.polname = 'profiles_read'
), checks as (
  select
    (select count(*) = 1 from routine) as function_exists,
    coalesce((
      select lanname = 'plpgsql'
        and prosecdef
        and provolatile = 's'
        and proconfig = array['search_path=public, pg_temp']
        and owner_name = 'postgres'
      from routine
    ), false) as function_security_preserved,
    coalesce((
      select encode(
        sha256(convert_to(source, 'UTF8')),
        'hex'
      ) = 'ad3ea17398cf1695e635f049d4dfdba790f7fed6f5a1568d64a9354e587bcc5e'
      from routine
    ), false) as function_definition_current,
    not coalesce(has_function_privilege(
      'anon',
      to_regprocedure('public.can_read_contractor_profile(uuid)'),
      'EXECUTE'
    ), false)
      and coalesce(has_function_privilege(
        'authenticated',
        to_regprocedure('public.can_read_contractor_profile(uuid)'),
        'EXECUTE'
      ), false)
      and coalesce(has_function_privilege(
        'service_role',
        to_regprocedure('public.can_read_contractor_profile(uuid)'),
        'EXECUTE'
      ), false) as execute_surface_preserved,
    coalesce((
      select
        strpos(source, 'if public.is_staff() then') > 0
        and strpos(source, 'if p_profile_id = auth.uid() then')
          > strpos(source, 'if public.is_staff() then')
        and strpos(source, 'from public.profiles viewer')
          > strpos(source, 'if p_profile_id = auth.uid() then')
        and strpos(source, 'from public.contractor_technicians lead_membership')
          > strpos(source, 'from public.profiles viewer')
      from routine
    ), false) as short_circuit_order_installed,
    coalesce((
      select
        polcmd = 'r'
        and polpermissive
        and polroles = array[0::oid]
        and expression =
          '(( SELECT is_staff() AS is_staff) OR can_read_contractor_profile(id))'
      from profile_policy
    ), false) as profile_policy_preserved,
    coalesce((
      select relrowsecurity
      from pg_class
      where oid = 'public.profiles'::regclass
    ), false) as profile_rls_enabled
)
select
  case
    when function_exists
      and function_security_preserved
      and function_definition_current
      and execute_surface_preserved
      and short_circuit_order_installed
      and profile_policy_preserved
      and profile_rls_enabled
    then 'PASS_0161_INSTALLED'
    else 'FAIL_0161_NEEDS_REVIEW'
  end as deployment_status,
  checks.*
from checks;
