import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  canReturnCompletedWorkOrderToField,
  validateCompletedReturnReason,
} from "./completedWorkOrderReturn";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0157_return_completed_work_to_field.sql");
const db = read("src/lib/db.ts");
const hook = read("src/features/work-orders/useWorkOrders.ts");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");

test("only operational staff and contractor company administrators receive the completed-return control", () => {
  const workOrder = {
    status: "completed", functionalStatus: "Completed", contractorId: "contractor",
    billingOnly: false, isCapital: false,
  };
  assert.equal(canReturnCompletedWorkOrderToField({ ...workOrder, isOperationalStaff: true }), true);
  assert.equal(canReturnCompletedWorkOrderToField({ ...workOrder, canManageContractorCompany: true }), true);
  assert.equal(canReturnCompletedWorkOrderToField({ ...workOrder }), false);
  assert.equal(canReturnCompletedWorkOrderToField({ ...workOrder, isOperationalStaff: true, isInvoiceController: true }), false);
  assert.equal(canReturnCompletedWorkOrderToField({ ...workOrder, isCapital: true, canManageContractorCompany: true }), false);
  assert.equal(canReturnCompletedWorkOrderToField({ ...workOrder, status: "closed", isOperationalStaff: true }), false);
  assert.equal(canReturnCompletedWorkOrderToField({ ...workOrder, billingOnly: true, isOperationalStaff: true }), false);
});

test("completed return accepts billing queues but never incomplete field state", () => {
  for (const status of ["completed", "pending_invoice", "pending_approval", "pending_payment"]) {
    assert.equal(canReturnCompletedWorkOrderToField({
      status, functionalStatus: "Completed", contractorId: "contractor",
      isOperationalStaff: true,
    }), true, status);
  }
  assert.equal(canReturnCompletedWorkOrderToField({
    status: "pending_approval", functionalStatus: "Awaiting Parts", contractorId: "contractor",
    isOperationalStaff: true,
  }), false);
});

test("a bounded audit reason is required", () => {
  assert.match(validateCompletedReturnReason("no") || "", /at least 5/i);
  assert.equal(validateCompletedReturnReason("Return visit needed"), null);
  assert.match(validateCompletedReturnReason("x".repeat(1001)) || "", /1000/);
});

test("migration owns one locked, versioned, replay-safe transition", () => {
  assert.match(migration, /create or replace function public\.return_completed_work_order_to_field_v1/);
  assert.match(migration, /language plpgsql[\s\S]*security definer/);
  assert.match(migration, /from public\.work_orders work_order[\s\S]*for update/);
  assert.match(migration, /contractor_assignment_version is distinct from[\s\S]*p_expected_assignment_version/);
  assert.match(migration, /workflow_cycle is distinct from p_expected_workflow_cycle/);
  assert.match(migration, /lifecycle_version is distinct from p_expected_lifecycle_version/);
  assert.match(migration, /activities_one_completed_return_operation/);
  assert.match(migration, /already_applied/);
  assert.match(migration, /Operation identity was reused with different input/);
});

test("database authorization is narrower than work-order visibility", () => {
  assert.match(migration, /v_actor\.role in \('manager', 'dispatcher', 'back_office'\)/);
  assert.match(migration, /profile_has_staff_permission\(v_actor\.id, 'invoice_controller'\)/);
  assert.match(migration, /v_actor\.role = 'contractor'[\s\S]*can_manage_contractor_company\(\)/);
  assert.match(migration, /can_access_contractor_work_order\(v_work_order\.id\)/);
  assert.match(migration, /Operational staff or contractor company administrator access required/);
  assert.match(migration, /to authenticated/);
  assert.match(migration, /from public, anon, service_role/);
});

test("transition keeps billing and history intact while opening a new field cycle", () => {
  assert.match(migration, /status::text not in \([\s\S]*'completed', 'pending_invoice', 'pending_approval', 'pending_payment'/);
  assert.match(migration, /functional_status::text is distinct from 'Completed'/);
  assert.match(migration, /public\.contractor_invoice_work_order_status\(v_work_order\.id\)/);
  assert.match(migration, /functional_status = 'Awaiting Parts'/);
  assert.match(migration, /v_next_workflow_cycle := v_work_order\.workflow_cycle \+ 1/);
  assert.match(migration, /set_config\('app\.contractor_invoicing_transition', 'finish', true\)/);
  assert.match(migration, /'invoicesChanged', false/);
  assert.match(migration, /'assignmentsChanged', false/);
  assert.match(migration, /'visitsChanged', false/);
  assert.doesNotMatch(migration, /update public\.invoices/i);
  assert.doesNotMatch(migration, /update public\.work_order_visits/i);
  assert.doesNotMatch(migration, /delete from public\.invoices/i);
  assert.doesNotMatch(migration, /delete from public\.work_order_visits/i);
  assert.doesNotMatch(migration, /contractor_id\s*=/i);
  assert.doesNotMatch(migration, /assigned_technician_profile_id\s*=/i);
});

test("client commits through the RPC and exposes a deliberate audited modal", () => {
  assert.match(db, /rpc\("return_completed_work_order_to_field_v1"/);
  assert.match(hook, /const doReturnCompletedToField = async/);
  assert.match(hook, /await returnCompletedWorkOrderToField/);
  assert.match(detail, /Field work is marked complete/);
  assert.match(detail, /title="Return to field work"/);
  assert.match(detail, /validateCompletedReturnReason\(returnToFieldReason\)/);
  assert.match(detail, /Existing invoices, contractor and technician assignments, prior visits, photos, and history will not be changed/);
});
