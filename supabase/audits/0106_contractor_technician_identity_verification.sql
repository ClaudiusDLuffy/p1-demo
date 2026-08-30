-- Run after migration 0106. This is read-only. Every boolean should be true,
-- issue counts should be zero, and all_checks_pass should be true.

with identity_guard as (
  select
    procedure.oid,
    procedure.prosecdef,
    lower(pg_get_functiondef(procedure.oid)) as body,
    coalesce(procedure.proconfig, '{}'::text[]) as config,
    not has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
      and not has_function_privilege('anon', procedure.oid, 'EXECUTE')
      as direct_untrusted_execute_blocked
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'validate_contractor_technician_profile'
    and pg_get_function_identity_arguments(procedure.oid) = ''
), identity_trigger as (
  select
    count(*) = 1 as present,
    bool_and(
      lower(pg_get_triggerdef(database_trigger.oid)) like '%before%'
      and lower(pg_get_triggerdef(database_trigger.oid)) like '%insert%'
      and lower(pg_get_triggerdef(database_trigger.oid)) like '%update of%'
      and lower(pg_get_triggerdef(database_trigger.oid)) like '%contractor_id%'
      and lower(pg_get_triggerdef(database_trigger.oid)) like '%profile_id%'
      and lower(pg_get_triggerdef(database_trigger.oid)) like '%name%'
    ) as covers_identity_fields
  from pg_trigger database_trigger
  where database_trigger.tgrelid
      = 'public.contractor_technicians'::regclass
    and database_trigger.tgname
      = 'validate_contractor_technician_profile_trigger'
    and not database_trigger.tgisinternal
), work_order_access as (
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
), scrc_organizations as (
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
), scrc_context as (
  select
    (select count(*) from scrc_organizations) as organization_count,
    (select organization.id from scrc_organizations organization limit 1)
      as organization_id,
    (
      select organization.canonical_contractor_id
      from scrc_organizations organization
      limit 1
    ) as contractor_id
), rush_candidates as (
  select profile.*
  from public.profiles profile
  cross join scrc_context context
  where lower(profile.email) = 'rayrush50@gmail.com'
    and profile.contractor_organization_id = context.organization_id
), rush_context as (
  select
    count(*) as profile_count,
    count(*) filter (
      where profile.role = 'contractor'
        and profile.active = true
        and profile.contractor_access_level = 'report_only'
        and profile.name = 'Raymond Rush'
        and profile.initials = 'RR'
        and profile.is_assignable = false
    ) as correctly_configured_count,
    min(profile.id::text)::uuid as profile_id,
    coalesce(
      jsonb_agg(jsonb_build_object(
        'id', profile.id,
        'name', profile.name,
        'email', profile.email,
        'accessLevel', profile.contractor_access_level,
        'active', profile.active
      )),
      '[]'::jsonb
    ) as profiles
  from rush_candidates profile
), rush_link_state as (
  select
    count(*) filter (
      where technician.contractor_id = context.contractor_id
        and technician.profile_id = rush.profile_id
        and technician.is_active = true
    ) as active_exact_link_count,
    count(*) filter (
      where technician.profile_id = rush.profile_id
        and technician.contractor_id
          is distinct from context.contractor_id
        and technician.is_active = true
    ) as active_other_company_link_count,
    count(*) filter (
      where technician.contractor_id = context.contractor_id
        and technician.profile_id = rush.profile_id
        and technician.is_active = true
        and technician.name = 'Raymond Rush'
    ) as canonical_name_link_count,
    coalesce(
      jsonb_agg(jsonb_build_object(
        'id', technician.id,
        'name', technician.name,
        'profileId', technician.profile_id,
        'contractorId', technician.contractor_id,
        'active', technician.is_active
      ) order by technician.is_active desc, technician.name)
        filter (where technician.id is not null),
      '[]'::jsonb
    ) as rows
  from scrc_context context
  cross join rush_context rush
  left join public.contractor_technicians technician
    on technician.profile_id = rush.profile_id
), rush_alias_state as (
  select
    count(*) filter (
      where technician.is_active = true
        and technician.profile_id is distinct from rush.profile_id
    ) as active_unlinked_or_wrong_profile_alias_count,
    coalesce(
      jsonb_agg(jsonb_build_object(
        'id', technician.id,
        'name', technician.name,
        'profileId', technician.profile_id,
        'active', technician.is_active
      ) order by technician.is_active desc, technician.name)
        filter (where technician.id is not null),
      '[]'::jsonb
    ) as alias_rows
  from scrc_context context
  cross join rush_context rush
  left join public.contractor_technicians technician
    on technician.contractor_id = context.contractor_id
   and regexp_replace(
     lower(trim(technician.name)),
     '[^a-z0-9]+',
     '',
     'g'
   ) in ('rush', 'rushraymond', 'raymondrush')
), rush_work_order_state as (
  select
    count(*) filter (
      where work_order.assigned_technician_profile_id = rush.profile_id
    ) as linked_work_order_count,
    count(*) filter (
      where regexp_replace(
        lower(trim(coalesce(work_order.technician_on_job, ''))),
        '[^a-z0-9]+',
        '',
        'g'
      ) in ('rush', 'rushraymond', 'raymondrush')
        and work_order.assigned_technician_profile_id
          is distinct from rush.profile_id
    ) as alias_without_rush_identity_count,
    count(*) filter (
      where work_order.assigned_technician_profile_id = rush.profile_id
        and work_order.technician_on_job is distinct from 'Raymond Rush'
    ) as linked_snapshot_mismatch_count,
    coalesce(
      jsonb_agg(jsonb_build_object(
        'workOrderId', work_order.id,
        'technicianOnJob', work_order.technician_on_job,
        'assignedTechnicianProfileId',
          work_order.assigned_technician_profile_id,
        'status', work_order.status
      ) order by work_order.id)
        filter (
          where work_order.assigned_technician_profile_id = rush.profile_id
        ),
      '[]'::jsonb
    ) as linked_work_orders
  from scrc_context context
  cross join rush_context rush
  left join public.work_orders work_order
    on work_order.contractor_id = context.contractor_id
   and work_order.deleted_at is null
), active_record_only_scrc_rows as (
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id', technician.id,
      'name', technician.name,
      'note', 'record only; does not grant a portal login access'
    ) order by technician.name),
    '[]'::jsonb
  ) as rows
  from public.contractor_technicians technician
  cross join scrc_context context
  where technician.contractor_id = context.contractor_id
    and technician.is_active = true
    and technician.profile_id is null
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
), checks as (
  select
    identity_guard.prosecdef
      and 'search_path=public, pg_temp' = any(identity_guard.config)
      and identity_guard.direct_untrusted_execute_blocked
      and identity_guard.body like
        '%profile.contractor_access_level in (''invoice'', ''report_only'')%'
      and identity_guard.body like
        '%contractor_account_id_for_profile(profile.id)%'
      and identity_guard.body like '%new.name := linked_profile_name%'
      and identity_trigger.present
      and coalesce(identity_trigger.covers_identity_fields, false)
      as linked_technician_identity_guard_present,
    work_order_access.prosecdef
      and 'search_path=public, pg_temp' = any(work_order_access.config)
      and work_order_access.body like '%work_order.contractor_id = case%'
      and work_order_access.body like
        '%work_order.assigned_technician_profile_id = viewer.id%'
      as contractor_company_and_assignment_wall_preserved,
    context.organization_count = 1 as exactly_one_scrc_organization,
    rush.profile_count = 1
      and rush.correctly_configured_count = 1
      as raymond_rush_profile_configured,
    link.active_exact_link_count = 1
      and link.canonical_name_link_count = 1
      and link.active_other_company_link_count = 0
      as raymond_rush_portal_link_configured,
    aliases.active_unlinked_or_wrong_profile_alias_count = 0
      as active_rush_alias_duplicates_removed,
    work_orders.alias_without_rush_identity_count = 0
      and work_orders.linked_snapshot_mismatch_count = 0
      as rush_work_orders_identity_linked,
    invalid_assignments.issue_count = 0 as current_assignments_valid,
    stale_assignment_history.issue_count = 0
      as assignment_history_consistent,
    work_orders.linked_work_order_count as raymond_rush_linked_work_order_count,
    work_orders.alias_without_rush_identity_count,
    work_orders.linked_snapshot_mismatch_count,
    invalid_assignments.issue_count as invalid_assignment_count,
    stale_assignment_history.issue_count
      as stale_assignment_history_count,
    rush.profiles as raymond_rush_profiles,
    link.rows as raymond_rush_technician_rows,
    aliases.alias_rows as raymond_rush_alias_rows,
    work_orders.linked_work_orders as raymond_rush_linked_work_orders,
    record_only.rows as active_record_only_scrc_dropdown_rows
  from identity_guard
  cross join identity_trigger
  cross join work_order_access
  cross join scrc_context context
  cross join rush_context rush
  cross join rush_link_state link
  cross join rush_alias_state aliases
  cross join rush_work_order_state work_orders
  cross join active_record_only_scrc_rows record_only
  cross join invalid_assignments
  cross join stale_assignment_history
)
select
  checks.*,
  linked_technician_identity_guard_present
    and contractor_company_and_assignment_wall_preserved
    and exactly_one_scrc_organization
    and raymond_rush_profile_configured
    and raymond_rush_portal_link_configured
    and active_rush_alias_duplicates_removed
    and rush_work_orders_identity_linked
    and current_assignments_valid
    and assignment_history_consistent
    as all_checks_pass
from checks;
