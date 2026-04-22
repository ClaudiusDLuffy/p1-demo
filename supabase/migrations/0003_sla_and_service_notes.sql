-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — SLA tracking + service_notes
-- ═══════════════════════════════════════════════════════════════
-- Adds the two pieces that v8 was missing:
--   1. SLA clock on work_orders (matches 7-Eleven's SLA-breach emails)
--   2. service_notes table (pairs raw contractor notes with AI-enhanced versions)
--
-- Depends on: 0001_initial_schema.sql, 0002_auth_trigger_fix.sql

-- ── 1. SLA FIELDS ON WORK ORDERS
alter table public.work_orders
  add column if not exists sla_deadline_at timestamptz,
  add column if not exists sla_breached_at timestamptz,
  add column if not exists sla_duration_hours int;

-- Open-SLA index: only WOs that have an SLA clock and haven't breached yet + aren't resolved.
create index if not exists idx_wo_sla_open
  on public.work_orders(sla_deadline_at)
  where sla_breached_at is null
    and status not in ('completed', 'pending_invoice', 'pending_approval');

comment on column public.work_orders.sla_deadline_at is
  'When the 7-Eleven SLA clock runs out. Set at dispatch based on priority: P1=8h, P2=12h, P3/P4 looser.';
comment on column public.work_orders.sla_breached_at is
  'Timestamp we observed the SLA breach (from 7HELP email or our own clock).';
comment on column public.work_orders.sla_duration_hours is
  'SLA window in hours at dispatch time (captures priority SLA at creation).';

-- ── 2. SERVICE NOTES (raw + AI-enhanced)
-- Paired notes: what the contractor wrote vs. what AI produced for 7-Eleven portal.
create table if not exists public.service_notes (
  id uuid primary key default gen_random_uuid(),
  work_order_id text references public.work_orders(id) on delete cascade not null,
  raw_note text not null,
  ai_enhanced_note text,
  enhanced_by_id uuid references public.profiles(id),
  enhanced_at timestamptz,
  created_by_id uuid references public.profiles(id),
  created_at timestamptz default now()
);
create index if not exists idx_service_notes_wo
  on public.service_notes(work_order_id, created_at desc);

alter table public.service_notes enable row level security;

drop policy if exists service_notes_read on public.service_notes;
create policy service_notes_read on public.service_notes for select using (
  exists (select 1 from public.work_orders w where w.id = work_order_id
          and (public.is_staff() or w.contractor_id = auth.uid()))
);

drop policy if exists service_notes_insert on public.service_notes;
create policy service_notes_insert on public.service_notes for insert with check (
  exists (select 1 from public.work_orders w where w.id = work_order_id
          and (public.is_staff() or w.contractor_id = auth.uid()))
);

-- Only staff can update (AI enhance happens on the manager side per the client decision).
drop policy if exists service_notes_update on public.service_notes;
create policy service_notes_update on public.service_notes for update using (public.is_staff());

-- Realtime for service notes too.
alter publication supabase_realtime add table public.service_notes;
