-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — per-contractor NTE display cap
--  Contractors must NEVER see the real NTE from 7-Eleven; otherwise they
--  bill toward the real ceiling. Lindsay 2026-06-16: every contractor
--  always sees $1,000 regardless of the stored WO NTE. Per-row column
--  here so individual contractors can carry a different cap later
--  without a code change.
--
--  The mask is applied at the PortalShell role boundary in code; this
--  column is the source of truth for the cap value. Default 1000
--  covers existing + future contractor rows.
--
--  Idempotent. Apply manually in the Supabase SQL editor BEFORE
--  deploying the matching app build.
-- ═══════════════════════════════════════════════════════════════

alter table public.profiles
  add column if not exists contractor_nte_display numeric default 1000;

-- Backfill any pre-existing contractor rows that came in as NULL (the
-- DEFAULT only fires on new INSERTs). Staff rows are unaffected — the
-- column has no behavioural impact for non-contractors.
update public.profiles
  set contractor_nte_display = 1000
  where contractor_nte_display is null;

comment on column public.profiles.contractor_nte_display is
  'Per-contractor masked NTE shown to that contractor in place of the real WO NTE. Default 1000. Display-only; never read by staff math or flag logic.';
