-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — closed_at timestamp for the closed-job lifecycle
--  Set when a work order reaches the terminal Closed & Paid state. Drives
--  the 24-hour board linger (Part 1): a closed WO stays on the active
--  board for 24h after closed_at, then lives only in the History view.
--  Cleared on Reopen so the WO is treated as active again.
--
--  Backfill: existing closed rows get closed_at = updated_at so they are
--  dated. A closed WO with a null closed_at is treated as archived
--  (History only) by the app, so the board never lingers on undated rows.
--
--  Run this in the Supabase SQL editor BEFORE deploying the matching
--  app build. ADD COLUMN IF NOT EXISTS is idempotent and safe to re-run.
-- ═══════════════════════════════════════════════════════════════

alter table public.work_orders
  add column if not exists closed_at timestamptz;

update public.work_orders
  set closed_at = coalesce(updated_at, now())
  where status = 'closed' and closed_at is null;

create index if not exists idx_work_orders_closed_at
  on public.work_orders(closed_at)
  where closed_at is not null;
