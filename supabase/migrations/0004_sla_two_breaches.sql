-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — SLA two-breach tracking
--  Adds response + resolution breach timestamps and an explicit
--  sla_started_at field so we can pivot off email-intake time.
--
--  Why two timestamps: 7-Eleven's portal tracks both arrival deadline
--  (Response Breach) and resolution deadline (Resolution Breach).
--  The portal currently only tracks one. This adds both columns so the
--  SLA UI can mirror what techs see in 7-Eleven's system.
--
--  Backfill: sla_started_at = created_at for every existing row. The
--  scripts/backfill-sla-breaches.ts runs after this and computes the
--  two breach times from priority + sla_started_at for legacy rows.
-- ═══════════════════════════════════════════════════════════════

alter table public.work_orders
  add column if not exists response_breach_at timestamptz,
  add column if not exists resolution_breach_at timestamptz,
  add column if not exists sla_started_at timestamptz;

-- Best-effort backfill of the new start-at field. Resolution + response
-- breaches are filled by the post-migration script which knows the
-- priority → window mapping (kept in TS so it can change without DDL).
update public.work_orders
  set sla_started_at = created_at
  where sla_started_at is null;

create index if not exists idx_wo_response_breach
  on public.work_orders(response_breach_at)
  where response_breach_at is not null;
create index if not exists idx_wo_resolution_breach
  on public.work_orders(resolution_breach_at)
  where resolution_breach_at is not null;
