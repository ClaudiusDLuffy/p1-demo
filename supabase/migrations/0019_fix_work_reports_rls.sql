drop policy if exists work_reports_insert on public.work_reports;

create policy work_reports_insert on public.work_reports
  for insert with check (
    contractor_id = auth.uid()
    and exists (
      select 1 from public.work_orders
      where id = work_order_id
      and contractor_id = auth.uid()
      and deleted_at is null
    )
  );

drop policy if exists work_reports_update on public.work_reports;

create policy work_reports_update on public.work_reports
  for update using (
    contractor_id = auth.uid()
    or exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('manager', 'dispatcher', 'back_office')
    )
  );
