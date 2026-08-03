-- Submit a contractor invoice as one transaction. A stable client key makes
-- retries return the original invoice instead of creating another header.

begin;

alter table public.invoices
  add column if not exists submission_key uuid;

create unique index if not exists invoices_contractor_submission_key_unique
  on public.invoices(contractor_id, submission_key)
  where submission_key is not null;

create or replace function public.submit_contractor_invoice_once(
  p_submission_key uuid,
  p_work_order_id text,
  p_num text,
  p_user_typed_num boolean,
  p_cme text,
  p_store_address text,
  p_invoice_date date,
  p_service_date date,
  p_due_date date,
  p_terms text,
  p_sales_tax numeric,
  p_total_override numeric,
  p_lines jsonb
)
returns public.invoices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_name text;
  work_order public.work_orders%rowtype;
  saved_invoice public.invoices%rowtype;
  requested_num text := nullif(trim(coalesce(p_num, '')), '');
  final_num text;
  v_invoice_subtotal numeric(10,2);
  v_invoice_tax numeric(10,2) := round(greatest(coalesce(p_sales_tax, 0), 0), 2);
  v_invoice_total numeric(10,2);
  line_count integer := 0;
  attempt integer := 0;
begin
  if actor_id is null then
    raise exception 'Authentication is required'
      using errcode = '42501';
  end if;

  if p_submission_key is null then
    raise exception 'A submission key is required'
      using errcode = '22023';
  end if;

  select invoice.*
    into saved_invoice
  from public.invoices invoice
  where invoice.contractor_id = actor_id
    and invoice.submission_key = p_submission_key;

  if found then
    return saved_invoice;
  end if;

  select profile.name
    into actor_name
  from public.profiles profile
  where profile.id = actor_id
    and profile.role = 'contractor'
    and profile.contractor_tier = 'direct'
    and profile.active = true;

  if not found then
    raise exception 'Only active direct contractors may submit invoices'
      using errcode = '42501';
  end if;

  select candidate.*
    into work_order
  from public.work_orders candidate
  where candidate.id = p_work_order_id
    and candidate.contractor_id = actor_id
    and candidate.deleted_at is null
  for update;

  if not found then
    raise exception 'This work order is not assigned to your company'
      using errcode = '42501';
  end if;

  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'Invoice lines must be an array'
      using errcode = '22023';
  end if;

  select
    count(*)::integer,
    round(
      coalesce(
        sum(
          round(coalesce(line.qty, 1), 2)
          * round(coalesce(line.rate, 0), 2)
        ),
        0
      ),
      2
    )
    into line_count, v_invoice_subtotal
  from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
    as line(type text, description text, qty numeric, rate numeric);

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as line(type text, description text, qty numeric, rate numeric)
    where coalesce(line.qty, 0) <= 0
       or coalesce(line.rate, -1) < 0
  ) then
    raise exception 'Invoice lines require a positive quantity and non-negative rate'
      using errcode = '22023';
  end if;

  if p_total_override is not null then
    v_invoice_total := round(p_total_override, 2);
    v_invoice_subtotal := greatest(v_invoice_total - v_invoice_tax, 0);
  else
    v_invoice_total := v_invoice_subtotal + v_invoice_tax;
  end if;

  if v_invoice_total <= 0 then
    raise exception 'Invoice total must be greater than zero'
      using errcode = '22023';
  end if;

  -- Serializing number allocation avoids two automatic submissions choosing
  -- the same next number. The unique index remains the final authority.
  perform pg_advisory_xact_lock(hashtext('contractor-invoice-number'));

  final_num := coalesce(requested_num, public.next_contractor_invoice_num());

  while attempt < 6 loop
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
        invoice_type,
        submission_key
      ) values (
        final_num,
        work_order.id,
        work_order.store_number,
        coalesce(
          nullif(trim(coalesce(p_store_address, '')), ''),
          work_order.address
        ),
        actor_id,
        nullif(trim(coalesce(p_cme, '')), ''),
        coalesce(p_invoice_date, current_date),
        p_service_date,
        p_due_date,
        coalesce(nullif(trim(coalesce(p_terms, '')), ''), 'Net 30'),
        'draft',
        v_invoice_subtotal,
        v_invoice_tax,
        v_invoice_total,
        actor_id,
        'contractor',
        p_submission_key
      )
      returning * into saved_invoice;

      exit;
    exception when unique_violation then
      select invoice.*
        into saved_invoice
      from public.invoices invoice
      where invoice.contractor_id = actor_id
        and invoice.submission_key = p_submission_key;

      if found then
        return saved_invoice;
      end if;

      if coalesce(p_user_typed_num, false) then
        raise exception 'Invoice #% already exists for this contractor', final_num
          using errcode = '23505';
      end if;

      final_num := public.next_contractor_invoice_num();
      attempt := attempt + 1;
    end;
  end loop;

  if saved_invoice.id is null then
    raise exception 'Could not allocate an unused invoice number'
      using errcode = '23505';
  end if;

  if line_count > 0 then
    insert into public.invoice_lines (
      invoice_id,
      position,
      type,
      description,
      qty,
      rate
    )
    select
      saved_invoice.id,
      line.ordinality::integer,
      coalesce(nullif(trim(line.item ->> 'type'), ''), 'Other'),
      coalesce(line.item ->> 'description', ''),
      round(coalesce(nullif(line.item ->> 'qty', '')::numeric, 1), 2),
      round(coalesce(nullif(line.item ->> 'rate', '')::numeric, 0), 2)
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
      with ordinality as line(item, ordinality);
  end if;

  update public.invoices invoice
  set state = 'submitted',
      updated_at = now()
  where invoice.id = saved_invoice.id
  returning invoice.* into saved_invoice;

  update public.work_orders
  set status = 'pending_approval',
      invoice_total = v_invoice_total,
      updated_at = now()
  where id = work_order.id;

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
      'Invoice %s submitted. Total: $%s.',
      saved_invoice.num,
      to_char(v_invoice_total, 'FM999999990.00')
    ),
    'system',
    'invoice_submitted',
    jsonb_build_object(
      'invoiceId', saved_invoice.id,
      'invoiceNum', saved_invoice.num,
      'total', v_invoice_total,
      'submissionKey', p_submission_key
    )
  );

  return saved_invoice;
end;
$$;

revoke all on function public.submit_contractor_invoice_once(
  uuid, text, text, boolean, text, text, date, date, date, text, numeric, numeric, jsonb
) from public, anon;
grant execute on function public.submit_contractor_invoice_once(
  uuid, text, text, boolean, text, text, date, date, date, text, numeric, numeric, jsonb
) to authenticated;

commit;
