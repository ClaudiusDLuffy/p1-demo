-- Formalize the existing Mr Freeze dispatcher relationship as a company-scoped
-- operational team. A lead may view and assign only their own technicians and
-- may perform field lifecycle actions on their behalf. Invoice authority stays
-- unchanged. Visit rows preserve both the acting account and actual technician.

begin;

alter table public.work_order_visits
  add column if not exists technician_profile_id uuid
    references public.profiles(id) on delete set null;

create index if not exists work_order_visits_technician_time
  on public.work_order_visits(technician_profile_id, check_in_at, check_out_at)
  where technician_profile_id is not null;

create or replace function public.is_contractor_team_lead(p_profile_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles lead
    join public.organizations organization
      on organization.id = lead.contractor_organization_id
     and organization.active = true
     and organization.canonical_contractor_id is not null
    join public.profiles canonical
      on canonical.id = organization.canonical_contractor_id
     and canonical.role = 'contractor'
     and canonical.active = true
     and canonical.contractor_organization_id = organization.id
    join public.contractor_technicians membership
      on membership.profile_id = lead.id
     and membership.contractor_id = canonical.id
     and membership.is_active = true
    where lead.id = p_profile_id
      and lead.role = 'contractor'
      and lead.active = true
      and lead.contractor_tier = 'mr_freeze'
      and lead.contractor_access_level = 'report_only'
  )
$$;

create or replace function public.can_lead_contractor_team()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and public.is_contractor_team_lead(auth.uid())
$$;

-- This helper always evaluates the current authenticated lead. It cannot be
-- used to ask about another lead's team.
create or replace function public.contractor_team_lead_can_manage_profile(
  p_profile_id uuid,
  p_contractor_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.can_lead_contractor_team()
    and exists (
      select 1
      from public.profiles lead
      join public.organizations organization
        on organization.id = lead.contractor_organization_id
       and organization.active = true
       and organization.canonical_contractor_id = p_contractor_id
      join public.profiles target
        on target.id = p_profile_id
       and target.role = 'contractor'
       and target.active = true
       and target.contractor_organization_id = organization.id
       and (target.id = lead.id or target.dispatcher_id = lead.id)
      join public.contractor_technicians membership
        on membership.profile_id = target.id
       and membership.contractor_id = p_contractor_id
       and membership.is_active = true
      where lead.id = auth.uid()
    )
$$;

revoke all on function public.is_contractor_team_lead(uuid),
  public.contractor_team_lead_can_manage_profile(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.can_lead_contractor_team()
  from public, anon;
grant execute on function public.can_lead_contractor_team()
  to authenticated, service_role;

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
       and organization.canonical_contractor_id is not null
      left join public.profiles canonical
        on canonical.id = organization.canonical_contractor_id
       and canonical.role = 'contractor'
       and canonical.active = true
       and canonical.contractor_organization_id = organization.id
      where work_order.id = p_work_order_id
        and work_order.deleted_at is null
        and work_order.contractor_id = case
          when viewer.contractor_organization_id is not null then canonical.id
          else viewer.id
        end
        and (
          viewer.contractor_organization_id is null
          or viewer.contractor_access_level = 'company_admin'
          or (
            viewer.contractor_access_level in ('invoice', 'report_only')
            and work_order.assigned_technician_profile_id = viewer.id
            and exists (
              select 1 from public.contractor_technicians technician
              where technician.profile_id = viewer.id
                and technician.contractor_id = organization.canonical_contractor_id
                and technician.contractor_id = work_order.contractor_id
                and technician.is_active = true
            )
          )
          or (
            work_order.assigned_technician_profile_id is not null
            and public.contractor_team_lead_can_manage_profile(
              work_order.assigned_technician_profile_id,
              work_order.contractor_id
            )
          )
        )
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
      join public.organizations organization
        on organization.id = viewer.contractor_organization_id
       and organization.active = true
       and organization.canonical_contractor_id = work_order.contractor_id
      join public.profiles canonical
        on canonical.id = organization.canonical_contractor_id
       and canonical.role = 'contractor'
       and canonical.active = true
       and canonical.contractor_organization_id = organization.id
      where work_order.id = p_work_order_id
        and work_order.deleted_at is null
        and (
          viewer.contractor_access_level = 'company_admin'
          or (
            work_order.assigned_technician_profile_id is not null
            and public.contractor_team_lead_can_manage_profile(
              work_order.assigned_technician_profile_id,
              work_order.contractor_id
            )
          )
        )
    )
$$;

create or replace function public.can_read_contractor_profile(p_profile_id uuid)
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
       and target.role = 'contractor'
       and target.contractor_organization_id = viewer.contractor_organization_id
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
        and viewer.active = true
        and viewer.contractor_access_level = 'company_admin'
    )
    or public.contractor_team_lead_can_manage_profile(
      p_profile_id,
      public.current_contractor_account_id()
    )
$$;

