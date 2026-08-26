-- Import-ready, effective-dated location tax contract. No rates are seeded by
-- this migration. Texas ZIP codes are delivery constructs, not tax boundaries;
-- an exact address resolution from an official source is required before a
-- local rate can auto-populate.

begin;

alter table public.work_orders
  add column if not exists store_county text,
  add column if not exists store_postal_code text;

alter table public.invoices
  add column if not exists tax_rate_source text,
  add column if not exists tax_rate_reference_id uuid,
  add column if not exists tax_jurisdiction_snapshot jsonb not null default '[]'::jsonb,
  add column if not exists tax_rate_verified_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'work_orders_store_postal_code_format'
      and conrelid = 'public.work_orders'::regclass
  ) then
    alter table public.work_orders
      add constraint work_orders_store_postal_code_format
      check (
        store_postal_code is null
        or store_postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'invoices_tax_rate_source_valid'
      and conrelid = 'public.invoices'::regclass
  ) then
    alter table public.invoices
      add constraint invoices_tax_rate_source_valid
      check (
        tax_rate_source is null
        or tax_rate_source in (
          'verified_location',
          'state_default',
          'manual_override',
          'manual_amount',
          'none'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'invoices_tax_jurisdiction_snapshot_array'
      and conrelid = 'public.invoices'::regclass
  ) then
    alter table public.invoices
      add constraint invoices_tax_jurisdiction_snapshot_array
      check (jsonb_typeof(tax_jurisdiction_snapshot) = 'array');
  end if;
end
$$;

create table if not exists public.tax_rate_import_batches (
  id uuid primary key default gen_random_uuid(),
  state_code text not null,
  source_name text not null,
  source_url text not null,
  source_version text not null,
  source_file_sha256 text,
  effective_from date not null,
  imported_by uuid references public.profiles(id) on delete set null,
  imported_at timestamptz not null default now(),
  notes text,
  constraint tax_rate_import_batches_state_format
    check (state_code = upper(state_code) and state_code ~ '^[A-Z]{2}$'),
  constraint tax_rate_import_batches_source_present
    check (
      char_length(trim(source_name)) > 0
      and char_length(trim(source_url)) > 0
      and char_length(trim(source_version)) > 0
    ),
  constraint tax_rate_import_batches_sha256_format
    check (
      source_file_sha256 is null
      or source_file_sha256 ~ '^[a-f0-9]{64}$'
    ),
  unique (state_code, source_name, source_version)
);

create table if not exists public.sales_tax_location_rates (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null
    references public.tax_rate_import_batches(id) on delete restrict,
  address text not null,
  city text,
  county text,
  state_code text not null,
  postal_code text,
  normalized_address text not null default '',
  normalized_city text not null default '',
  normalized_county text not null default '',
  combined_rate numeric(8, 6) not null,
  jurisdictions jsonb not null default '[]'::jsonb,
  effective_from date not null,
  effective_to date,
  source_reference text,
  verification_status text not null default 'official',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_tax_location_rates_state_format
    check (state_code = upper(state_code) and state_code ~ '^[A-Z]{2}$'),
  constraint sales_tax_location_rates_postal_format
    check (postal_code is null or postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  constraint sales_tax_location_rates_rate_range
    check (combined_rate >= 0 and combined_rate <= 1),
  constraint sales_tax_location_rates_date_order
    check (effective_to is null or effective_to >= effective_from),
  constraint sales_tax_location_rates_jurisdictions_array
    check (jsonb_typeof(jurisdictions) = 'array'),
  constraint sales_tax_location_rates_verification
    check (verification_status in ('official', 'manually_verified')),
  constraint sales_tax_location_rates_address_present
    check (char_length(trim(address)) >= 6)
);

create index if not exists sales_tax_location_rates_exact_lookup
  on public.sales_tax_location_rates(
    state_code,
    normalized_address,
    normalized_city,
    postal_code,
    effective_from desc
  );

create or replace function public.normalize_sales_tax_location_rate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.address := trim(new.address);
  new.city := nullif(trim(coalesce(new.city, '')), '');
  new.county := nullif(trim(coalesce(new.county, '')), '');
  new.state_code := upper(trim(new.state_code));
  new.postal_code := nullif(trim(coalesce(new.postal_code, '')), '');
  new.normalized_address := lower(regexp_replace(new.address, '[[:space:]]+', ' ', 'g'));
  new.normalized_city := lower(regexp_replace(coalesce(new.city, ''), '[[:space:]]+', ' ', 'g'));
  new.normalized_county := lower(regexp_replace(coalesce(new.county, ''), '[[:space:]]+', ' ', 'g'));
  new.updated_at := now();

  -- Prevent two concurrently imported files from creating ambiguous effective
  -- periods for the same exact location.
  perform pg_advisory_xact_lock(hashtextextended(
    new.state_code || '|' || new.normalized_address || '|' ||
    new.normalized_city || '|' || coalesce(new.postal_code, ''),
    0
  ));

  if exists (
    select 1
    from public.sales_tax_location_rates rate
    where rate.id <> new.id
      and rate.state_code = new.state_code
      and rate.normalized_address = new.normalized_address
      and rate.normalized_city = new.normalized_city
      and coalesce(rate.postal_code, '') = coalesce(new.postal_code, '')
      and daterange(
        rate.effective_from,
        case when rate.effective_to is null then null else rate.effective_to + 1 end,
        '[)'
      ) && daterange(
        new.effective_from,
        case when new.effective_to is null then null else new.effective_to + 1 end,
        '[)'
      )
  ) then
    raise exception 'Location tax-rate effective dates overlap for %', new.address;
  end if;

  return new;
end;
$$;

drop trigger if exists normalize_sales_tax_location_rate_trigger
  on public.sales_tax_location_rates;
create trigger normalize_sales_tax_location_rate_trigger
  before insert or update on public.sales_tax_location_rates
  for each row execute function public.normalize_sales_tax_location_rate();

alter table public.tax_rate_import_batches enable row level security;
alter table public.sales_tax_location_rates enable row level security;

drop policy if exists tax_rate_import_batches_read
  on public.tax_rate_import_batches;
create policy tax_rate_import_batches_read
  on public.tax_rate_import_batches
  for select using (public.is_staff());

drop policy if exists sales_tax_location_rates_read
  on public.sales_tax_location_rates;
create policy sales_tax_location_rates_read
  on public.sales_tax_location_rates
  for select using (public.is_staff());

revoke all on public.tax_rate_import_batches
  from public, anon, authenticated;
grant select on public.tax_rate_import_batches to authenticated;
grant all on public.tax_rate_import_batches to service_role;

revoke all on public.sales_tax_location_rates
  from public, anon, authenticated;
grant select on public.sales_tax_location_rates to authenticated;
grant all on public.sales_tax_location_rates to service_role;

create or replace function public.resolve_location_sales_tax_rate(
  p_address text,
  p_city text,
  p_county text,
  p_state text,
  p_postal_code text,
  p_on_date date
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_address text := lower(regexp_replace(trim(coalesce(p_address, '')), '[[:space:]]+', ' ', 'g'));
  v_city text := lower(regexp_replace(trim(coalesce(p_city, '')), '[[:space:]]+', ' ', 'g'));
  v_county text := lower(regexp_replace(trim(coalesce(p_county, '')), '[[:space:]]+', ' ', 'g'));
  v_state text := upper(trim(coalesce(p_state, '')));
  v_postal text := nullif(left(regexp_replace(coalesce(p_postal_code, ''), '[^0-9]', '', 'g'), 5), '');
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_staff() then
    raise exception 'Staff access required'
      using errcode = '42501';
  end if;

  -- Exact street address is mandatory. City/county/postal data narrows and
  -- explains a match but can never make a ZIP-only row eligible.
  if char_length(regexp_replace(v_address, '[^a-z0-9]', '', 'g')) < 6
     or v_state !~ '^[A-Z]{2}$' then
    return null;
  end if;

  with candidates as (
    select
      rate,
      batch.source_name,
      batch.source_version,
      batch.source_url
    from public.sales_tax_location_rates rate
    join public.tax_rate_import_batches batch
      on batch.id = rate.import_batch_id
    where rate.state_code = v_state
      and rate.normalized_address = v_address
      and (v_city = '' or rate.normalized_city = v_city)
      and (v_county = '' or rate.normalized_county = v_county)
      and (v_postal is null or left(coalesce(rate.postal_code, ''), 5) = v_postal)
      and rate.effective_from <= coalesce(p_on_date, current_date)
      and (rate.effective_to is null or rate.effective_to >= coalesce(p_on_date, current_date))
      and rate.verification_status in ('official', 'manually_verified')
  )
  select case
    when count(*) = 1 then (
      jsonb_agg(jsonb_build_object(
        'id', (candidate.rate).id,
        'rate', (candidate.rate).combined_rate,
        'effectiveFrom', (candidate.rate).effective_from,
        'effectiveTo', (candidate.rate).effective_to,
        'jurisdictions', (candidate.rate).jurisdictions,
        'sourceName', candidate.source_name,
        'sourceVersion', candidate.source_version,
        'sourceUrl', candidate.source_url,
        'sourceReference', (candidate.rate).source_reference
      )) -> 0
    )
    else null
  end
  into v_result
  from candidates candidate;

  return v_result;
end;
$$;

revoke all on function public.resolve_location_sales_tax_rate(
  text, text, text, text, text, date
) from public, anon;
grant execute on function public.resolve_location_sales_tax_rate(
  text, text, text, text, text, date
) to authenticated, service_role;

alter table public.invoices
  drop constraint if exists invoices_tax_rate_reference_fkey;
alter table public.invoices
  add constraint invoices_tax_rate_reference_fkey
  foreign key (tax_rate_reference_id)
  references public.sales_tax_location_rates(id)
  on delete set null;

create or replace function public.stamp_staff_invoice_tax_provenance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_work_order public.work_orders%rowtype;
  v_location jsonb;
  v_state_default numeric;
begin
  if new.invoice_type <> 'staff' then
    return new;
  end if;

  new.tax_rate_reference_id := null;
  new.tax_jurisdiction_snapshot := '[]'::jsonb;
  new.tax_rate_verified_at := null;

  if new.tax_rate is null and coalesce(new.sales_tax, 0) > 0 then
    new.tax_rate_source := 'manual_amount';
    return new;
  end if;

  if new.tax_rate is null then
    new.tax_rate_source := 'none';
    return new;
  end if;

  if new.work_order_id is not null then
    select * into v_work_order
    from public.work_orders work_order
    where work_order.id = new.work_order_id;

    if found then
      v_location := public.resolve_location_sales_tax_rate(
        v_work_order.address,
        v_work_order.city,
        v_work_order.store_county,
        coalesce(new.tax_state, v_work_order.store_state),
        v_work_order.store_postal_code,
        coalesce(new.service_date, new.invoice_date, current_date)
      );
    end if;
  end if;

  if v_location is not null
     and abs(new.tax_rate - (v_location ->> 'rate')::numeric) <= 0.000001 then
    new.tax_rate_source := 'verified_location';
    new.tax_rate_reference_id := (v_location ->> 'id')::uuid;
    new.tax_jurisdiction_snapshot := coalesce(v_location -> 'jurisdictions', '[]'::jsonb);
    new.tax_rate_verified_at := now();
    return new;
  end if;

  select rate.rate into v_state_default
  from public.state_sales_tax_rates rate
  where rate.state_code = new.tax_state
    and rate.effective_from <= coalesce(new.service_date, new.invoice_date, current_date)
    and (rate.effective_to is null or rate.effective_to >= coalesce(new.service_date, new.invoice_date, current_date))
  order by rate.effective_from desc
  limit 1;

  if v_state_default is not null
     and new.tax_state <> 'TX'
     and abs(new.tax_rate - v_state_default) <= 0.000001 then
    new.tax_rate_source := 'state_default';
  else
    new.tax_rate_source := 'manual_override';
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_staff_invoice_tax_provenance_trigger
  on public.invoices;
create trigger stamp_staff_invoice_tax_provenance_trigger
  before insert or update of tax_rate, tax_state, sales_tax, work_order_id,
    service_date, invoice_date
  on public.invoices
  for each row execute function public.stamp_staff_invoice_tax_provenance();

comment on table public.sales_tax_location_rates is
  'Verified, exact-address combined tax rates with effective dates, jurisdiction breakdown, and official import provenance. ZIP-only matching is forbidden.';

commit;
