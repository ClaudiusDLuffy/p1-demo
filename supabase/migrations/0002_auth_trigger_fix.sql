-- ═══════════════════════════════════════════════════════════════
--  P1 Service Portal — auth trigger + unique email enforcement (0002)
-- ═══════════════════════════════════════════════════════════════
-- Recreates the handle_new_user trigger after it was dropped. This
-- fires on every new Supabase Auth signup and makes sure a matching
-- public.profiles row exists.
--
-- Key behaviors:
--   • Idempotent — re-running is safe (CREATE OR REPLACE + DROP IF EXISTS)
--   • Pulls name + role from raw_user_meta_data if the signup included them
--   • ON CONFLICT (id) DO NOTHING handles re-runs cleanly
--   • Exception handler swallows unique_violation on email so a signup
--     never fails just because a pre-seeded profile with that email exists
--   • SECURITY DEFINER so the function runs with the creator's privileges
--
-- Profiles.email already has UNIQUE (email) from 0001, so the "enforce
-- unique emails" invariant is satisfied at the schema level.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, role, initials, color)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'contractor'),
    upper(left(coalesce(new.raw_user_meta_data->>'name', new.email), 2)),
    '#C15F3C'
  )
  on conflict (id) do nothing;
  return new;
exception
  when unique_violation then
    -- email already belongs to a pre-seeded profile; don't block the signup
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
