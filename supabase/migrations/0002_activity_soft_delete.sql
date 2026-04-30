-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — activity soft-delete
--  Adds deleted_at column + RLS policy for authors/managers to update
--  (used to soft-delete their own / any comments). Existing read policy
--  is unchanged; the app filters deleted_at IS NULL at query time.
-- ═══════════════════════════════════════════════════════════════

-- 1. Soft-delete column
alter table public.activities
  add column if not exists deleted_at timestamptz;

-- Useful for "live" feed queries that filter out deleted entries
create index if not exists idx_act_wo_live
  on public.activities(work_order_id, created_at desc)
  where deleted_at is null;

-- 2. RLS: authors can update their own row; staff can update any.
--    (Update is the only way to soft-delete; we never DELETE the row.)
drop policy if exists act_update on public.activities;
create policy act_update on public.activities for update using (
  author_id = auth.uid() or public.is_staff()
) with check (
  author_id = auth.uid() or public.is_staff()
);
