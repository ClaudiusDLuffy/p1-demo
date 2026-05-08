-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — pending_payment + closed statuses
--  Adds two new values to the wo_status enum:
--    - pending_payment: AFM-approved invoice, awaiting RipCord disbursement
--    - closed:          P1 marked the work order paid (terminal state)
--
--  Pipeline becomes:
--    ... → Completed → Pending Invoice → Pending Approval → Pending Payment → Closed
--
--  Existing `closed`-like rows do not exist yet; nothing to migrate backwards.
-- ═══════════════════════════════════════════════════════════════

alter type public.wo_status add value if not exists 'pending_payment';
alter type public.wo_status add value if not exists 'closed';
