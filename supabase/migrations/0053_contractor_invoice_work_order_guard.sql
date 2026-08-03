-- Keep contractor invoice ownership tied to the work order selected when the
-- draft was created. Staff retain their existing correction workflows.

begin;

create or replace function public.enforce_contractor_invoice_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
begin
  -- Service-role operations and P1 staff use the existing staff policies.
  if actor_id is null or public.is_staff() then
    return new;
  end if;

  if old.invoice_type = 'contractor'
     and old.contractor_id = actor_id then
    if new.contractor_id is distinct from old.contractor_id
       or new.work_order_id is distinct from old.work_order_id
       or new.invoice_type is distinct from old.invoice_type
       or new.created_by is distinct from old.created_by then
      raise exception 'Contractor invoice ownership cannot be changed'
        using errcode = '42501';
    end if;

    if not exists (
      select 1
      from public.work_orders work_order
      where work_order.id = old.work_order_id
        and work_order.contractor_id = actor_id
        and work_order.deleted_at is null
    ) then
      raise exception 'This work order is no longer assigned to your company'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_contractor_invoice_identity()
  from public, anon, authenticated;

drop trigger if exists enforce_contractor_invoice_identity_trigger
  on public.invoices;
create trigger enforce_contractor_invoice_identity_trigger
  before update on public.invoices
  for each row execute function public.enforce_contractor_invoice_identity();

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
      and exists (
        select 1
        from public.profiles profile
        where profile.id = auth.uid()
          and profile.role = 'contractor'
          and profile.contractor_tier = 'direct'
      )
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = invoices.work_order_id
          and work_order.contractor_id = auth.uid()
          and work_order.deleted_at is null
      )
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
      and exists (
        select 1
        from public.profiles profile
        where profile.id = auth.uid()
          and profile.role = 'contractor'
          and profile.contractor_tier = 'direct'
      )
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = invoices.work_order_id
          and work_order.contractor_id = auth.uid()
          and work_order.deleted_at is null
      )
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
            and exists (
              select 1
              from public.work_orders work_order
              where work_order.id = invoice.work_order_id
                and work_order.contractor_id = auth.uid()
                and work_order.deleted_at is null
            )
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
            and exists (
              select 1
              from public.work_orders work_order
              where work_order.id = invoice.work_order_id
                and work_order.contractor_id = auth.uid()
                and work_order.deleted_at is null
            )
          )
        )
    )
  );

commit;
