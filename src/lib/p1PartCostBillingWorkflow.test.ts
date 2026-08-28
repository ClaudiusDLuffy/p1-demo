import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0092_p1_part_costs_and_billing.sql");
const equipmentTagMigration = read("supabase/migrations/0097_quickbooks_equipment_tags.sql");
const route = read("src/app/api/billing-invoices/route.ts");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const editor = read("src/features/billing/BillingInvoiceCreateModal.tsx");

test("P1 purchase cost is private and available only through guarded staff RPCs", () => {
  assert.match(migration, /create table if not exists public\.p1_part_costs/);
  assert.match(migration, /alter table public\.p1_part_costs enable row level security/);
  assert.match(
    migration,
    /revoke all on public\.p1_part_costs, public\.p1_part_cost_audit[\s\S]*from public, anon, authenticated/,
  );
  assert.doesNotMatch(
    migration,
    /grant\s+(?:select|all)[\s\S]{0,100}public\.p1_part_costs[\s\S]{0,100}authenticated/i,
  );
  assert.match(migration, /list_p1_part_costs_for_work_order[\s\S]*not public\.is_staff\(\)/);
  assert.match(detail, /useP1PartCostsQuery\([\s\S]*detailEnabled && isManager/);
  assert.match(detail, /isManager \? \([\s\S]*P1 unit cost/);
});

test("ordered P1 parts require a positive cost and are billed once at exactly 25 percent markup", () => {
  assert.match(migration, /p_status in \('ordered', 'received'\)[\s\S]*v_cost <= 0/);
  assert.match(migration, /round\(cost\.unit_cost \* 1\.25, 2\)/);
  assert.match(migration, /invoice_lines_invoice_p1_part_unique/);
  assert.match(migration, /for update/);
  assert.match(migration, /source_part_cost <= 0/);
  assert.match(migration, /markup_percent, -1\), 4\) <> 25\.0000/);
  assert.match(migration, /already billed on another active invoice/);
  assert.match(migration, /before changing this billed P1 part/);
});

test("server canonicalizes and injects every eligible P1 part before tax and atomic save", () => {
  const canonicalizeAt = route.indexOf("async function canonicalizeP1PartLines");
  const resolveTaxAt = route.indexOf("async function resolveTax");
  assert.ok(canonicalizeAt >= 0 && resolveTaxAt > canonicalizeAt);
  assert.match(route, /rpc\("list_billable_p1_parts"/);
  assert.match(route, /for \(const part of billableParts \|\| \[\]\)/);
  assert.match(route, /markupPercent: 25/);
  assert.match(route, /save_staff_billing_invoice_v3/);
  assert.match(equipmentTagMigration, /public\.save_staff_billing_invoice_v2\(/);
  assert.match(migration, /auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /public\.save_staff_billing_invoice\(/);
  assert.match(migration, /set source_work_order_part_id = requested\.part_id/);
});

test("billing editor refreshes, locks, and cannot omit a P1-purchased part", () => {
  assert.match(editor, /useBillableP1PartsQuery/);
  assert.match(editor, /replace\(\[\.\.\.normalizedCurrentLines, \.\.\.additions\]\)/);
  assert.match(editor, /readOnly=\{isP1PurchasedPart\}/);
  assert.match(editor, /disabled=\{isP1PurchasedPart\}/);
  assert.match(editor, /P1-purchased parts are required on this invoice/);
});
