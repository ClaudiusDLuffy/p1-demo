-- Disposable-local behavior check for migration 0162. Every attempted command
-- is expected to fail before mutation and the enclosing transaction rolls back.
begin;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (select id from auth.users where email = 'e2e.report.tech@p1.invalid'),
    'role', 'authenticated'
  )::text,
  true
);
set local role authenticated;

do $policy$
declare
  v_start public.work_orders%rowtype;
  v_complete public.work_orders%rowtype;
  v_check_in timestamptz;
begin
  select * into strict v_start from public.work_orders where id = 'E2E-TIME-START';
  select * into strict v_complete from public.work_orders where id = 'E2E-TIME-COMPLETE';
  select check_in_at into strict v_check_in from public.work_order_visits
    where work_order_id = v_complete.id and check_out_at is null;

  begin
    perform public.start_work_order_visit_v1(
      v_start.id, v_start.contractor_assignment_version, v_start.workflow_cycle,
      v_start.lifecycle_version, gen_random_uuid(), clock_timestamp() + interval '1 hour', 'Synthetic future arrival'
    );
    raise exception 'Future arrival unexpectedly succeeded';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'Check-in time cannot be in the future' then raise; end if;
  end;

  begin
    perform public.pause_work_order_for_parts_v1(
      v_complete.id, v_complete.contractor_assignment_version, v_complete.workflow_cycle,
      v_complete.lifecycle_version, gen_random_uuid(), clock_timestamp() + interval '1 hour',
      'Temporary fix', '[]'::jsonb, 'Synthetic future checkout', null, null
    );
    raise exception 'Future checkout unexpectedly succeeded';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'Checkout time cannot be in the future' then raise; end if;
  end;

  begin
    perform public.complete_work_order_field_v1(
      v_complete.id, v_complete.contractor_assignment_version, v_complete.workflow_cycle,
      v_complete.lifecycle_version, gen_random_uuid(), clock_timestamp() + interval '1 hour',
      'Synthetic', 'Time', 'FUTURE', 2026, 'Current Asset Repaired', 'Synthetic future completion'
    );
    raise exception 'Future completion unexpectedly succeeded';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'Completion time cannot be in the future' then raise; end if;
  end;

  begin
    perform public.complete_work_order_field_v1(
      v_complete.id, v_complete.contractor_assignment_version, v_complete.workflow_cycle,
      v_complete.lifecycle_version, gen_random_uuid(), v_check_in - interval '1 minute',
      'Synthetic', 'Time', 'EARLY', 2026, 'Current Asset Repaired', 'Synthetic early completion'
    );
    raise exception 'Early completion unexpectedly succeeded';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'Completion time cannot be before active visit check-in' then raise; end if;
  end;

  raise notice 'PASS_0162_FIELD_EVENT_BEHAVIOR';
end;
$policy$;

reset role;
do $no_residue$
begin
  if exists (
    select 1 from public.work_order_lifecycle_operations
    where work_order_id in ('E2E-TIME-START', 'E2E-TIME-COMPLETE')
  ) then
    raise exception 'Rejected time commands left lifecycle operation rows';
  end if;
  raise notice 'PASS_0162_NO_REJECTED_OPERATION_RESIDUE';
end;
$no_residue$;

rollback;
