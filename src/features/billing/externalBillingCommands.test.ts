import assert from "node:assert/strict";
import test from "node:test";
import { createExternalBillingAttempt } from "./externalBillingCommands";
import { canRecordExternalBilling, externalBillingFieldsSchema, externalBillingError } from "./externalBillingContracts";

const id = "00000000-0000-4000-8000-000000000101";
const work = { id: "E2E-EXTERNAL", contractorAssignmentVersion: 1, workflowCycle: 2, lifecycleVersion: 3 };
const fields = { billingSystem: "QuickBooks", invoiceReference: "SYNTHETIC-SHARED", billedOn: "2026-01-01", note: "Synthetic shared invoice" };
const receipt = { ...fields, applied: true, workOrderId: work.id, operationId: id, assignmentVersion: 1,
  workflowCycle: 2, lifecycleVersion: 4, workOrderStatus: "closed", functionalStatus: "Completed",
  activityId: "00000000-0000-4000-8000-000000000102", closedAt: "2026-01-02T12:00:00Z" };

test("external billing validates required bounded fields and real dates", () => {
  for (const patch of [{ note: "    " }, { note: "four" }, { note: "x".repeat(1001) }, { invoiceReference: "" },
    { billingSystem: "a\nb" }, { invoiceReference: "x".repeat(101) }, { billedOn: "2026-02-30" }, { billedOn: "" }]) {
    assert.equal(externalBillingFieldsSchema.safeParse({ ...fields, ...patch }).success, false);
  }
  assert.equal(externalBillingFieldsSchema.parse({ ...fields, invoiceReference: "  shared  " }).invoiceReference, "shared");
});
test("only active operational staff can see external billing controls", () => {
  for (const role of ["manager", "dispatcher", "back_office"]) {
    assert.equal(canRecordExternalBilling({ role, active: true }), true);
    assert.equal(canRecordExternalBilling({ role, active: false }), false);
    assert.equal(canRecordExternalBilling({ role, active: true, staffPermissions: ["invoice_controller"] }), false);
  }
  assert.equal(canRecordExternalBilling({ role: "contractor", active: true }), false);
  assert.equal(canRecordExternalBilling(null), false);
});
test("lost response retry retains exact identity, fields and displayed versions", async () => {
  const source = { ...work }; const form = { ...fields };
  const attempt = createExternalBillingAttempt(source, form, id);
  let original: unknown;
  await assert.rejects(attempt(async (name, args) => {
    assert.equal(name, "record_work_order_external_billing_v1"); original = args;
    return { data: null, error: { code: "57014", message: "private database detail" } };
  }), /could not be confirmed/);
  source.lifecycleVersion = 99; form.invoiceReference = "new reference";
  const saved = await attempt(async (_name, args) => {
    assert.deepEqual(args, original);
    assert.equal(args.p_expected_lifecycle_version, 3);
    assert.equal(args.p_invoice_reference, fields.invoiceReference);
    return { data: { ...receipt, applied: false }, error: null };
  });
  assert.equal(saved.applied, false);
});
test("successful transport is not success without a matching receipt", async () => {
  for (const patch of [{ workOrderId: "OTHER" }, { operationId: receipt.activityId }, { invoiceReference: "OTHER" },
    { assignmentVersion: 2 }, { workflowCycle: 3 }, { lifecycleVersion: 9 }, { note: "Different note" },
    { billedOn: "2026-01-02" }, { workOrderStatus: "completed" }]) {
    await assert.rejects(createExternalBillingAttempt(work, fields, id)(async () => ({ data: { ...receipt, ...patch }, error: null })), /could not be confirmed/);
  }
});
test("safe external billing errors never display provider internals", () => {
  assert.match(externalBillingError({ message: "EXTERNAL_BILLING_PENDING_UPDATES" }).message, /pending 7-Eleven updates/);
  assert.match(externalBillingError({ message: "EXTERNAL_BILLING_OPEN_VISIT" }).message, /actual checkout time/);
  assert.equal(externalBillingError({ message: "EXTERNAL_BILLING_STALE" }).uncertain, false);
  assert.equal(externalBillingError(new Error("private token or SQL")).uncertain, true);
  assert.doesNotMatch(externalBillingError(new Error("private token or SQL")).message, /private token/);
});
