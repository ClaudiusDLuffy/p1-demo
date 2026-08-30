-- Contractor companies may have more than one company administrator. Every
-- administrator is still anchored to one active organization and its single
-- canonical contractor id, so company-wide access never crosses the contractor
-- wall. Invoice/report-only members remain current-assignment scoped.

begin;

-- Resolve organization members only through a live canonical contractor
-- profile. A stale/inactive canonical identity makes the company fail closed.
create or replace function public.current_contractor_account_id()
returns uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select case
    when profile.role <> 'contractor' or profile.active is not true then null
    when profile.contractor_organization_id is not null then canonical.id
    else profile.id
  end
  from public.profiles profile
  left join public.organizations organization
    on organization.id = profile.contractor_organization_id
   and organization.active = true
   and organization.canonical_contractor_id is not null
  left join public.profiles canonical
    on canonical.id = organization.canonical_contractor_id
   and canonical.role = 'contractor'
   and canonical.active = true
   and canonical.contractor_organization_id = organization.id
  where profile.id = auth.uid()
$$;

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
        -- This equality is the contractor-company wall. An organization member
        -- can only ever authorize rows owned by that organization's canonical
        -- contractor identity.
        and work_order.contractor_id = case
          when viewer.contractor_organization_id is not null
            then canonical.id
          else viewer.id
        end
        and (
          -- Preserve the existing single-login contractor behavior.
          viewer.contractor_organization_id is null
          -- Any explicitly authorized administrator may see their own complete
          -- company queue; they do not need an individual technician link.
          or viewer.contractor_access_level = 'company_admin'
          -- Operational members must be linked to this exact company and hold
          -- the work order's current explicit assignment.
          or (
            viewer.contractor_access_level in ('invoice', 'report_only')
            and work_order.assigned_technician_profile_id = viewer.id
            and exists (
              select 1
              from public.contractor_technicians technician
              where technician.profile_id = viewer.id
                and technician.contractor_id
                  = organization.canonical_contractor_id
                and technician.contractor_id = work_order.contractor_id
                and technician.is_active = true
            )
          )
        )
    )
