-- Configure Florida's state sales-tax baseline. County surtax remains an
-- invoice-level staff override until the client provides store rate tables.
do $$
declare
  launch_date constant date := date '2026-08-04';
  next_rate_date date;
begin
  select min(effective_from)
    into next_rate_date
  from public.state_sales_tax_rates
  where state_code = 'FL'
    and effective_from > launch_date;

  update public.state_sales_tax_rates
  set effective_to = launch_date - 1
  where state_code = 'FL'
    and effective_from < launch_date
    and (effective_to is null or effective_to >= launch_date);

  insert into public.state_sales_tax_rates (
    state_code,
    rate,
    effective_from,
    effective_to
  ) values (
    'FL',
    0.060000,
    launch_date,
    case when next_rate_date is null then null else next_rate_date - 1 end
  )
  on conflict (state_code, effective_from) do update
  set rate = excluded.rate,
      effective_to = excluded.effective_to,
      updated_at = now();
end
$$;
