import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  "supabase/migrations/0165_identify_visit_correction_overlap.sql",
  "utf8",
);

test("overlap guidance preserves serialized correction and the private policy core", () => {
  assert.match(migration, /create or replace function public\.correct_work_order_visit\(/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /work_order_lifecycle_transition_guards/i);
  assert.match(migration, /public\.correct_work_order_visit_lc_core\(/i);
  assert.doesNotMatch(migration, /create or replace function public\.correct_work_order_visit_lc_core\(/i);
});

test("overlap details are bounded to work orders the actor can already access", () => {
  assert.match(migration, /coalesce\(other\.technician_profile_id, other\.checked_in_by\) = v_technician_id/i);
  assert.match(migration, /can_access_contractor_work_order\(other\.work_order_id\)/i);
  assert.match(migration, /conflictingWorkOrderIds/i);
  assert.match(migration, /VISIT_TIME_OVERLAP/i);
  assert.match(migration, /errcode = 'PT409'/i);
});

test("overlap guidance keeps the public RPC pinned and least privileged", () => {
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/i);
  assert.match(migration, /revoke all on function public\.correct_work_order_visit[\s\S]*from public, anon/i);
  assert.match(migration, /grant execute on function public\.correct_work_order_visit[\s\S]*to authenticated, service_role/i);
});
