-- Preserve assignment-scoped technician access while allowing a linked field
-- technician to continue accessing a work order they verifiably participated
-- in before structured portal assignments existed. Participation is limited to
-- durable, authenticated field evidence: assignment history, visits, or photos,
-- and must identify exactly one active linked technician for an unassigned job.
-- No work-order ownership, technician snapshot, or profile row is rewritten.

begin;

create index if not exists technician_work_order_participation
  on public.work_order_technician_assignments(
    technician_profile_id,
    work_order_id
  );

create index if not exists work_order_visits_check_in_participant
  on public.work_order_visits(checked_in_by, work_order_id);

create index if not exists work_order_visits_check_out_participant
  on public.work_order_visits(checked_out_by, work_order_id)
  where checked_out_by is not null;

create index if not exists work_order_photos_participant
  on public.photos(uploader_id, work_order_id)
  where uploader_id is not null;

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
          -- Unlinked invoice-capable office accounts remain company-wide.
          or (
            viewer.contractor_access_level = 'invoice'
            and not public.is_linked_contractor_technician(
              viewer.id,
              work_order.contractor_id
            )
          )
          -- Linked technicians receive current assignment scope plus durable
          -- access to jobs in which their own authenticated profile previously
          -- participated. Activity and invoice authorship are intentionally not
          -- sufficient because those can represent office-only work.
          or (
            viewer.contractor_access_level in ('invoice', 'report_only')
            and exists (
              select 1
              from public.contractor_technicians technician
              where technician.profile_id = viewer.id
                and technician.contractor_id = work_order.contractor_id
                and technician.is_active = true
            )
            and (
              work_order.assigned_technician_profile_id = viewer.id
              or (
                -- Participation is a compatibility fallback for legacy jobs
                -- only. A current structured assignment always takes
                -- precedence and excludes former participants.
                work_order.assigned_technician_profile_id is null
                and (
                  exists (
                    select 1
                    from public.work_order_technician_assignments assignment
                    where assignment.work_order_id = work_order.id
                      and assignment.technician_profile_id = viewer.id
                  )
                  or exists (
                    select 1
                    from public.work_order_visits visit
                    where visit.work_order_id = work_order.id
                      and visit.contractor_id = work_order.contractor_id
                      and (
                        visit.checked_in_by = viewer.id
                        or visit.checked_out_by = viewer.id
                      )
                  )
                  or exists (
                    select 1
                    from public.photos photo
                    where photo.work_order_id = work_order.id
                      and photo.uploader_id = viewer.id
                  )
                )
                and (
                  select count(distinct participant.profile_id)
                  from lateral (
                    select assignment.technician_profile_id as profile_id
                    from public.work_order_technician_assignments assignment
                    where assignment.work_order_id = work_order.id

                    union

                    select visit.checked_in_by as profile_id
                    from public.work_order_visits visit
                    where visit.work_order_id = work_order.id
                      and visit.contractor_id = work_order.contractor_id
                      and visit.checked_in_by is not null

                    union

                    select visit.checked_out_by as profile_id
                    from public.work_order_visits visit
                    where visit.work_order_id = work_order.id
                      and visit.contractor_id = work_order.contractor_id
                      and visit.checked_out_by is not null

                    union

                    select photo.uploader_id as profile_id
                    from public.photos photo
                    where photo.work_order_id = work_order.id
                      and photo.uploader_id is not null
                  ) participant
                  join public.contractor_technicians participant_technician
                    on participant_technician.profile_id = participant.profile_id
                   and participant_technician.contractor_id = work_order.contractor_id
                   and participant_technician.is_active = true
                  join public.profiles participant_profile
                    on participant_profile.id = participant.profile_id
                   and participant_profile.role = 'contractor'
                   and participant_profile.active = true
                   and participant_profile.contractor_access_level
                     in ('invoice', 'report_only')
                ) = 1
              )
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
  'Authorizes staff, company-wide office members, or an active linked technician with a current assignment; unique durable authenticated participation is a fallback only for work orders without a current structured assignment.';

commit;
