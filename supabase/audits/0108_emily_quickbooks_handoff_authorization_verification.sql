-- Run after migration 0108. The approved authorization set currently contains
-- Emily only. Once the named backup is approved, update this explicit allowlist
-- in a reviewed migration and audit instead of granting access ad hoc.

with handoff_functions as (
  select
    to_regprocedure(
      'public.stage_controller_invoice_export(uuid,uuid,text,uuid[])'
    ) as stage_handoff_rpc,
    to_regprocedure(
      'public.confirm_controller_invoice_export(uuid,uuid)'
    ) as confirm_handoff_rpc,
    to_regprocedure(
      'public.cancel_controller_invoice_export(uuid,uuid,text)'
    ) as cancel_handoff_rpc,
    to_regprocedure(
      'public.complete_controller_invoice_export(uuid,uuid,text,uuid[])'
    ) as legacy_complete_rpc
),
emily_profiles as (
  select profile.*
  from public.profiles profile
  where lower(trim(coalesce(profile.email, '')))
    = 'emilyb@phospitality.com'
),
handoff_grantees as (
  select
    profile.id,
    profile.name,
    profile.email,
    profile.role,
    profile.active,
    permission_grant.created_at,
    lower(trim(coalesce(profile.email, '')))
      = 'emilyb@phospitality.com'
      and profile.active = true
      and profile.role in ('manager', 'dispatcher', 'back_office')
      as is_currently_approved
  from public.staff_permission_grants permission_grant
  join public.profiles profile on profile.id = permission_grant.profile_id
  where permission_grant.permission = 'quickbooks_handoff'
),
checks as (
  select
    (select count(*) = 1 from emily_profiles)
      as exactly_one_emily_profile,
    (
      select count(*) = 1
      from emily_profiles profile
      where profile.active = true
        and profile.role in ('manager', 'dispatcher', 'back_office')
    ) as emily_is_active_staff,
    (
      select count(*) = 1
      from handoff_grantees grantee
      where grantee.is_currently_approved
    ) as emily_handoff_grant_present,
    (select count(*) = 1 from handoff_grantees)
      as exactly_approved_handoff_roster,
    not exists (
      select 1
      from handoff_grantees grantee
      where not grantee.is_currently_approved
    ) as no_unexpected_handoff_grantees,
    exists (
      select 1
      from pg_class table_class
      where table_class.oid = 'public.staff_permission_grants'::regclass
        and table_class.relrowsecurity
    ) as permission_table_rls_enabled,
    not coalesce(
      has_table_privilege(
        'anon',
        'public.staff_permission_grants',
        'SELECT'
      ),
      false
    )
      and not coalesce(
        has_table_privilege(
          'anon', 'public.staff_permission_grants', 'INSERT'
        ),
        false
      )
      and not coalesce(
        has_table_privilege(
          'anon', 'public.staff_permission_grants', 'UPDATE'
        ),
        false
      )
      and not coalesce(
        has_table_privilege(
          'anon', 'public.staff_permission_grants', 'DELETE'
        ),
        false
      ) as anonymous_permission_table_blocked,
    not coalesce(
      has_table_privilege(
        'anon',
        'public.controller_invoice_export_batches',
        'SELECT'
      ),
      false
    )
      and not coalesce(
        has_table_privilege(
          'anon', 'public.controller_invoice_export_batches', 'INSERT'
        ),
        false
      )
      and not coalesce(
        has_table_privilege(
          'anon', 'public.controller_invoice_export_batches', 'UPDATE'
        ),
        false
      )
      and not coalesce(
        has_table_privilege(
          'anon', 'public.controller_invoice_export_batches', 'DELETE'
        ),
        false
      )
      and not coalesce(
        has_table_privilege(
          'anon',
          'public.controller_invoice_export_items',
          'SELECT'
        ),
        false
      )
      and not coalesce(
        has_table_privilege(
          'anon', 'public.controller_invoice_export_items', 'INSERT'
        ),
        false
      )
      and not coalesce(
        has_table_privilege(
          'anon', 'public.controller_invoice_export_items', 'UPDATE'
        ),
        false
      )
      and not coalesce(
        has_table_privilege(
          'anon', 'public.controller_invoice_export_items', 'DELETE'
        ),
        false
      ) as anonymous_export_tables_blocked,
    handoff_functions.stage_handoff_rpc is not null
      and handoff_functions.confirm_handoff_rpc is not null
      and handoff_functions.cancel_handoff_rpc is not null
      and handoff_functions.legacy_complete_rpc is not null
      and not coalesce(
        has_function_privilege(
          'anon', handoff_functions.stage_handoff_rpc, 'EXECUTE'
        ),
        false
      )
      and not coalesce(
        has_function_privilege(
          'authenticated', handoff_functions.stage_handoff_rpc, 'EXECUTE'
        ),
        false
      )
      and not coalesce(
        has_function_privilege(
          'anon', handoff_functions.confirm_handoff_rpc, 'EXECUTE'
        ),
        false
      )
      and not coalesce(
        has_function_privilege(
          'authenticated', handoff_functions.confirm_handoff_rpc, 'EXECUTE'
        ),
        false
      )
      and not coalesce(
        has_function_privilege(
          'anon', handoff_functions.cancel_handoff_rpc, 'EXECUTE'
        ),
        false
      )
      and not coalesce(
        has_function_privilege(
          'authenticated', handoff_functions.cancel_handoff_rpc, 'EXECUTE'
        ),
        false
      )
      and not coalesce(
        has_function_privilege(
          'anon', handoff_functions.legacy_complete_rpc, 'EXECUTE'
        ),
        false
      )
      and not coalesce(
        has_function_privilege(
          'authenticated', handoff_functions.legacy_complete_rpc, 'EXECUTE'
        ),
        false
      )
      and coalesce(
        has_function_privilege(
          'service_role', handoff_functions.stage_handoff_rpc, 'EXECUTE'
        ),
        false
      )
      and coalesce(
        has_function_privilege(
          'service_role', handoff_functions.confirm_handoff_rpc, 'EXECUTE'
        ),
        false
      )
      and coalesce(
        has_function_privilege(
          'service_role', handoff_functions.cancel_handoff_rpc, 'EXECUTE'
        ),
        false
      )
      and coalesce(
        has_function_privilege(
          'service_role', handoff_functions.legacy_complete_rpc, 'EXECUTE'
        ),
        false
      ) as handoff_rpcs_server_only
  from handoff_functions
)
select
  exactly_one_emily_profile,
  emily_is_active_staff,
  emily_handoff_grant_present,
  exactly_approved_handoff_roster,
  no_unexpected_handoff_grantees,
  permission_table_rls_enabled,
  anonymous_permission_table_blocked,
  anonymous_export_tables_blocked,
  handoff_rpcs_server_only,
  exactly_one_emily_profile
    and emily_is_active_staff
    and emily_handoff_grant_present
    and exactly_approved_handoff_roster
    and no_unexpected_handoff_grantees
    and permission_table_rls_enabled
    and anonymous_permission_table_blocked
    and anonymous_export_tables_blocked
    and handoff_rpcs_server_only
    as all_checks_pass
