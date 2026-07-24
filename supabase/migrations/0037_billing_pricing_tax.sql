-- Add state-aware billing snapshots and staff-only pricing metadata. Tax
-- rates are intentionally not seeded; staff must load approved rates before
-- the application calculates tax.

alter table public.work_orders
  add column if not exists store_state text,
  add column if not exists store_timezone text;

alter table public.invoices
  add column if not exists tax_state text,
  add column if not exists tax_rate numeric(8, 6);

alter table public.invoice_lines
  add column if not exists is_taxable boolean not null default false,
  add column if not exists source_invoice_line_id uuid
    references public.invoice_lines(id) on delete set null,
  add column if not exists source_unit_cost numeric(10, 2),
  add column if not exists markup_percent numeric(9, 4);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'work_orders_store_state_format'
      and conrelid = 'public.work_orders'::regclass
  ) then
    alter table public.work_orders
      add constraint work_orders_store_state_format
      check (
        store_state is null
        or (
          store_state = upper(store_state)
          and store_state ~ '^[A-Z]{2}$'
        )
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'invoices_tax_state_format'
      and conrelid = 'public.invoices'::regclass
  ) then
    alter table public.invoices
      add constraint invoices_tax_state_format
      check (
        tax_state is null
        or (
          tax_state = upper(tax_state)
          and tax_state ~ '^[A-Z]{2}$'
        )
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'invoices_tax_rate_range'
      and conrelid = 'public.invoices'::regclass
  ) then
    alter table public.invoices
      add constraint invoices_tax_rate_range
      check (tax_rate is null or (tax_rate >= 0 and tax_rate <= 1));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'invoices_contractor_tax_metadata_empty'
      and conrelid = 'public.invoices'::regclass
  ) then
    alter table public.invoices
      add constraint invoices_contractor_tax_metadata_empty
      check (
        invoice_type = 'staff'
        or (tax_state is null and tax_rate is null)
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'invoice_lines_source_unit_cost_nonnegative'
      and conrelid = 'public.invoice_lines'::regclass
  ) then
    alter table public.invoice_lines
      add constraint invoice_lines_source_unit_cost_nonnegative
      check (source_unit_cost is null or source_unit_cost >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'invoice_lines_markup_percent_nonnegative'
      and conrelid = 'public.invoice_lines'::regclass
  ) then
    alter table public.invoice_lines
      add constraint invoice_lines_markup_percent_nonnegative
      check (markup_percent is null or markup_percent >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'invoice_lines_source_not_self'
      and conrelid = 'public.invoice_lines'::regclass
  ) then
    alter table public.invoice_lines
      add constraint invoice_lines_source_not_self
      check (
        source_invoice_line_id is null
        or source_invoice_line_id <> id
      );
  end if;
end
$$;

create index if not exists idx_work_orders_store_state
  on public.work_orders(store_state)
  where store_state is not null and deleted_at is null;

create index if not exists idx_invoice_lines_source
  on public.invoice_lines(source_invoice_line_id)
  where source_invoice_line_id is not null;

create table if not exists public.state_sales_tax_rates (
  id uuid primary key default gen_random_uuid(),
  state_code text not null,
  rate numeric(8, 6) not null,
  effective_from date not null,
  effective_to date,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint state_sales_tax_rates_state_format
    check (
      state_code = upper(state_code)
      and state_code ~ '^[A-Z]{2}$'
    ),
  constraint state_sales_tax_rates_rate_range
    check (rate >= 0 and rate <= 1),
  constraint state_sales_tax_rates_date_order
    check (effective_to is null or effective_to >= effective_from),
  constraint state_sales_tax_rates_state_start_unique
    unique (state_code, effective_from)
);

create index if not exists idx_state_sales_tax_rates_lookup
  on public.state_sales_tax_rates(
    state_code,
    effective_from desc,
    effective_to
  );