create or replace function public.get_my_contractor_scope()
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'contractorAccountId', public.current_contractor_account_id(),
    'organizationId', profile.contractor_organization_id,
    'organizationName', organization.name,
    'accessLevel', coalesce(
      profile.contractor_access_level,
      case
        when profile.role = 'contractor' and coalesce(profile.contractor_tier, 'direct') = 'direct' then 'invoice'
        when profile.role = 'contractor' then 'report_only'
        else null
      end
    ),
    'canInvoice', public.can_invoice_for_contractor(public.current_contractor_account_id()),
    'canManageTeam', public.can_manage_contractor_company(),
    'canLeadTeam', public.can_lead_contractor_team()
  )
  from public.profiles profile
  left join public.organizations organization
    on organization.id = profile.contractor_organization_id
   and organization.active = true
  where profile.id = auth.uid()
$$;

revoke all on function public.can_access_contractor_work_order(text),
  public.can_manage_work_order_technician(text),
  public.can_read_contractor_profile(uuid),
  public.get_my_contractor_scope()
  from public, anon;
grant execute on function public.can_access_contractor_work_order(text),
  public.can_manage_work_order_technician(text),
  public.can_read_contractor_profile(uuid),
  public.get_my_contractor_scope()
  to authenticated, service_role;

-- The existing bounded legacy_team directory becomes the supported team-lead
-- directory. It contains only the lead and active direct reports inside the
-- same canonical contractor company.
create or replace function public.directory_scope_v1(p_domain text, p_contractor_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  actor record;
  staff boolean;
  operational boolean;
  grants jsonb;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or auth.uid() is null then
    raise exception 'Active authentication required' using errcode = '42501';
  end if;
  select p.id, p.role, p.contractor_organization_id, p.contractor_access_level, p.contractor_tier
    into actor from public.profiles p where p.id = auth.uid() and p.active = true;
  if not found then
    raise exception 'Active authentication required' using errcode = '42501';
  end if;
  staff := public.is_staff();
  operational := staff and not public.is_invoice_controller();
  if p_domain in ('assignable_contractors', 'staff_choices', 'contractor_directory', 'contacts') then
    if not operational then raise exception 'Operational staff access required' using errcode = '42501'; end if;
  elsif p_domain = 'contractor_filter' then
    if not staff then raise exception 'Staff access required' using errcode = '42501'; end if;
  elsif p_domain in ('company_technicians', 'technician_profile', 'technician_management', 'technician_detail') then
    if p_contractor_id is null then raise exception 'A company is required' using errcode = '22023'; end if;
    if p_domain in ('technician_management', 'technician_detail') then
      if not operational then raise exception 'Operational staff access required' using errcode = '42501'; end if;
    elsif not operational and not (
      actor.role = 'contractor'
      and public.can_manage_contractor_company()
      and public.current_contractor_account_id() = p_contractor_id
    ) then
      if p_domain <> 'technician_profile' or actor.role <> 'contractor'
        or public.current_contractor_account_id() is distinct from p_contractor_id then
        raise exception 'Company access required' using errcode = '42501';
      end if;
    end if;
  elsif p_domain = 'legacy_team' then
    if actor.role <> 'contractor' or not public.can_lead_contractor_team() then
      raise exception 'Team lead access required' using errcode = '42501';
    end if;
  elsif p_domain not in ('profile_labels', 'contact_detail') or p_domain is null then
    raise exception 'Unknown directory domain' using errcode = '22023';
  end if;
  if p_domain not in ('company_technicians', 'technician_profile', 'technician_management', 'technician_detail')
    and p_contractor_id is not null then
    raise exception 'Unexpected company scope' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(g.permission order by g.permission), '[]'::jsonb)
    into grants from public.staff_permission_grants g where g.profile_id = actor.id;
  return md5(jsonb_build_array(actor.id, actor.role, actor.contractor_organization_id,
    actor.contractor_access_level, actor.contractor_tier,
    public.current_contractor_account_id(), public.can_lead_contractor_team(), grants,
    p_domain, p_contractor_id)::text);
end
$$;