$$;

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
     and organization.canonical_contractor_id is not null
    left join public.profiles canonical
      on canonical.id = organization.canonical_contractor_id
     and canonical.role = 'contractor'
     and canonical.active = true
     and canonical.contractor_organization_id = organization.id
    where profile.id = auth.uid()
      and profile.role = 'contractor'
      and profile.active = true
      and p_contractor_id = case
        when profile.contractor_organization_id is not null
          then canonical.id
        else profile.id
      end
      and (
        (
          profile.contractor_organization_id is null
          and coalesce(profile.contractor_tier, 'direct') = 'direct'
        )
        or profile.contractor_access_level = 'company_admin'
        or (
          profile.contractor_access_level = 'invoice'
          and exists (
            select 1
            from public.contractor_technicians technician
            where technician.profile_id = profile.id
              and technician.contractor_id
                = organization.canonical_contractor_id
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
     and organization.canonical_contractor_id is not null
    join public.profiles canonical
      on canonical.id = organization.canonical_contractor_id
     and canonical.role = 'contractor'
     and canonical.active = true
     and canonical.contractor_organization_id = organization.id
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
       and target.role = 'contractor'
       and target.contractor_organization_id
         = viewer.contractor_organization_id
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
       and organization.canonical_contractor_id is not null
       and organization.canonical_contractor_id = work_order.contractor_id
      join public.profiles canonical
        on canonical.id = organization.canonical_contractor_id
       and canonical.role = 'contractor'
       and canonical.active = true
       and canonical.contractor_organization_id = organization.id
      where work_order.id = p_work_order_id
        and work_order.deleted_at is null
    )
$$;

revoke all on function public.current_contractor_account_id(),
  public.can_access_contractor_work_order(text),
  public.can_invoice_for_contractor(uuid),
  public.can_manage_contractor_company(),
  public.can_read_contractor_profile(uuid),
  public.can_manage_work_order_technician(text)
  from public, anon;
grant execute on function public.current_contractor_account_id(),
  public.can_access_contractor_work_order(text),
  public.can_invoice_for_contractor(uuid),
  public.can_manage_contractor_company(),
  public.can_read_contractor_profile(uuid),
  public.can_manage_work_order_technician(text)
  to authenticated, service_role;

-- Administrators can enumerate only the technician directory belonging to
-- their own organization's canonical contractor id. Ordinary members can read
-- only their own technician row.
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
       and organization.canonical_contractor_id is not null
       and organization.canonical_contractor_id
         = contractor_technicians.contractor_id
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
  );

-- Apply the explicitly approved SCRC access map. The guards make this repair
-- fail closed if an email belongs to the wrong company or if a technician link
-- would be moved across contractor companies.
do $$
declare
  scrc_organization_id uuid;
  scrc_contractor_id uuid;
  matching_count integer;
  candidate_count integer;
  member_profile public.profiles%rowtype;
  candidate_link public.contractor_technicians%rowtype;
  expected record;
begin
  select count(*)
  into matching_count
  from public.organizations organization
  join public.profiles canonical
    on canonical.id = organization.canonical_contractor_id
   and canonical.contractor_organization_id = organization.id
   and canonical.role = 'contractor'
   and canonical.active = true
  where organization.active = true
    and lower(canonical.email) = 'scrcdallastexas@gmail.com';

  if matching_count <> 1 then
    raise exception 'Expected exactly one active SCRC organization for Derek Starnes; found %',
      matching_count using errcode = '23514';
  end if;

  select organization.id, organization.canonical_contractor_id
  into scrc_organization_id, scrc_contractor_id
  from public.organizations organization
  join public.profiles canonical
    on canonical.id = organization.canonical_contractor_id
   and canonical.contractor_organization_id = organization.id
   and canonical.role = 'contractor'
   and canonical.active = true
  where organization.active = true
    and lower(canonical.email) = 'scrcdallastexas@gmail.com';

  -- Derek remains the canonical administrator. Jennifer and Nancy are two
  -- additional SCRC-only administrators and deliberately are not technicians.
  for expected in
    select *
    from (values
      ('scrcdallastexas@gmail.com'::text, 'company_admin'::text),
      ('jenniferk@scrcdtx.com'::text, 'company_admin'::text),
      ('nancypb.scrc@gmail.com'::text, 'company_admin'::text)
    ) approved(email, access_level)
  loop
    select count(*)
    into matching_count
    from public.profiles profile
    where lower(profile.email) = expected.email
      and profile.role = 'contractor'
      and profile.active = true
      and profile.contractor_organization_id = scrc_organization_id;

    if matching_count <> 1 then
      raise exception 'Expected one active SCRC administrator profile for %; found %',
        expected.email, matching_count using errcode = '23514';
    end if;

    select profile.*
    into member_profile
    from public.profiles profile
    where lower(profile.email) = expected.email
      and profile.role = 'contractor'
      and profile.active = true
      and profile.contractor_organization_id = scrc_organization_id
    for update;

    update public.profiles
    set contractor_access_level = expected.access_level,
        is_assignable = (member_profile.id = scrc_contractor_id),
        updated_at = now()
    where id = member_profile.id;

    -- Company admins are company-wide managers, not assignment targets. If a
    -- legacy technician row exists, preserve the row but detach and deactivate
    -- it so it cannot accidentally grant or receive assignment scope.
    update public.contractor_technicians
    set profile_id = null,
        is_active = false,
        updated_at = now()
    where profile_id = member_profile.id;
  end loop;

  -- Reece and Rush remain report-only and receive the missing active company
  -- link required for assignment-scoped portal access.
  for expected in
    select *
    from (values
      ('ap@scrcdtx.com'::text, 'report_only'::text),
      ('rayrush50@gmail.com'::text, 'report_only'::text)
    ) approved(email, access_level)
  loop
    select count(*)
    into matching_count
    from public.profiles profile
    where lower(profile.email) = expected.email
      and profile.role = 'contractor'
      and profile.active = true
      and profile.contractor_organization_id = scrc_organization_id;

    if matching_count <> 1 then
      raise exception 'Expected one active SCRC member profile for %; found %',
        expected.email, matching_count using errcode = '23514';
    end if;

    select profile.*
    into member_profile
    from public.profiles profile
    where lower(profile.email) = expected.email
      and profile.role = 'contractor'
      and profile.active = true
      and profile.contractor_organization_id = scrc_organization_id
    for update;

    if exists (
      select 1
      from public.contractor_technicians technician
      where technician.profile_id = member_profile.id
        and technician.contractor_id is distinct from scrc_contractor_id
    ) then
      raise exception 'SCRC member % has a technician link to another contractor',
        expected.email using errcode = '23514';
    end if;

    update public.profiles
    set contractor_access_level = expected.access_level,
        is_assignable = false,
        updated_at = now()
    where id = member_profile.id;

    select count(*)
    into candidate_count
    from public.contractor_technicians technician
    where technician.contractor_id = scrc_contractor_id
      and (
        technician.profile_id = member_profile.id
        or lower(trim(technician.name)) = lower(trim(member_profile.name))
      );

    if candidate_count > 1 then
      raise exception 'SCRC member % matches more than one technician row',
        expected.email using errcode = '23514';
    end if;

    if candidate_count = 1 then
      select technician.*
      into candidate_link
      from public.contractor_technicians technician
      where technician.contractor_id = scrc_contractor_id
        and (
          technician.profile_id = member_profile.id
          or lower(trim(technician.name)) = lower(trim(member_profile.name))
        )
      for update;

      if candidate_link.profile_id is not null
         and candidate_link.profile_id <> member_profile.id then
        raise exception 'Technician row for SCRC member % belongs to another profile',
          expected.email using errcode = '23514';
      end if;

      update public.contractor_technicians
      set profile_id = member_profile.id,
          name = member_profile.name,
          tier = 'contracted',
          is_active = true,
          updated_at = now()
      where id = candidate_link.id;
    else
      insert into public.contractor_technicians (
        contractor_id,
        profile_id,
        name,
        tier,
        is_active
      ) values (
        scrc_contractor_id,
        member_profile.id,
        member_profile.name,
        'contracted',
        true
      );
    end if;
  end loop;
end
$$;

comment on function public.can_access_contractor_work_order(text) is
  'Authorizes staff, standalone contractors, all explicitly authorized administrators of the work order contractor company, or an active linked member holding the current assignment. The organization canonical contractor equality is the cross-company wall.';
comment on function public.can_manage_contractor_company() is
  'Returns true for any active company_admin in one valid active contractor organization; downstream writes remain tied to that organization canonical contractor id.';

commit;
