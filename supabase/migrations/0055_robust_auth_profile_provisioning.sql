-- Keep Auth user creation independent of the caller's search path and ignore
-- unknown role metadata instead of rolling back the auth.users insert.

begin;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  profile_name text := coalesce(
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'name', '')), ''),
    split_part(new.email, '@', 1)
  );
  requested_role text := lower(
    trim(coalesce(new.raw_user_meta_data ->> 'role', ''))
  );
  profile_role public.user_role := 'contractor'::public.user_role;
begin
  if requested_role in (
    'manager',
    'dispatcher',
    'back_office',
    'contractor'
  ) then
    profile_role := requested_role::public.user_role;
  end if;

  insert into public.profiles (
    id,
    name,
    email,
    role,
    initials,
    color
  ) values (
    new.id,
    profile_name,
    lower(new.email),
    profile_role,
    upper(left(profile_name, 2)),
    '#C15F3C'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function public.handle_new_user()
  from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

commit;