create or replace function public.directory_candidates_v1(
  p_domain text, p_contractor_id uuid, p_query text, p_id uuid default null,
  p_limit integer default 51, p_last_name text default null, p_last_id uuid default null,
  p_snapshot_at timestamptz default now()
)
returns table(id uuid, sort_name text, created_at timestamptz)
language sql stable
set search_path = pg_catalog, public
as $$
  with candidates as not materialized (
  select p.id, public.directory_sort_key_v1(p.name) as sort_name, p.created_at
  from public.profiles p
  where (p_id is null or p.id = p_id)
    and case p_domain
      when 'assignable_contractors' then p.role = 'contractor' and p.active = true
        and p.is_assignable = true and public.contractor_account_id_for_profile(p.id) = p.id
      when 'contractor_directory' then p.role = 'contractor' and p.is_assignable = true
      when 'contractor_filter' then p.role = 'contractor'
      when 'staff_choices' then p.active = true and p.role in ('manager', 'dispatcher', 'back_office')
      when 'contacts' then p.active = true and p.role in ('manager', 'dispatcher', 'back_office', 'contractor')
      when 'legacy_team' then p.role = 'contractor' and p.active = true
        and public.contractor_team_lead_can_manage_profile(
          p.id,
          public.current_contractor_account_id()
        )
      else false end
    and (p_query = '' or strpos(public.directory_normalize_v1(p.name), p_query) > 0
      or (p_domain in ('assignable_contractors', 'contractor_directory', 'contacts')
        and strpos(public.directory_normalize_v1(p.company), p_query) > 0)
      or (p_domain in ('assignable_contractors', 'contractor_directory') and (
        strpos(public.directory_normalize_v1(p.territory), p_query) > 0
        or exists (select 1 from unnest(p.trades) trade where strpos(public.directory_normalize_v1(trade), p_query) > 0)))
      or (p_domain = 'contacts' and (
        strpos(public.directory_normalize_v1(p.title), p_query) > 0
        or strpos(public.directory_normalize_v1(p.email), p_query) > 0
        or strpos(public.directory_normalize_v1(p.phone), p_query) > 0)))
  union all
  select t.id, public.directory_sort_key_v1(coalesce(p.name, t.name)), t.created_at
  from public.contractor_technicians t
  left join public.profiles owner on owner.id = t.contractor_id
  left join public.profiles p on p.id = t.profile_id and p.role = 'contractor'
    and (p.id = t.contractor_id or (owner.contractor_organization_id is not null
      and p.contractor_organization_id = owner.contractor_organization_id))
  where p_domain in ('company_technicians', 'technician_management')
    and t.contractor_id = p_contractor_id and (p_id is null or t.id = p_id)
    and (p_domain = 'technician_management' or (t.is_active = true and (
      t.profile_id is null or (p.active = true
        and p.contractor_access_level in ('invoice', 'report_only')
        and public.contractor_account_id_for_profile(p.id) = t.contractor_id))))
    and (p_query = '' or strpos(public.directory_normalize_v1(coalesce(p.name, t.name)), p_query) > 0)
  ), positioned as (
    select c.* from candidates c where p_last_id is null
      and (c.created_at is null or c.created_at <= p_snapshot_at)
    union all
    select c.* from candidates c where p_last_id is not null
      and (c.created_at is null or c.created_at <= p_snapshot_at)
      and (c.sort_name collate "C", c.id) > (p_last_name collate "C", p_last_id)
  )
  select c.* from positioned c order by c.sort_name collate "C", c.id
    limit least(greatest(p_limit, 1), 51)
$$;

