import assert from "node:assert/strict";
import test from "node:test";
import { createBillingSourceRepository } from "../server/billing-invoices/billingSourceRepository";
import { canonicalizeBillingSaveCommand } from "../server/billing-invoices/billingSaveCanonicalizer";
import { validateCommittedBillingSummary } from "../server/billing-invoices/billingPostCommitResult";
import { billingQueryHarness } from "./billing-post-test-support/queryHarness";
import { StaffInvoiceSaveSchema } from "./staffInvoiceContracts";
import { validBillingRequest } from "./billingFinancialRouteTestHarness";

const uuid = "a6100000-abcd-4000-8abc-000000000001";
const upper = uuid.toUpperCase();
test("source UUID identity follows PostgreSQL case semantics without changing the requested operation payload", async () => {
  const h = billingQueryHarness([{ data: [{ id: uuid, work_order_id: "WOTSYNTHETIC", invoice_type: "contractor",
    state: "approved", deleted_at: null }], error: null }]);
  const facts = await createBillingSourceRepository(h.session).loadForSave({ workOrderId: "WOTSYNTHETIC", sourceInvoiceIds: [upper] }, { signal: null });
  assert.deepEqual(facts.sourceInvoiceIds, [uuid]);
  const input = StaffInvoiceSaveSchema.parse({ ...validBillingRequest(), sourceInvoiceIds: [upper] });
  const result = canonicalizeBillingSaveCommand(input, facts, { kind: "work_order", workOrderId: "WOTSYNTHETIC",
    assignmentVersion: 0, workflowCycle: 0, storeState: "TX", duplicateRootWorkOrderId: null });
  assert.deepEqual(result, input);
  assert.equal(result.sourceInvoiceIds[0], upper);
});

test("UUID-equivalent committed detail identity is accepted without case-folding the work-order TEXT identity", () => {
  const result = validateCommittedBillingSummary({ projection: "summary", id: uuid, invoiceType: "staff", num: "SYNTHETIC",
    state: "draft", workOrderId: "Mixed-Case-Relational-Id", subtotal: 10, salesTax: 0, total: 10,
    invoiceVersion: 1, lineCount: 1, sourceCount: 0, contractorAssignmentVersion: 2, workflowCycle: 1 }, upper);
  assert.equal(result.id, uuid);
  assert.equal(result.workOrderId, "Mixed-Case-Relational-Id");
});
