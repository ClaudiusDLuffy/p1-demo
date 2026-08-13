-- Persist a P1-to-7-Eleven invoice header, line items, source links, and audit
-- entry in one transaction. This prevents a saved header total from outliving
-- missing line items when any later write fails.

begin;

create or replace function public.save_staff_billing_invoice(
  p_actor_id uuid,
  p_invoice_id uuid,
  p_num text,
  p_work_order_id text,
  p_store_number text,
  p_store_address text,
  p_cme text,
  p_invoice_date date,
  p_service_date date,
  p_due_date date,
  p_terms text,
  p_state text,
  p_sales_tax numeric,
  p_tax_state text,
  p_tax_rate numeric,
  p_territory text,
  p_lines jsonb,
  p_source_invoice_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_name text;
  v_actor_role text;
  v_invoice_id uuid := p_invoice_id;
  v_existing public.invoices%rowtype;
  v_previous_num text;
  v_previous_state text;
  v_num text := trim(coalesce(p_num, ''));
  v_work_order_id text := nullif(trim(coalesce(p_work_order_id, '')), '');
  v_store_number text := trim(coalesce(p_store_number, ''));
  v_territory text := trim(coalesce(p_territory, ''));
  v_state public.invoice_state;
  v_tax_state text := nullif(upper(trim(coalesce(p_tax_state, ''))), '');
  v_sales_tax numeric(10, 2);
  v_subtotal numeric(10, 2);
  v_total numeric(10, 2);
  v_source_invoice_ids uuid[] := '{}'::uuid[];
  v_source_count integer := 0;
  v_line_count integer := 0;
  v_action text;
  v_audit_text text;
begin
  select profile.name, profile.role::text
  into v_actor_name, v_actor_role
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.active = true;

  if v_actor_role not in ('manager', 'dispatcher', 'back_office') then
    raise exception 'Active staff access is required'
      using errcode = '42501';
  end if;

  if v_num = ''
     or length(v_num) > 80
     or v_num ~ '[[:cntrl:]]' then
    raise exception 'Invoice number is invalid'
      using errcode = '22023';
  end if;

  if p_invoice_date is null then
    raise exception 'Invoice date is required'
      using errcode = '22023';
  end if;

  if v_store_number = '' then
    raise exception 'Store number is required'
      using errcode = '22023';
  end if;

  if v_territory = '' then
    raise exception 'Territory is required'
      using errcode = '22023';
  end if;

  if p_state not in ('draft', 'submitted') then
    raise exception 'P1 billing invoices may only be saved as draft or submitted'
      using errcode = '22023';
  end if;
  v_state := p_state::public.invoice_state;

  if p_sales_tax is null or p_sales_tax < 0 then
    raise exception 'Sales tax must be zero or greater'
      using errcode = '22023';
  end if;
  v_sales_tax := round(p_sales_tax, 2);

  if v_tax_state is not null and v_tax_state !~ '^[A-Z]{2}$' then
    raise exception 'Tax state is invalid'
      using errcode = '22023';
  end if;

  if p_tax_rate is not null and (p_tax_rate < 0 or p_tax_rate > 1) then
    raise exception 'Tax rate is invalid'
      using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'Invoice lines must be an array'
      using errcode = '22023';
  end if;

  select
    count(*)::integer,
    round(
      coalesce(sum(round(line.qty, 2) * round(line.rate, 2)), 0),
      2
    )
  into v_line_count, v_subtotal
  from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as line(
    type text,
    description text,
    qty numeric,
    rate numeric,
    is_taxable boolean,
    source_invoice_line_id uuid,
    source_unit_cost numeric,
    markup_percent numeric
  );

  if v_line_count = 0 then
    raise exception 'At least one valid line item is required'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as line(
      type text,
      description text,
      qty numeric,
      rate numeric,
      is_taxable boolean,
      source_invoice_line_id uuid,
      source_unit_cost numeric,
      markup_percent numeric
    )
    where nullif(trim(coalesce(line.type, '')), '') is null
       or coalesce(line.qty, 0) <= 0
       or coalesce(line.rate, 0) <= 0
       or coalesce(line.source_unit_cost, 0) < 0
       or coalesce(line.markup_percent, 0) < 0
       or (
         nullif(trim(coalesce(line.description, '')), '') is null
         and lower(trim(coalesce(line.type, ''))) not in ('travel', 'truck charge')
       )
  ) then
    raise exception 'One or more invoice lines are invalid'
      using errcode = '22023';
  end if;

  v_total := round(v_subtotal + v_sales_tax, 2);

  if v_work_order_id is not null and not exists (
    select 1
    from public.work_orders work_order
    where work_order.id = v_work_order_id
      and work_order.deleted_at is null
  ) then
    raise exception 'Linked work order was not found'
      using errcode = '23503';
  end if;

  select coalesce(array_agg(distinct source_id order by source_id), '{}'::uuid[])
  into v_source_invoice_ids
  from unnest(coalesce(p_source_invoice_ids, '{}'::uuid[])) as source(source_id);
  v_source_count := cardinality(v_source_invoice_ids);

  if v_source_count > 0 and v_work_order_id is null then
    raise exception 'A work order is required when contractor invoices are linked'
      using errcode = '22023';
  end if;

  -- Lock selected contractor invoices before checking their links. Concurrent
  -- staff saves that select the same source then serialize here.
  if v_source_count > 0 then
    perform 1
    from public.invoices source_invoice
    where source_invoice.id = any(v_source_invoice_ids)
    order by source_invoice.id
    for update;

    if (
      select count(*)
      from public.invoices source_invoice
      where source_invoice.id = any(v_source_invoice_ids)
        and source_invoice.invoice_type = 'contractor'
        and source_invoice.deleted_at is null
        and source_invoice.work_order_id = v_work_order_id
        and source_invoice.state not in ('draft', 'rejected')
    ) <> v_source_count then
      raise exception 'Source invoices must be live contractor invoices on the selected work order'
        using errcode = '22023';
    end if;

    if exists (
      select 1
      from public.staff_invoice_sources source_link
      join public.invoices staff_invoice
        on staff_invoice.id = source_link.staff_invoice_id
       and staff_invoice.invoice_type = 'staff'
       and staff_invoice.deleted_at is null
      where source_link.contractor_invoice_id = any(v_source_invoice_ids)
        and source_link.staff_invoice_id is distinct from p_invoice_id
    ) then
      raise exception 'A selected contractor invoice is already linked to another active P1 invoice'
        using errcode = '55000';
    end if;
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as line(
      type text,
      description text,
      qty numeric,
      rate numeric,
      is_taxable boolean,
      source_invoice_line_id uuid,
      source_unit_cost numeric,
      markup_percent numeric
    )
    where line.source_invoice_line_id is not null
      and not exists (
        select 1
        from public.invoice_lines source_line
        where source_line.id = line.source_invoice_line_id
          and source_line.invoice_id = any(v_source_invoice_ids)
      )
  ) then
    raise exception 'A line item references an invalid contractor invoice line'
      using errcode = '23503';
  end if;

  if p_invoice_id is null then
    insert into public.invoices (
      num,
      invoice_type,
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
      tax_state,
      tax_rate,
      total,
      territory,
      created_by
    ) values (
      v_num,
      'staff',
      v_work_order_id,
      v_store_number,
      nullif(trim(coalesce(p_store_address, '')), ''),
      null,
      nullif(trim(coalesce(p_cme, '')), ''),
      p_invoice_date,
      p_service_date,
      p_due_date,
      coalesce(nullif(trim(coalesce(p_terms, '')), ''), 'Net 30'),
      v_state,
      v_subtotal,
      v_sales_tax,
      v_tax_state,
      p_tax_rate,
      v_total,
      v_territory,
      p_actor_id
    )
    returning id into v_invoice_id;

    v_previous_num := null;
    v_previous_state := null;
  else
    select invoice.*
    into v_existing
    from public.invoices invoice
    where invoice.id = p_invoice_id
      and invoice.invoice_type = 'staff'
      and invoice.deleted_at is null
    for update;

    if not found then
      raise exception 'Billing invoice not found'
        using errcode = 'P0002';
    end if;

    if v_existing.state not in ('draft', 'submitted') then
      raise exception 'Approved, paid, rejected, or revised billing invoices are locked'
        using errcode = '55000';
    end if;

    if v_existing.qbo_invoice_id is not null or v_existing.qbo_synced_at is not null then
      raise exception 'QuickBooks-synced billing invoices are locked'
        using errcode = '55000';
    end if;

    v_previous_num := v_existing.num;
    v_previous_state := v_existing.state::text;

    update public.invoices invoice
    set
      num = v_num,
      work_order_id = v_work_order_id,
      store_number = v_store_number,
      store_address = nullif(trim(coalesce(p_store_address, '')), ''),
      contractor_id = null,
      cme = nullif(trim(coalesce(p_cme, '')), ''),
      invoice_date = p_invoice_date,
      service_date = p_service_date,
      due_date = p_due_date,
      terms = coalesce(nullif(trim(coalesce(p_terms, '')), ''), 'Net 30'),
      state = v_state,
      subtotal = v_subtotal,
      sales_tax = v_sales_tax,
      tax_state = v_tax_state,
      tax_rate = p_tax_rate,
      total = v_total,
      territory = v_territory,
      updated_at = now()
    where invoice.id = p_invoice_id;
  end if;

  delete from public.invoice_lines line
  where line.invoice_id = v_invoice_id;

  insert into public.invoice_lines (
    invoice_id,
    position,
    type,
    description,
    qty,
    rate,
    is_taxable,
    source_invoice_line_id,
    source_unit_cost,
    markup_percent
  )
  select
    v_invoice_id,
    line.ordinality::integer,
    trim(line.item ->> 'type'),
    coalesce(line.item ->> 'description', ''),
    round((line.item ->> 'qty')::numeric, 2),
    round((line.item ->> 'rate')::numeric, 2),
    coalesce((line.item ->> 'is_taxable')::boolean, false),
    nullif(line.item ->> 'source_invoice_line_id', '')::uuid,
    nullif(line.item ->> 'source_unit_cost', '')::numeric,
    nullif(line.item ->> 'markup_percent', '')::numeric
  from jsonb_array_elements(p_lines)
    with ordinality as line(item, ordinality);

  if (
    select count(*)
    from public.invoice_lines line
    where line.invoice_id = v_invoice_id
  ) <> v_line_count
  or abs(
    coalesce((
      select round(sum(line.amount), 2)
      from public.invoice_lines line
      where line.invoice_id = v_invoice_id
    ), 0) - v_subtotal
  ) > 0.01 then
    raise exception 'Saved invoice lines did not reconcile to the invoice subtotal'
      using errcode = '23514';
  end if;

  delete from public.staff_invoice_sources source_link
  where source_link.staff_invoice_id = v_invoice_id;

  if v_source_count > 0 then
    insert into public.staff_invoice_sources (
      staff_invoice_id,
      contractor_invoice_id,
      work_order_id,
      created_by
    )
    select
      v_invoice_id,
      source_id,
      v_work_order_id,
      p_actor_id
    from unnest(v_source_invoice_ids) as source(source_id);
  end if;

  if v_work_order_id is not null then
    if p_invoice_id is null then
      v_action := case
        when v_state = 'submitted' then 'prepared for 7-Eleven submission'
        else 'created'
      end;
      v_audit_text := format(
        'P1 invoice #%s %s%s.',
        v_num,
        v_action,
        case
          when v_source_count = 0 then ''
          else format(
            ' from %s contractor invoice%s',
            v_source_count,
            case when v_source_count = 1 then '' else 's' end
          )
        end
      );
    else
      v_action := case
        when v_state = 'submitted' and v_previous_state <> 'submitted'
          then 'prepared for 7-Eleven submission'
        when v_state = 'submitted' then 'updated'
        else 'draft updated'
      end;
      v_audit_text := case
        when v_previous_num <> v_num then format(
          'P1 invoice #%s renumbered to #%s and %s.',
          v_previous_num,
          v_num,
          v_action
        )
        else format('P1 invoice #%s %s.', v_num, v_action)
      end;
    end if;

    insert into public.activities (
      work_order_id,
      author_id,
      author_name,
      text,
      type,
      is_staff_override,
      is_staff_only,
      event_key,
      event_data
    ) values (
      v_work_order_id,
      p_actor_id,
      coalesce(v_actor_name, 'P1 staff'),
      v_audit_text,
      'system',
      false,
      true,
      'staff_billing',
      jsonb_build_object(
        'action', case when p_invoice_id is null then 'created' else 'updated' end,
        'invoiceId', v_invoice_id,
        'previousInvoiceNum', v_previous_num,
        'invoiceNum', v_num,
        'renumbered', coalesce(v_previous_num <> v_num, false),
        'lineCount', v_line_count,
        'sourceInvoiceCount', v_source_count,
        'subtotal', v_subtotal,
        'salesTax', v_sales_tax,
        'total', v_total
      )
    );
  end if;

  return v_invoice_id;
end;
$$;

revoke all on function public.save_staff_billing_invoice(
  uuid, uuid, text, text, text, text, text, date, date, date, text,
  text, numeric, text, numeric, text, jsonb, uuid[]
) from public, anon, authenticated;
grant execute on function public.save_staff_billing_invoice(
  uuid, uuid, text, text, text, text, text, date, date, date, text,
  text, numeric, text, numeric, text, jsonb, uuid[]
) to service_role;

commit;
