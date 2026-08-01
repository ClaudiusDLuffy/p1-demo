-- Configure the Texas state sales-tax baseline for launch. Staff may override
-- the percentage or final tax amount on an individual billing invoice.
do $$
declare
  launch_date constant date := date '2026-08-01';
  next_rate_date date;
begin
  select min(effective_from)
    into next_rate_date
  from public.state_sales_tax_rates
  where state_code = 'TX'
    and effective_from > launch_date;

  update public.state_sales_tax_rates
  set effective_to = launch_date - 1
  where state_code = 'TX'
    and effective_from < launch_date
    and (effective_to is null or effective_to >= launch_date);

  insert into public.state_sales_tax_rates (
    state_code,
    rate,
    effective_from,
    effective_to
  ) values (
    'TX',
    0.062500,
    launch_date,
    case when next_rate_date is null then null else next_rate_date - 1 end
  )
  on conflict (state_code, effective_from) do update
  set rate = excluded.rate,
      effective_to = excluded.effective_to,
      updated_at = now();
end
$$;
