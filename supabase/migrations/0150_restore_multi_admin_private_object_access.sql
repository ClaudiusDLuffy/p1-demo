-- Restore the multi-admin contractor-company scope in the canonical private
-- object workflow. Migration 0105 deliberately allowed every active company
-- administrator to act for the organization's canonical contractor account,
-- but 0132 accidentally limited file operations to the canonical profile.
-- This is a forward-only routine correction; it does not rewrite object or
-- business data.

begin;

create or replace function public.private_object_actor_access(
  p_actor uuid,
  p_work_order text,
  p_invoice_capable boolean default false
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles profile
    join public.work_orders work_order
      on work_order.id = p_work_order
    left join public.organizations organization
      on organization.id = profile.contractor_organization_id
     and organization.active = true
    left join public.profiles canonical_profile
      on canonical_profile.id = organization.canonical_contractor_id
     and canonical_profile.role = 'contractor'
     and canonical_profile.active
     and canonical_profile.contractor_organization_id = organization.id
    where profile.id = p_actor
      and profile.active
      and work_order.deleted_at is null
      and (
        (
          profile.role in ('manager', 'dispatcher', 'back_office')
          and (
            not p_invoice_capable
            or not public.profile_has_staff_permission(
              profile.id,
              'invoice_controller'
            )
          )
        )
        or (
          profile.role = 'contractor'
          and work_order.contractor_id = case
            when profile.contractor_organization_id is null then profile.id
            else canonical_profile.id
          end
          and (
            profile.contractor_organization_id is null
            -- 0105 permits multiple administrators in one organization. The
            -- canonical profile is the account identity, not the only admin.
            or profile.contractor_access_level = 'company_admin'
            or (
              profile.id is distinct from canonical_profile.id
              and work_order.assigned_technician_profile_id = profile.id
              and exists (
                select 1
                from public.contractor_technicians technician
                where technician.profile_id = profile.id
                  and technician.contractor_id = work_order.contractor_id
                  and technician.is_active
              )
            )
          )
          and (
            not p_invoice_capable
            or (
              profile.contractor_organization_id is null
              and coalesce(profile.contractor_tier, 'direct') = 'direct'
            )
            or profile.contractor_access_level = 'company_admin'
            or (
              profile.id is distinct from canonical_profile.id
              and profile.contractor_access_level = 'invoice'
              and exists (
                select 1
                from public.contractor_technicians technician
                where technician.profile_id = profile.id
                  and technician.contractor_id = work_order.contractor_id
                  and technician.is_active
              )
            )
          )
        )
      )
  );
$$;

revoke all on function public.private_object_actor_access(uuid, text, boolean)
  from public, anon;
grant execute on function public.private_object_actor_access(uuid, text, boolean)
  to authenticated, service_role;

comment on function public.private_object_actor_access(uuid, text, boolean) is
  'Authorizes private file workflows for active staff and the current contractor company scope, including every valid company administrator; invoice-capable operations retain their additional role checks.';

commit;
