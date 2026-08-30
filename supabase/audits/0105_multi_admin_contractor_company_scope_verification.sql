-- Run after migration 0105. This is read-only. Every boolean should be true,
-- every issue count should be zero, and all_checks_pass should be true.

with access_function as (
  select
    procedure.prosecdef,
    lower(pg_get_functiondef(procedure.oid)) as body,
    coalesce(procedure.proconfig, '{}'::text[]) as config
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'can_access_contractor_work_order'
    and pg_get_function_identity_arguments(procedure.oid)
      = 'p_work_order_id text'
), company_identity_function as (
  select
    procedure.prosecdef,
    lower(pg_get_functiondef(procedure.oid)) as body,
    coalesce(procedure.proconfig, '{}'::text[]) as config
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'current_contractor_account_id'
    and pg_get_function_identity_arguments(procedure.oid) = ''
), helper_functions as (
  select
    count(*) = 4 as all_present,
    bool_and(procedure.prosecdef) as all_security_definer,
    bool_and(
      'search_path=public, pg_temp'
        = any(coalesce(procedure.proconfig, '{}'::text[]))
    ) as all_search_paths_pinned,
    bool_or(
      procedure.proname = 'can_invoice_for_contractor'
      and lower(pg_get_functiondef(procedure.oid))
        like '%p_contractor_id = case%'
      and lower(pg_get_functiondef(procedure.oid))
        like '%profile.contractor_access_level = ''company_admin''%'
      and lower(pg_get_functiondef(procedure.oid))
        like '%profile.contractor_access_level = ''invoice''%'
      and lower(pg_get_functiondef(procedure.oid))
        like '%technician.contractor_id = p_contractor_id%'
      and lower(pg_get_functiondef(procedure.oid))
        like '%technician.is_active = true%'
    ) as invoice_helper_company_scoped,
    bool_or(
      procedure.proname = 'can_manage_contractor_company'
      and lower(pg_get_functiondef(procedure.oid))
        like '%organization.id = profile.contractor_organization_id%'
      and lower(pg_get_functiondef(procedure.oid))
        like '%organization.active = true%'
      and lower(pg_get_functiondef(procedure.oid))
        like '%organization.canonical_contractor_id is not null%'
      and lower(pg_get_functiondef(procedure.oid))
        like '%profile.contractor_access_level = ''company_admin''%'
    ) as company_management_requires_valid_organization,
    bool_or(
      procedure.proname = 'can_read_contractor_profile'
      and lower(pg_get_functiondef(procedure.oid))
        like '%target.contractor_organization_id%viewer.contractor_organization_id%'
      and lower(pg_get_functiondef(procedure.oid))
        like '%viewer.contractor_access_level = ''company_admin''%'
    ) as profile_directory_same_organization_only,
    bool_or(
      procedure.proname = 'can_manage_work_order_technician'
      and lower(pg_get_functiondef(procedure.oid))
        like '%organization.canonical_contractor_id = work_order.contractor_id%'
      and lower(pg_get_functiondef(procedure.oid))
        like '%viewer.contractor_access_level = ''company_admin''%'
    ) as technician_management_same_company_only
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname in (
      'can_invoice_for_contractor',
      'can_manage_contractor_company',
      'can_read_contractor_profile',
      'can_manage_work_order_technician'
    )
), profile_protection as (
  select
    procedure.prosecdef,
    lower(pg_get_functiondef(procedure.oid)) as body,
    coalesce(procedure.proconfig, '{}'::text[]) as config,
    exists (
      select 1
      from pg_trigger database_trigger
      where database_trigger.tgrelid = 'public.profiles'::regclass
        and database_trigger.tgname
          = 'protect_profile_security_fields_trigger'
        and not database_trigger.tgisinternal
    ) as trigger_present
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'protect_profile_security_fields'
    and pg_get_function_identity_arguments(procedure.oid) = ''
), work_order_policy as (
  select
    count(*) filter (where policy.polcmd in ('r', '*')) = 1
      as one_read_policy,
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
), expected_staff_only_policies(schema_name, table_name, policy_name) as (
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
    count(*) filter (
      where policy.polname = 'ct_read' and policy.polcmd = 'r'
    ) = 1 as scoped_read_policy_present,
    bool_and(
      lower(pg_get_expr(policy.polqual, policy.polrelid))
        like '%organization.canonical_contractor_id%contractor_technicians.contractor_id%'
      and lower(pg_get_expr(policy.polqual, policy.polrelid))
        like '%viewer.contractor_access_level = ''company_admin''%'
      and lower(pg_get_expr(policy.polqual, policy.polrelid))
        not like '%organization.canonical_contractor_id = viewer.id%'
    ) filter (
      where policy.polname = 'ct_read' and policy.polcmd = 'r'
    ) as same_company_admin_scope,
    bool_and(
      policy.polname = 'ct_read'
      or lower(coalesce(
        pg_get_expr(policy.polqual, policy.polrelid),
        ''
      )) like '%is_staff%'
    ) filter (where policy.polcmd in ('r', '*'))
      as all_other_read_capable_policies_staff_only
  from pg_policy policy
  where policy.polrelid = 'public.contractor_technicians'::regclass
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
    ) as all_work_order_scoped
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname in (
      'attach_contractor_invoice_pdf',
      'submit_contractor_invoice_once'
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
      where technician.profile_id
          = work_order.assigned_technician_profile_id
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
), profile_issue_candidates as (
  select profile.id, profile.name, profile.email,
    'staff role also has contractor ownership or membership' as issue
  from public.profiles profile
  where profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office')
    and (
      profile.contractor_organization_id is not null
      or profile.contractor_access_level is not null
      or exists (
        select 1 from public.contractor_technicians technician
        where technician.profile_id = profile.id
      )
      or exists (
        select 1 from public.organizations organization
        where organization.canonical_contractor_id = profile.id
      )
    )
  union all
  select profile.id, profile.name, profile.email,
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
  select profile.id, profile.name, profile.email,
    'company administrator has an active technician link'
  from public.profiles profile
  where profile.active = true
    and profile.role = 'contractor'
    and profile.contractor_organization_id is not null
    and profile.contractor_access_level = 'company_admin'
    and exists (
      select 1 from public.contractor_technicians technician
      where technician.profile_id = profile.id
        and technician.is_active = true
    )
  union all
  select profile.id, profile.name, profile.email,
    'noncanonical company member is exposed as an assignable contractor identity'
  from public.profiles profile
  join public.organizations organization
    on organization.id = profile.contractor_organization_id
   and organization.active = true
   and organization.canonical_contractor_id is distinct from profile.id
  where profile.active = true
    and profile.role = 'contractor'
    and profile.is_assignable = true
  union all
  select profile.id, profile.name, profile.email,
    'invoice/report member has no active link to its own company'
  from public.profiles profile
  join public.organizations organization
    on organization.id = profile.contractor_organization_id
   and organization.active = true
   and organization.canonical_contractor_id is not null
  where profile.active = true
    and profile.role = 'contractor'
    and profile.contractor_access_level in ('invoice', 'report_only')
    and not exists (
      select 1 from public.contractor_technicians technician
      where technician.profile_id = profile.id
        and technician.contractor_id = organization.canonical_contractor_id
        and technician.is_active = true
    )
  union all
  select profile.id, profile.name, profile.email,
    'contractor organization member has an invalid access level'
  from public.profiles profile
  where profile.active = true
    and profile.role = 'contractor'
    and profile.contractor_organization_id is not null
    and (
      profile.contractor_access_level is null
      or profile.contractor_access_level not in (
        'company_admin', 'invoice', 'report_only'
      )
    )
  union all
  select profile.id, profile.name, profile.email,
    'contractor profile has no active canonical company account'
  from public.profiles profile
  where profile.active = true
    and profile.role = 'contractor'
    and profile.contractor_organization_id is not null
    and not exists (
      select 1 from public.organizations organization
      where organization.id = profile.contractor_organization_id
        and organization.active = true
        and organization.canonical_contractor_id is not null
    )
  union all
  select profile.id, profile.name, profile.email,
    'technician profile has an active link outside its own company'
  from public.profiles profile
  join public.organizations organization
    on organization.id = profile.contractor_organization_id
   and organization.active = true
   and organization.canonical_contractor_id is not null
  where profile.active = true
    and profile.role = 'contractor'
    and exists (
      select 1 from public.contractor_technicians technician
      where technician.profile_id = profile.id
        and technician.is_active = true
        and technician.contractor_id
          is distinct from organization.canonical_contractor_id
    )
), profile_issues as (
  select
    count(*) as issue_count,
    coalesce(
      jsonb_agg(jsonb_build_object(
        'name', candidate.name,
        'email', candidate.email,
        'issue', candidate.issue
      ) order by candidate.name, candidate.issue),
      '[]'::jsonb
    ) as issues
  from profile_issue_candidates candidate
), organization_issue_candidates as (
  select
    organization.id,
    organization.name,
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
        then 'canonical contractor belongs to a different organization'
      when canonical.contractor_access_level is distinct from 'company_admin'
        then 'canonical contractor is not company_admin'
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
      jsonb_agg(jsonb_build_object(
        'organization', candidate.name,
        'issue', candidate.issue
      ) order by candidate.name)
        filter (where candidate.issue is not null),
      '[]'::jsonb
    ) as issues
  from organization_issue_candidates candidate
), scrc_organization as (
  select
    organization.id,
    organization.name,
    organization.canonical_contractor_id
  from public.organizations organization
  join public.profiles canonical
    on canonical.id = organization.canonical_contractor_id
   and canonical.contractor_organization_id = organization.id
   and canonical.role = 'contractor'
   and canonical.active = true
  where organization.active = true
    and lower(canonical.email) = 'scrcdallastexas@gmail.com'
), expected_scrc_admins(email) as (
  values
    ('scrcdallastexas@gmail.com'::text),
    ('jenniferk@scrcdtx.com'::text),
    ('nancypb.scrc@gmail.com'::text)
), expected_scrc_members(email, access_level) as (
  values
    ('alan_yeager@icloud.com'::text, 'invoice'::text),
    ('dfwregoftexhvacr@gmail.com'::text, 'invoice'::text),
    ('info.mrfreezems@gmail.com'::text, 'report_only'::text),
    ('scrcrob@gmail.com'::text, 'invoice'::text),
    ('ap@scrcdtx.com'::text, 'report_only'::text),
    ('rayrush50@gmail.com'::text, 'report_only'::text)
), scrc_admin_state as (
  select
    count(profile.id) = 3
      and bool_and(
        organization.id is not null
        and profile.role = 'contractor'
        and profile.active = true
        and profile.contractor_access_level = 'company_admin'
        and profile.contractor_organization_id = organization.id
        and profile.is_assignable
          = (profile.id = organization.canonical_contractor_id)
      ) as approved_admins_configured,
    bool_and(not exists (
      select 1 from public.contractor_technicians technician
      where technician.profile_id = profile.id
        and technician.is_active = true
    )) as admins_not_assignment_targets,
    coalesce(jsonb_agg(jsonb_build_object(
      'name', profile.name,
      'email', profile.email,
      'company', organization.name,
      'accessLevel', profile.contractor_access_level,
      'effectiveWorkOrderScope', 'full SCRC queue only',
      'canInvoice', true,
      'canReport', true,
      'canManageTeam', true
    ) order by profile.name), '[]'::jsonb) as users
  from expected_scrc_admins expected
  left join public.profiles profile on lower(profile.email) = expected.email
  left join scrc_organization organization
    on organization.id = profile.contractor_organization_id
), scrc_member_state as (
  select
    count(profile.id) = 6
      and bool_and(
        organization.id is not null
        and profile.role = 'contractor'
        and profile.active = true
        and profile.contractor_access_level = expected.access_level
        and profile.contractor_organization_id = organization.id
        and profile.is_assignable = false
        and exists (
          select 1 from public.contractor_technicians technician
          where technician.profile_id = profile.id
            and technician.contractor_id
              = organization.canonical_contractor_id
            and technician.is_active = true
        )
      ) as approved_members_configured,
    bool_and(not exists (
      select 1 from public.contractor_technicians technician
      where technician.profile_id = profile.id
        and technician.is_active = true
        and technician.contractor_id
          is distinct from organization.canonical_contractor_id
    )) as members_have_no_cross_company_links,
    coalesce(jsonb_agg(jsonb_build_object(
      'name', profile.name,
      'email', profile.email,
      'company', organization.name,
      'accessLevel', profile.contractor_access_level,
      'currentlyAssignedWorkOrders', (
        select count(*)
        from public.work_orders work_order
        where work_order.deleted_at is null
          and work_order.contractor_id
            = organization.canonical_contractor_id
          and work_order.assigned_technician_profile_id = profile.id
      ),
      'effectiveWorkOrderScope', 'current explicit assignment only'
    ) order by profile.name), '[]'::jsonb) as users
  from expected_scrc_members expected
  left join public.profiles profile on lower(profile.email) = expected.email
  left join scrc_organization organization
    on organization.id = profile.contractor_organization_id
), scrc_roster_state as (
  select
    (select count(*) from scrc_organization) = 1
      as exactly_one_scrc_organization,
    (
      select count(*) = 9
      from public.profiles profile
      join scrc_organization organization
        on organization.id = profile.contractor_organization_id
      where profile.role = 'contractor' and profile.active = true
    ) as exactly_approved_active_roster,
    not exists (
      select 1
      from public.profiles profile
      join scrc_organization organization
        on organization.id = profile.contractor_organization_id
      where profile.role = 'contractor'
        and profile.active = true
        and profile.contractor_access_level = 'company_admin'
        and lower(profile.email) not in (
          select expected.email from expected_scrc_admins expected
        )
    ) as no_unapproved_scrc_admins,
    not exists (
      select 1
      from public.contractor_technicians technician
      join public.profiles profile on profile.id = technician.profile_id
      join scrc_organization organization
        on organization.id = profile.contractor_organization_id
      where technician.is_active = true
        and technician.contractor_id
          is distinct from organization.canonical_contractor_id
    ) as no_scrc_cross_company_links
), checks as (
  select
    access_function.prosecdef
      and 'search_path=public, pg_temp' = any(access_function.config)
      and access_function.body like '%viewer.role = ''contractor''%'
      and access_function.body like '%viewer.active = true%'
      and access_function.body like '%work_order.contractor_id = case%'
      and access_function.body like '%organization.canonical_contractor_id%'
      as contractor_company_wall_enforced,
    access_function.body like
        '%viewer.contractor_access_level = ''company_admin''%'
      and access_function.body not like
        '%viewer.id = organization.canonical_contractor_id%'
      as multiple_company_admins_enabled,
    access_function.body like
        '%viewer.contractor_access_level in (''invoice'', ''report_only'')%'
      and access_function.body like
        '%work_order.assigned_technician_profile_id = viewer.id%'
      and access_function.body like '%technician.profile_id = viewer.id%'
      and access_function.body like
        '%technician.contractor_id = work_order.contractor_id%'
      and access_function.body like '%technician.is_active = true%'
      as non_admin_members_assignment_scoped,
    company_identity_function.prosecdef
      and 'search_path=public, pg_temp'
        = any(company_identity_function.config)
      and company_identity_function.body like
        '%then canonical.id%'
      and company_identity_function.body like
        '%canonical.id = organization.canonical_contractor_id%'
      and company_identity_function.body like '%canonical.active = true%'
      as company_identity_canonicalized,
    helper_functions.all_present
      and helper_functions.all_security_definer
      and helper_functions.all_search_paths_pinned
      and helper_functions.invoice_helper_company_scoped
      as invoice_permissions_company_scoped,
    helper_functions.company_management_requires_valid_organization
      and helper_functions.profile_directory_same_organization_only
      and helper_functions.technician_management_same_company_only
      as management_permissions_company_scoped,
    technician_directory_policy.scoped_read_policy_present
      and coalesce(
        technician_directory_policy.same_company_admin_scope,
        false
      )
      and coalesce(
        technician_directory_policy.all_other_read_capable_policies_staff_only,
        false
      ) as technician_directory_company_scoped,
    profile_protection.prosecdef
      and 'search_path=public, pg_temp' = any(profile_protection.config)
      and profile_protection.trigger_present
      and profile_protection.body like
        '%new.contractor_organization_id is distinct from old.contractor_organization_id%'
      and profile_protection.body like
        '%new.contractor_access_level is distinct from old.contractor_access_level%'
      as contractor_self_promotion_blocked,
    (
      select relrowsecurity from pg_class
      where oid = 'public.work_orders'::regclass
    )
      and work_order_policy.one_read_policy
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
    invoice_rpc_guards.all_present
      and invoice_rpc_guards.all_security_definer
      and invoice_rpc_guards.all_search_paths_pinned
      and invoice_rpc_guards.all_work_order_scoped
      as invoice_rpcs_work_order_scoped,
    read_rpcs.all_present
      and read_rpcs.all_security_invoker
      and read_rpcs.all_search_paths_pinned
      as read_rpcs_preserve_rls,
    invalid_assignments.issue_count = 0 as current_assignments_valid,
    stale_assignment_history.issue_count = 0
      as assignment_history_consistent,
    profile_issues.issue_count = 0 as profile_roles_consistent,
    organization_issues.issue_count = 0 as organizations_consistent,
    scrc_roster_state.exactly_one_scrc_organization,
    scrc_roster_state.exactly_approved_active_roster,
    scrc_roster_state.no_unapproved_scrc_admins,
    scrc_admin_state.approved_admins_configured,
    scrc_admin_state.admins_not_assignment_targets,
    scrc_member_state.approved_members_configured,
    scrc_member_state.members_have_no_cross_company_links,
    scrc_roster_state.no_scrc_cross_company_links,
    invalid_assignments.issue_count as invalid_assignment_count,
    stale_assignment_history.issue_count
      as stale_assignment_history_count,
    profile_issues.issue_count as profile_role_issue_count,
    profile_issues.issues as profile_role_issues,
    organization_issues.issue_count as organization_issue_count,
    organization_issues.issues as organization_issues,
    scrc_admin_state.users as scrc_company_admin_users,
    scrc_member_state.users as scrc_assignment_scoped_users
  from access_function
  cross join company_identity_function
  cross join helper_functions
  cross join profile_protection
  cross join work_order_policy
  cross join contractor_scoped_policies
  cross join staff_only_policies
  cross join technician_directory_policy
  cross join invoice_rpc_guards
  cross join read_rpcs
  cross join invalid_assignments
  cross join stale_assignment_history
  cross join profile_issues
  cross join organization_issues
  cross join scrc_admin_state
  cross join scrc_member_state
  cross join scrc_roster_state
)
select
  checks.*,
  contractor_company_wall_enforced
    and multiple_company_admins_enabled
    and non_admin_members_assignment_scoped
    and company_identity_canonicalized
    and invoice_permissions_company_scoped
    and management_permissions_company_scoped
    and technician_directory_company_scoped
    and contractor_self_promotion_blocked
    and work_order_rls_scoped
    and related_data_rls_scoped
    and sensitive_staff_data_rls_scoped
    and invoice_rpcs_work_order_scoped
    and read_rpcs_preserve_rls
    and current_assignments_valid
    and assignment_history_consistent
    and profile_roles_consistent
    and organizations_consistent
    and exactly_one_scrc_organization
    and exactly_approved_active_roster
    and no_unapproved_scrc_admins
    and approved_admins_configured
    and admins_not_assignment_targets
    and approved_members_configured
    and members_have_no_cross_company_links
    and no_scrc_cross_company_links
    as all_checks_pass
from checks;
