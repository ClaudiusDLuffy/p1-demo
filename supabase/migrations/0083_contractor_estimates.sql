-- Contractor estimates are operational documents, not invoices. Keeping them
-- in dedicated tables prevents drafts/submissions from affecting work-order
-- billing state, money-owed totals, QuickBooks exports, or P1 markup data.
-- Conversion creates one editable contractor invoice draft atomically and
-- leaves the existing invoice submission/review workflow unchanged.

begin;

create sequence if not exists public.contractor_estimate_number_seq
  as bigint
  start with 1001
  increment by 1
  no cycle;

revoke all on sequence public.contractor_estimate_number_seq
  from public, anon, authenticated;
grant usage, select on sequence public.contractor_estimate_number_seq
  to service_role;

create table if not exists public.contractor_estimates (
  id uuid primary key default gen_random_uuid(),
  quote_num text not null default (
    'Q-' || lpad(
      nextval('public.contractor_estimate_number_seq')::text,
      6,
      '0'
    )
  ),
  work_order_id text not null
    references public.work_orders(id) on delete restrict,
  contractor_id uuid not null
    references public.profiles(id) on delete restrict,
  contractor_assignment_version integer not null,
  created_by uuid not null
    references public.profiles(id) on delete restrict,
  updated_by uuid not null
    references public.profiles(id) on delete restrict,
  quote_date date not null default current_date,
  valid_until date,
  terms text not null default 'Net 30',
  notes text,
  state text not null default 'draft',
  subtotal numeric(10,2) not null default 0,
  sales_tax numeric(10,2) not null default 0,
  total numeric(10,2)
    generated always as (round(subtotal + sales_tax, 2)) stored,
  submitted_at timestamptz,
  submitted_by uuid
    references public.profiles(id) on delete restrict,
  converted_at timestamptz,
  converted_by uuid
    references public.profiles(id) on delete restrict,
  converted_invoice_id uuid unique
    references public.invoices(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contractor_estimates_quote_num_unique unique (quote_num),
  constraint contractor_estimates_state_check
    check (state in ('draft', 'submitted', 'converted')),
  constraint contractor_estimates_amounts_check
    check (
      subtotal >= 0
      and sales_tax >= 0
      and subtotal::text not in ('NaN', 'Infinity', '-Infinity')
      and sales_tax::text not in ('NaN', 'Infinity', '-Infinity')
    ),
  constraint contractor_estimates_text_lengths_check
    check (
      char_length(quote_num) between 1 and 50
      and char_length(terms) between 1 and 100
      and char_length(coalesce(notes, '')) <= 4000
    ),
  constraint contractor_estimates_validity_check
    check (valid_until is null or valid_until >= quote_date),
  constraint contractor_estimates_conversion_check
    check (
      (
        state = 'draft'
        and submitted_at is null
        and submitted_by is null
        and converted_at is null
        and converted_by is null
        and converted_invoice_id is null
      )
      or (
        state = 'submitted'
        and submitted_at is not null
        and submitted_by is not null
        and converted_at is null
        and converted_by is null
        and converted_invoice_id is null
      )
      or (
        state = 'converted'
        and submitted_at is not null
        and submitted_by is not null
        and converted_at is not null
        and converted_by is not null
        and converted_invoice_id is not null
      )
    )
);

create table if not exists public.contractor_estimate_lines (
  id uuid primary key default gen_random_uuid(),
  estimate_id uuid not null
    references public.contractor_estimates(id) on delete cascade,
  position integer not null,
  type text not null,
  description text,
  qty numeric(10,2) not null default 1,
  rate numeric(10,2) not null default 0,
  amount numeric(10,2)
    generated always as (round(qty * rate, 2)) stored,
  constraint contractor_estimate_lines_position_unique
    unique (estimate_id, position),
  constraint contractor_estimate_lines_position_check
    check (position > 0),
  constraint contractor_estimate_lines_type_check
    check (
      type in (
        'Truck Charge',
        'Labor',
        'Parts/Hardware',
        'Shipping',
        'Other'
      )
    ),
  constraint contractor_estimate_lines_values_check
    check (
      qty > 0
      and rate >= 0
      and qty::text not in ('NaN', 'Infinity', '-Infinity')
      and rate::text not in ('NaN', 'Infinity', '-Infinity')
    ),
  constraint contractor_estimate_lines_description_length_check
    check (char_length(coalesce(description, '')) <= 1000)
);

create index if not exists contractor_estimates_work_order_recent
  on public.contractor_estimates(work_order_id, created_at desc, id desc);

create index if not exists contractor_estimates_contractor_recent
  on public.contractor_estimates(contractor_id, created_at desc, id desc);

create index if not exists contractor_estimates_assignment_scope
  on public.contractor_estimates(
    work_order_id,
    contractor_id,
    contractor_assignment_version
  );

create index if not exists contractor_estimate_lines_estimate_position
  on public.contractor_estimate_lines(estimate_id, position, id);

drop trigger if exists touch_contractor_estimates
  on public.contractor_estimates;
create trigger touch_contractor_estimates
  before update on public.contractor_estimates
  for each row execute function public.touch_updated_at();

alter table public.contractor_estimates enable row level security;
alter table public.contractor_estimate_lines enable row level security;

drop policy if exists contractor_estimates_read
  on public.contractor_estimates;
create policy contractor_estimates_read
  on public.contractor_estimates
  for select using (
    (
      public.is_staff()
      and not public.is_invoice_controller()
    )
    or (
      contractor_id = public.current_contractor_account_id()
      and public.can_invoice_for_contractor(contractor_id)
      and public.can_access_contractor_work_order(work_order_id)
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = contractor_estimates.work_order_id
          and work_order.deleted_at is null
          and work_order.contractor_id = contractor_estimates.contractor_id
          and work_order.contractor_assignment_version
            = contractor_estimates.contractor_assignment_version
      )
    )
  );

