alter table public.work_orders
  add column if not exists asset_year integer
    default null,
  add column if not exists repair_quote numeric(10,2)
    default null,
  add column if not exists install_quote numeric(10,2)
    default null,
  add column if not exists capital_notes text
    default null;

comment on column public.work_orders.asset_year is
  '7-Eleven required field for capital replacements.
   Mandatory when is_capital = true.';

comment on column public.work_orders.repair_quote is
  'Vendor repair quote amount for capital evaluation.';

comment on column public.work_orders.install_quote is
  'Vendor installation quote amount for capital evaluation.';