from checks;

-- Current handoff roster. Until a backup is formally named, this should return
-- exactly one row and that row should be Emily with authorization_status=approved.
select
  profile.id,
  profile.name,
  profile.email,
  profile.role,
  profile.active,
  permission_grant.created_at as granted_at,
  case
    when lower(trim(coalesce(profile.email, '')))
        = 'emilyb@phospitality.com'
      and profile.active = true
      and profile.role in ('manager', 'dispatcher', 'back_office')
      then 'approved'
    else 'unexpected - remove pending named-backup approval'
  end as authorization_status
from public.staff_permission_grants permission_grant
join public.profiles profile on profile.id = permission_grant.profile_id
where permission_grant.permission = 'quickbooks_handoff'
order by authorization_status, profile.name, profile.id;

-- Unexpected grants only. This result must be empty while Emily is the sole
-- approved handoff owner.
select
  profile.id,
  profile.name,
  profile.email,
  profile.role,
  profile.active,
  permission_grant.created_at as granted_at
from public.staff_permission_grants permission_grant
join public.profiles profile on profile.id = permission_grant.profile_id
where permission_grant.permission = 'quickbooks_handoff'
  and not (
    lower(trim(coalesce(profile.email, '')))
      = 'emilyb@phospitality.com'
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office')
  )
order by profile.name, profile.id;
