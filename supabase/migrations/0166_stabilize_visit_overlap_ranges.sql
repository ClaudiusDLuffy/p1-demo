-- Keep visit-overlap validation total for legacy rows whose open check-in is
-- later than the database clock. PostgreSQL rejects a range whose lower bound
-- is later than its upper bound, so clamp only the comparison range to empty.
-- The stored visit remains unchanged and the normal future-time policy still
-- governs all new field events.

begin;

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
      and tstzrange(
        other.check_in_at,
        greatest(other.check_in_at, coalesce(other.check_out_at, now())),
        '[)'
      ) && tstzrange(p_check_in_at, p_check_out_at, '[)')
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
  'Private lifecycle correction core. Overlap comparison remains total for legacy future-open or reversed visit intervals without changing stored evidence.';

revoke all on function public.correct_work_order_visit_lc_core(uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;

create or replace function public.correct_work_order_visit(
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
  v_target text;
  v_result jsonb;
  v_technician_id uuid;
  v_conflicting_work_order_ids text[];
  v_conflict_count integer;
begin
  select visit.work_order_id,
         coalesce(visit.technician_profile_id, visit.checked_in_by)
    into v_target, v_technician_id
  from public.work_order_visits visit
  where visit.id = p_visit_id;

  perform 1
  from public.work_orders work_order
  where work_order.id = v_target
  for update;

  if v_target is not null
     and exists (select 1 from public.work_orders work_order where work_order.id = v_target) then
    insert into public.work_order_lifecycle_transition_guards(
      transaction_id, work_order_id, actor_id, command_kind,
      parent_allowed, visit_allowed, event_key
    ) values (
      txid_current(), v_target, auth.uid(), 'compat:correct_work_order_visit',
      true, true, 'visit_time_corrected'
    );
  end if;

  begin
    v_result := public.correct_work_order_visit_lc_core(
      p_visit_id,
      p_check_in_at,
      p_check_out_at,
      p_reason
    );
  exception
    when others then
      if sqlerrm = 'The corrected time overlaps another visit for this technician'
         and v_technician_id is not null
         and p_check_in_at is not null
         and p_check_out_at is not null then
        select
          array_agg(conflict.work_order_id order by conflict.work_order_id),
          count(*)::integer
          into v_conflicting_work_order_ids, v_conflict_count
        from (
          select distinct other.work_order_id
          from public.work_order_visits other
          join public.work_orders other_work_order
            on other_work_order.id = other.work_order_id
           and other_work_order.deleted_at is null
          where other.id <> p_visit_id
            and coalesce(other.technician_profile_id, other.checked_in_by) = v_technician_id
            and tstzrange(
              other.check_in_at,
              greatest(other.check_in_at, coalesce(other.check_out_at, now())),
              '[)'
            ) && tstzrange(p_check_in_at, p_check_out_at, '[)')
            and (
              public.is_staff()
              or public.can_access_contractor_work_order(other.work_order_id)
            )
        ) conflict;

        if coalesce(v_conflict_count, 0) > 0 then
          raise exception using
            errcode = 'PT409',
            message = 'The corrected time overlaps another visit for this technician',
            detail = jsonb_build_object(
              'code', 'VISIT_TIME_OVERLAP',
              'conflictingWorkOrderIds', to_jsonb(v_conflicting_work_order_ids),
              'conflictCount', v_conflict_count
            )::text;
        end if;
      end if;
      raise;
  end;

  delete from public.work_order_lifecycle_transition_guards
  where transaction_id = txid_current()
    and work_order_id = v_target
    and command_kind = 'compat:correct_work_order_visit';

  return v_result;
end;
$$;

comment on function public.correct_work_order_visit(uuid, timestamptz, timestamptz, text) is
  'Serialized audited visit correction. Authorized overlap guidance remains bounded and malformed legacy comparison intervals cannot abort the request.';

revoke all on function public.correct_work_order_visit(uuid, timestamptz, timestamptz, text)
  from public, anon;
grant execute on function public.correct_work_order_visit(uuid, timestamptz, timestamptz, text)
  to authenticated, service_role;

commit;
