-- Read-only preflight. A previously reused local database retained legacy
-- permissive policies alongside the canonical policy, invalidating browser
-- authorization evidence. Never silently repair that state while seeding.
do $baseline$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'photos'
      and policyname = 'canonical_photo_read' and cmd = 'SELECT'
  ) or exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'photos'
      and policyname <> 'canonical_photo_read'
  ) or has_table_privilege('authenticated', 'public.photos', 'INSERT,UPDATE,DELETE') then
    raise exception 'Synthetic database has private-object policy drift. Rebuild the disposable local schema from existing migrations before testing.';
  end if;
end;
$baseline$;
