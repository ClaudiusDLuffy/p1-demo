-- Let staff correct a contractor-entered total without replacing the source
-- PDF or line items, and prevent contractor changes after submission.

create or replace function public.correct_contractor_invoice_total(
  p_invoice_id uuid,
  p_total numeric,
  p_reason text default null
)
returns public.invoices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_name text;
  invoice public.invoices%rowtype;
  old_total numeric;
  corrected_total numeric;
  correction_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if actor_id is null or not public.is_staff() then
    raise exception 'Only P1 staff may correct contractor invoice totals'
      using errcode = '42501';
  end if;

  corrected_total := round(p_total, 2);
  if corrected_total <= 0 then
    raise exception 'Corrected total must be greater than zero'
      using errcode = '22023';
  end if;

  select *
    into invoice
  from public.invoices
  where id = p_invoice_id
    and invoice_type = 'contractor'
    and deleted_at is null
  for update;

  if not found then
    raise exception 'Contractor invoice was not found'
      using errcode = 'P0002';
  end if;

  if public.is_invoice_controller()
     and invoice.state not in ('approved', 'paid') then
    raise exception 'The controller can only correct an approved invoice'
      using errcode = '42501';
  end if;

  old_total := invoice.total;

  select name
    into actor_name
  from public.profiles
  where id = actor_id;

  update public.invoices
  set total = corrected_total,
      subtotal = greatest(corrected_total - coalesce(sales_tax, 0), 0),
      updated_at = now()
  where id = p_invoice_id
  returning * into invoice;

  if invoice.work_order_id is not null then
    insert into public.activities (
      work_order_id,
      author_id,
      author_name,
      text,
      type,
      is_staff_only,
      event_key,
      event_data
    ) values (
      invoice.work_order_id,
      actor_id,
      coalesce(actor_name, 'P1 staff'),
      format(
        'Corrected contractor invoice #%s total from $%s to $%s.%s',
        invoice.num,
        to_char(old_total, 'FM999999990.00'),
        to_char(corrected_total, 'FM999999990.00'),
        case
          when correction_reason is null then ''
          else ' Reason: ' || correction_reason
        end
      ),
      'system',
      true,
      'contractor_invoice_total_corrected',
      jsonb_build_object(
        'invoiceId', invoice.id,
        'invoiceNum', invoice.num,
        'oldTotal', old_total,
        'newTotal', corrected_total,
        'reason', correction_reason
      )
    );
  end if;

  return invoice;
end;
$$;

revoke all on function public.correct_contractor_invoice_total(uuid, numeric, text)
  from public, anon;
grant execute on function public.correct_contractor_invoice_total(uuid, numeric, text)
  to authenticated, service_role;

create or replace function public.attach_contractor_invoice_pdf(
  p_invoice_id uuid,
  p_storage_path text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  invoice public.invoices%rowtype;
begin
  if actor_id is null then
    raise exception 'Authentication is required'
      using errcode = '42501';
  end if;

  if nullif(trim(coalesce(p_storage_path, '')), '') is null then
    raise exception 'PDF storage path is required'
      using errcode = '22023';
  end if;

  select *
    into invoice
  from public.invoices
  where id = p_invoice_id
    and invoice_type = 'contractor'
    and deleted_at is null
  for update;

  if not found then
    raise exception 'Contractor invoice was not found'
      using errcode = 'P0002';
  end if;

  if not public.is_staff() and not (
    invoice.contractor_id = actor_id
    and (
      invoice.state = 'draft'
      or (
        invoice.state = 'submitted'
        and invoice.pdf_storage_path is null
      )
    )
  ) then
    raise exception 'This invoice PDF is locked'
      using errcode = '42501';
  end if;

  update public.invoices
  set pdf_storage_path = trim(p_storage_path),
      updated_at = now()
  where id = p_invoice_id;
end;
$$;

revoke all on function public.attach_contractor_invoice_pdf(uuid, text)
  from public, anon;
grant execute on function public.attach_contractor_invoice_pdf(uuid, text)
  to authenticated, service_role;

drop policy if exists inv_update on public.invoices;
create policy inv_update on public.invoices
  for update using (
    (
      exists (
        select 1
        from public.profiles
        where id = auth.uid()
          and role in ('manager', 'dispatcher', 'back_office')
      )
      and (
        not public.is_invoice_controller()
        or (
          invoice_type = 'contractor'
          and state = 'approved'
        )
      )
    )
    or (
      contractor_id = auth.uid()
      and invoice_type = 'contractor'
      and state = 'draft'
    )
  )
  with check (
    (
      exists (
        select 1
        from public.profiles
        where id = auth.uid()
          and role in ('manager', 'dispatcher', 'back_office')
      )
      and (
        not public.is_invoice_controller()
        or (
          invoice_type = 'contractor'
          and state = 'paid'
        )
      )
    )
    or (
      contractor_id = auth.uid()
      and invoice_type = 'contractor'
      and state in ('draft', 'submitted')
    )
  );

drop policy if exists line_write on public.invoice_lines;
create policy line_write on public.invoice_lines
  for all using (
    exists (
      select 1
      from public.invoices invoice
      where invoice.id = invoice_id
        and (
          (
            public.is_staff()
            and not public.is_invoice_controller()
          )
          or (
            invoice.contractor_id = auth.uid()
            and invoice.invoice_type = 'contractor'
            and invoice.state = 'draft'
          )
        )
    )
  )
  with check (
    exists (
      select 1
      from public.invoices invoice
      where invoice.id = invoice_id
        and (
          (
            public.is_staff()
            and not public.is_invoice_controller()
          )
          or (
            invoice.contractor_id = auth.uid()
            and invoice.invoice_type = 'contractor'
            and invoice.state = 'draft'
          )
        )
    )
  );
