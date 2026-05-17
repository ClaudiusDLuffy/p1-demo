-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — work-order intake source
--  Distinguishes how a work order entered the system. Phase 1 only
--  produces 'manual' (the Create Work Order modal). Phase 1.5 email
--  ingestion will set 'email'. Defaulted so existing rows + the
--  app insert stay valid without a backfill.
--
--  Run this in the Supabase SQL editor BEFORE deploying the matching
--  app build. ADD COLUMN IF NOT EXISTS is idempotent and safe to re-run.
-- ═══════════════════════════════════════════════════════════════

alter table public.work_orders
  add column if not exists source text default 'manual';

update public.work_orders set source = 'manual' where source is null;
