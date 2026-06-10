drop policy if exists inv_insert on public.invoices;

create policy inv_insert on public.invoices
  for insert with check (
    -- Staff can insert any invoice
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('manager', 'dispatcher', 'back_office')
    )
    or
    -- Direct tier contractors can only invoice their own WOs
    (
      contractor_id = auth.uid()
      and exists (
        select 1 from public.profiles
        where id = auth.uid()
        and role = 'contractor'
        and contractor_tier = 'direct'
      )
      and exists (
        select 1 from public.work_orders
        where id = work_order_id
        and contractor_id = auth.uid()
        and deleted_at is null
      )
    )
  );
