-- Drop the existing broad insert policy
drop policy if exists inv_write on public.invoices;

-- Recreate with tier check
create policy inv_insert on public.invoices
  for insert with check (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and (
        role in ('manager', 'dispatcher', 'back_office')
        or (
          role = 'contractor'
          and (
            contractor_tier = 'direct'
            or contractor_tier is null
          )
        )
      )
    )
  );

-- Keep read and other write operations as before
create policy inv_update on public.invoices
  for update using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and (
        role in ('manager', 'dispatcher', 'back_office')
        or id = contractor_id
      )
    )
  );

create policy inv_delete on public.invoices
  for delete using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('manager', 'dispatcher', 'back_office')
    )
  );
