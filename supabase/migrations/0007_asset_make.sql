-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — asset make on close-complete
--  7-Eleven's DSP closure captures equipment make in addition to
--  model + serial. Nullable so existing rows + seeds stay valid.
--
--  Run this in the Supabase SQL editor BEFORE deploying the matching
--  app build. ADD COLUMN IF NOT EXISTS is idempotent and safe to re-run.
-- ═══════════════════════════════════════════════════════════════

alter table public.work_orders
  add column if not exists asset_make text;
