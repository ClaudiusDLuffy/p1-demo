-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — relax store_number FK on work_orders
--  Manual intake must be able to create a work order for ANY store
--  number, including stores not pre-seeded in `stores`. The FK made
--  Create Work Order fail for unseeded stores. Drop it so store_number
--  is free-form; the app still best-effort upserts a stores row so the
--  Stores/Kanban context stays populated.
--
--  Run this in the Supabase SQL editor BEFORE deploying the matching
--  app build. DROP CONSTRAINT IF EXISTS is idempotent and safe to re-run.
-- ═══════════════════════════════════════════════════════════════

alter table public.work_orders
  drop constraint if exists work_orders_store_number_fkey;
