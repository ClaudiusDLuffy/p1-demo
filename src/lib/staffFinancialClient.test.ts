import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "./errors/AppError";
import { captureStaffInvoiceSnapshot, createStaffFinancialAttempt, recordStaffFinancialAttemptError } from "./staffFinancialClient";
import { StaffInvoiceSaveSchema, staffInvoiceRpcPayload } from "./staffInvoiceContracts";
import { financialErrorResponse, parseFinancialRequest } from "./financialHttpBoundary";
import { financialTestIds, validBillingRequest } from "./billingFinancialRouteTestHarness";

const workOrder = { id: "WOTSYNTHETIC", contractorAssignmentVersion: 3, workflowCycle: 2 };
const invoice = { id: financialTestIds.invoice, invoiceVersion: 5, workOrderId: workOrder.id,
  assignmentVersion: 3, workflowCycle: 2 };
test("staff editor captures original invoice and selected work-order versions without a save-time read", () => {
  const snapshot = captureStaffInvoiceSnapshot(invoice);
  const current = { ...invoice, invoiceVersion: 9, assignmentVersion: 8 };
  assert.equal(snapshot.expectedInvoiceVersion, 5);
  assert.equal(snapshot.expectedAssignmentVersion, 3);
  assert.equal(captureStaffInvoiceSnapshot(current).expectedInvoiceVersion, 9);
  assert.deepEqual(captureStaffInvoiceSnapshot(null, workOrder), {
    workOrderId: workOrder.id, expectedInvoiceVersion: null, expectedAssignmentVersion: 3, expectedWorkflowCycle: 2,
  });
});
test("staff relinking preserves the captured invoice revision and captures the new target assignment", () => {
  assert.deepEqual(captureStaffInvoiceSnapshot(invoice, { ...workOrder, id: "WOTOTHER", contractorAssignmentVersion: 7 }), {
    workOrderId: "WOTOTHER", expectedInvoiceVersion: 5, expectedAssignmentVersion: 7, expectedWorkflowCycle: 2,
  });
  assert.deepEqual(captureStaffInvoiceSnapshot(invoice, null), {
    workOrderId: null, expectedInvoiceVersion: 5, expectedAssignmentVersion: null, expectedWorkflowCycle: null,
  });
});
test("old expanded-schema-missing editor fails safely rather than silently deriving an invoice revision", () => {
  assert.throws(() => captureStaffInvoiceSnapshot({ ...invoice, invoiceVersion: null }), /version is unavailable/);
  assert.throws(() => captureStaffInvoiceSnapshot(null, { ...workOrder, contractorAssignmentVersion: undefined }), /version is unavailable/);
});
test("lost-response retry keeps the same operation and rejects altered content", () => {
  const attempt = createStaffFinancialAttempt();
  const first = attempt.save(validBillingRequest());
  assert.deepEqual(attempt.save(validBillingRequest()), first);
  assert.throws(() => attempt.save({ ...validBillingRequest(), num: "CHANGED" }), /unconfirmed/);
  attempt.rejected(500);
  assert.equal(attempt.save(validBillingRequest()).operationId, first.operationId);
  attempt.rejected(409);
  assert.equal(attempt.save(validBillingRequest()).operationId, first.operationId);
});
test("explicit validation rejection allows correction but successful save starts a new logical operation", () => {
  const attempt = createStaffFinancialAttempt();
  const first = attempt.save(validBillingRequest());
  attempt.rejected(422);
  const correction = attempt.save({ ...validBillingRequest(), num: "CORRECTED" });
  assert.notEqual(correction.operationId, first.operationId);
  attempt.confirmed();
  assert.notEqual(attempt.save(validBillingRequest()).operationId, correction.operationId);
});
test("the editor releases known API rejections but retains an unconfirmed mutation", () => {
  const rejected = createStaffFinancialAttempt();
  const rejectedCommand = rejected.save(validBillingRequest());
  recordStaffFinancialAttemptError(rejected, new AppError("VALIDATION_FAILED"));
  assert.notEqual(
    rejected.save({ ...validBillingRequest(), num: "CORRECTED" }).operationId,
    rejectedCommand.operationId,
  );

  const unconfirmed = createStaffFinancialAttempt();
  unconfirmed.save(validBillingRequest());
  recordStaffFinancialAttemptError(unconfirmed, new AppError("RESULT_UNCONFIRMED"));
  assert.throws(
    () => unconfirmed.save({ ...validBillingRequest(), num: "CHANGED" }),
    /unconfirmed/,
  );
});
test("source order is normalized but line order and checkbox meaning are preserved", () => {
  const attempt = createStaffFinancialAttempt();
  const sourceIds = [financialTestIds.invoice, financialTestIds.actor];
  const first = attempt.save({ ...validBillingRequest(), sourceInvoiceIds: sourceIds });
  assert.deepEqual(attempt.save({ ...validBillingRequest(), sourceInvoiceIds: [...sourceIds].reverse() }), first);
  assert.equal(first.lines[0].isTaxable, false);
  const payload = staffInvoiceRpcPayload(first);
  assert.equal(payload.lines[0].description, "Synthetic work");
  assert.ok(!("subtotal" in payload));
  assert.ok(!("total" in payload));
});
test("tax command retains explicit zero amount precedence and the approved percent boundary", () => {
  const manual = StaffInvoiceSaveSchema.parse({ ...validBillingRequest(), salesTaxOverride: 0, taxRateOverride: 8.25 });
  assert.equal(staffInvoiceRpcPayload(manual).taxMode, "manual_amount");
  const rate = StaffInvoiceSaveSchema.parse({ ...validBillingRequest(), salesTaxOverride: null, taxRateOverride: 8.25 });
  assert.equal(staffInvoiceRpcPayload(rate).taxMode, "manual_rate");
  assert.equal(staffInvoiceRpcPayload(rate).taxRateOverride, 8.25);
  const databaseRate = StaffInvoiceSaveSchema.parse({ ...validBillingRequest(), salesTaxOverride: null });
  assert.equal(staffInvoiceRpcPayload(databaseRate).taxMode, "active_db_rate");
});
test("delete retry remains operation-bound and rejects a changed captured version", () => {
  const attempt = createStaffFinancialAttempt();
  const body = { expectedInvoiceVersion: 5, expectedAssignmentVersion: 3, expectedWorkflowCycle: 2 };
  const first = attempt.delete(body);
  assert.deepEqual(attempt.delete(body), first);
  assert.throws(() => attempt.delete({ ...body, expectedInvoiceVersion: 6 }), /unconfirmed/);
});
test("unknown and provider errors never expose provider messages; missing expansion yields safe 503", async () => {
  for (const [code, status] of [["PT409", 409], ["42501", 403], ["P0002", 404], ["23514", 422], ["PGRST202", 503], ["42883", 503], ["unknown", 500]] as const) {
    const response = financialErrorResponse({ code, message: "SECRET SQL /private/provider", stack: "stack" });
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /SECRET|provider|stack|\/private/);
  }
});
test("invalid JSON and MIME are rejected at the financial request boundary", async () => {
  await assert.rejects(() => parseFinancialRequest(new Request("https://synthetic.invalid", { method: "POST", body: "broken", headers: { "content-type": "application/json" } }), StaffInvoiceSaveSchema), /not valid JSON/);
  await assert.rejects(() => parseFinancialRequest(new Request("https://synthetic.invalid", { method: "POST", body: "{}" }), StaffInvoiceSaveSchema), /JSON financial command/);
});
