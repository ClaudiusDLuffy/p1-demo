import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  "supabase/migrations/0150_restore_multi_admin_private_object_access.sql",
  "utf8",
);

test("private object access restores every valid company admin without changing historical migrations", () => {
  assert.match(migration, /create or replace function public\.private_object_actor_access/);
  assert.match(migration, /or profile\.contractor_access_level = 'company_admin'/);
  assert.doesNotMatch(
    migration,
    /profile\.id\s*=\s*organization\.canonical_contractor_id\s+and\s+profile\.contractor_access_level\s*=\s*'company_admin'/,
  );
  assert.match(migration, /canonical_profile\.id = organization\.canonical_contractor_id/);
  assert.match(migration, /canonical_profile\.active/);
  assert.match(migration, /work_order\.contractor_id = case[\s\S]*canonical_profile\.id/);
  assert.match(migration, /technician\.contractor_id = work_order\.contractor_id/);
  assert.match(migration, /not p_invoice_capable[\s\S]*profile\.contractor_access_level = 'company_admin'/);
});

test("the corrective migration is data-preserving and retains private routine grants", () => {
  assert.doesNotMatch(migration, /\b(?:insert|update|delete|truncate)\s+(?:into\s+|from\s+)?public\./i);
  assert.match(migration, /revoke all on function public\.private_object_actor_access/);
  assert.match(migration, /grant execute on function public\.private_object_actor_access[\s\S]*authenticated, service_role/);
});
