-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — NTE early-warning flag
--  7-Eleven's hard NTE is $1,300 and P1 exceeds it on nearly every
--  job. This adds a per-work-order EARLY-WARNING threshold (default
--  $900, a $400 buffer below the hard cap) so Mandy's team can review
--  only the jobs approaching the limit instead of every job.
--
--  - nte_flag_threshold: editable per WO (owner/dispatcher), default 900
--  - nte_flagged: set true when a submitted invoice total >= threshold
--  - nte_flag_amount: the triggering invoice total, for the review queue
--
--  This is SEPARATE from the existing "exceeds NTE" highlight (which
--  compares spend against the actual NTE). Both coexist. Dollar-based,
--  never a percentage (the 7-Eleven NTE is a dollar amount).
--
--  Run this in the Supabase SQL editor BEFORE deploying the matching
--  app build. ADD COLUMN IF NOT EXISTS is idempotent and safe to re-run.
-- ═══════════════════════════════════════════════════════════════

alter table public.work_orders
  add column if not exists nte_flag_threshold numeric(10,2) default 900,
  add column if not exists nte_flagged boolean default false,
  add column if not exists nte_flag_amount numeric(10,2);

update public.work_orders set nte_flag_threshold = 900 where nte_flag_threshold is null;
update public.work_orders set nte_flagged = false where nte_flagged is null;

create index if not exists idx_work_orders_nte_flagged
  on public.work_orders(nte_flagged)
  where nte_flagged = true;
