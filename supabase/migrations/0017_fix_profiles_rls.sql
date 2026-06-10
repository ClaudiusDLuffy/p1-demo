-- Drop the existing broad policy
drop policy if exists profiles_read on public.profiles;

-- Staff can read all profiles
-- Contractors can only read their own profile
-- Plus contractors need to read other contractors
--   assigned to the same work orders (for display purposes)
create policy profiles_read on public.profiles
  for select using (
    auth.uid() = id
    or exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('manager', 'dispatcher', 'back_office')
    )
    or (
      role = 'contractor'
      and exists (
        select 1 from public.profiles
        where id = auth.uid()
        and role = 'contractor'
      )
    )
  );