revoke all on function public.directory_scope_v1(text, uuid),
  public.directory_candidates_v1(text, uuid, text, uuid, integer, text, uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.protect_work_order_technician_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_role text := coalesce(auth.role(), '');
  actor_is_staff boolean := public.is_staff();
  actor_is_company_admin boolean := public.can_manage_contractor_company();
  actor_is_team_lead boolean := public.can_lead_contractor_team();
  technician_name text;
  assignment_changed boolean := new.assigned_technician_profile_id is distinct from old.assigned_technician_profile_id;
  snapshot_changed boolean := new.technician_on_job is distinct from old.technician_on_job;
begin
  if not assignment_changed and not snapshot_changed then return new; end if;

  if actor_role not in ('service_role', '') then
    if assignment_changed and not public.can_manage_work_order_technician(old.id) then
      raise exception 'Only P1 staff, a company administrator, or the assigned team lead can assign a portal technician'
        using errcode = '42501';
    end if;
    if not assignment_changed and new.assigned_technician_profile_id is not null
       and not public.can_manage_work_order_technician(old.id) then
      raise exception 'Only P1 staff, a company administrator, or the assigned team lead can change the assigned technician'
        using errcode = '42501';
    end if;
    if not assignment_changed and new.assigned_technician_profile_id is null
       and not public.can_access_contractor_work_order(old.id) then
      raise exception 'Technician snapshot update is not permitted' using errcode = '42501';
    end if;
    if actor_is_team_lead and not actor_is_staff and not actor_is_company_admin
       and (
         new.assigned_technician_profile_id is null
         or not public.contractor_team_lead_can_manage_profile(
           new.assigned_technician_profile_id,
           old.contractor_id
         )
       ) then
      raise exception 'A team lead may assign only an active member of their own team'
        using errcode = '42501';
    end if;
  end if;

  if new.assigned_technician_profile_id is null then
    if assignment_changed then
      new.technician_on_job := null;
      new.technician_assigned_at := null;
      new.technician_assigned_by := null;
    end if;
    return new;
  end if;

  select profile.name into technician_name
  from public.profiles profile
  join public.contractor_technicians technician
    on technician.profile_id = profile.id
   and technician.contractor_id = new.contractor_id
   and technician.is_active = true
  where profile.id = new.assigned_technician_profile_id
    and profile.role = 'contractor'
    and profile.active = true
    and profile.contractor_access_level in ('invoice', 'report_only')
    and public.contractor_account_id_for_profile(profile.id) = new.contractor_id;

  if technician_name is null then
    raise exception 'Selected technician is not an active member of the assigned contractor company'
      using errcode = '23514';
  end if;
  new.technician_on_job := technician_name;
  if assignment_changed then
    new.technician_assigned_at := now();
    new.technician_assigned_by := auth.uid();
  end if;
  return new;
end
$$;

create or replace function public.assign_contractor_technician(
  p_work_order_id text,
  p_technician_profile_id uuid
)
returns public.work_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_name text;
  actor_is_staff boolean;
  actor_is_company_admin boolean;
  actor_is_team_lead boolean;
  work_order public.work_orders%rowtype;
  technician_name text;
begin
  if actor_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select public.is_staff(), public.can_manage_contractor_company(), public.can_lead_contractor_team()
  into actor_is_staff, actor_is_company_admin, actor_is_team_lead;

  select * into work_order
  from public.work_orders
  where id = p_work_order_id and deleted_at is null
  for update;
  if not found then raise exception 'Work order not found' using errcode = 'P0002'; end if;

  if not public.can_manage_work_order_technician(p_work_order_id) then
    raise exception 'Only P1 staff, a company administrator, or the assigned team lead can assign technicians'
      using errcode = '42501';
  end if;

  if actor_is_team_lead and not actor_is_staff and not actor_is_company_admin
     and (
       p_technician_profile_id is null
       or not public.contractor_team_lead_can_manage_profile(
         p_technician_profile_id,
         work_order.contractor_id
       )
     ) then
    raise exception 'A team lead may assign only an active member of their own team'
      using errcode = '42501';
  end if;

  if p_technician_profile_id is not null then
    select profile.name into technician_name
    from public.profiles profile
    join public.contractor_technicians technician
      on technician.profile_id = profile.id
     and technician.contractor_id = work_order.contractor_id
     and technician.is_active = true
    where profile.id = p_technician_profile_id
      and profile.role = 'contractor'
      and profile.active = true
      and profile.contractor_access_level in ('invoice', 'report_only')
      and public.contractor_account_id_for_profile(profile.id) = work_order.contractor_id;
    if technician_name is null then
      raise exception 'Technician is not an active member of this contractor company'
        using errcode = '22023';
    end if;
  end if;

  update public.work_orders
  set assigned_technician_profile_id = p_technician_profile_id,
      updated_at = now()
  where id = p_work_order_id
  returning * into work_order;

  select name into actor_name from public.profiles where id = actor_id;
  insert into public.activities (
    work_order_id, author_id, author_name, text, type, event_key, event_data
  ) values (
    p_work_order_id,
    actor_id,
    coalesce(actor_name, 'Portal user'),
    case
      when p_technician_profile_id is null then 'Technician assignment cleared.'
      else format('Technician on job set to %s.', technician_name)
    end,
    'note',
    'technician_updated',
    jsonb_build_object(
      'technicianProfileId', p_technician_profile_id,
      'technician', technician_name,
      'actedByProfileId', actor_id,
      'assignedByTeamLead', actor_is_team_lead and not actor_is_staff and not actor_is_company_admin
    )
  );
  return work_order;
end
$$;

revoke all on function public.assign_contractor_technician(text, uuid)
  from public, anon;
grant execute on function public.assign_contractor_technician(text, uuid)
  to authenticated, service_role;

create or replace function public.protect_work_order_visit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := coalesce(auth.role(), '');
  actor_is_staff boolean := public.is_staff();
  actor_account_id uuid := public.current_contractor_account_id();
  assigned_contractor_id uuid;
  assigned_technician_id uuid;
  work_order_is_active boolean;
  correction_authorized boolean;
  visit_technician_id uuid;
begin
  select work_order.contractor_id, work_order.assigned_technician_profile_id,
    work_order.deleted_at is null
  into assigned_contractor_id, assigned_technician_id, work_order_is_active
  from public.work_orders work_order
  where work_order.id = new.work_order_id;
  if not found then raise exception 'Visit must reference an existing work order'; end if;

  if new.check_in_activity_id is not null and not exists (
    select 1 from public.activities activity
    where activity.id = new.check_in_activity_id and activity.work_order_id = new.work_order_id
  ) then raise exception 'Check-in activity must belong to the same work order'; end if;
  if new.check_out_activity_id is not null and not exists (
    select 1 from public.activities activity
    where activity.id = new.check_out_activity_id and activity.work_order_id = new.work_order_id
  ) then raise exception 'Check-out activity must belong to the same work order'; end if;

  if tg_op = 'INSERT' then
    if not work_order_is_active then raise exception 'Cannot open a visit on an archived work order'; end if;
    if assigned_contractor_id is null or new.contractor_id <> assigned_contractor_id then
      raise exception 'Visit contractor must match the assigned contractor';
    end if;
    if actor_role not in ('service_role', '') then
      new.checked_in_by := actor_id;
      if actor_is_staff and new.check_out_at is not null then new.checked_out_by := actor_id; end if;
    else
      new.checked_in_by := coalesce(new.checked_in_by, actor_id);
    end if;
    if new.checked_in_by is null then raise exception 'A check-in actor is required'; end if;

    new.technician_profile_id := coalesce(
      new.technician_profile_id,
      assigned_technician_id,
      case when not actor_is_staff then actor_id else null end
    );
    if assigned_technician_id is not null
       and new.technician_profile_id is distinct from assigned_technician_id then
      raise exception 'Visit technician must match the assigned technician' using errcode = '42501';
    end if;

    if actor_role not in ('service_role', '') and not actor_is_staff then
      if actor_id is null or actor_account_id is null
         or actor_account_id <> assigned_contractor_id
         or new.contractor_id <> actor_account_id
         or new.checked_in_by <> actor_id
         or not public.can_access_contractor_work_order(new.work_order_id) then
        raise exception 'Only an authorized member of the assigned contractor can check in'
          using errcode = '42501';
      end if;
      if new.check_out_at is not null or new.checked_out_by is not null
         or new.check_out_activity_id is not null then
        raise exception 'Contractor check-in must create an open visit' using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  -- Migration-owner maintenance may backfill only the newly introduced visit
  -- subject. Authenticated and service callers never receive this path.
  if actor_role = ''
     and new.technician_profile_id is distinct from old.technician_profile_id
     and (to_jsonb(new) - 'technician_profile_id')
       is not distinct from (to_jsonb(old) - 'technician_profile_id') then
    return new;
  end if;

  select exists (
    select 1 from public.work_order_visit_correction_context correction_context
    where correction_context.transaction_id = txid_current()
      and correction_context.visit_id = old.id
  ) into correction_authorized;
  if correction_authorized then
    if new.work_order_id is distinct from old.work_order_id
       or new.contractor_id is distinct from old.contractor_id
       or new.technician_profile_id is distinct from old.technician_profile_id
       or new.checked_in_by is distinct from old.checked_in_by
       or new.checked_out_by is distinct from old.checked_out_by
       or new.check_in_activity_id is distinct from old.check_in_activity_id
       or new.check_out_activity_id is distinct from old.check_out_activity_id
       or new.created_at is distinct from old.created_at then
      raise exception 'Visit correction may only change actual start and stop times';
    end if;
    return new;
  end if;

  if new.work_order_id is distinct from old.work_order_id
     or new.contractor_id is distinct from old.contractor_id
     or new.technician_profile_id is distinct from old.technician_profile_id
     or new.check_in_at is distinct from old.check_in_at
     or new.checked_in_by is distinct from old.checked_in_by
     or new.check_in_activity_id is distinct from old.check_in_activity_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Visit check-in identity and timestamps are immutable';
  end if;

  if actor_role not in ('service_role', '') and actor_is_staff then
    if new.check_out_at is null then new.checked_out_by := null;
    elsif old.check_out_at is null then new.checked_out_by := actor_id;
    else new.checked_out_by := old.checked_out_by;
    end if;
  end if;

  if actor_role not in ('service_role', '') and not actor_is_staff then
    visit_technician_id := coalesce(old.technician_profile_id, old.checked_in_by);
    if not work_order_is_active or actor_id is null or actor_account_id is null
       or actor_account_id <> assigned_contractor_id
       or old.contractor_id <> actor_account_id
       or not public.can_access_contractor_work_order(old.work_order_id)
       or not (
         old.checked_in_by = actor_id
         or visit_technician_id = actor_id
         or public.can_manage_contractor_company()
         or public.contractor_team_lead_can_manage_profile(visit_technician_id, old.contractor_id)
       ) then
      raise exception 'Only the visit technician, acting lead, or company admin can close this visit'
        using errcode = '42501';
    end if;
    if old.check_out_at is not null then
      raise exception 'A contractor cannot change a closed visit' using errcode = '42501';
    end if;
    if new.check_out_at is null then
      raise exception 'Contractor visit updates must close the visit' using errcode = '42501';
    end if;
    new.checked_out_by := actor_id;
  end if;
  return new;
end
$$;

create or replace function public.insert_work_order_lifecycle_activity(
  p_work_order_id text,
  p_operation_id uuid,
  p_text text,
  p_event_data jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_event text;
  v_activity uuid;
  v_version bigint;
  v_technician_id uuid;
  v_technician_name text;
begin
  v_actor := public.require_work_order_lifecycle_actor(p_work_order_id);
  select guard.event_key into strict v_event
  from public.work_order_lifecycle_transition_guards guard
  where guard.transaction_id = txid_current()
    and guard.work_order_id = p_work_order_id
    and guard.operation_id = p_operation_id
    and guard.actor_id = v_actor.id;

  select work_order.lifecycle_version,
    work_order.assigned_technician_profile_id,
    technician.name
  into strict v_version, v_technician_id, v_technician_name
  from public.work_orders work_order
  left join public.profiles technician
    on technician.id = work_order.assigned_technician_profile_id
  where work_order.id = p_work_order_id;

  insert into public.activities(
    work_order_id, author_id, author_name, text, type, is_staff_override,
    event_key, event_data, lifecycle_operation_id, lifecycle_version
  ) values (
    p_work_order_id,
    v_actor.id,
    v_actor.name,
    p_text,
    case when v_event = 'eta_updated' then 'system' else 'note' end,
    v_actor.role in ('manager', 'dispatcher', 'back_office'),
    v_event,
    p_event_data || jsonb_strip_nulls(jsonb_build_object(
      'operationId', p_operation_id,
      'lifecycleVersion', v_version,
      'actedByProfileId', v_actor.id,
      'technicianProfileId', v_technician_id,
      'technician', v_technician_name,
      'onBehalfOfTechnician',
        v_actor.role = 'contractor'
        and v_technician_id is not null
        and v_technician_id <> v_actor.id
    )),
    p_operation_id,
    v_version
  ) returning id into v_activity;
  return v_activity;
end
$$;

create or replace function public.begin_work_order_visit_command(
  p_work_order_id text,
  p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,
  p_operation_id uuid,
  p_check_in_at timestamptz,
  p_notes text,
  p_resume boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_replay jsonb;
  v_work public.work_orders%rowtype;
  v_activity uuid;
  v_visit uuid;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_receiving boolean;
  v_regular_start boolean;
  v_regular_resume boolean;
  v_next_status public.wo_status;
begin
  if p_check_in_at is null or not isfinite(p_check_in_at) or length(coalesce(v_notes, '')) > 10000 then
    raise exception 'A valid check-in time and notes are required' using errcode = '22023';
  end if;
  v_replay := public.begin_work_order_lifecycle_command(
    p_work_order_id, p_expected_assignment_version, p_expected_workflow_cycle,
    p_expected_lifecycle_version, p_operation_id,
    case when p_resume then 'resume' else 'start' end,
    jsonb_build_object('checkedInAt', p_check_in_at, 'notes', v_notes)
  );
  if v_replay is not null then return v_replay; end if;

  select * into strict v_work from public.work_orders work_order where work_order.id = p_work_order_id;
  v_receiving := v_work.assignment_transfer_pending_visit
    and v_work.assignment_transfer_operation_id is not null
    and v_work.status = 'wip' and v_work.functional_status = 'Work in Progress';
  v_regular_start := not p_resume and v_work.status = 'assigned'
    and v_work.functional_status::text in ('New', 'Dispatched');
  v_regular_resume := p_resume
    and v_work.status::text in ('parts', 'pending_invoice', 'pending_approval', 'pending_payment')
    and v_work.functional_status = 'Awaiting Parts';
  if v_work.contractor_id is null or not (v_receiving or v_regular_start or v_regular_resume) then
    raise exception 'Work order cannot start or resume from its current state' using errcode = 'PT409';
  end if;
  if exists (
      select 1 from public.work_order_visits visit
      where visit.work_order_id = p_work_order_id and visit.check_out_at is null
    ) or exists (
      select 1 from public.work_order_visits visit
      where visit.work_order_id = p_work_order_id
        and visit.created_at >= v_work.contractor_assignment_started_at
        and visit.check_out_at > p_check_in_at
    ) or (v_receiving and p_check_in_at < v_work.contractor_assignment_started_at) then
    raise exception 'The requested visit overlaps existing work' using errcode = 'PT409';
  end if;

  v_next_status := case
    when v_regular_resume and v_work.status::text in ('pending_invoice', 'pending_approval', 'pending_payment')
      then v_work.status
    else 'wip'::public.wo_status
  end;
  update public.work_orders
  set status = v_next_status,
      functional_status = 'Work in Progress',
      start_time = coalesce(start_time, p_check_in_at),
      assignment_transfer_pending_visit = false
  where id = p_work_order_id;

  v_activity := public.insert_work_order_lifecycle_activity(
    p_work_order_id,
    p_operation_id,
    'Checked in and started work at ' || p_check_in_at::text || '.'
      || case when v_notes is null then '' else ' Notes: ' || v_notes end,
    jsonb_build_object(
      'checkedInAt', p_check_in_at,
      'notes', v_notes,
      'preservedWorkOrderStatus', v_next_status
    )
  );
  insert into public.work_order_visits(
    work_order_id, contractor_id, technician_profile_id,
    check_in_at, checked_in_by, check_in_activity_id
  ) values (
    p_work_order_id, v_work.contractor_id,
    coalesce(v_work.assigned_technician_profile_id, auth.uid()),
    p_check_in_at, auth.uid(), v_activity
  ) returning id into v_visit;
  return public.finish_work_order_lifecycle_command(
    p_work_order_id, p_operation_id, v_activity, v_visit
  );
end
$$;

comment on function public.begin_work_order_visit_command(text, integer, integer, bigint, uuid, timestamptz, text, boolean) is
  'Private lifecycle owner for initial, resumed, and transfer visits. The acting account and assigned technician are recorded separately for team-lead proxy work.';

revoke all on function public.insert_work_order_lifecycle_activity(text, uuid, text, jsonb),
  public.begin_work_order_visit_command(text, integer, integer, bigint, uuid, timestamptz, text, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.correct_work_order_visit_lc_core(
  p_visit_id uuid,
  p_check_in_at timestamptz,
  p_check_out_at timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles%rowtype;
  visit public.work_order_visits%rowtype;
  work_order public.work_orders%rowtype;
  corrected public.work_order_visits%rowtype;
  correction_id uuid;
  actor_is_staff boolean;
  visit_technician_id uuid;
  clean_reason text := trim(coalesce(p_reason, ''));
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select profile.* into actor from public.profiles profile
  where profile.id = auth.uid() and profile.active is not false;
  if not found then raise exception 'An active portal profile is required' using errcode = '42501'; end if;

  select candidate.* into visit from public.work_order_visits candidate
  where candidate.id = p_visit_id for update;
  if not found then raise exception 'Visit not found'; end if;
  select candidate.* into work_order from public.work_orders candidate
  where candidate.id = visit.work_order_id;
  if not found or work_order.deleted_at is not null then raise exception 'Work order is unavailable'; end if;

  actor_is_staff := public.is_staff();
  visit_technician_id := coalesce(visit.technician_profile_id, visit.checked_in_by);
  if visit.check_out_at is null then raise exception 'Close the visit before correcting its actual times'; end if;
  if length(clean_reason) < 5 then raise exception 'A correction reason of at least 5 characters is required'; end if;
  if p_check_in_at is null or p_check_out_at is null then raise exception 'Both actual start and stop times are required'; end if;
  if p_check_out_at < p_check_in_at then raise exception 'Actual stop time cannot be before actual start time'; end if;
  if p_check_out_at > now() + interval '5 minutes' or p_check_in_at > now() + interval '5 minutes' then
    raise exception 'Visit times cannot be in the future';
  end if;
  if p_check_out_at - p_check_in_at > interval '72 hours' then
    raise exception 'A single visit cannot exceed 72 hours';
  end if;
  if p_check_in_at is not distinct from visit.check_in_at
     and p_check_out_at is not distinct from visit.check_out_at then
    raise exception 'The corrected times are unchanged';
  end if;

  if not actor_is_staff then
    if work_order.status::text = 'closed'
       or not public.can_access_contractor_work_order(visit.work_order_id)
       or not (
         visit.checked_in_by = actor.id
         or visit_technician_id = actor.id
         or public.can_manage_contractor_company()
         or public.contractor_team_lead_can_manage_profile(
           visit_technician_id,
           visit.contractor_id
         )
       ) then
      raise exception 'You cannot correct this visit' using errcode = '42501';
    end if;
  end if;

  if exists (
    select 1 from public.invoices invoice
    where invoice.work_order_id = visit.work_order_id
      and invoice.invoice_type = 'staff'
      and invoice.document_kind::text <> 'capital_quote'
      and invoice.deleted_at is null
      and invoice.state::text in ('approved', 'paid')
  ) then raise exception 'Visit time is locked after the P1 invoice is approved'; end if;

  if exists (
    select 1 from public.work_order_visits other
    where other.id <> visit.id
      and coalesce(other.technician_profile_id, other.checked_in_by) = visit_technician_id
      and tstzrange(other.check_in_at, coalesce(other.check_out_at, now()), '[)')
        && tstzrange(p_check_in_at, p_check_out_at, '[)')
  ) then raise exception 'The corrected time overlaps another visit for this technician'; end if;

  insert into public.work_order_visit_correction_context(transaction_id, visit_id)
  values (txid_current(), visit.id);
  update public.work_order_visits
  set check_in_at = p_check_in_at,
      check_out_at = p_check_out_at,
      updated_at = now()
  where id = visit.id
  returning * into corrected;
  delete from public.work_order_visit_correction_context
  where transaction_id = txid_current() and visit_id = visit.id;

  insert into public.work_order_visit_corrections(
    visit_id, work_order_id, actor_id, actor_role,
    old_check_in_at, old_check_out_at, new_check_in_at, new_check_out_at, reason
  ) values (
    visit.id, visit.work_order_id, actor.id, actor.role::text,
    visit.check_in_at, visit.check_out_at, corrected.check_in_at, corrected.check_out_at, clean_reason
  ) returning id into correction_id;

  insert into public.activities(
    work_order_id, author_id, author_name, text, type, entered_by_role,
    is_staff_override, is_staff_only, event_key, event_data,
    requires_7eleven_sync, requires_contractor_attention
  ) values (
    visit.work_order_id,
    actor.id,
    actor.name,
    actor.name || ' corrected visit time: ' || clean_reason,
    'system',
    actor.role::text,
    actor_is_staff,
    false,
    'visit_time_corrected',
    jsonb_build_object(
      'correctionId', correction_id,
      'visitId', visit.id,
      'actedByProfileId', actor.id,
      'technicianProfileId', visit_technician_id,
      'onBehalfOfTechnician', actor.role = 'contractor' and actor.id <> visit_technician_id,
      'before', jsonb_build_object('checkInAt', visit.check_in_at, 'checkOutAt', visit.check_out_at),
      'after', jsonb_build_object('checkInAt', corrected.check_in_at, 'checkOutAt', corrected.check_out_at),
      'reason', clean_reason
    ),
    false,
    false
  );
  return jsonb_build_object('correctionId', correction_id, 'visit', to_jsonb(corrected));
end
$$;

comment on function public.correct_work_order_visit_lc_core(uuid, timestamptz, timestamptz, text) is
  'Private lifecycle correction core. The visit technician, their team lead, company administrators, and staff may correct authorized completed visits with immutable actor and subject audit evidence.';

revoke all on function public.correct_work_order_visit_lc_core(uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;

-- Canonical private-file commands validate an explicit actor because their
-- finalization step runs under a service identity. Keep that check aligned with
-- the work-order wall without relying on auth.uid() during finalization.
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
    from public.profiles actor
    join public.work_orders work_order on work_order.id = p_work_order
    left join public.organizations organization
      on organization.id = actor.contractor_organization_id
     and organization.active = true
     and organization.canonical_contractor_id is not null
    left join public.profiles canonical
      on canonical.id = organization.canonical_contractor_id
     and canonical.role = 'contractor'
     and canonical.active = true
     and canonical.contractor_organization_id = organization.id
    where actor.id = p_actor
      and actor.active = true
      and work_order.deleted_at is null
      and (
        (
          actor.role in ('manager', 'dispatcher', 'back_office')
          and (not p_invoice_capable or not public.profile_has_staff_permission(actor.id, 'invoice_controller'))
        )
        or (
          actor.role = 'contractor'
          and work_order.contractor_id = case
            when actor.contractor_organization_id is null then actor.id
            else canonical.id
          end
          and (
            actor.contractor_organization_id is null
            or actor.contractor_access_level = 'company_admin'
            or (
              actor.contractor_access_level in ('invoice', 'report_only')
              and work_order.assigned_technician_profile_id = actor.id
              and exists (
                select 1 from public.contractor_technicians membership
                where membership.profile_id = actor.id
                  and membership.contractor_id = work_order.contractor_id
                  and membership.is_active = true
              )
            )
            or (
              actor.contractor_tier = 'mr_freeze'
              and actor.contractor_access_level = 'report_only'
              and exists (
                select 1
                from public.contractor_technicians lead_membership
                join public.profiles target
                  on target.id = work_order.assigned_technician_profile_id
                 and target.role = 'contractor'
                 and target.active = true
                 and target.contractor_organization_id = organization.id
                 and (target.id = actor.id or target.dispatcher_id = actor.id)
                join public.contractor_technicians target_membership
                  on target_membership.profile_id = target.id
                 and target_membership.contractor_id = work_order.contractor_id
                 and target_membership.is_active = true
                where lead_membership.profile_id = actor.id
                  and lead_membership.contractor_id = work_order.contractor_id
                  and lead_membership.is_active = true
              )
            )
          )
          and (
            not p_invoice_capable
            or (
              actor.contractor_organization_id is null
              and coalesce(actor.contractor_tier, 'direct') = 'direct'
            )
            or actor.contractor_access_level = 'company_admin'
            or (
              actor.contractor_access_level = 'invoice'
              and exists (
                select 1 from public.contractor_technicians invoice_membership
                where invoice_membership.profile_id = actor.id
                  and invoice_membership.contractor_id = work_order.contractor_id
                  and invoice_membership.is_active = true
              )
            )
          )
        )
      )
  )
$$;

revoke all on function public.private_object_actor_access(uuid, text, boolean)
  from public, anon, authenticated, service_role;

-- Before proxy entry existed, a contractor visit's actor was also its subject.
-- Preserve that identity for historical contractor visits without guessing for
-- staff-authored rows. The visit guard above permits this one owner-only column
-- backfill and continues to reject browser/service rewrites.
update public.work_order_visits visit
set technician_profile_id = visit.checked_in_by
from public.profiles actor
where visit.technician_profile_id is null
  and actor.id = visit.checked_in_by
  and actor.role = 'contractor'
  and (
    actor.id = visit.contractor_id
    or exists (
      select 1
      from public.organizations organization
      where organization.id = actor.contractor_organization_id
        and organization.canonical_contractor_id = visit.contractor_id
    )
  );

comment on column public.work_order_visits.technician_profile_id is
  'The technician whose field time this visit represents. checked_in_by and checked_out_by remain the acting portal accounts.';

commit;
