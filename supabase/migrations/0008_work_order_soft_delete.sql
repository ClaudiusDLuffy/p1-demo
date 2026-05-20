-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — work-order soft delete
--  Phase 1 launch testing needs reversible WO cleanup. Soft delete
--  only: set deleted_at + deleted_by, never hard delete, so related
--  invoices / photos / activities stay intact and a row can be
--  restored via SQL if needed.
--
--  The partial index keeps "active work orders" filtering fast since
--  the vast majority of rows have deleted_at IS NULL.
--
--  Run this in the Supabase SQL editor BEFORE deploying the matching
--  app build. ADD COLUMN IF NOT EXISTS is idempotent and safe to re-run.
-- ═══════════════════════════════════════════════════════════════

alter table public.work_orders
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles(id);

create index if not exists idx_work_orders_deleted_at
  on public.work_orders(deleted_at)
  where deleted_at is null;
