import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  "supabase/migrations/0166_stabilize_visit_overlap_ranges.sql",
  "utf8",
);
const audit = readFileSync(
  "supabase/audits/0166_stabilize_visit_overlap_ranges_verification.sql",
  "utf8",
);

test("visit correction overlap ranges remain valid for future-open legacy rows", () => {
  assert.match(migration, /create or replace function public\.correct_work_order_visit_lc_core\(/i);
  assert.match(migration, /create or replace function public\.correct_work_order_visit\(/i);
  assert.equal(
    migration.match(/greatest\(other\.check_in_at, coalesce\(other\.check_out_at, now\(\)\)\)/gi)?.length,
    2,
  );
  assert.doesNotMatch(
    migration,
    /tstzrange\(other\.check_in_at, coalesce\(other\.check_out_at, now\(\)\), '\[\)'\)/i,
  );
});

test("range stabilization preserves overlap policy, audit evidence, and least privilege", () => {
  assert.match(migration, /The corrected time overlaps another visit for this technician/i);
  assert.match(migration, /insert into public\.work_order_visit_corrections/i);
  assert.match(migration, /'visit_time_corrected'/i);
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/i);
  assert.match(
    migration,
    /revoke all on function public\.correct_work_order_visit_lc_core[\s\S]*from public, anon, authenticated, service_role/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.correct_work_order_visit[\s\S]*to authenticated, service_role/i,
  );
});

test("deployment audit proves both corrected definitions and a safe empty future interval", () => {
  assert.match(audit, /PASS_0166_INSTALLED/);
  assert.match(audit, /safe_overlap_ranges_installed/);
  assert.match(audit, /future_open_interval_is_safe/);
  assert.match(audit, /private_core_not_executable/);
});
