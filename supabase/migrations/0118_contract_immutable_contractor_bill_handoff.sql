-- Contract phase for migration 0117.
--
-- Operational gate: do not apply this migration merely because old instances
-- appear drained. Apply it only after the revision-bound application is stable
-- and the rollback window for the legacy application is closed. Rolling back
-- the app after this migration would restore callers of the disabled RPCs.

begin;

do $$
begin
  if to_regprocedure(
    'public.stage_contractor_bill_handoff(uuid,uuid,text,jsonb,text,bigint,text)'
  ) is null then
    raise exception 'Migration 0117 must be applied before the contractor-bill contract phase';
  end if;
end
$$;

-- Serialize the cutoff against an old application instance that may already be
-- staging a legacy package. A transaction that began first either finishes
-- before this lock is acquired or is rejected by the verified-pending
-- constraint after this transaction commits.
-- Fail the entire migration quickly instead of leaving an ACCESS EXCLUSIVE
-- request queued behind live traffic. A timeout is safe to retry because this
-- migration is transactional.
set local lock_timeout = '5s';
lock table public.controller_invoice_export_batches in access exclusive mode;

-- A legacy pending archive is not bound to a source revision or fingerprint.
-- Preserve the batch, item audit trail, and private storage object, but require
-- accounting to build a new verified package before confirming QuickBooks entry.
update public.controller_invoice_export_batches batch
set status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = batch.created_by,
    cancellation_reason = 'Automatically cancelled during immutable contractor-bill handoff contract; rebuild the package before QuickBooks entry.'
where batch.status = 'pending'
  and (
    batch.archive_format is distinct from 'reference_manifest_v2'
    or batch.archive_sha256 is null
    or batch.archive_bytes is null
  );

do $$
begin
  if not exists (
    select 1 from pg_constraint constraint_row
    where constraint_row.conname = 'controller_export_pending_verified_check'
      and constraint_row.conrelid = 'public.controller_invoice_export_batches'::regclass
  ) then
    alter table public.controller_invoice_export_batches
      add constraint controller_export_pending_verified_check check (
        status <> 'pending'
        or (
          archive_format = 'reference_manifest_v2'
          and archive_sha256 is not null
          and archive_bytes is not null
        )
      );
  end if;
end
$$;

-- Keep the signatures for schema stability, but make every legacy entry point
-- fail closed. Only the revision-bound stage_contractor_bill_handoff RPC may
-- create a new pending package after this point.
create or replace function public.stage_controller_invoice_export(
  p_batch_id uuid,
  p_actor_id uuid,
  p_object_path text,
  p_invoice_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'Legacy contractor-bill staging is disabled; use the revision-bound payables handoff'
    using errcode = '55000';
end;
$$;

create or replace function public.complete_controller_invoice_export(
  p_batch_id uuid,
  p_actor_id uuid,
  p_object_path text,
  p_invoice_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'Legacy contractor-bill staging is disabled; use the revision-bound payables handoff'
    using errcode = '55000';
end;
$$;

revoke all on function public.stage_controller_invoice_export(
  uuid, uuid, text, uuid[]
) from public, anon, authenticated;
revoke all on function public.complete_controller_invoice_export(
  uuid, uuid, text, uuid[]
) from public, anon, authenticated;

grant execute on function public.stage_controller_invoice_export(
  uuid, uuid, text, uuid[]
), public.complete_controller_invoice_export(
  uuid, uuid, text, uuid[]
) to service_role;

commit;
