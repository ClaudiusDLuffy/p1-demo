-- Separate a contractor member's workflow capability from their work-order
-- row scope. A linked field technician may still be invoice-capable, but can
-- only access work orders explicitly assigned to that profile. Company admins
-- and unlinked office invoice accounts retain company-wide access.

begin;

create or replace function public.is_linked_contractor_technician(
  p_profile_id uuid,
  p_contractor_id uuid default null
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.contractor_technicians technician
    where technician.profile_id = p_profile_id
      and (
        p_contractor_id is null
        or technician.contractor_id = p_contractor_id
      )
  )
$$;

revoke all on function public.is_linked_contractor_technician(uuid, uuid)
  from public, anon;
grant execute on function public.is_linked_contractor_technician(uuid, uuid)
  to authenticated, service_role;

-- Migrate only unambiguous legacy technician snapshots. Exact normalized
-- name matches preserve already-recorded assignments without guessing when
-- two linked profiles could match the same display value.
with legacy_assignment_candidates as (
  select
    work_order.id as work_order_id,
    min(technician.profile_id::text)::uuid as technician_profile_id
  from public.work_orders work_order
  join public.contractor_technicians technician
    on technician.contractor_id = work_order.contractor_id
   and technician.profile_id is not null
   and technician.is_active = true
  join public.profiles profile
    on profile.id = technician.profile_id
   and profile.role = 'contractor'
   and profile.active = true
   and profile.contractor_access_level in ('invoice', 'report_only')
  where work_order.deleted_at is null
    and work_order.assigned_technician_profile_id is null
    and nullif(trim(coalesce(work_order.technician_on_job, '')), '') is not null
    and lower(regexp_replace(trim(work_order.technician_on_job), '[[:space:]]+', ' ', 'g')) in (
      lower(regexp_replace(trim(technician.name), '[[:space:]]+', ' ', 'g')),
      lower(regexp_replace(trim(profile.name), '[[:space:]]+', ' ', 'g'))
    )
  group by work_order.id
  having count(distinct technician.profile_id) = 1
)
update public.work_orders work_order
set assigned_technician_profile_id = candidate.technician_profile_id,
    updated_at = now()
from legacy_assignment_candidates candidate
where work_order.id = candidate.work_order_id
  and work_order.assigned_technician_profile_id is null;

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
          -- Standalone canonical contractors retain their existing scope.
          viewer.contractor_organization_id is null
          -- Company administrators deliberately see the company queue.
          or viewer.contractor_access_level = 'company_admin'
          -- Invoice is a workflow capability for office accounts, not an
          -- automatic scope expansion for linked field technicians.
          or (
            viewer.contractor_access_level = 'invoice'
            and not public.is_linked_contractor_technician(
              viewer.id,
              work_order.contractor_id
            )
          )
          -- Every linked technician is assignment-scoped, including a linked
          -- technician who is also allowed to create contractor invoices.
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

-- Defense in depth for SECURITY DEFINER invoice workflows: even if a linked
-- invoice-capable technician guesses another work-order id, invoice inserts
-- and updates must pass the same assignment-scoped authorization check.
create or replace function public.enforce_contractor_invoice_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null or public.is_staff() then
    return new;
  end if;

  if new.invoice_type <> 'contractor' then
    raise exception 'Contractors cannot modify staff invoices'
      using errcode = '42501';
  end if;

  if not public.can_invoice_for_contractor(new.contractor_id)
     or not public.can_access_contractor_work_order(new.work_order_id) then
    raise exception 'You cannot invoice this work order'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.contractor_id is distinct from public.current_contractor_account_id()
       or new.created_by is distinct from actor_id then
      raise exception 'Contractor invoice ownership is invalid'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.invoice_type = 'contractor' then
    if new.contractor_id is distinct from old.contractor_id
       or new.work_order_id is distinct from old.work_order_id
       or new.invoice_type is distinct from old.invoice_type
       or new.created_by is distinct from old.created_by then
      raise exception 'Contractor invoice ownership cannot be changed'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_contractor_invoice_identity()
  from public, anon, authenticated;

drop trigger if exists enforce_contractor_invoice_identity_trigger
  on public.invoices;
create trigger enforce_contractor_invoice_identity_trigger
  before insert or update on public.invoices
  for each row execute function public.enforce_contractor_invoice_identity();

comment on function public.can_access_contractor_work_order(text) is
  'Authorizes staff, company-wide office members, or the explicitly assigned linked technician for one work order.';
comment on function public.is_linked_contractor_technician(uuid, uuid) is
  'Returns whether a contractor profile is managed as a field technician; inactive links remain linked to prevent privilege widening.';

commit;
