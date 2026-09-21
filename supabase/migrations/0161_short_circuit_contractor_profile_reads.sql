-- Contractor table reads join profile rows for presentation. After the team
-- lead capability was added, PostgreSQL could evaluate the complete team
-- hierarchy branch for every joined profile even when the viewer was the
-- profile itself or a company administrator. At ordinary hosted concurrency,
-- mobile sort/filter reads could then exceed the statement deadline.
--
-- Preserve the 0158 authorization contract exactly, but enforce its intended
-- branch order procedurally so irrelevant hierarchy checks are never planned
-- or executed for the common self/company-admin paths.

begin;

do $contractor_profile_read_guard$
declare
  v_function record;
  v_policy record;
begin
  select
    procedure.*,
    language.lanname,
    pg_get_userbyid(procedure.proowner) as owner_name
  into strict v_function
  from pg_proc procedure
  join pg_language language on language.oid = procedure.prolang
  where procedure.oid =
    'public.can_read_contractor_profile(uuid)'::regprocedure;

  select
    policy.*,
    pg_get_expr(policy.polqual, policy.polrelid) as expression
  into strict v_policy
  from pg_policy policy
  where policy.polrelid = 'public.profiles'::regclass
    and policy.polname = 'profiles_read';

  if v_function.lanname <> 'sql'
     or not v_function.prosecdef
     or v_function.provolatile <> 's'
     or v_function.proconfig is distinct from
       array['search_path=public, pg_temp']
     or v_function.owner_name <> 'postgres'
     or encode(
       sha256(
         convert_to(
           replace(v_function.prosrc, chr(13), ''),
           'UTF8'
         )
       ),
       'hex'
     ) is distinct from
       'd8e199f56a957565558495ae6adb781305024e6717edaa18057fd89ac11954e9'
     or v_policy.polcmd <> 'r'
     or not v_policy.polpermissive
     or v_policy.polroles <> array[0::oid]
     or v_policy.expression is distinct from
       '(( SELECT is_staff() AS is_staff) OR can_read_contractor_profile(id))'
  then
    raise exception
      'Contractor profile authorization drifted; review before optimizing'
      using errcode = '23514';
  end if;
end;
$contractor_profile_read_guard$;

create or replace function public.can_read_contractor_profile(
  p_profile_id uuid
)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_viewer_id uuid;
  v_organization_id uuid;
  v_canonical_contractor_id uuid;
  v_access_level text;
  v_tier text;
begin
  if public.is_staff() then
    return true;
  end if;

  -- Preserve the original unconditional self-read before requiring an active
  -- contractor/company relationship.
  if p_profile_id = auth.uid() then
    return true;
  end if;

  select
    viewer.id,
    organization.id,
    organization.canonical_contractor_id,
    viewer.contractor_access_level,
    viewer.contractor_tier
  into
    v_viewer_id,
    v_organization_id,
    v_canonical_contractor_id,
    v_access_level,
    v_tier
  from public.profiles viewer
  join public.organizations organization
    on organization.id = viewer.contractor_organization_id
   and organization.active = true
   and organization.canonical_contractor_id is not null
  join public.profiles canonical
    on canonical.id = organization.canonical_contractor_id
   and canonical.role = 'contractor'
   and canonical.active = true
   and canonical.contractor_organization_id = organization.id
  where viewer.id = auth.uid()
    and viewer.role = 'contractor'
    and viewer.active = true;

  if not found then
    return false;
  end if;

  -- Company administrators retain the complete organization profile scope
  -- from 0105/0158, including inactive target profiles used in history.
  if v_access_level = 'company_admin' then
    return exists (
      select 1
      from public.profiles target
      where target.id = p_profile_id
        and target.role = 'contractor'
        and target.contractor_organization_id = v_organization_id
    );
  end if;

  -- Team leads retain only their active, explicitly linked direct reports.
  -- This is the same boundary enforced by
  -- contractor_team_lead_can_manage_profile in 0158, expanded here so the
  -- common non-lead path returns without starting nested security functions.
  if v_tier = 'mr_freeze'
     and v_access_level = 'report_only'
     and exists (
       select 1
       from public.contractor_technicians lead_membership
       where lead_membership.profile_id = v_viewer_id
         and lead_membership.contractor_id = v_canonical_contractor_id
         and lead_membership.is_active = true
     )
  then
    return exists (
      select 1
      from public.profiles target
      join public.contractor_technicians membership
        on membership.profile_id = target.id
       and membership.contractor_id = v_canonical_contractor_id
       and membership.is_active = true
      where target.id = p_profile_id
        and target.role = 'contractor'
        and target.active = true
        and target.contractor_organization_id = v_organization_id
        and (
          target.id = v_viewer_id
          or target.dispatcher_id = v_viewer_id
        )
    );
  end if;

  return false;
end;
$$;

revoke all on function public.can_read_contractor_profile(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.can_read_contractor_profile(uuid)
  to authenticated, service_role;

comment on function public.can_read_contractor_profile(uuid) is
  'Authorizes staff, self, company-admin, and bounded team-lead profile reads with procedural short-circuiting for work-order list performance.';

do $contractor_profile_read_verify$
declare
  v_function record;
begin
  select
    procedure.*,
    language.lanname,
    pg_get_userbyid(procedure.proowner) as owner_name
  into strict v_function
  from pg_proc procedure
  join pg_language language on language.oid = procedure.prolang
  where procedure.oid =
    'public.can_read_contractor_profile(uuid)'::regprocedure;

  if v_function.lanname <> 'plpgsql'
     or not v_function.prosecdef
     or v_function.provolatile <> 's'
     or v_function.proconfig is distinct from
       array['search_path=public, pg_temp']
     or v_function.owner_name <> 'postgres'
     or has_function_privilege(
       'anon',
       'public.can_read_contractor_profile(uuid)',
       'execute'
     )
     or not has_function_privilege(
       'authenticated',
       'public.can_read_contractor_profile(uuid)',
       'execute'
     )
     or not has_function_privilege(
       'service_role',
       'public.can_read_contractor_profile(uuid)',
       'execute'
     )
  then
    raise exception
      'Contractor profile read optimization verification failed'
      using errcode = '23514';
  end if;
end;
$contractor_profile_read_verify$;

commit;