drop policy if exists contractor_estimate_lines_read
  on public.contractor_estimate_lines;
create policy contractor_estimate_lines_read
  on public.contractor_estimate_lines
  for select using (
    exists (
      select 1
      from public.contractor_estimates estimate
      where estimate.id = contractor_estimate_lines.estimate_id
        and (
          (
            public.is_staff()
            and not public.is_invoice_controller()
          )
          or (
            estimate.contractor_id = public.current_contractor_account_id()
            and public.can_invoice_for_contractor(estimate.contractor_id)
            and public.can_access_contractor_work_order(
              estimate.work_order_id
            )
            and exists (
              select 1
              from public.work_orders work_order
              where work_order.id = estimate.work_order_id
                and work_order.deleted_at is null
                and work_order.contractor_id = estimate.contractor_id
                and work_order.contractor_assignment_version
                  = estimate.contractor_assignment_version
            )
          )
        )
    )
  );

revoke all on table public.contractor_estimates
  from public, anon, authenticated;
revoke all on table public.contractor_estimate_lines
  from public, anon, authenticated;
grant select on table public.contractor_estimates
  to authenticated, service_role;
grant select on table public.contractor_estimate_lines
  to authenticated, service_role;
grant insert, update, delete on table public.contractor_estimates
  to service_role;
grant insert, update, delete on table public.contractor_estimate_lines
  to service_role;

comment on table public.contractor_estimates is
  'Contractor-authored estimates that remain outside invoice, money-owed, billing, and QuickBooks workflows until explicitly converted to one contractor invoice draft.';
comment on column public.contractor_estimates.contractor_assignment_version is
  'Pins the estimate to the contractor assignment that created it so reassignment cannot expose it to a later contractor.';
comment on column public.contractor_estimates.converted_invoice_id is
  'The one contractor invoice draft created from this estimate; conversion is idempotent.';

