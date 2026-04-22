-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — initial schema (v8)
--  Run this once in the Supabase SQL Editor (Dashboard → SQL → New query → paste → Run)
--  After this, run 0002_seed.sql for the demo data.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. ENUMS
do $$ begin
  create type user_role as enum ('manager', 'dispatcher', 'back_office', 'contractor');
exception when duplicate_object then null; end $$;

do $$ begin
  create type wo_priority as enum ('p1', 'p2', 'p3', 'p4');
exception when duplicate_object then null; end $$;

do $$ begin
  create type wo_status as enum (
    'unassigned', 'assigned', 'wip', 'parts',
    'capital', 'completed', 'pending_invoice', 'pending_approval'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type fsm_functional_status as enum (
    'New', 'Dispatched', 'Work in Progress', 'Pending Capital Approval',
    'Awaiting Parts', 'Completed', 'Cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type invoice_state as enum ('draft', 'submitted', 'approved', 'rejected', 'revised', 'paid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type capital_status as enum (
    'Pending approval', 'Equipment ordered', 'Equipment received', 'Installation scheduled', 'Installed'
  );
exception when duplicate_object then null; end $$;

-- ── 2. PROFILES (extends auth.users with portal-specific fields)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  initials text,
  email text not null unique,
  role user_role not null default 'contractor',
  title text,
  company text,
  phone text,
  territory text,
  trades text[] default '{}',
  color text default '#1F1E1C',
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── 3. AFM CONTACTS (7-Eleven Area Facility Managers)
create table if not exists public.afms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  region text,
  notes text,
  created_at timestamptz default now()
);

-- ── 4. STORES (7-Eleven locations P1 services)
create table if not exists public.stores (
  store_number text primary key,
  city text,
  state text,
  address text,
  default_afm_id uuid references public.afms(id),
  notes text,
  created_at timestamptz default now()
);

-- ── 5. WORK ORDERS (real 7-Eleven FSM schema)
create table if not exists public.work_orders (
  id text primary key,                              -- e.g. FWKD11421039
  incident_id text unique,                          -- e.g. INC24890517
  store_number text references public.stores(store_number),
  city text,
  address text,
  line_of_service text,
  business_service text,
  category text,
  sub_category text,
  summary text,
  description text,
  priority wo_priority not null default 'p3',
  status wo_status not null default 'unassigned',
  functional_status fsm_functional_status default 'New',
  contractor_id uuid references public.profiles(id),
  afm_id uuid references public.afms(id),
  afm_name text,                                    -- denormalized snapshot
  afm_email text,
  nte numeric(10,2) default 0,
  invoice_total numeric(10,2),
  eta timestamptz,
  dispatched_at timestamptz,
  start_time timestamptz,
  end_time timestamptz,
  asset_model text,
  asset_serial text,
  is_capital boolean default false,
  capital_status capital_status,
  part_needed text,
  part_eta date,
  resolution_code text,
  resolution_notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_wo_status on public.work_orders(status);
create index if not exists idx_wo_contractor on public.work_orders(contractor_id);
create index if not exists idx_wo_priority on public.work_orders(priority);
create index if not exists idx_wo_store on public.work_orders(store_number);

-- ── 6. ACTIVITIES (append-only audit log per work order)
create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  work_order_id text references public.work_orders(id) on delete cascade not null,
  author_id uuid references public.profiles(id),
  author_name text not null,                        -- snapshot in case profile changes
  text text not null,
  type text default 'note',                         -- 'note' | 'system' | 'ai'
  created_at timestamptz default now()
);
create index if not exists idx_act_wo on public.activities(work_order_id, created_at desc);

-- ── 7. PHOTOS (metadata; binary lives in Supabase Storage bucket 'photos')
create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  work_order_id text references public.work_orders(id) on delete cascade not null,
  storage_path text not null,                       -- e.g. 'wo/FWKD11421039/abc123.jpg'
  uploader_id uuid references public.profiles(id),
  uploader_name text,
  caption text,
  created_at timestamptz default now()
);
create index if not exists idx_photo_wo on public.photos(work_order_id);

-- ── 8. INVOICES (P1 → 7-Eleven, matches Invoice 6556 format)
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  num text not null unique,                         -- e.g. '6556'
  work_order_id text references public.work_orders(id),
  store_number text,
  store_address text,
  contractor_id uuid references public.profiles(id),
  cme text,
  invoice_date date not null,
  service_date date,
  due_date date,
  terms text default 'Net 30',
  state invoice_state not null default 'draft',
  subtotal numeric(10,2) default 0,
  sales_tax numeric(10,2) default 0,
  total numeric(10,2) default 0,
  pdf_storage_path text,
  rejection_reason text,
  qbo_invoice_id text,                              -- for QB sync (v9)
  qbo_synced_at timestamptz,
  paid_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_inv_state on public.invoices(state);
create index if not exists idx_inv_wo on public.invoices(work_order_id);

-- ── 9. INVOICE LINES (1:N, matches QB line-item structure)
create table if not exists public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references public.invoices(id) on delete cascade not null,
  position int not null,                            -- order on the invoice
  type text not null,                               -- 'Travel' | 'Labor' | 'Parts/Hardware' | 'Shipping' | 'Other'
  description text,
  qty numeric(10,2) not null default 1,
  rate numeric(10,2) not null default 0,
  amount numeric(10,2) generated always as (qty * rate) stored
);
create index if not exists idx_line_inv on public.invoice_lines(invoice_id, position);

-- ── 10. QBO TOKENS (for QuickBooks integration in v9)
create table if not exists public.qbo_tokens (
  id uuid primary key default gen_random_uuid(),
  realm_id text not null unique,                    -- QB company ID
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  refreshed_at timestamptz default now(),
  created_at timestamptz default now()
);

