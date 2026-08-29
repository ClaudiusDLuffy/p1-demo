-- A contractor reassignment must also end the individual technician
-- assignment. The company-level RLS wall already follows the current
-- work_orders.contractor_id, but retaining the prior technician profile would
-- allow that old assignment to become effective again if the work order later
-- returned to the same contractor company.

begin;

-- Only the canonical contractor company account may see the full company
-- queue. Every organization member, including invoice-capable members and a
-- member whose access level was accidentally set to company_admin, must be an
-- active linked technician and must hold the current explicit assignment.
-- Unlinked organization members fail closed.
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
          -- A standalone profile is itself the canonical contractor identity.
          viewer.contractor_organization_id is null
          -- Company-wide access belongs only to the organization's canonical
          -- contractor account. A member-level role mistake cannot widen scope.
          or (
            viewer.id = organization.canonical_contractor_id
            and viewer.contractor_access_level = 'company_admin'
          )
          -- Every other organization member is current-assignment scoped.
          -- Workflow capability remains controlled separately by access level.
          or (
            viewer.id is distinct from organization.canonical_contractor_id
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
  'Authorizes active staff, a standalone canonical contractor, the canonical company administrator, or an active organization member holding the current explicit technician assignment. Unlinked members and historical participation never grant access.';

-- Apply the same canonical-account rule to company-management capabilities.
-- Invoice-capable members keep that workflow capability only while actively
-- linked to the company; work-order authorization still limits them to their
-- current assignment.
create or replace function public.can_invoice_for_contractor(
  p_contractor_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles profile
    left join public.organizations organization
      on organization.id = profile.contractor_organization_id
     and organization.active = true
    where profile.id = auth.uid()
      and profile.role = 'contractor'
      and profile.active = true
      and p_contractor_id = case
        when profile.contractor_organization_id is not null
          then organization.canonical_contractor_id
        else profile.id
      end
      and (
        (
          profile.contractor_organization_id is null
          and coalesce(profile.contractor_tier, 'direct') = 'direct'
        )
        or (
          profile.id = organization.canonical_contractor_id
          and profile.contractor_access_level = 'company_admin'
        )
        or (
          profile.id is distinct from organization.canonical_contractor_id
          and profile.contractor_access_level = 'invoice'
          and exists (
            select 1
            from public.contractor_technicians technician
            where technician.profile_id = profile.id
              and technician.contractor_id = p_contractor_id
              and technician.is_active = true
          )
        )
      )
  )
$$;

create or replace function public.can_manage_contractor_company()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles profile
    join public.organizations organization
      on organization.id = profile.contractor_organization_id
     and organization.active = true
     and organization.canonical_contractor_id = profile.id
    where profile.id = auth.uid()
      and profile.role = 'contractor'
      and profile.active = true
      and profile.contractor_access_level = 'company_admin'
  )
$$;

