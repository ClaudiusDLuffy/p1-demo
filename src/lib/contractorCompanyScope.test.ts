import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const companyMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0056_contractor_company_scope.sql"),
  "utf8",
);
const financialMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0057_work_order_financial_privacy.sql"),
  "utf8",
);
const verification = readFileSync(
  resolve(process.cwd(), "supabase/verify_0056_0057.sql"),
  "utf8",
);

test("company members resolve to one canonical contractor without becoming staff", () => {
  assert.match(companyMigration, /current_contractor_account_id/);
  assert.match(companyMigration, /canonical_contractor_id/);
  assert.match(companyMigration, /company_admin[\s\S]*invoice[\s\S]*report_only/);
  assert.doesNotMatch(companyMigration, /role\s*=\s*'manager'/);
});

test("company scope is enforced on raw work orders, artifacts, visits, and invoices", () => {
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
    assert.match(companyMigration, new RegExp(`create policy ${policy}`), policy);
  }
  assert.match(companyMigration, /can_access_contractor_account/);
  assert.match(companyMigration, /created_at >= work_order\.contractor_assignment_started_at/);
});

test("invoice permission is a contractor capability and submitted invoices remain locked", () => {
  assert.match(companyMigration, /can_invoice_for_contractor/);
  assert.match(companyMigration, /invoice_type = 'contractor'\s+and state = 'draft'\s+and contractor_id = public\.current_contractor_account_id/);
  assert.match(companyMigration, /state = 'draft'[\s\S]*can_invoice_for_contractor/);
  assert.match(companyMigration, /state in \('draft', 'submitted'\)/);
  assert.match(companyMigration, /created_by[\s\S]*actor_id/);
});

test("completion idempotency and activity visibility follow each assignment version", () => {
  assert.match(companyMigration, /activities_one_job_completion_per_assignment/);
  assert.match(companyMigration, /protect_activity_assignment_version/);
  assert.match(companyMigration, /activities\.contractor_assignment_version\s+= work_order\.contractor_assignment_version/);
});

test("the real NTE is absent from contractor-readable work order rows", () => {
  assert.match(financialMigration, /create table if not exists public\.work_order_financials/);
  assert.match(financialMigration, /for select using \(public\.is_staff\(\)\)/);
  assert.match(financialMigration, /nte = 1000/);
  assert.match(financialMigration, /Only P1 staff may change work-order financial fields/);
  assert.match(financialMigration, /after update of nte on public\.work_orders/);
  assert.match(financialMigration, /after update of nte_flagged on public\.work_orders/);
});

test("company migrations and verification remain tenant-agnostic", () => {
  const emailLiteral = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  for (const source of [companyMigration, financialMigration, verification]) {
    assert.doesNotMatch(source, emailLiteral);
  }
});
