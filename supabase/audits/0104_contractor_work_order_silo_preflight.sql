-- Read-only preflight for migration 0104.
--
-- Run this before applying 0104. The first result lists every active account
-- that can participate in contractor scope and compares its effective scope
-- under 0091 with its scope after 0104. The second result identifies the exact
-- technician assignments that 0104 will clear as structurally invalid.

with account_facts as (
  select
    profile.id as profile_id,
    profile.name as profile_name,
    profile.email,
    profile.role::text as profile_role,
    profile.contractor_access_level,
    profile.active is true as profile_active,
    profile.contractor_organization_id,
    organization.name as organization_name,
    organization.active is true as organization_active,
    organization.canonical_contractor_id,
    canonical.name as canonical_contractor_name,
    coalesce(
      organization.name,
      nullif(profile.company, ''),
      profile.name
    ) as company,
    coalesce(link_stats.current_company_link_rows, 0) as current_company_link_rows,
    coalesce(link_stats.active_current_company_link_rows, 0)
      as active_current_company_link_rows,
    coalesce(link_stats.active_other_company_link_rows, 0)
      as active_other_company_link_rows,
    coalesce(work_stats.company_work_orders, 0) as company_work_orders,
    coalesce(work_stats.currently_assigned_work_orders, 0)
      as currently_assigned_work_orders,
    case
      when profile.role in ('manager', 'dispatcher', 'back_office')
        then 'P1 staff'
      when profile.role <> 'contractor' then 'non-contractor'
      when profile.contractor_organization_id is null
        then 'standalone canonical contractor'
      when organization.canonical_contractor_id = profile.id
        then 'canonical company account'
      else 'company member'
    end as account_type
  from public.profiles profile
  left join public.organizations organization
    on organization.id = profile.contractor_organization_id
  left join public.profiles canonical
    on canonical.id = organization.canonical_contractor_id
  left join lateral (
    select
      count(*) filter (
        where technician.contractor_id = coalesce(
          organization.canonical_contractor_id,
          case
            when profile.role = 'contractor'
              and profile.contractor_organization_id is null
              then profile.id
            else null
          end
        )
      ) as current_company_link_rows,
      count(*) filter (
        where technician.contractor_id = coalesce(
          organization.canonical_contractor_id,
          case
            when profile.role = 'contractor'
              and profile.contractor_organization_id is null
              then profile.id
            else null
          end
        )
          and technician.is_active = true
      ) as active_current_company_link_rows,
      count(*) filter (
        where technician.contractor_id is distinct from coalesce(
          organization.canonical_contractor_id,
          case
            when profile.role = 'contractor'
              and profile.contractor_organization_id is null
              then profile.id
            else null
          end
        )
          and technician.is_active = true
      ) as active_other_company_link_rows
    from public.contractor_technicians technician
    where technician.profile_id = profile.id
  ) link_stats on true
  left join lateral (
    select
      count(*) as company_work_orders,
      count(*) filter (
        where work_order.assigned_technician_profile_id = profile.id
      ) as currently_assigned_work_orders
    from public.work_orders work_order
    where work_order.deleted_at is null
      and work_order.contractor_id = coalesce(
        organization.canonical_contractor_id,
        case
          when profile.role = 'contractor'
            and profile.contractor_organization_id is null
            then profile.id
          else null
        end
      )
  ) work_stats on true
  where profile.active = true
    and (
      profile.role in ('manager', 'dispatcher', 'back_office', 'contractor')
      or profile.contractor_organization_id is not null
      or profile.contractor_access_level is not null
      or exists (
        select 1
        from public.contractor_technicians technician
        where technician.profile_id = profile.id
      )
      or exists (
        select 1
        from public.organizations owned_organization
        where owned_organization.canonical_contractor_id = profile.id
      )
    )
), scope_comparison as (
  select
    account_facts.*,
    case
      when profile_role in ('manager', 'dispatcher', 'back_office')
        then 'all work orders as active P1 staff'
      when profile_role <> 'contractor' then 'blocked'
      when not profile_active then 'blocked'
      when contractor_organization_id is null
        then 'full standalone contractor queue'
      when not organization_active or canonical_contractor_id is null
        then 'blocked: invalid organization'
      when contractor_access_level = 'company_admin'
        then 'full company queue'
      when contractor_access_level = 'invoice'
        and current_company_link_rows = 0
        then 'full company queue via unlinked invoice fallback'
      when contractor_access_level in ('invoice', 'report_only')
        and active_current_company_link_rows > 0
        then 'current explicit assignment only'
      else 'blocked'
    end as current_scope,
    case
      when profile_role in ('manager', 'dispatcher', 'back_office')
        then 'all work orders as active P1 staff'
      when profile_role <> 'contractor' then 'blocked'
      when not profile_active then 'blocked'
      when contractor_organization_id is null
        then 'full standalone contractor queue'
      when not organization_active or canonical_contractor_id is null
        then 'blocked: invalid organization'
      when profile_id = canonical_contractor_id
        and contractor_access_level = 'company_admin'
        then 'full company queue'
      when profile_id is distinct from canonical_contractor_id
        and active_current_company_link_rows > 0
        then 'current explicit assignment only'
      else 'blocked until role/link is repaired'
    end as post_migration_scope,
    concat_ws(
      '; ',
      case
        when profile_role in ('manager', 'dispatcher', 'back_office')
          and (
            contractor_organization_id is not null
            or contractor_access_level is not null
            or current_company_link_rows > 0
          )
          then 'remove contractor ownership/membership from this staff profile'
      end,
      case
        when profile_role = 'contractor'
          and contractor_organization_id is not null
          and (not organization_active or canonical_contractor_id is null)
          then 'repair the inactive or incomplete contractor organization'
      end,
      case
        when profile_role = 'contractor'
          and profile_id = canonical_contractor_id
          and contractor_access_level is distinct from 'company_admin'
          then 'restore company_admin on the canonical account'
      end,
      case
        when profile_role = 'contractor'
          and profile_id is distinct from canonical_contractor_id
          and contractor_access_level = 'company_admin'
          then 'change the member to invoice or report_only'
      end,
      case
        when profile_role = 'contractor'
          and profile_id is distinct from canonical_contractor_id
          and organization_active
          and canonical_contractor_id is not null
          and active_current_company_link_rows = 0
          then 'create or reactivate the technician link to the canonical company'
      end,
      case
        when active_other_company_link_rows > 0
          then 'deactivate links to other contractor accounts'
      end
    ) as required_action
  from account_facts
), impact as (
  select
    scope_comparison.*,
    current_scope is distinct from post_migration_scope as scope_changes,
    greatest(
      company_work_orders - currently_assigned_work_orders,
      0
    ) as unassigned_company_work_orders
  from scope_comparison
)
select
  company,
  canonical_contractor_name,
  profile_name,
  email,
  profile_role,
  contractor_access_level,
  account_type,
  current_company_link_rows,
  active_current_company_link_rows,
  active_other_company_link_rows,
  currently_assigned_work_orders,
  company_work_orders,
  case
    when current_scope like 'full company queue%'
      and account_type = 'company member'
      then unassigned_company_work_orders
    else 0
  end as currently_visible_unassigned_work_orders,
  current_scope,
  post_migration_scope,
  scope_changes,
  nullif(required_action, '') as required_action,
  case
    when profile_role in ('manager', 'dispatcher', 'back_office')
      then 'P1 staff roles intentionally see every work order. Confirm this is a real P1 staff account and not a contractor account with the wrong role.'
    when account_type = 'canonical company account'
      then 'Do not share this login; it intentionally remains company-wide.'
    else null
  end as safety_note,
  profile_role in ('manager', 'dispatcher', 'back_office')
    as manual_role_confirmation_required,
  count(*) over (partition by company) as company_account_count,
  count(*) filter (where scope_changes) over (partition by company)
    as company_accounts_whose_scope_changes