create or replace function public.save_contractor_estimate(
  p_estimate_id uuid,
  p_work_order_id text,
  p_quote_date date,
  p_valid_until date,
  p_terms text,
  p_notes text,
  p_sales_tax numeric,
  p_lines jsonb,
  p_submit boolean default false,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_name text;
  contractor_account_id uuid;
  work_order public.work_orders%rowtype;
  estimate public.contractor_estimates%rowtype;
  estimate_id uuid;
  normalized_quote_date date := coalesce(p_quote_date, current_date);
  normalized_terms text := coalesce(
    nullif(trim(coalesce(p_terms, '')), ''),
    'Net 30'
  );
  normalized_notes text := nullif(trim(coalesce(p_notes, '')), '');
  normalized_tax numeric := round(
    greatest(coalesce(p_sales_tax, 0), 0),
    2
  );
  line_count integer;
  calculated_subtotal numeric;
  saved_at timestamptz := clock_timestamp();
begin
  if actor_id is null then
    raise exception 'Contractor authentication is required'
      using errcode = '42501';
  end if;

  select profile.name
  into actor_name
  from public.profiles profile
  where profile.id = actor_id
    and profile.role = 'contractor'
    and profile.active = true;

  if not found then
    raise exception 'An active contractor profile is required'
      using errcode = '42501';
  end if;

  contractor_account_id := public.current_contractor_account_id();
  if contractor_account_id is null
     or not public.can_invoice_for_contractor(contractor_account_id) then
    raise exception 'Invoice-capable contractor access is required'
      using errcode = '42501';
  end if;

  select candidate.*
  into work_order
  from public.work_orders candidate
  where candidate.id = p_work_order_id
    and candidate.deleted_at is null
    and candidate.status <> 'closed'
    and candidate.contractor_id = contractor_account_id
    and candidate.contractor_assignment_started_at is not null
    and public.can_access_contractor_work_order(candidate.id)
  for update;

  if not found then
    raise exception 'This work order is unavailable for contractor estimates'
      using errcode = '42501';
  end if;

  if p_valid_until is not null
     and p_valid_until < normalized_quote_date then
    raise exception 'Valid-until date cannot be before the quote date'
      using errcode = '22023';
  end if;

  if coalesce(p_sales_tax, 0)::text in ('NaN', 'Infinity', '-Infinity')
     or coalesce(p_sales_tax, 0) < 0 then
    raise exception 'Sales tax must be a nonnegative number'
      using errcode = '22023';
  end if;

  if length(normalized_terms) > 100 then
    raise exception 'Terms cannot exceed 100 characters'
      using errcode = '22023';
  end if;

  if length(coalesce(normalized_notes, '')) > 4000 then
    raise exception 'Estimate notes cannot exceed 4000 characters'
      using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'Estimate lines must be an array'
      using errcode = '22023';
  end if;

  line_count := jsonb_array_length(coalesce(p_lines, '[]'::jsonb));
  if line_count > 100 then
    raise exception 'An estimate cannot contain more than 100 lines'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as line(type text, description text, qty numeric, rate numeric)
    where coalesce(line.type, '') not in (
            'Truck Charge',
            'Labor',
            'Parts/Hardware',
            'Shipping',
            'Other'
          )
       or coalesce(round(line.qty, 2), 0) <= 0
       or coalesce(line.rate, -1) < 0
       or coalesce(line.qty, 0)::text in ('NaN', 'Infinity', '-Infinity')
       or coalesce(line.rate, 0)::text in ('NaN', 'Infinity', '-Infinity')
       or round(line.qty, 2) > 99999999.99
       or round(line.rate, 2) > 99999999.99
       or round(round(line.qty, 2) * round(line.rate, 2), 2)
         > 99999999.99
       or char_length(coalesce(line.description, '')) > 1000
  ) then
    raise exception 'Estimate lines contain an invalid type, quantity, or rate'
      using errcode = '22023';
  end if;

  select round(
    coalesce(
      sum(round(round(line.qty, 2) * round(line.rate, 2), 2)),
      0
    ),
    2
  )
  into calculated_subtotal
  from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
    as line(qty numeric, rate numeric);

  if calculated_subtotal > 99999999.99
     or normalized_tax > 99999999.99
     or calculated_subtotal + normalized_tax > 99999999.99 then
    raise exception 'Estimate total is too large'
      using errcode = '22003';
  end if;

  if coalesce(p_submit, false) then
    if line_count = 0 or calculated_subtotal <= 0 then
      raise exception 'A submitted estimate needs at least one priced line'
        using errcode = '22023';
    end if;

    if exists (
      select 1
      from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
        as line(type text, description text)
      where line.type <> 'Truck Charge'
        and nullif(trim(coalesce(line.description, '')), '') is null
    ) then
      raise exception 'Every submitted estimate line needs a description'
        using errcode = '22023';
    end if;
  end if;

  if p_estimate_id is null then
    insert into public.contractor_estimates (
      work_order_id,
      contractor_id,
      contractor_assignment_version,
      created_by,
      updated_by,
      quote_date,
      valid_until,
      terms,
      notes,
      state,
      subtotal,
      sales_tax,
      submitted_at,
      submitted_by,
      updated_at
    ) values (
      work_order.id,
      contractor_account_id,
      work_order.contractor_assignment_version,
      actor_id,
      actor_id,
      normalized_quote_date,
      p_valid_until,
      normalized_terms,
      normalized_notes,
      case when coalesce(p_submit, false) then 'submitted' else 'draft' end,
      calculated_subtotal,
      normalized_tax,
      case when coalesce(p_submit, false) then saved_at else null end,
      case when coalesce(p_submit, false) then actor_id else null end,
      saved_at
    )
    returning * into estimate;
  else
    if p_expected_updated_at is null then
      raise exception 'Reload the draft before editing it'
        using errcode = '40001';
    end if;

    select candidate.*
    into estimate
    from public.contractor_estimates candidate
    where candidate.id = p_estimate_id
      and candidate.work_order_id = work_order.id
      and candidate.contractor_id = contractor_account_id
      and candidate.contractor_assignment_version
        = work_order.contractor_assignment_version
    for update;

    if not found then
      raise exception 'Estimate was not found for this contractor assignment'
        using errcode = 'P0002';
    end if;

    if estimate.state <> 'draft' then
      raise exception 'Only a draft estimate can be edited or submitted'
        using errcode = '40001';
    end if;

    if p_expected_updated_at is not null
       and estimate.updated_at is distinct from p_expected_updated_at then
      raise exception 'Estimate changed in another session; reload before saving'
        using errcode = '40001';
    end if;

    update public.contractor_estimates candidate
    set quote_date = normalized_quote_date,
        valid_until = p_valid_until,
        terms = normalized_terms,
        notes = normalized_notes,
        state = case
          when coalesce(p_submit, false) then 'submitted'
          else 'draft'
        end,
        subtotal = calculated_subtotal,
        sales_tax = normalized_tax,
        submitted_at = case
          when coalesce(p_submit, false) then saved_at
          else null
        end,
        submitted_by = case
          when coalesce(p_submit, false) then actor_id
          else null
        end,
        updated_by = actor_id,
        updated_at = saved_at
    where candidate.id = estimate.id
      and candidate.state = 'draft'
    returning * into estimate;

    if not found then
      raise exception 'Estimate changed before it could be saved'
        using errcode = '40001';
    end if;

    delete from public.contractor_estimate_lines line
    where line.estimate_id = estimate.id;
  end if;

  estimate_id := estimate.id;

  if line_count > 0 then
    insert into public.contractor_estimate_lines (
      estimate_id,
      position,
      type,
      description,
      qty,
      rate
    )
    select
      estimate_id,
      line.ordinality::integer,
      line.item ->> 'type',
      nullif(trim(coalesce(line.item ->> 'description', '')), ''),
      round((line.item ->> 'qty')::numeric, 2),
      round((line.item ->> 'rate')::numeric, 2)
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
      with ordinality as line(item, ordinality);
  end if;

  if coalesce(p_submit, false) then
    insert into public.activities (
      work_order_id,
      author_id,
      author_name,
      text,
      type,
      event_key,
      event_data
    ) values (
      work_order.id,
      actor_id,
      actor_name,
      format(
        'Estimate #%s submitted. Total: $%s.',
        estimate.quote_num,
        to_char(estimate.total, 'FM999999990.00')
      ),
      'system',
      'contractor_estimate_submitted',
      jsonb_build_object(
        'estimateId', estimate.id,
        'quoteNum', estimate.quote_num,
        'state', estimate.state,
        'total', estimate.total
      )
    );
  end if;

  return jsonb_build_object(
    'estimateId', estimate.id,
    'quoteNum', estimate.quote_num,
    'state', estimate.state,
    'workOrderId', estimate.work_order_id,
    'subtotal', estimate.subtotal,
    'salesTax', estimate.sales_tax,
    'total', estimate.total,
    'updatedAt', estimate.updated_at
  );
