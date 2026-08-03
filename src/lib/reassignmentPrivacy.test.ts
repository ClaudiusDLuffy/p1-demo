import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0052_reassignment_receiving_contractor_privacy.sql"),
  "utf8",
);

test("reassignment privacy establishes a new assignment boundary", () => {
  assert.match(migration, /contractor_assignment_started_at timestamptz/);
  assert.match(migration, /protect_work_order_assignment_boundary/);
  assert.match(migration, /new\.contractor_assignment_started_at := boundary_at/);
  assert.match(migration, /new\.dispatched_at := boundary_at/);
});

test("receiving contractors cannot read prior contractor artifacts", () => {
  for (const table of ["activities", "photos", "wo_parts", "service_notes"]) {
    assert.match(
      migration,
      new RegExp(`${table}\\.created_at >= w\\.contractor_assignment_started_at`),
      `${table} must be limited to the current assignment`,
    );
  }

  assert.match(migration, /p\.created_at >= w\.contractor_assignment_started_at/);
  assert.match(migration, /contractor_id = auth\.uid\(\)[\s\S]*w\.contractor_id = auth\.uid\(\)/);
});

test("prior contractor workflow is archived for staff and cleared for the recipient", () => {
  assert.match(migration, /work_order_assignment_history/);
  assert.match(migration, /for select using \(public\.is_staff\(\)\)/);

  for (const field of [
    "eta",
    "start_time",
    "end_time",
    "technician_on_job",
    "asset_make",
    "resolution_notes",
    "part_needed",
    "invoice_total",
    "repair_quote",
  ]) {
    assert.match(migration, new RegExp(`new\\.${field} := null`));
  }
});

test("contractor profile lookup no longer exposes the competitor directory", () => {
  assert.match(
    migration,
    /create policy profiles_read[\s\S]*auth\.uid\(\) = id[\s\S]*public\.get_my_role\(\) in/,
  );
  assert.doesNotMatch(migration, /or role = 'contractor'/);
});