-- ── 11. updated_at trigger (auto-bump on row change)
create or replace function public.touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end $$ language plpgsql;

drop trigger if exists touch_profiles on public.profiles;
create trigger touch_profiles before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_wo on public.work_orders;
create trigger touch_wo before update on public.work_orders
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_inv on public.invoices;
create trigger touch_inv before update on public.invoices
  for each row execute function public.touch_updated_at();

-- ── 12. profile auto-provision on signup
create or replace function public.handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, name, email, role, initials, color)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'contractor'),
    upper(left(coalesce(new.raw_user_meta_data->>'name', new.email), 2)),
    '#C15F3C'
  )
  on conflict (id) do nothing;
  return new;
end $$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 13. ROW LEVEL SECURITY
alter table public.profiles enable row level security;
alter table public.afms enable row level security;
alter table public.stores enable row level security;
alter table public.work_orders enable row level security;
alter table public.activities enable row level security;
alter table public.photos enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.qbo_tokens enable row level security;

-- helper: is the current user a manager-class role?
create or replace function public.is_staff() returns boolean as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('manager', 'dispatcher', 'back_office')
  );
$$ language sql stable security definer;

-- profiles: everyone can see all profiles (so we can render names/avatars)
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select using (true);
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update using (id = auth.uid());

-- afms: readable by everyone signed in
drop policy if exists afms_read on public.afms;
create policy afms_read on public.afms for select using (auth.uid() is not null);
drop policy if exists afms_write on public.afms;
create policy afms_write on public.afms for all using (public.is_staff());

-- stores: readable by everyone signed in
drop policy if exists stores_read on public.stores;
create policy stores_read on public.stores for select using (auth.uid() is not null);
drop policy if exists stores_write on public.stores;
create policy stores_write on public.stores for all using (public.is_staff());

-- work_orders: staff see all; contractors see only their own
drop policy if exists wo_read on public.work_orders;
create policy wo_read on public.work_orders for select using (
  public.is_staff() or contractor_id = auth.uid()
);
drop policy if exists wo_insert on public.work_orders;
create policy wo_insert on public.work_orders for insert with check (public.is_staff());
drop policy if exists wo_update on public.work_orders;
create policy wo_update on public.work_orders for update using (
  public.is_staff() or contractor_id = auth.uid()
);

-- activities: visible/insertable to anyone who can see the parent WO
drop policy if exists act_read on public.activities;
create policy act_read on public.activities for select using (
  exists (select 1 from public.work_orders w where w.id = work_order_id
          and (public.is_staff() or w.contractor_id = auth.uid()))
);
drop policy if exists act_insert on public.activities;
create policy act_insert on public.activities for insert with check (
  exists (select 1 from public.work_orders w where w.id = work_order_id
          and (public.is_staff() or w.contractor_id = auth.uid()))
);

-- photos: same scope as activities
drop policy if exists photo_read on public.photos;
create policy photo_read on public.photos for select using (
  exists (select 1 from public.work_orders w where w.id = work_order_id
          and (public.is_staff() or w.contractor_id = auth.uid()))
);
drop policy if exists photo_insert on public.photos;
create policy photo_insert on public.photos for insert with check (
  exists (select 1 from public.work_orders w where w.id = work_order_id
          and (public.is_staff() or w.contractor_id = auth.uid()))
);
drop policy if exists photo_delete on public.photos;
create policy photo_delete on public.photos for delete using (
  uploader_id = auth.uid() or public.is_staff()
);

-- invoices: staff see all; contractors see only invoices for their WOs
drop policy if exists inv_read on public.invoices;
create policy inv_read on public.invoices for select using (
  public.is_staff() or contractor_id = auth.uid()
);
drop policy if exists inv_write on public.invoices;
create policy inv_write on public.invoices for all using (
  public.is_staff() or contractor_id = auth.uid()
);

-- invoice_lines: visible if you can see the parent invoice
drop policy if exists line_read on public.invoice_lines;
create policy line_read on public.invoice_lines for select using (
  exists (select 1 from public.invoices i where i.id = invoice_id
          and (public.is_staff() or i.contractor_id = auth.uid()))
);
drop policy if exists line_write on public.invoice_lines;
create policy line_write on public.invoice_lines for all using (
  exists (select 1 from public.invoices i where i.id = invoice_id
          and (public.is_staff() or i.contractor_id = auth.uid()))
);

-- qbo_tokens: staff only, no public read
drop policy if exists qbo_staff on public.qbo_tokens;
create policy qbo_staff on public.qbo_tokens for all using (public.is_staff());

-- ── 14. STORAGE BUCKETS
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('photos', 'photos', false, 10485760, array['image/jpeg','image/png','image/heic','image/webp']),
  ('invoice-pdfs', 'invoice-pdfs', false, 5242880, array['application/pdf'])
on conflict (id) do nothing;

-- storage policies: signed-in users can read/write their workspace
drop policy if exists "photos_read" on storage.objects;
create policy "photos_read" on storage.objects for select
  using (bucket_id = 'photos' and auth.uid() is not null);

drop policy if exists "photos_write" on storage.objects;
create policy "photos_write" on storage.objects for insert
  with check (bucket_id = 'photos' and auth.uid() is not null);

drop policy if exists "photos_delete" on storage.objects;
create policy "photos_delete" on storage.objects for delete
  using (bucket_id = 'photos' and auth.uid() is not null);

drop policy if exists "invoice_pdfs_rw" on storage.objects;
create policy "invoice_pdfs_rw" on storage.objects for all
  using (bucket_id = 'invoice-pdfs' and auth.uid() is not null);
