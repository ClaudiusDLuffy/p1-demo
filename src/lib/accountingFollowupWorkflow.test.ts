import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const equipmentMigration = read("supabase/migrations/0097_quickbooks_equipment_tags.sql");
const readyMigration = read("supabase/migrations/0098_staff_invoice_ready_transition.sql");
const attachmentMigration = read("supabase/migrations/0099_contractor_estimate_attachments.sql");
const billingRoute = read("src/app/api/billing-invoices/route.ts");
const billingDetail = read("src/features/billing/BillingInvoiceDetail.tsx");
const estimatePanel = read("src/features/estimates/ContractorEstimatePanel.tsx");
const capitalProjects = read("src/features/work-orders/CapitalProjects.tsx");
const workOrderList = read("src/features/work-orders/WorkOrderList.tsx");

test("QuickBooks equipment tags are persisted atomically and validated server-side", () => {
  assert.match(equipmentMigration, /add column if not exists equipment_tag text/);
  assert.match(equipmentMigration, /invoices_equipment_tag_check/);
  assert.match(equipmentMigration, /save_staff_billing_invoice_v3/);
  assert.match(equipmentMigration, /v_invoice_id := public\.save_staff_billing_invoice_v2/);
  assert.match(equipmentMigration, /set equipment_tag = p_equipment_tag/);
  assert.match(billingRoute, /isQuickBooksEquipmentTag\(body\.equipmentTag\)/);
  assert.match(billingRoute, /save_staff_billing_invoice_v3/);
});

test("quote-converted drafts have an explicit guarded ready transition", () => {
  assert.match(readyMigration, /create or replace function public\.mark_staff_invoice_ready/);
  assert.match(readyMigration, /for update/);
  assert.match(readyMigration, /set state = 'submitted'/);
  assert.match(readyMigration, /invoice_type = 'staff'/);
  assert.match(billingRoute, /body\.action === "mark_ready"/);
  assert.match(billingDetail, /Ready for 7-Eleven/);
});

test("estimate forms stay private, assignment-scoped, and limited to xlsx drafts", () => {
  assert.match(attachmentMigration, /alter table public\.contractor_estimate_attachments enable row level security/);
  assert.match(attachmentMigration, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.match(attachmentMigration, /size_bytes between 1 and 15728640/);
  assert.match(attachmentMigration, /estimate\.state = 'draft'/);
  assert.match(attachmentMigration, /work_order\.contractor_assignment_version\s+= estimate\.contractor_assignment_version/);
  assert.match(attachmentMigration, /public\.can_access_contractor_work_order\(estimate\.work_order_id\)/);
  assert.match(attachmentMigration, /revoke all on table public\.contractor_estimate_attachments[\s\S]*from public, anon, authenticated/);
  assert.match(estimatePanel, /accept="\.xlsx,application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet"/);
  assert.match(estimatePanel, /Forms stay private to P1 and the current contractor assignment/);
});

test("status guidance and capital completion visibility are present in list views", () => {
  assert.match(workOrderList, /<WorkOrderStatusLegend/);
  assert.match(capitalProjects, /Pending capital completion/);
});
