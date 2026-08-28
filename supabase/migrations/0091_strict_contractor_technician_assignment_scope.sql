-- Retire the legacy participation compatibility fallback introduced in 0081.
-- A managed technician's visits, photos, and assignment history remain intact,
-- but they no longer authorize access to a work order without a current
-- structured assignment. Workflow capability (invoice versus report-only)
-- remains independent from row scope.

begin;

create or replace function public.can_access_contractor_work_order(
  p_work_order_id text
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.is_staff()
    or exists (
      select 1
      from public.work_orders work_order
      join public.profiles viewer
        on viewer.id = auth.uid()
       and viewer.role = 'contractor'
       and viewer.active = true
      left join public.organizations organization
        on organization.id = viewer.contractor_organization_id
       and organization.active = true
      where work_order.id = p_work_order_id
        and work_order.deleted_at is null
        and work_order.contractor_id = case
          when viewer.contractor_organization_id is not null
            then organization.canonical_contractor_id
          else viewer.id
        end
        and (
          -- A standalone contractor sees only work orders assigned to that
          -- canonical contractor account.
          viewer.contractor_organization_id is null
          -- Company administrators deliberately retain the company queue.
          or viewer.contractor_access_level = 'company_admin'
          -- Explicitly unlinked invoice-capable office accounts retain the
          -- company queue. A linked field technician never enters this branch.
          or (
            viewer.contractor_access_level = 'invoice'
            and not public.is_linked_contractor_technician(
              viewer.id,
              work_order.contractor_id
            )
          )
          -- Every managed field technician is strictly current-assignment
          -- scoped, including technicians who can create invoices.
          or (
            viewer.contractor_access_level in ('invoice', 'report_only')
            and work_order.assigned_technician_profile_id = viewer.id
            and exists (
              select 1
              from public.contractor_technicians technician
              where technician.profile_id = viewer.id
                and technician.contractor_id = work_order.contractor_id
                and technician.is_active = true
            )
          )
        )
    )
$$;

revoke all on function public.can_access_contractor_work_order(text)
  from public, anon;
grant execute on function public.can_access_contractor_work_order(text)
  to authenticated, service_role;

comment on function public.can_access_contractor_work_order(text) is
  'Authorizes staff, company-wide administrators or office members, standalone contractor assignments, or an active linked technician with the current explicit structured assignment; historical participation never grants row access.';

commit;
