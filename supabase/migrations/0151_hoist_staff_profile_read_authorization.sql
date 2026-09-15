-- A hosted work-order table read timed out while repeatedly evaluating
-- is_staff() through can_read_contractor_profile() for profile rows. The
-- helper's first disjunct is already is_staff(), so hoisting that unchanged
-- predicate into an InitPlan preserves the complete contractor fallback while
-- allowing PostgreSQL to authorize active staff once per statement.

begin;

do $profile_read_staff_initplan$
declare
  v_policy record;
  v_profile_helper record;
  v_staff_helper record;
begin
  select p.*, pg_get_expr(p.polqual, p.polrelid) as expression
    into strict v_policy
    from pg_policy p
    where p.polrelid = 'public.profiles'::regclass
      and p.polname = 'profiles_read';

  select p.* into strict v_profile_helper
    from pg_proc p
    where p.oid = 'public.can_read_contractor_profile(uuid)'::regprocedure;

  select p.* into strict v_staff_helper
    from pg_proc p
    where p.oid = 'public.is_staff()'::regprocedure;

  if v_policy.polcmd <> 'r'
    or not v_policy.polpermissive
    or v_policy.polroles <> array[0::oid]
    or v_policy.expression is distinct from 'can_read_contractor_profile(id)'
    or not v_profile_helper.prosecdef
    or v_profile_helper.provolatile <> 's'
    or v_profile_helper.proconfig is distinct from array['search_path=public, pg_temp']
    or encode(sha256(convert_to(replace(v_profile_helper.prosrc, chr(13), ''), 'UTF8')), 'hex')
      is distinct from '98934a0495e36d0dbe7f64dfdec991ac6226a4f883a3d4c6399cc14aba8b1f15'
    or not v_staff_helper.prosecdef
    or v_staff_helper.provolatile <> 's'
    or v_staff_helper.proconfig is distinct from array['search_path=public, pg_temp']
    or encode(sha256(convert_to(replace(v_staff_helper.prosrc, chr(13), ''), 'UTF8')), 'hex')
      is distinct from '79e243b92cd476f97c6d25edf89bded391fd86dd1088ce6caa02fc8418803a5b'
    or btrim(regexp_replace(v_profile_helper.prosrc, '[[:space:]]+', ' ', 'g'))
      not like 'select public.is_staff() or p_profile_id = auth.uid() or exists (%' then
    raise exception 'Profile read authorization shape drifted; review before InitPlan optimization'
      using errcode = '23514';
  end if;
end;
$profile_read_staff_initplan$;

alter policy profiles_read on public.profiles
  using (
    (select public.is_staff())
    or public.can_read_contractor_profile(id)
  );

comment on policy profiles_read on public.profiles is
  'Staff authorization is evaluated once per statement; the canonical contractor profile helper remains the complete row-dependent fallback.';

commit;
