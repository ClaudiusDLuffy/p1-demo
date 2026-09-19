import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../../supabase/migrations/0155_preserve_parallel_billing_during_field_visits.sql", import.meta.url),
  "utf8",
);

test("resume accepts a paused field state without erasing a billing queue", () => {
  assert.match(migration, /v_work\.status::text in \('parts','pending_invoice','pending_approval','pending_payment'\)/);
  assert.match(migration, /when v_regular_resume and v_work\.status::text in \('pending_invoice','pending_approval','pending_payment'\)[\s\S]*then v_work\.status/);
});

test("pause preserves a parallel billing queue", () => {
  assert.match(migration, /when v_work\.status::text in \('pending_invoice','pending_approval','pending_payment'\) then v_work\.status/);
  assert.match(migration, /functional_status='Awaiting Parts'/);
});

test("the private visit owner remains inaccessible and the public pause command remains authenticated", () => {
  assert.match(migration, /revoke all on function public\.begin_work_order_visit_command[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(migration, /grant execute on function public\.pause_work_order_for_parts_v1[\s\S]*to authenticated/);
});
