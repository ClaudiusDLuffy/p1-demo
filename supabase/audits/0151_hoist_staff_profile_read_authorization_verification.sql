-- Read-only structural verification. Returns aggregate booleans only and does
-- not inspect or expose profile rows.
with profile_policy as (
  select p.*, pg_get_expr(p.polqual, p.polrelid) as expression
  from pg_policy p
  where p.polrelid = 'public.profiles'::regclass
    and p.polname = 'profiles_read'
), helpers as (
  select p.oid::regprocedure::text as identity, p.prosecdef, p.provolatile,
    p.proconfig, replace(p.prosrc, chr(13), '') as source
  from pg_proc p
  where p.oid in (
    'public.is_staff()'::regprocedure,
    'public.can_read_contractor_profile(uuid)'::regprocedure
  )
), checks as (
  select
    (select count(*) = 1 from profile_policy) as one_profile_read_policy,
    (select polcmd = 'r' and polpermissive and polroles = array[0::oid]
      and expression like '%SELECT is_staff()%'
      and expression like '%OR can_read_contractor_profile(id)%'
      from profile_policy) as staff_initplan_with_canonical_fallback,
    (select count(*) = 2 and bool_and(prosecdef and provolatile = 's'
      and proconfig = array['search_path=public, pg_temp']) from helpers)
      as unchanged_stable_definer_helpers,
    (select encode(sha256(convert_to(source, 'UTF8')), 'hex') =
      '98934a0495e36d0dbe7f64dfdec991ac6226a4f883a3d4c6399cc14aba8b1f15'
      from helpers where identity = 'can_read_contractor_profile(uuid)')
      as canonical_profile_helper_preserved,
    (select encode(sha256(convert_to(source, 'UTF8')), 'hex') =
      '79e243b92cd476f97c6d25edf89bded391fd86dd1088ce6caa02fc8418803a5b'
      from helpers where identity = 'is_staff()')
      as canonical_staff_helper_preserved,
    (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass)
      as profile_rls_enabled
)
select checks.*,
  one_profile_read_policy
    and staff_initplan_with_canonical_fallback
    and unchanged_stable_definer_helpers
    and canonical_profile_helper_preserved
    and canonical_staff_helper_preserved
    and profile_rls_enabled as all_checks_pass
from checks;