from impact
order by
  case when lower(company) like '%starnes%' then 0 else 1 end,
  company,
  case account_type
    when 'canonical company account' then 0
    when 'company member' then 1
    else 2
  end,
  profile_name;

-- Assignments in this result are the only data rows migration 0104 repairs.
-- It clears the current technician pointer; it does not delete the work order,
-- invoice, activity, photo, report, visit, estimate, or audit history.
select
  work_order.id as work_order_id,
  coalesce(organization.name, canonical.company, canonical.name)
    as contractor_company,
  canonical.name as canonical_contractor_name,
  assigned.id as assigned_profile_id,
  assigned.name as assigned_profile_name,
  assigned.email as assigned_profile_email,
  assigned.role::text as assigned_profile_role,
  assigned.contractor_access_level,
  assigned.active as assigned_profile_active,
  case
    when assigned.id is null then 'assigned profile no longer exists'
    when assigned.role <> 'contractor' then 'assigned profile is not a contractor'
    when assigned.active is not true then 'assigned profile is inactive'
    when assigned.contractor_access_level is null
      or assigned.contractor_access_level not in ('invoice', 'report_only')
      then 'assigned profile is not a field-member access level'
    when public.contractor_account_id_for_profile(assigned.id)
      is distinct from work_order.contractor_id
      then 'assigned profile belongs to a different contractor company'
    when not exists (
      select 1
      from public.contractor_technicians technician
      where technician.profile_id = assigned.id
        and technician.contractor_id = work_order.contractor_id
        and technician.is_active = true
    ) then 'active technician link is missing'
    else 'unknown structural mismatch'
  end as invalid_reason,
  true as assignment_will_be_cleared
from public.work_orders work_order
left join public.profiles canonical on canonical.id = work_order.contractor_id
left join public.organizations organization
  on organization.canonical_contractor_id = work_order.contractor_id
left join public.profiles assigned
  on assigned.id = work_order.assigned_technician_profile_id
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
order by contractor_company, work_order.id;
