import assert from "node:assert/strict";
import test from "node:test";
import { createRecordedBillingCloseOutAttempt, recordedBillingCloseOutError, recordedBillingEvidenceSchema } from "./recordedBillingCloseOut";

const evidence = {
  workOrderId: "SYNTHETIC-WO", assignmentVersion: 1, workflowCycle: 0, lifecycleVersion: 3,
  invoiceId: "11111111-1111-4111-8111-111111111111", invoiceVersion: 2, invoiceNumber: "SYNTHETIC-P1-40",
  billingActivityId: "22222222-2222-4222-8222-222222222222", billedAt: "2026-08-06T21:58:08.534079Z",
};
const operation = "33333333-3333-4333-8333-333333333333";
const receipt = () => ({ ...evidence, lifecycleVersion: 4, operationId: operation, applied: true, reason: "applied",
  workOrderStatus: "closed", functionalStatus: "Completed", activityId: "44444444-4444-4444-8444-444444444444",
  closedAt: "2026-10-14T12:00:00Z", invoiceCreated: false, billingRecorded: false, paymentRecorded: false, csvExported: false,
});

test("reconciliation requires explicit confirmation and complete, legacy-cycle evidence", () => {
  assert.throws(() => createRecordedBillingCloseOutAttempt(evidence, false, operation));
  for (const bad of [{ ...evidence, workflowCycle: 1 }, { ...evidence, invoiceVersion: null },
    { ...evidence, lifecycleVersion: undefined }, { ...evidence, billingActivityId: "missing" }]) {
    assert.equal(recordedBillingEvidenceSchema.safeParse(bad).success, false);
  }
});
test("the invoice, evidence and work versions are frozen for an uncertain retry", async () => {
  const input = { ...evidence }; const attempt = createRecordedBillingCloseOutAttempt(input, true, operation);
  input.invoiceNumber = "CHANGED"; input.invoiceVersion = 99; input.lifecycleVersion = 99;
  const calls: unknown[] = [];
  await assert.rejects(attempt(async (name, args) => { calls.push({ name, args }); return { data: null, error: null }; }),
    error => recordedBillingCloseOutError(error).uncertain);
  const result = await attempt(async (name, args) => { calls.push({ name, args }); return { data: receipt(), error: null }; });
  assert.equal(result.workOrderStatus, "closed"); assert.deepEqual(calls[0], calls[1]);
});
for (const changed of [
  { workOrderId: "OTHER" }, { operationId: "55555555-5555-4555-8555-555555555555" },
  { assignmentVersion: 2 }, { lifecycleVersion: 5 }, { invoiceVersion: 3 },
  { invoiceNumber: "OTHER" }, { billingActivityId: "55555555-5555-4555-8555-555555555555" },
  { billedAt: "2026-08-07T00:00:00Z" }, { workOrderStatus: "pending_invoice" },
  { invoiceCreated: true }, { billingRecorded: true }, { paymentRecorded: true }, { csvExported: true },
]) test(`mismatched or mutation-bearing receipts remain unconfirmed: ${Object.keys(changed)[0]}`, async () => {
  await assert.rejects(createRecordedBillingCloseOutAttempt(evidence, true, operation)(async () => ({
    data: { ...receipt(), ...changed }, error: null,
  })), error => recordedBillingCloseOutError(error).uncertain);
});
test("a matching idempotent replay is accepted without a second action", async () => {
  const result = await createRecordedBillingCloseOutAttempt(evidence, true, operation)(async () => ({
    data: { ...receipt(), applied: false, reason: "already_applied" }, error: null,
  }));
  assert.equal(result.applied, false);
});
test("known guards have safe, specific guidance and private provider strings never escape", () => {
  assert.match(recordedBillingCloseOutError({ code: "23514", message: "RECORDED_BILLING_OPEN_VISIT" }).message, /actual checkout/);
  assert.equal(recordedBillingCloseOutError({ code: "PT409", message: "synthetic-private-detail" }).uncertain, false);
  assert.match(recordedBillingCloseOutError({ code: "PGRST202" }).message, /not installed/);
  const unknown = recordedBillingCloseOutError({ message: "synthetic-private-detail" });
  assert.equal(unknown.uncertain, true); assert.equal(unknown.message.includes("synthetic-private-detail"), false);
});
