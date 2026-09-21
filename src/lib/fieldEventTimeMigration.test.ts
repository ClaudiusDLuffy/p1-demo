import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("supabase/migrations/0162_enforce_field_event_time_order.sql", "utf8");
const verification = readFileSync("supabase/audits/0162_enforce_field_event_time_order_verification.sql", "utf8");
const installedDefinitions = migration.slice(migration.indexOf("create or replace function"));

test("all three field commands reject events beyond bounded clock skew", () => {
  assert.equal((migration.match(/clock_timestamp\(\) \+ interval '5 minutes'/g) || []).length, 3);
  assert.match(migration, /Check-in time cannot be in the future/);
  assert.match(migration, /Checkout time cannot be in the future/);
  assert.match(migration, /Completion time cannot be in the future/);
});

test("checkout and completion report chronology separately from contractor drift", () => {
  assert.match(migration, /Checkout time cannot be before active visit check-in/);
  assert.match(migration, /Completion time cannot be before active visit check-in/);
  assert.ok((migration.match(/The active visit contractor does not match this work order/g) || []).length >= 2);
  assert.doesNotMatch(installedDefinitions, /The active visit does not match this (?:checkout|completion)/);
});

test("parallel billing, capital checkout, team technician identity, and RPC grants remain intact", () => {
  assert.match(migration, /coalesce\(v_work\.assigned_technician_profile_id, auth\.uid\(\)\)/);
  assert.match(migration, /'capitalStagePreserved',v_capital_checkout/);
  assert.match(migration, /when v_work\.status::text in \('pending_invoice','pending_approval','pending_payment'\)/);
  assert.match(migration, /revoke all on function public\.begin_work_order_visit_command[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(migration, /grant execute on function public\.pause_work_order_for_parts_v1[\s\S]*to authenticated/);
});

test("deployment check is read-only and verifies the installed time policy", () => {
  assert.match(verification, /PASS_0162_INSTALLED/);
  assert.match(verification, /arrival_policy_installed/);
  assert.match(verification, /checkout_policy_installed/);
  assert.match(verification, /completion_policy_installed/);
  assert.doesNotMatch(verification, /^\s*(?:insert|update|delete|truncate|alter|grant|revoke|create|drop)\s/im);
});
