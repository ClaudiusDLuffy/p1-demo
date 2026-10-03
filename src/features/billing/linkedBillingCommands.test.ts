import assert from "node:assert/strict";
import test from "node:test";
import { createLinkedBillingAttempt } from "./linkedBillingCommands";
import { linkedBillingFieldsSchema, linkedBillingError, type LinkedBillingCandidate } from "./linkedBillingContracts";
import { billingClosureUnavailableReason, billingClosureStatusEligible } from "./billingClosurePolicy";
import { isInternalWorkOrderActivity, resolveWorkOrderClosedBy } from "../../lib/workOrderView";

const id = "00000000-0000-4000-8000-000000000101";
const work = { id: "E2E-COVERED", contractorAssignmentVersion: 1, workflowCycle: 2, lifecycleVersion: 3 };
const candidate: LinkedBillingCandidate = { workOrderId: "E2E-BILLING", invoiceId: id, invoiceVersion: 5,
  assignmentVersion: 2, workflowCycle: 3, invoiceNumber: "SYNTHETIC-100", invoiceDate: "2026-01-01", state: "submitted" };
const note = "Synthetic invoice covers both work orders";
const receipt = { applied: true, workOrderId: work.id, operationId: id, assignmentVersion: 1, workflowCycle: 2,
  lifecycleVersion: 4, workOrderStatus: "closed", functionalStatus: "Completed", activityId: id, billingActivityId: id,
  closedAt: "2026-01-02T12:00:00Z", billingWorkOrderId: candidate.workOrderId,
  billingAssignmentVersion: 2, billingWorkflowCycle: 3, invoiceId: id, invoiceVersion: 5,
  invoiceNumber: candidate.invoiceNumber, invoiceDate: candidate.invoiceDate, note };

test("linked billing requires explicit coverage, a valid submitted invoice and bounded note", () => {
  assert.equal(linkedBillingFieldsSchema.safeParse({ candidate, note, coverageConfirmed: true }).success, true);
  for (const patch of [{ note: " " }, { note: "x".repeat(1001) }, { coverageConfirmed: false },
    { candidate: { ...candidate, state: "draft" } }, { candidate: { ...candidate, state: "rejected" } },
    { candidate: { ...candidate, invoiceVersion: -1 } }]) {
    assert.equal(linkedBillingFieldsSchema.safeParse({ candidate, note, coverageConfirmed: true, ...patch }).success, false);
  }
  assert.throws(() => createLinkedBillingAttempt(work, { ...candidate, workOrderId: work.id }, note, true), /different billing work order/);
});
test("linked billing freezes both identities and versions for uncertain retries", async () => {
  const selected = { ...candidate }; const attempt = createLinkedBillingAttempt(work, selected, note, true, id);
  let original: unknown;
  await assert.rejects(attempt(async (name, args) => {
    assert.equal(name, "record_work_order_linked_billing_v1"); original = args;
    return { data: null, error: new Error("private transport details") };
  }), /could not be confirmed/);
  selected.invoiceVersion = 99;
  const saved = await attempt(async (_name, args) => {
    assert.deepEqual(args, original); assert.equal(args.p_expected_invoice_version, 5);
    return { data: { ...receipt, applied: false }, error: null };
  });
  assert.equal(saved.applied, false);
});
test("linked billing accepts only matching authoritative receipts", async () => {
  for (const patch of [{ workOrderId: "OTHER" }, { billingWorkOrderId: "OTHER" }, { invoiceNumber: "OTHER" },
    { invoiceId: "00000000-0000-4000-8000-000000000102" }, { invoiceVersion: 6 }, { billingAssignmentVersion: 3 },
    { billingWorkflowCycle: 4 }, { lifecycleVersion: 9 }, { note: "Different note" }, { invoiceDate: "2026-01-02" }]) {
    await assert.rejects(createLinkedBillingAttempt(work, candidate, note, true, id)(async () => ({ data: { ...receipt, ...patch }, error: null })), /could not be confirmed/);
  }
});
test("closure visibility explains Awaiting Parts rather than implying refresh can fix it", () => {
  assert.equal(billingClosureStatusEligible("parts"), false);
  assert.match(billingClosureUnavailableReason("parts")!, /Awaiting Parts/);
  for (const status of ["completed", "pending_invoice", "pending_payment"]) assert.equal(billingClosureUnavailableReason(status), null);
});
test("coverage activity is internal and only the covered work order is attributed as closed", () => {
  assert.equal(isInternalWorkOrderActivity({ eventKey: "work_order_billing_coverage_added" }), true);
  assert.equal(resolveWorkOrderClosedBy([{ author: "Synthetic Staff", eventKey: "work_order_billing_coverage_added" }]), null);
  assert.equal(resolveWorkOrderClosedBy([{ author: "Synthetic Staff", eventKey: "work_order_billed_under_another" }]), "Synthetic Staff");
});
test("linked billing errors expose only safe guidance", () => {
  assert.match(linkedBillingError({ message: "LINKED_BILLING_INVOICE_UNAVAILABLE" }).message, /Drafts/);
  assert.match(linkedBillingError({ message: "LINKED_BILLING_INVOICE_IN_USE" }).message, /Reopen/);
  assert.equal(linkedBillingError({ message: "LINKED_BILLING_STALE" }).uncertain, false);
  assert.doesNotMatch(linkedBillingError(new Error("private SQL")).message, /private SQL/);
});
