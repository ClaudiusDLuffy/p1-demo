-- Add invoice_type to distinguish contractor invoices from staff
-- P1-to-7-Eleven billing invoices.

alter table public.invoices
  add column if not exists invoice_type text
  not null default 'contractor'
  check (invoice_type in ('contractor', 'staff'));

update public.invoices
set invoice_type = 'contractor'
where invoice_type is null or invoice_type = '';

create index if not exists idx_inv_type
  on public.invoices(invoice_type);

drop policy if exists inv_read on public.invoices;

create policy inv_read on public.invoices
  for select using (
    deleted_at is null
    and (
      public.is_staff()
      or (
        contractor_id = auth.uid()
        and invoice_type = 'contractor'
      )
    )
  );

drop policy if exists inv_insert on public.invoices;

create policy inv_insert on public.invoices
  for insert with check (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('manager', 'dispatcher', 'back_office')
    )
    or
    (
      invoice_type = 'contractor'
      and contractor_id = auth.uid()
      and exists (
        select 1 from public.profiles
        where id = auth.uid()
        and role = 'contractor'
        and contractor_tier = 'direct'
      )
      and exists (
        select 1 from public.work_orders
        where id = invoices.work_order_id
        and contractor_id = auth.uid()
        and deleted_at is null
      )
    )
  );

drop policy if exists inv_update on public.invoices;

create policy inv_update on public.invoices
  for update using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('manager', 'dispatcher', 'back_office')
    )
    or (
      contractor_id = auth.uid()
      and invoice_type = 'contractor'
    )
  )
  with check (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('manager', 'dispatcher', 'back_office')
    )
    or (
      contractor_id = auth.uid()
      and invoice_type = 'contractor'
    )
  );

drop policy if exists inv_delete on public.invoices;

create policy inv_delete on public.invoices
  for delete using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('manager', 'dispatcher', 'back_office')
    )
  );

drop policy if exists line_read on public.invoice_lines;

create policy line_read on public.invoice_lines
  for select using (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_id
      and i.deleted_at is null
      and (
        public.is_staff()
        or (
          i.contractor_id = auth.uid()
          and i.invoice_type = 'contractor'
        )
      )
    )
  );

drop policy if exists line_write on public.invoice_lines;

create policy line_write on public.invoice_lines
  for all using (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_id
      and (
        public.is_staff()
        or (
          i.contractor_id = auth.uid()
          and i.invoice_type = 'contractor'
        )
      )
    )
  )
  with check (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_id
      and (
        public.is_staff()
        or (
          i.contractor_id = auth.uid()
          and i.invoice_type = 'contractor'
        )
      )
    )
  );

drop policy if exists invoice_pdfs_read on storage.objects;

create policy invoice_pdfs_read on storage.objects
  for select using (
    bucket_id = 'invoice-pdfs'
    and (
      exists (
        select 1 from public.profiles
        where id = auth.uid()
        and role in ('manager', 'dispatcher', 'back_office')
      )
      or exists (
        select 1 from public.invoices i
        where i.contractor_id = auth.uid()
        and i.invoice_type = 'contractor'
        and i.pdf_storage_path = name
      )
    )
  );
