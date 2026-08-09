import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0058_individual_contractor_technician_scope.sql"),
  "utf8",
);

test("portal technician identity is linked to one profile and one active job", () => {
  assert.match(migration, /contractor_technicians[\s\S]*profile_id uuid/);
  assert.match(migration, /contractor_technicians_profile_unique/);
  assert.match(migration, /work_order_technician_one_current/);
  assert.match(migration, /assigned_technician_profile_id uuid/);
});

test("report-only access requires the technician's explicit work-order assignment", () => {
  assert.match(migration, /can_access_contractor_work_order/);
  assert.match(
    migration,
    /viewer\.contractor_access_level = 'report_only'[\s\S]*work_order\.assigned_technician_profile_id = viewer\.id/,
  );
  for (const policy of [
    "wo_read",
    "act_read",
    "photo_read",
    "wo_parts_select",
    "service_notes_read",
    "work_reports_select",
    "work_order_visits_read",
    "inv_read",
    "line_read",
    "invoice_pdfs_read",
  ]) {
    assert.match(migration, new RegExp(`create policy ${policy}`), policy);
  }
});

test("only staff and company admins assign a validated report-only member", () => {
  assert.match(migration, /can_manage_work_order_technician/);
  assert.match(migration, /viewer\.contractor_access_level = 'company_admin'/);
  assert.match(migration, /profile\.contractor_access_level = 'report_only'/);
  assert.match(migration, /assign_contractor_technician/);
  assert.match(migration, /work_order_technician_assignments/);
});

test("report-only technicians cannot use contractor invoice reads", () => {
  assert.match(
    migration,
    /invoice_type = 'contractor'[\s\S]*can_invoice_for_contractor\(contractor_id\)[\s\S]*can_access_contractor_work_order\(work_order_id\)/,
  );
});

test("technician migration is tenant-agnostic", () => {
  assert.doesNotMatch(migration, /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
});

