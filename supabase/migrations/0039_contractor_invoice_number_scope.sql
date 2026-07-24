-- Contractor invoice numbers originate in each vendor's accounting system.
-- Different contractors may legitimately use the same number, while a
-- contractor must not reuse one of its own invoice numbers.

alter table public.invoices
  drop constraint if exists invoices_num_key;

create unique index if not exists invoices_staff_num_unique
  on public.invoices(num)
  where invoice_type = 'staff';

create unique index if not exists invoices_contractor_num_per_vendor_unique
  on public.invoices(
    coalesce(contractor_id, '00000000-0000-0000-0000-000000000000'::uuid),
    num
  )
  where invoice_type = 'contractor';
