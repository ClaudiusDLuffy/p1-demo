import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0101_enforce_active_staff_authorization.sql");
const profileSecurity = read("supabase/migrations/0056_contractor_company_scope.sql");
const strictWorkOrderScope = read(
  "supabase/migrations/0091_strict_contractor_technician_assignment_scope.sql",
);

test("the shared staff RLS helper requires an active authenticated profile", () => {
  assert.match(migration, /profile\.id = auth\.uid\(\)/);
  assert.match(migration, /profile\.active = true/);
  assert.match(migration, /profile\.role in \('manager', 'dispatcher', 'back_office'\)/);
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = public, pg_temp/);
});

test("inactive sessions cannot invoke the helper anonymously", () => {
  assert.match(
    migration,
    /revoke all on function public\.is_staff\(\) from public, anon/,
  );
  assert.match(
    migration,
    /grant execute on function public\.is_staff\(\) to authenticated, service_role/,
  );
});

test("profile self-service and work-order scope inherit active-staff revocation", () => {
  assert.match(profileSecurity, /public\.is_staff\(\)[\s\S]*return new/);
  assert.match(strictWorkOrderScope, /select public\.is_staff\(\)/);
});

test("the store directory follows current work-order authorization", () => {
  assert.match(migration, /drop policy if exists stores_read on public\.stores/);
  assert.match(migration, /public\.is_staff\(\)/);
  assert.match(
    migration,
    /work_order\.store_number = stores\.store_number[\s\S]*public\.can_access_contractor_work_order\(work_order\.id\)/,
  );
  assert.doesNotMatch(migration, /stores_read[\s\S]*auth\.uid\(\) is not null/);
  assert.match(migration, /revoke select on public\.stores from anon/);
});