end;
$$;

create or replace function public.convert_contractor_estimate_to_invoice(
  p_estimate_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_name text;
  contractor_account_id uuid;
  estimate public.contractor_estimates%rowtype;
  work_order public.work_orders%rowtype;
  invoice public.invoices%rowtype;
  invoice_num text;
  attempt integer := 0;
  conversion_time timestamptz := clock_timestamp();
begin
  if actor_id is null then
    raise exception 'Contractor authentication is required'
      using errcode = '42501';
  end if;

  select profile.name
  into actor_name
  from public.profiles profile
  where profile.id = actor_id
    and profile.role = 'contractor'
    and profile.active = true;

  if not found then
    raise exception 'An active contractor profile is required'
      using errcode = '42501';
  end if;

  contractor_account_id := public.current_contractor_account_id();
  if contractor_account_id is null
     or not public.can_invoice_for_contractor(contractor_account_id) then
    raise exception 'Invoice-capable contractor access is required'
      using errcode = '42501';
  end if;

  select candidate.*
  into estimate
  from public.contractor_estimates candidate
  where candidate.id = p_estimate_id
    and candidate.contractor_id = contractor_account_id
  for update;

  if not found then
    raise exception 'Estimate was not found'
      using errcode = 'P0002';
  end if;

  select candidate.*
  into work_order
  from public.work_orders candidate
  where candidate.id = estimate.work_order_id
    and candidate.deleted_at is null
    and candidate.status <> 'closed'
    and candidate.contractor_id = estimate.contractor_id
    and candidate.contractor_assignment_version
      = estimate.contractor_assignment_version
    and candidate.contractor_assignment_started_at is not null
    and public.can_access_contractor_work_order(candidate.id)
  for update;

  if not found then
    raise exception 'This estimate no longer belongs to the current contractor assignment'
      using errcode = '42501';
  end if;

  if estimate.state = 'converted'
     and estimate.converted_invoice_id is not null then
    select candidate.*
    into invoice
    from public.invoices candidate
    where candidate.id = estimate.converted_invoice_id
      and candidate.invoice_type = 'contractor'
      and candidate.deleted_at is null;

    if not found then
      raise exception 'The converted invoice is unavailable'
        using errcode = 'P0002';
    end if;

    return jsonb_build_object(
      'estimateId', estimate.id,
      'quoteNum', estimate.quote_num,
      'invoiceId', invoice.id,
      'invoiceNum', invoice.num,
      'invoiceState', invoice.state,
      'workOrderId', estimate.work_order_id,
      'alreadyConverted', true
    );
  end if;

  if estimate.state <> 'submitted' then
    raise exception 'Submit the estimate before converting it to an invoice'
      using errcode = '40001';
  end if;

  if estimate.total <= 0
     or not exists (
       select 1
       from public.contractor_estimate_lines line
       where line.estimate_id = estimate.id
     ) then
    raise exception 'The estimate has no priced lines to convert'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('contractor-invoice-number'));

  while attempt < 6 loop
    invoice_num := public.next_contractor_invoice_num();
    begin
      insert into public.invoices (
        num,
        work_order_id,
        store_number,
        store_address,
        contractor_id,
        cme,
        invoice_date,
        service_date,
        due_date,
        terms,
        state,
        subtotal,
        sales_tax,
        total,
        created_by,
        invoice_type
      ) values (
        invoice_num,
        work_order.id,
        work_order.store_number,
        work_order.address,
        estimate.contractor_id,
        estimate.notes,
        current_date,
        null,
        current_date + 30,
        estimate.terms,
        'draft',
        estimate.subtotal,
        estimate.sales_tax,
        estimate.total,
        actor_id,
        'contractor'
      )
      returning * into invoice;

      exit;
    exception when unique_violation then
      attempt := attempt + 1;
    end;
  end loop;

  if invoice.id is null then
    raise exception 'Could not allocate an invoice number for this estimate'
      using errcode = '23505';
  end if;

  insert into public.invoice_lines (
    invoice_id,
    position,
    type,
    description,
    qty,
    rate
  )
  select
    invoice.id,
    line.position,
    line.type,
    line.description,
    line.qty,
    line.rate
  from public.contractor_estimate_lines line
  where line.estimate_id = estimate.id
  order by line.position, line.id;

  update public.contractor_estimates candidate
  set state = 'converted',
      converted_invoice_id = invoice.id,
      converted_at = conversion_time,
      converted_by = actor_id,
      updated_by = actor_id,
      updated_at = conversion_time
  where candidate.id = estimate.id
    and candidate.state = 'submitted'
  returning * into estimate;

  if not found then
    raise exception 'Estimate changed before it could be converted'
      using errcode = '40001';
  end if;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data
  ) values (
    work_order.id,
    actor_id,
    actor_name,
    format(
      'Estimate #%s converted to invoice #%s draft.',
      estimate.quote_num,
      invoice.num
    ),
    'system',
    'contractor_estimate_converted',
    jsonb_build_object(
      'estimateId', estimate.id,
      'quoteNum', estimate.quote_num,
      'invoiceId', invoice.id,
      'invoiceNum', invoice.num,
      'invoiceState', invoice.state,
      'total', invoice.total
    )
  );

  return jsonb_build_object(
    'estimateId', estimate.id,
    'quoteNum', estimate.quote_num,
    'invoiceId', invoice.id,
    'invoiceNum', invoice.num,
    'invoiceState', invoice.state,
    'workOrderId', estimate.work_order_id,
    'alreadyConverted', false
  );
end;
$$;

revoke all on function public.save_contractor_estimate(
  uuid,
  text,
  date,
  date,
  text,
  text,
  numeric,
  jsonb,
  boolean,
  timestamptz
) from public, anon;
revoke all on function public.convert_contractor_estimate_to_invoice(uuid)
  from public, anon;

grant execute on function public.save_contractor_estimate(
  uuid,
  text,
  date,
  date,
  text,
  text,
  numeric,
  jsonb,
  boolean,
  timestamptz
) to authenticated, service_role;
grant execute on function public.convert_contractor_estimate_to_invoice(uuid)
  to authenticated, service_role;

do $$
begin
  alter publication supabase_realtime
    add table public.contractor_estimates;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

commit;