create or replace function public.validate_state_sales_tax_rate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.state_code := upper(trim(new.state_code));

  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_by := old.created_by;
  end if;

  -- Serialize changes per state so concurrent inserts cannot create
  -- overlapping effective periods after both pass the overlap check.
  perform pg_advisory_xact_lock(hashtextextended(new.state_code, 0));

  if exists (
    select 1
    from public.state_sales_tax_rates r
    where r.state_code = new.state_code
      and r.id <> new.id
      and daterange(
        r.effective_from,
        case
          when r.effective_to is null then null
          else r.effective_to + 1
        end,
        '[)'
      ) && daterange(
        new.effective_from,
        case
          when new.effective_to is null then null
          else new.effective_to + 1
        end,
        '[)'
      )
  ) then
    raise exception 'Tax-rate effective dates overlap for state %',
      new.state_code;
  end if;

  return new;
end;
$$;

drop trigger if exists validate_state_sales_tax_rate_trigger
  on public.state_sales_tax_rates;

create trigger validate_state_sales_tax_rate_trigger
  before insert or update on public.state_sales_tax_rates
  for each row execute function public.validate_state_sales_tax_rate();

drop trigger if exists touch_state_sales_tax_rates
  on public.state_sales_tax_rates;

create trigger touch_state_sales_tax_rates
  before update on public.state_sales_tax_rates
  for each row execute function public.touch_updated_at();

alter table public.state_sales_tax_rates enable row level security;

drop policy if exists state_sales_tax_rates_read
  on public.state_sales_tax_rates;
create policy state_sales_tax_rates_read
  on public.state_sales_tax_rates
  for select using (public.is_staff());

drop policy if exists state_sales_tax_rates_insert
  on public.state_sales_tax_rates;
create policy state_sales_tax_rates_insert
  on public.state_sales_tax_rates
  for insert with check (public.is_staff());

drop policy if exists state_sales_tax_rates_update
  on public.state_sales_tax_rates;
create policy state_sales_tax_rates_update
  on public.state_sales_tax_rates
  for update using (public.is_staff())
  with check (public.is_staff());

drop policy if exists state_sales_tax_rates_delete
  on public.state_sales_tax_rates;
create policy state_sales_tax_rates_delete
  on public.state_sales_tax_rates
  for delete using (public.is_staff());

revoke all on public.state_sales_tax_rates from anon;
grant select, insert, update, delete
  on public.state_sales_tax_rates to authenticated;
grant all on public.state_sales_tax_rates to service_role;

-- Contractors can still manage their own contractor invoice lines, but all
-- tax/source-cost/markup metadata is reserved for staff invoice lines.
create or replace function public.protect_invoice_line_billing_metadata()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_role text := coalesce(auth.role(), '');
  actor_is_staff boolean := public.is_staff();
  target_invoice_type text;
  target_work_order_id text;
  source_invoice_type text;
  source_work_order_id text;
begin
  select i.invoice_type, i.work_order_id
  into target_invoice_type, target_work_order_id
  from public.invoices i
  where i.id = new.invoice_id
    and i.deleted_at is null;

  if not found then
    raise exception 'Invoice line must reference an active invoice';
  end if;

  if target_invoice_type = 'contractor' then
    if new.is_taxable
       or new.source_invoice_line_id is not null
       or new.source_unit_cost is not null
       or new.markup_percent is not null then
      raise exception 'Contractor invoice lines cannot contain staff billing metadata'
        using errcode = '42501';
    end if;

    return new;
  end if;

  if target_invoice_type <> 'staff' then
    raise exception 'Unsupported invoice type';
  end if;

  if actor_role not in ('service_role', '')
     and not actor_is_staff then
    raise exception 'Staff access required for billing metadata'
      using errcode = '42501';
  end if;

  if new.source_invoice_line_id is not null then
    select i.invoice_type, i.work_order_id
    into source_invoice_type, source_work_order_id
    from public.invoice_lines source_line
    join public.invoices i on i.id = source_line.invoice_id
    where source_line.id = new.source_invoice_line_id
      and i.deleted_at is null;

    if not found or source_invoice_type <> 'contractor' then
      raise exception 'Source line must belong to an active contractor invoice';
    end if;

    if target_work_order_id is null
       or source_work_order_id is null
       or target_work_order_id <> source_work_order_id then
      raise exception 'Source and staff invoice lines must share a work order';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_invoice_line_billing_metadata_trigger
  on public.invoice_lines;

create trigger protect_invoice_line_billing_metadata_trigger
  before insert or update on public.invoice_lines
  for each row execute function public.protect_invoice_line_billing_metadata();
