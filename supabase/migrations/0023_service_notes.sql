-- Service notes table for AI-enhanced work order notes
-- This table was present in the original database
-- but was never saved as a migration file

create table if not exists public.service_notes (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null
    references public.work_orders(id),
  raw_note text not null,
  ai_enhanced_note text,
  enhanced_by_id uuid
    references public.profiles(id),
  enhanced_at timestamptz,
  created_by_id uuid
    references public.profiles(id),
  created_at timestamptz default now()
);

alter table public.service_notes
  enable row level security;

create policy service_notes_read
  on public.service_notes
  for select using (
    auth.uid() is not null
  );

create policy service_notes_insert
  on public.service_notes
  for insert with check (
    auth.uid() is not null
  );

create policy service_notes_update
  on public.service_notes
  for update using (
    created_by_id = auth.uid()
  );
