-- Link P1-to-7-Eleven invoices to the contractor invoice(s) they were
-- built from. The relationship is staff-only and validated in the DB.

create table if not exists public.staff_invoice_sources (
  id uuid primary key default gen_random_uuid(),
  staff_invoice_id uuid not null
    references public.invoices(id) on delete cascade,
  contractor_invoice_id uuid not null
    references public.invoices(id) on delete restrict,
  work_order_id text not null
    references public.work_orders(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint staff_invoice_sources_unique_link
    unique (staff_invoice_id, contractor_invoice_id),
  constraint staff_invoice_sources_distinct_invoices
    check (staff_invoice_id <> contractor_invoice_id)
);

create index if not exists idx_staff_invoice_sources_staff
  on public.staff_invoice_sources(staff_invoice_id);

create index if not exists idx_staff_invoice_sources_contractor
  on public.staff_invoice_sources(contractor_invoice_id);

create index if not exists idx_staff_invoice_sources_work_order
  on public.staff_invoice_sources(work_order_id);

create or replace function public.validate_staff_invoice_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  staff_invoice public.invoices%rowtype;
  contractor_invoice public.invoices%rowtype;
begin
  select * into staff_invoice
  from public.invoices
  where id = new.staff_invoice_id;

  if not found
     or staff_invoice.invoice_type <> 'staff'
     or staff_invoice.deleted_at is not null then
    raise exception 'staff_invoice_id must reference an active staff invoice';
  end if;

  select * into contractor_invoice
  from public.invoices
  where id = new.contractor_invoice_id;

  if not found
     or contractor_invoice.invoice_type <> 'contractor'
     or contractor_invoice.deleted_at is not null then
    raise exception 'contractor_invoice_id must reference an active contractor invoice';
  end if;

  if staff_invoice.work_order_id is null
     or contractor_invoice.work_order_id is null
     or staff_invoice.work_order_id <> contractor_invoice.work_order_id then
    raise exception 'linked invoices must belong to the same work order';
  end if;

  new.work_order_id := staff_invoice.work_order_id;
  new.created_by := coalesce(new.created_by, auth.uid());
  return new;
end;
$$;

drop trigger if exists validate_staff_invoice_source_trigger
  on public.staff_invoice_sources;

create trigger validate_staff_invoice_source_trigger
  before insert or update on public.staff_invoice_sources
  for each row execute function public.validate_staff_invoice_source();

alter table public.staff_invoice_sources enable row level security;

drop policy if exists staff_invoice_sources_read
  on public.staff_invoice_sources;
create policy staff_invoice_sources_read
  on public.staff_invoice_sources
  for select using (public.is_staff());

drop policy if exists staff_invoice_sources_insert
  on public.staff_invoice_sources;
create policy staff_invoice_sources_insert
  on public.staff_invoice_sources
  for insert with check (
    public.is_staff()
    and created_by = auth.uid()
  );

drop policy if exists staff_invoice_sources_update
  on public.staff_invoice_sources;
create policy staff_invoice_sources_update
  on public.staff_invoice_sources
  for update using (public.is_staff())
  with check (public.is_staff());

drop policy if exists staff_invoice_sources_delete
  on public.staff_invoice_sources;
create policy staff_invoice_sources_delete
  on public.staff_invoice_sources
  for delete using (public.is_staff());

grant select, insert, update, delete
  on public.staff_invoice_sources to authenticated;
grant all on public.staff_invoice_sources to service_role;

