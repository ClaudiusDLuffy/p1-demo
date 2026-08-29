-- Run after migration 0104. The structural checks must all be true. Review
-- company_wide_scope_users even when all_checks_pass: those users can
-- intentionally see every work order for their own contractor company,
-- including standalone canonical contractor accounts.

with access_function as (
  select
    procedure.oid,
    procedure.prosecdef,
    lower(pg_get_functiondef(procedure.oid)) as body,
    coalesce(procedure.proconfig, '{}'::text[]) as config
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'can_access_contractor_work_order'
    and pg_get_function_identity_arguments(procedure.oid) = 'p_work_order_id text'
), clear_function as (
  select
    procedure.oid,
    procedure.prosecdef,
    lower(pg_get_functiondef(procedure.oid)) as body,
    coalesce(procedure.proconfig, '{}'::text[]) as config
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'clear_technician_on_contractor_change'
    and pg_get_function_identity_arguments(procedure.oid) = ''
), work_order_policy as (
  select
    count(*) filter (where policy.polcmd in ('r', '*')) as read_policy_count,
    bool_and(
      lower(pg_get_expr(policy.polqual, policy.polrelid))
        like '%can_access_contractor_work_order%'
    ) filter (where policy.polcmd in ('r', '*')) as all_reads_scoped
  from pg_policy policy
  where policy.polrelid = 'public.work_orders'::regclass
), expected_scoped_policies(
  schema_name,
  table_name,
  policy_name,
  required_fragment
) as (
  values
    ('public', 'work_orders', 'wo_read', 'can_access_contractor_work_order'),
    ('public', 'stores', 'stores_read', 'can_access_contractor_work_order'),
    ('public', 'activities', 'act_read', 'can_access_contractor_work_order'),
    ('public', 'photos', 'photo_read', 'can_access_contractor_work_order'),
    ('storage', 'objects', 'photos_read', 'can_access_contractor_work_order'),
    ('public', 'wo_parts', 'wo_parts_select', 'can_access_contractor_work_order'),
    ('public', 'service_notes', 'service_notes_read', 'can_access_contractor_work_order'),
    ('public', 'work_reports', 'work_reports_select', 'can_access_contractor_work_order'),
    ('public', 'work_order_visits', 'work_order_visits_read', 'can_access_contractor_work_order'),
    ('public', 'invoices', 'inv_read', 'can_access_contractor_work_order'),
    ('public', 'invoice_lines', 'line_read', 'can_access_contractor_work_order'),
    ('storage', 'objects', 'invoice_pdfs_read', 'can_access_contractor_work_order'),
    ('public', 'contractor_estimates', 'contractor_estimates_read', 'can_access_contractor_work_order'),
    ('public', 'contractor_estimate_lines', 'contractor_estimate_lines_read', 'can_access_contractor_work_order'),
    ('public', 'contractor_estimate_attachments', 'contractor_estimate_attachments_read', 'can_access_contractor_work_order'),
    ('storage', 'objects', 'contractor_estimate_attachments_storage_read', 'contractor_estimate_attachments'),
    ('public', 'profiles', 'profiles_read', 'can_read_contractor_profile'),
    ('public', 'work_order_technician_assignments', 'work_order_technician_assignments_read', 'can_manage_work_order_technician')
), contractor_scoped_policies as (
  select
    count(policy.oid) = count(*) as all_present,
    bool_and(coalesce(relation.relrowsecurity, false)) as all_rls_enabled,
    bool_and(
      coalesce(
        lower(pg_get_expr(policy.polqual, policy.polrelid))
          like '%' || expected.required_fragment || '%',
        false
      )
    ) as all_scoped
  from expected_scoped_policies expected
  left join pg_namespace namespace
    on namespace.nspname = expected.schema_name
  left join pg_class relation
    on relation.relnamespace = namespace.oid
   and relation.relname = expected.table_name
  left join pg_policy policy
    on policy.polrelid = relation.oid
   and policy.polname = expected.policy_name
   and policy.polcmd in ('r', '*')
), expected_staff_only_policies(
  schema_name,
  table_name,
  policy_name
) as (
  values
    ('public', 'work_order_assignment_history', 'work_order_assignment_history_staff_read'),
    ('public', 'work_order_afm_contacts', 'work_order_afm_contacts_read'),
    ('public', 'afms', 'afms_read'),
    ('public', 'contractor_invoice_payment_holds', 'contractor_invoice_payment_holds_read'),
    ('public', 'contractor_invoice_payment_hold_events', 'contractor_invoice_payment_hold_events_read'),
    ('public', 'contractor_technician_admin_events', 'contractor_technician_admin_events_read'),
    ('public', 'controller_invoice_export_batches', 'controller_export_batches_read'),
    ('public', 'controller_invoice_export_items', 'controller_export_items_read')
), staff_only_policies as (
  select
    count(policy.oid) = count(*) as all_present,
    bool_and(coalesce(relation.relrowsecurity, false)) as all_rls_enabled,
    bool_and(
      coalesce(
        lower(pg_get_expr(policy.polqual, policy.polrelid)) like '%is_staff%',
        false
      )
    ) as all_staff_scoped
  from expected_staff_only_policies expected
  left join pg_namespace namespace
    on namespace.nspname = expected.schema_name
  left join pg_class relation
    on relation.relnamespace = namespace.oid
   and relation.relname = expected.table_name
  left join pg_policy policy
    on policy.polrelid = relation.oid
   and policy.polname = expected.policy_name
   and policy.polcmd in ('r', '*')
), technician_directory_policy as (
  select
    count(*) filter (where policy.polcmd in ('r', '*')) = 1 as one_read_policy,
    bool_and(
      lower(pg_get_expr(policy.polqual, policy.polrelid))
        like '%organization.canonical_contractor_id = viewer.id%'
    ) filter (where policy.polcmd in ('r', '*')) as canonical_only
  from pg_policy policy
  where policy.polrelid = 'public.contractor_technicians'::regclass
), scope_helpers as (
  select
    count(*) = 4 as all_present,
    bool_and(helper.prosecdef) as all_security_definer,
    bool_and('search_path=public, pg_temp' = any(helper.config))
      as all_search_paths_pinned,
    bool_or(
      helper.name = 'can_invoice_for_contractor'
      and helper.body like '%profile.id = organization.canonical_contractor_id%'
      and helper.body like '%profile.contractor_access_level = ''invoice''%'
      and helper.body like '%technician.profile_id = profile.id%'
      and helper.body like '%technician.is_active = true%'
    ) as invoice_members_require_active_link,
    bool_or(
      helper.name = 'can_manage_contractor_company'
      and helper.body like '%organization.canonical_contractor_id = profile.id%'
    )
      and bool_or(
        helper.name = 'can_read_contractor_profile'
        and helper.body like '%organization.canonical_contractor_id = viewer.id%'
      )
      and bool_or(
        helper.name = 'can_manage_work_order_technician'
        and helper.body like '%organization.canonical_contractor_id = viewer.id%'
      ) as management_helpers_canonical_only
  from (
    select
      procedure.proname as name,
      procedure.prosecdef,
      lower(pg_get_functiondef(procedure.oid)) as body,
      coalesce(procedure.proconfig, '{}'::text[]) as config
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'can_invoice_for_contractor',
        'can_manage_contractor_company',
        'can_read_contractor_profile',
        'can_manage_work_order_technician'
      )
  ) helper
), invoice_rpc_guards as (
  select
    count(distinct procedure.proname) = 2 as all_present,
    bool_and(procedure.prosecdef) as all_security_definer,
    bool_and(
      'search_path=public, pg_temp'
        = any(coalesce(procedure.proconfig, '{}'::text[]))
    ) as all_search_paths_pinned,
    bool_and(
      lower(pg_get_functiondef(procedure.oid))
        like '%can_access_contractor_work_order%'
    ) as all_assignment_scoped
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname in (
      'attach_contractor_invoice_pdf',
      'submit_contractor_invoice_once'
    )
), internal_identity_helper as (
  select
    count(distinct procedure.proname) = 2 as present,
    bool_and(
      not has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
      and not has_function_privilege('anon', procedure.oid, 'EXECUTE')
    ) as untrusted_execute_blocked
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname in (
      'contractor_account_id_for_profile',
      'is_linked_contractor_technician'
    )
), legacy_invoice_rpcs as (
  select
    count(distinct procedure.proname) = 2 as all_present,
    bool_and(
      not has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
      and not has_function_privilege('anon', procedure.oid, 'EXECUTE')
    ) as untrusted_execute_blocked
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname in (
      'attach_contractor_invoice_pdf_company_scope_legacy',
      'submit_contractor_invoice_once_company_scope_legacy'
    )
), read_rpcs as (
  select
    count(distinct procedure.proname) = 10 as all_present,
    bool_and(not procedure.prosecdef) as all_security_invoker,
    bool_and(
      exists (
        select 1
        from unnest(coalesce(procedure.proconfig, '{}'::text[])) option
        where option like 'search_path=%'
      )
    ) as all_search_paths_pinned
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname in (
      'list_work_orders_page',
      'list_work_orders_table_page',
      'get_portal_work_order',
      'get_portal_navigation_summary',
      'get_contractor_workload_summary',
      'get_work_order_activity_summaries',
      'list_work_order_activities_page',
      'list_work_order_photos_page',
      'list_work_order_visits_page',
      'list_contractor_invoices_page'
    )
), invalid_assignments as (
  select count(*) as issue_count
  from public.work_orders work_order
  where work_order.assigned_technician_profile_id is not null
    and not exists (
      select 1
      from public.contractor_technicians technician
      join public.profiles profile
        on profile.id = technician.profile_id
       and profile.role = 'contractor'
       and profile.active = true
       and profile.contractor_access_level in ('invoice', 'report_only')
      where technician.profile_id = work_order.assigned_technician_profile_id
        and technician.contractor_id = work_order.contractor_id
        and technician.is_active = true
        and public.contractor_account_id_for_profile(profile.id)
          = work_order.contractor_id
    )
), stale_assignment_history as (
  select count(*) as issue_count
  from public.work_order_technician_assignments assignment
  join public.work_orders work_order on work_order.id = assignment.work_order_id
  where assignment.ended_at is null
    and assignment.technician_profile_id
      is distinct from work_order.assigned_technician_profile_id
), role_issue_candidates as (
  select
    profile.id,
    profile.name,
    profile.email,
    profile.role,
    profile.contractor_access_level,
    'staff role also has contractor ownership or membership' as issue
  from public.profiles profile
  where profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office')
    and (
      profile.contractor_organization_id is not null
      or profile.contractor_access_level is not null
      or exists (
        select 1
        from public.contractor_technicians technician
        where technician.profile_id = profile.id
      )
      or exists (
        select 1
        from public.organizations organization
        where organization.canonical_contractor_id = profile.id
      )
    )
  union all
  select
    profile.id,
    profile.name,
    profile.email,
    profile.role,
    profile.contractor_access_level,
    'canonical company account is not company_admin'
  from public.profiles profile
  join public.organizations organization
    on organization.id = profile.contractor_organization_id
   and organization.active = true
   and organization.canonical_contractor_id = profile.id
  where profile.active = true
    and profile.role = 'contractor'
    and profile.contractor_access_level is distinct from 'company_admin'
  union all
  select
    profile.id,
    profile.name,
    profile.email,
    profile.role,
    profile.contractor_access_level,
    'noncanonical company member has company_admin access level'
  from public.profiles profile
  join public.organizations organization
    on organization.id = profile.contractor_organization_id
   and organization.active = true
   and organization.canonical_contractor_id is distinct from profile.id
  where profile.active = true
    and profile.role = 'contractor'
    and profile.contractor_access_level = 'company_admin'
  union all
  select
    profile.id,
    profile.name,
    profile.email,
    profile.role,
    profile.contractor_access_level,
    'contractor organization member has no active technician link'
  from public.profiles profile
  join public.organizations organization
    on organization.id = profile.contractor_organization_id
   and organization.active = true
   and organization.canonical_contractor_id is not null
   and organization.canonical_contractor_id is distinct from profile.id
  where profile.active = true
    and profile.role = 'contractor'
    and not exists (
      select 1
      from public.contractor_technicians technician
      where technician.profile_id = profile.id
        and technician.contractor_id = organization.canonical_contractor_id
        and technician.is_active = true
    )
  union all
  select
    profile.id,
    profile.name,
    profile.email,
    profile.role,
    profile.contractor_access_level,
    'contractor profile has no active canonical company account'
  from public.profiles profile
  where profile.active = true
    and profile.role = 'contractor'
    and profile.contractor_organization_id is not null
    and not exists (
      select 1
      from public.organizations organization
      where organization.id = profile.contractor_organization_id
        and organization.active = true
        and organization.canonical_contractor_id is not null
    )
  union all
  select
    profile.id,
    profile.name,
    profile.email,
    profile.role,
    profile.contractor_access_level,
    'technician profile has active links to multiple contractor accounts'
  from public.profiles profile
  where profile.active = true
    and profile.role = 'contractor'
    and exists (
      select 1
      from public.contractor_technicians technician
      where technician.profile_id = profile.id
        and technician.is_active = true
      group by technician.profile_id
      having count(distinct technician.contractor_id) > 1
    )
  union all
  select
    profile.id,
    profile.name,
    profile.email,
    profile.role,
    profile.contractor_access_level,
    'technician profile has an active link outside its canonical company'
  from public.profiles profile
  join public.organizations organization
    on organization.id = profile.contractor_organization_id
   and organization.active = true
   and organization.canonical_contractor_id is not null
  where profile.active = true
    and profile.role = 'contractor'
    and exists (
      select 1
      from public.contractor_technicians technician
      where technician.profile_id = profile.id
        and technician.is_active = true
        and technician.contractor_id
          is distinct from organization.canonical_contractor_id
    )
), organization_issue_candidates as (
  select
    organization.id,
    organization.name,
    organization.canonical_contractor_id,
    case
      when organization.canonical_contractor_id is null
        then 'active organization has no canonical contractor'
      when canonical.id is null
        then 'canonical contractor profile does not exist'
      when canonical.role <> 'contractor'
        then 'canonical contractor profile is not a contractor'
      when canonical.active is not true
        then 'canonical contractor profile is inactive'
      when canonical.contractor_organization_id is distinct from organization.id
        then 'canonical contractor profile belongs to a different organization'
      when canonical.contractor_access_level is distinct from 'company_admin'
        then 'canonical contractor profile is not company_admin'
      else null
    end as issue
  from public.organizations organization
  left join public.profiles canonical
    on canonical.id = organization.canonical_contractor_id
  where organization.active = true
), organization_issues as (
  select
    count(*) filter (where candidate.issue is not null) as issue_count,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'organization', candidate.name,
          'canonicalContractorId', candidate.canonical_contractor_id,
          'issue', candidate.issue
        )
        order by candidate.name
      ) filter (where candidate.issue is not null),
      '[]'::jsonb
    ) as issues
  from organization_issue_candidates candidate
), role_issues as (
  select
    count(*) as issue_count,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'name', candidate.name,
          'email', candidate.email,
          'role', candidate.role,
          'accessLevel', candidate.contractor_access_level,
          'issue', candidate.issue
        )
        order by candidate.name
      ),
      '[]'::jsonb
    ) as issues
  from role_issue_candidates candidate
), staff_role_scope as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'name', profile.name,
        'email', profile.email,
        'role', profile.role
      )
      order by profile.name
    ),
    '[]'::jsonb
  ) as users
  from public.profiles profile
  where profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office')
), company_wide_scope as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'name', profile.name,
        'email', profile.email,
        'accessLevel', profile.contractor_access_level,
        'company', coalesce(organization.name, profile.company, profile.name),
        'canonicalContractorId', coalesce(
          organization.canonical_contractor_id,
          profile.id
        ),
        'reason', case
          when profile.contractor_organization_id is null
            then 'standalone canonical contractor account'
          else 'canonical company administrator'
        end
      )
      order by coalesce(organization.name, profile.company, profile.name), profile.name
    ),
    '[]'::jsonb
  ) as users
  from public.profiles profile
  left join public.organizations organization
    on organization.id = profile.contractor_organization_id
   and organization.active = true
  where profile.role = 'contractor'
    and profile.active = true
    and (
      profile.contractor_organization_id is null
      or (
        profile.contractor_access_level = 'company_admin'
        and profile.id = organization.canonical_contractor_id
      )
    )
), organization_member_scope as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'name', profile.name,
        'email', profile.email,
        'accessLevel', profile.contractor_access_level,
        'company', organization.name,
        'canonicalContractorId', organization.canonical_contractor_id,
        'activeTechnicianLink', exists (
          select 1
          from public.contractor_technicians technician
          where technician.profile_id = profile.id
            and technician.contractor_id = organization.canonical_contractor_id
            and technician.is_active = true
        ),
        'effectiveWorkOrderScope', case
          when exists (
            select 1
            from public.contractor_technicians technician
            where technician.profile_id = profile.id
              and technician.contractor_id = organization.canonical_contractor_id
              and technician.is_active = true
          ) then 'current explicit assignment only'
          else 'blocked until actively linked'
        end
      )
      order by organization.name, profile.name
    ),
    '[]'::jsonb
  ) as users
  from public.profiles profile
  join public.organizations organization
    on organization.id = profile.contractor_organization_id
   and organization.active = true
   and organization.canonical_contractor_id is not null
   and organization.canonical_contractor_id is distinct from profile.id
  where profile.role = 'contractor'
    and profile.active = true
), checks as (
  select
    access_function.prosecdef
      and 'search_path=public, pg_temp' = any(access_function.config)
      and access_function.body like '%viewer.role = ''contractor''%'
      and access_function.body like '%viewer.active = true%'
      and access_function.body like '%work_order.contractor_id = case%'
      as canonical_contractor_wall_enforced,
    access_function.body like '%viewer.id = organization.canonical_contractor_id%'
      and access_function.body like '%viewer.contractor_access_level = ''company_admin''%'
      as canonical_company_admin_only,
    access_function.body like '%viewer.id is distinct from organization.canonical_contractor_id%'
      and access_function.body like '%assigned_technician_profile_id = viewer.id%'
      and access_function.body like '%technician.is_active = true%'
      and access_function.body not like '%not public.is_linked_contractor_technician%'
      and access_function.body not like '%work_order_assignment_history%'
      and access_function.body not like '%work_order_visits%'
      and access_function.body not like '%from public.photos%'
      as organization_members_assignment_scoped,
    scope_helpers.all_present
      and scope_helpers.all_security_definer
      and scope_helpers.all_search_paths_pinned
      and scope_helpers.management_helpers_canonical_only
      as management_helpers_canonical_only,
    scope_helpers.invoice_members_require_active_link
      as invoice_members_require_active_link,
    invoice_rpc_guards.all_present
      and invoice_rpc_guards.all_security_definer
      and invoice_rpc_guards.all_search_paths_pinned
      and invoice_rpc_guards.all_assignment_scoped
      as security_definer_invoice_rpcs_assignment_scoped,
    internal_identity_helper.present
      and internal_identity_helper.untrusted_execute_blocked
      as arbitrary_profile_identity_lookup_blocked,
    legacy_invoice_rpcs.all_present
      and legacy_invoice_rpcs.untrusted_execute_blocked
      as legacy_invoice_rpc_execute_blocked,
    technician_directory_policy.one_read_policy
      and coalesce(technician_directory_policy.canonical_only, false)
      as technician_directory_canonical_only,
    (
      select relrowsecurity
      from pg_class
      where oid = 'public.work_orders'::regclass
    )
      and work_order_policy.read_policy_count = 1
      and coalesce(work_order_policy.all_reads_scoped, false)
      as work_order_rls_scoped,
    contractor_scoped_policies.all_present
      and contractor_scoped_policies.all_rls_enabled
      and contractor_scoped_policies.all_scoped
      as related_data_rls_scoped,
    staff_only_policies.all_present
      and staff_only_policies.all_rls_enabled
      and staff_only_policies.all_staff_scoped
      as sensitive_staff_data_rls_scoped,
    read_rpcs.all_present
      and read_rpcs.all_security_invoker
      and read_rpcs.all_search_paths_pinned
      as read_rpcs_preserve_rls,
    clear_function.prosecdef
      and 'search_path=public, pg_temp' = any(clear_function.config)
      and clear_function.body like '%new.assigned_technician_profile_id := null%'
      and clear_function.body like '%new.technician_on_job := null%'
      and clear_function.body like '%assignment.ended_at is null%'
      and exists (
        select 1
        from pg_trigger database_trigger
        where database_trigger.tgrelid = 'public.work_orders'::regclass
          and database_trigger.tgname = 'clear_technician_on_contractor_change_trigger'
          and not database_trigger.tgisinternal
      )
      as reassignment_clears_technician,
    invalid_assignments.issue_count = 0 as current_assignments_valid,
    stale_assignment_history.issue_count = 0 as assignment_history_consistent,
    role_issues.issue_count = 0 as profile_roles_consistent,
    organization_issues.issue_count = 0 as organizations_consistent,
    invalid_assignments.issue_count as invalid_assignment_count,
    stale_assignment_history.issue_count as stale_assignment_history_count,
    role_issues.issue_count as profile_role_issue_count,
    role_issues.issues as profile_role_issues,
    organization_issues.issue_count as organization_issue_count,
    organization_issues.issues as organization_issues,
    staff_role_scope.users as staff_role_users,
    company_wide_scope.users as company_wide_scope_users,
    organization_member_scope.users as organization_member_scope_users
  from access_function
  cross join clear_function
  cross join work_order_policy
  cross join contractor_scoped_policies
  cross join staff_only_policies
  cross join technician_directory_policy
  cross join scope_helpers
  cross join invoice_rpc_guards
  cross join internal_identity_helper
  cross join legacy_invoice_rpcs
  cross join read_rpcs
  cross join invalid_assignments
  cross join stale_assignment_history
  cross join role_issues
  cross join organization_issues
  cross join staff_role_scope
  cross join company_wide_scope
  cross join organization_member_scope
)
select
  checks.*,
  canonical_contractor_wall_enforced
    and canonical_company_admin_only
    and organization_members_assignment_scoped
    and management_helpers_canonical_only
    and invoice_members_require_active_link
    and security_definer_invoice_rpcs_assignment_scoped
    and arbitrary_profile_identity_lookup_blocked
    and legacy_invoice_rpc_execute_blocked
    and technician_directory_canonical_only
    and work_order_rls_scoped
    and related_data_rls_scoped
    and sensitive_staff_data_rls_scoped
    and read_rpcs_preserve_rls
    and reassignment_clears_technician
    and current_assignments_valid
    and assignment_history_consistent
    and profile_roles_consistent
    and organizations_consistent
    as all_checks_pass
from checks;
