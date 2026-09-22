-- Preserve the visit-overlap safety rule while returning reviewed, bounded
-- guidance for conflicts the acting user is already authorized to view.
-- No visit, assignment, or work-order data is changed by this migration.
begin;

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
            and tstzrange(other.check_in_at, coalesce(other.check_out_at, now()), '[)')
              && tstzrange(p_check_in_at, p_check_out_at, '[)')
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
  'Serialized audited visit correction. Authorized overlap conflicts identify the conflicting work order without weakening technician chronology enforcement.';

revoke all on function public.correct_work_order_visit(uuid, timestamptz, timestamptz, text)
  from public, anon;
grant execute on function public.correct_work_order_visit(uuid, timestamptz, timestamptz, text)
  to authenticated, service_role;

commit;
