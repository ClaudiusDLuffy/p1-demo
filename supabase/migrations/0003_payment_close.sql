-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — payment + close lifecycle
--  Extends the work-order pipeline past Pending Approval so a WO can
--  be walked all the way to Closed:
--    pending_approval → (Owner approves on behalf of AFM) → pending_payment
--    pending_payment  → (Owner marks paid)                → closed
--  invoice_state already has 'paid'; only wo_status needs the new values.
--
--  Run this in the Supabase SQL editor BEFORE deploying the matching
--  app build. ADD VALUE IF NOT EXISTS is idempotent and safe to re-run.
-- ═══════════════════════════════════════════════════════════════

alter type wo_status add value if not exists 'pending_payment';
alter type wo_status add value if not exists 'closed';
