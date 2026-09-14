-- Batch 2A contraction: only after 0126 and the command-compatible web/intake
-- release. Never bulk-apply the pending stabilization chain before cutover.
begin;

do $prerequisites$
begin
  if to_regprocedure('public.transition_work_order_contractor_v1(text,uuid,integer,integer,bigint,uuid)') is null
    or to_regprocedure('public.reject_unassigned_work_order_v1(text,text,integer,integer,bigint,uuid)') is null
    or to_regprocedure('public.duplicate_work_order_for_reassignment_v1(text,integer,integer,bigint,uuid)') is null
    or to_regprocedure('public.create_work_order_with_assignment_v1(uuid,jsonb)') is null
    or to_regprocedure('public.create_email_work_order_with_assignment_v1(uuid,jsonb)') is null then
    raise exception 'Assignment expansion must be installed before contraction';
  end if;
end;
$prerequisites$;

update public.work_order_assignment_control set contracted=true where singleton;

-- Read-only history and service delivery inspection remain available. Owning
-- SECURITY DEFINER commands, not browser/service raw DML, write evidence.
revoke all on public.work_order_assignment_history from public,anon,authenticated,service_role;
grant select on public.work_order_assignment_history to authenticated,service_role;
revoke all on public.contractor_assignment_transition_deliveries from public,anon,authenticated,service_role;
grant select on public.contractor_assignment_transition_deliveries to service_role;
-- TRUNCATE does not fire row guards. It must not be an alternative way to
-- erase retained assignment/archive evidence in a direct SQL session.
revoke truncate on public.work_orders,public.activities from public,anon,authenticated,service_role;

-- These old signatures cannot carry the user's captured workflow/version or
-- operation UUID. Old tabs fail safely; new callers use their v1 replacements.
revoke all on function public.reject_unassigned_work_order(text,text),
  public.duplicate_work_order_for_reassignment_notified(text),
  public.duplicate_work_order_for_reassignment(text)
  from public,anon,authenticated,service_role;

commit;