create or replace function public.can_read_contractor_profile(
  p_profile_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.is_staff()
    or p_profile_id = auth.uid()
    or exists (
      select 1
      from public.profiles viewer
      join public.profiles target
        on target.id = p_profile_id
       and target.contractor_organization_id = viewer.contractor_organization_id
      join public.organizations organization
        on organization.id = viewer.contractor_organization_id
       and organization.active = true
       and organization.canonical_contractor_id = viewer.id
      where viewer.id = auth.uid()
        and viewer.role = 'contractor'
        and viewer.active = true
        and target.role = 'contractor'
        and viewer.contractor_access_level = 'company_admin'
    )
    or exists (
      select 1
      from public.profiles viewer
      join public.profiles target
        on target.id = p_profile_id
       and target.dispatcher_id = viewer.id
       and target.role = 'contractor'
      where viewer.id = auth.uid()
        and viewer.role = 'contractor'
        and viewer.active = true
        and coalesce(viewer.contractor_tier, '') = 'mr_freeze'
    )
$$;

create or replace function public.can_manage_work_order_technician(
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
       and viewer.contractor_access_level = 'company_admin'
      join public.organizations organization
        on organization.id = viewer.contractor_organization_id
       and organization.active = true
       and organization.canonical_contractor_id = viewer.id
       and organization.canonical_contractor_id = work_order.contractor_id
      where work_order.id = p_work_order_id
        and work_order.deleted_at is null
    )
$$;

revoke all on function public.can_invoice_for_contractor(uuid),
  public.can_manage_contractor_company(),
  public.can_read_contractor_profile(uuid),
  public.can_manage_work_order_technician(text)
  from public, anon;
grant execute on function public.can_invoice_for_contractor(uuid),
  public.can_manage_contractor_company(),
  public.can_read_contractor_profile(uuid),
  public.can_manage_work_order_technician(text)
  to authenticated, service_role;

-- These helpers accept arbitrary profile/company ids and are needed only by
-- trusted trigger/RPC implementations. Do not expose cross-profile company
-- identity or membership resolution as directly callable authenticated RPCs.
revoke all on function public.contractor_account_id_for_profile(uuid)
  from public, anon, authenticated;
grant execute on function public.contractor_account_id_for_profile(uuid)
  to service_role;
revoke all on function public.is_linked_contractor_technician(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.is_linked_contractor_technician(uuid, uuid)
  to service_role;

-- The original company-scope invoice RPCs predate individual assignment
-- scoping. Their write path is protected by the invoice identity trigger, but
-- the idempotent submission return happened before that trigger and could
-- disclose another member's invoice when given its retry key. Keep the mature
-- implementations internal and place an assignment-aware guard in front.
alter function public.attach_contractor_invoice_pdf(uuid, text)
  rename to attach_contractor_invoice_pdf_company_scope_legacy;

revoke all on function public.attach_contractor_invoice_pdf_company_scope_legacy(
  uuid,
  text
) from public, anon, authenticated;
grant execute on function public.attach_contractor_invoice_pdf_company_scope_legacy(
  uuid,
  text
) to service_role;

create or replace function public.attach_contractor_invoice_pdf(
  p_invoice_id uuid,
  p_storage_path text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  invoice public.invoices%rowtype;
begin
  if actor_id is null then
    raise exception 'Authentication is required'
      using errcode = '42501';
  end if;

  select candidate.*
  into invoice
  from public.invoices candidate
  where candidate.id = p_invoice_id
    and candidate.invoice_type = 'contractor'
    and candidate.deleted_at is null;

  if not found then
    raise exception 'Contractor invoice was not found'
      using errcode = 'P0002';
  end if;

  if not public.is_staff()
     and (
       not public.can_invoice_for_contractor(invoice.contractor_id)
       or not public.can_access_contractor_work_order(invoice.work_order_id)
     ) then
    raise exception 'This invoice PDF is outside your current assignment'
      using errcode = '42501';
  end if;

  perform public.attach_contractor_invoice_pdf_company_scope_legacy(
    p_invoice_id,
    p_storage_path
  );
end;
$$;

revoke all on function public.attach_contractor_invoice_pdf(uuid, text)
  from public, anon;
grant execute on function public.attach_contractor_invoice_pdf(uuid, text)
  to authenticated, service_role;

alter function public.submit_contractor_invoice_once(
  uuid,
  text,
  text,
  boolean,
  text,
  text,
  date,
  date,
  date,
  text,
  numeric,
  numeric,
  jsonb
) rename to submit_contractor_invoice_once_company_scope_legacy;

revoke all on function public.submit_contractor_invoice_once_company_scope_legacy(
  uuid,
  text,
  text,
  boolean,
  text,
  text,
  date,
  date,
  date,
  text,
  numeric,
  numeric,
  jsonb
) from public, anon, authenticated;
grant execute on function public.submit_contractor_invoice_once_company_scope_legacy(
  uuid,
  text,
  text,
  boolean,
  text,
  text,
  date,
  date,
  date,
  text,
  numeric,
  numeric,
  jsonb
) to service_role;

create or replace function public.submit_contractor_invoice_once(
  p_submission_key uuid,
  p_work_order_id text,
  p_num text,
  p_user_typed_num boolean,
  p_cme text,
  p_store_address text,
  p_invoice_date date,
  p_service_date date,
  p_due_date date,
  p_terms text,
  p_sales_tax numeric,
  p_total_override numeric,
  p_lines jsonb
)
returns public.invoices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  account_id uuid := public.current_contractor_account_id();
  existing_work_order_id text;
  existing_invoice_found boolean := false;
begin
  if actor_id is null
     or account_id is null
     or not public.can_invoice_for_contractor(account_id) then
    raise exception 'Contractor invoice access is required'
      using errcode = '42501';
  end if;

  if p_submission_key is null then
    raise exception 'A submission key is required'
      using errcode = '22023';
  end if;

  select invoice.work_order_id
  into existing_work_order_id
  from public.invoices invoice
  where invoice.contractor_id = account_id
    and invoice.submission_key = p_submission_key;
  existing_invoice_found := found;

  if existing_invoice_found
     and (
       existing_work_order_id is distinct from p_work_order_id
       or not public.can_access_contractor_work_order(existing_work_order_id)
     ) then
    raise exception 'The existing submission is outside your current assignment'
      using errcode = '42501';
  end if;

  if not public.can_access_contractor_work_order(p_work_order_id) then
    raise exception 'This work order is outside your current assignment'
      using errcode = '42501';
  end if;

  return public.submit_contractor_invoice_once_company_scope_legacy(
    p_submission_key,
    p_work_order_id,
    p_num,
    p_user_typed_num,
    p_cme,
    p_store_address,
    p_invoice_date,
    p_service_date,
    p_due_date,
    p_terms,
    p_sales_tax,
    p_total_override,
    p_lines
  );
end;
$$;

revoke all on function public.submit_contractor_invoice_once(
  uuid,
  text,
  text,
  boolean,
  text,
  text,
  date,
  date,
  date,
  text,
  numeric,
  numeric,
  jsonb
) from public, anon;
grant execute on function public.submit_contractor_invoice_once(
  uuid,
  text,
  text,
  boolean,
  text,
  text,
  date,
  date,
  date,
  text,
  numeric,
  numeric,
  jsonb
) to authenticated, service_role;

-- A member may read their own technician directory row. Only the canonical
-- company administrator may enumerate the complete company directory.
drop policy if exists ct_read on public.contractor_technicians;
create policy ct_read on public.contractor_technicians
  for select using (
    public.is_staff()
    or profile_id = auth.uid()
    or exists (
      select 1
      from public.profiles viewer
      join public.organizations organization
        on organization.id = viewer.contractor_organization_id
       and organization.active = true
       and organization.canonical_contractor_id = viewer.id
       and organization.canonical_contractor_id
         = contractor_technicians.contractor_id
      where viewer.id = auth.uid()
        and viewer.role = 'contractor'
        and viewer.active = true
        and viewer.contractor_access_level = 'company_admin'
    )
  );

create or replace function public.clear_technician_on_contractor_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.contractor_id is not distinct from old.contractor_id then
    return new;
  end if;

  -- Close the structured assignment history in the same transaction. This is
  -- required here because an UPDATE OF trigger is selected from the columns in
  -- the original statement, not from columns changed by another BEFORE trigger.
  update public.work_order_technician_assignments assignment
  set ended_at = clock_timestamp(),
      ended_by = auth.uid()
  where assignment.work_order_id = old.id
    and assignment.ended_at is null;

  new.assigned_technician_profile_id := null;
  new.technician_assigned_at := null;
  new.technician_assigned_by := null;
  new.technician_on_job := null;

  return new;
end;
$$;

revoke all on function public.clear_technician_on_contractor_change()
  from public, anon, authenticated;
grant execute on function public.clear_technician_on_contractor_change()
  to service_role;

drop trigger if exists clear_technician_on_contractor_change_trigger
  on public.work_orders;
create trigger clear_technician_on_contractor_change_trigger
  before update of contractor_id
  on public.work_orders
  for each row
  when (old.contractor_id is distinct from new.contractor_id)
  execute function public.clear_technician_on_contractor_change();

-- Repair only structurally invalid current assignments. Valid assignments are
-- untouched. The existing technician-assignment triggers close their open
-- history row and clear the display snapshot for each repaired work order.
update public.work_orders work_order
set assigned_technician_profile_id = null
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
  );

comment on function public.clear_technician_on_contractor_change() is
  'Atomically ends and clears the individual technician assignment whenever a work order moves to a different contractor account.';

commit;
