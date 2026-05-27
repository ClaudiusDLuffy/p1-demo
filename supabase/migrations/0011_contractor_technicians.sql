-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — contractor technicians + "Technician on Job"
--  Lets a contractor record WHO was actually on a job, for P1's
--  reporting visibility. Phase 1 scope: P1 seeds the technician list;
--  contractors only pick from it. No per-tech logins, no tier
--  enforcement (tier is captured for future Phase 2 use only).
--
--  Run this in the Supabase SQL editor BEFORE deploying the matching
--  app build. All statements are idempotent / safe to re-run.
-- ═══════════════════════════════════════════════════════════════

create table if not exists public.contractor_technicians (
  id uuid primary key default gen_random_uuid(),
  contractor_id uuid references public.profiles(id) on delete cascade,
  name text not null,
  tier text,                                  -- 'direct' | 'mr_freeze' | 'contracted' | null (future use only)
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.contractor_technicians
  drop constraint if exists contractor_technicians_tier_check;
alter table public.contractor_technicians
  add constraint contractor_technicians_tier_check
  check (tier is null or tier in ('direct', 'mr_freeze', 'contracted'));

create index if not exists idx_contractor_technicians_contractor
  on public.contractor_technicians(contractor_id);

-- Idempotent seeding key: one row per (contractor, technician name).
create unique index if not exists idx_contractor_technicians_unique
  on public.contractor_technicians(contractor_id, name);

alter table public.contractor_technicians enable row level security;

-- Staff see all; a contractor sees only their own technicians.
drop policy if exists ct_read on public.contractor_technicians;
create policy ct_read on public.contractor_technicians for select using (
  public.is_staff() or contractor_id = auth.uid()
);
-- Inserts/updates are staff-only (P1 seeds the list; no contractor CRUD this phase).
drop policy if exists ct_write on public.contractor_technicians;
create policy ct_write on public.contractor_technicians for all using (public.is_staff());

-- Text snapshot of who was on the job (NOT a FK, so history survives
-- a technician being renamed/removed). Nullable; no backfill needed.
alter table public.work_orders
  add column if not exists technician_on_job text;
