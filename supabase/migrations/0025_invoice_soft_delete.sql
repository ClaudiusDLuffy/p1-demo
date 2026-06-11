-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — invoice soft delete (testing-phase cleanup)
--  Staff (manager / dispatcher / back_office) can soft-delete invoices
--  to clean up test data. Mirrors the work-order soft-delete pattern
--  (0008): set deleted_at + deleted_by, never hard delete, so the row
--  stays in the database and is restorable via SQL.
--
--  No RLS change needed: inv_update (0016) already allows staff to
--  UPDATE any invoice, and the app performs the soft delete as an
--  UPDATE. Display queries filter deleted_at IS NULL.
--
--  Apply MANUALLY in the Supabase SQL editor BEFORE merging the
--  matching app build. ADD COLUMN IF NOT EXISTS is idempotent.
-- ═══════════════════════════════════════════════════════════════

alter table public.invoices
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles(id);

create index if not exists idx_invoices_deleted_at
  on public.invoices(deleted_at)
  where deleted_at is null;
