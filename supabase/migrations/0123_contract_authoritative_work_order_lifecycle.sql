-- Batch 1B contraction. STOP: apply only AFTER expansion 0122, deployment of
-- the compatible web build, staging smoke tests and the read-only anomaly
-- review. Old browser tabs must refresh; raw lifecycle writes intentionally
-- fail closed. Do not roll back by reopening raw write access.
begin;

do $$
begin
  if to_regprocedure('public.complete_work_order_field_v1(text,integer,integer,bigint,uuid,timestamp with time zone,text,text,text,integer,text,text)') is null
    or to_regprocedure('public.pause_work_order_for_parts_v1(text,integer,integer,bigint,uuid,timestamp with time zone,text,jsonb,text,text,date)') is null then
    raise exception 'Lifecycle expansion must be installed before contraction';
  end if;
end;
$$;

update public.work_order_lifecycle_control set contracted=true where singleton;

-- These pre-cutover signatures cannot carry expected assignment/cycle/version
-- tokens. Keeping them browser-callable would bypass the new concurrency
-- boundary. Their implementations remain private for controlled internal use;
-- the live UI uses versioned field completion followed by the independently
-- guarded invoicing confirmation. No current UI calls the legacy combined RPC.
-- Old clients must refresh rather than silently completing a newer assignment.
revoke all on function
  public.complete_work_order_once(text,timestamptz,text,text,text,integer,text,text,text),
  public.complete_contractor_work_and_invoicing(text,timestamptz,text,text,text,integer,text,text,text)
from public,anon,authenticated,service_role;

comment on table public.work_order_lifecycle_control is
  'Private rollout state. 0123 contraction requires the compatible web release; do not reset to false as rollback.';
comment on column public.work_orders.lifecycle_version is
  'Server-owned monotonic field-lifecycle version. Includes assignment/technician/cycle changes; compare on every lifecycle command.';
comment on column public.activities.lifecycle_operation_id is
  'Transaction-owned lifecycle evidence. NULL legacy rows are not retroactively certified or automatically repaired.';
comment on function public.complete_work_order_once(text,timestamptz,text,text,text,integer,text,text,text) is
  'Private legacy compatibility implementation after 0123. Public field completion must use complete_work_order_field_v1 with expected versions and operation UUID.';
comment on function public.complete_contractor_work_and_invoicing(text,timestamptz,text,text,text,integer,text,text,text) is
  'Private unused legacy combined implementation after 0123. Existing web uses versioned field completion and separate guarded finish_contractor_invoicing.';

commit;
