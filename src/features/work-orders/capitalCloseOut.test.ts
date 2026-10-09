import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { CapitalCloseOutError, capitalCloseOutFieldsSchema, createCapitalCloseOutAttempt } from "./capitalCloseOut";

const operation = "20000000-0000-4000-8000-000000000001";
const document = "20000000-0000-4000-8000-000000000002";
const work = { id: "SYNTHETIC-CAPITAL", contractorAssignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 8 };
const fields = { outcome: "billed", confirmed: true, documentId: document, invoiceVersion: 4,
  markQuoteSubmitted: true, quoteReference: "", invoiceReference: "SYNTHETIC-QUOTE", billedOn: "2026-10-01" };
const receipt = { applied: true, reason: "applied", operationId: operation, workOrderId: work.id,
  assignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 11, workOrderStatus: "closed", functionalStatus: "Completed",
  activityId: "20000000-0000-4000-8000-000000000003", outcome: "billed", documentId: document, invoiceVersion: 6,
  invoiceCreated: false, csvExported: false };

test("capital closeout follows base migration 0170 without the removed tax-period upgrade", () => {
  assert.ok(existsSync("supabase/migrations/0170_guarded_capital_self_service.sql"));
  const migration = readFileSync("supabase/migrations/0171_simple_capital_close_out.sql", "utf8");
  assert.match(migration, /create or replace function public\.close_out_capital_v1\(/);
  assert.doesNotMatch(migration, /invoice-date tax period|stamp_staff_invoice_tax_provenance|resolve_location_sales_tax_rate|state_sales_tax_rates/);
});

test("one guarded request captures the original versions and validates its billed receipt", async () => {
  const attempt = createCapitalCloseOutAttempt(work, fields, operation);
  const saved = await attempt(async (name, args) => {
    assert.equal(name, "close_out_capital_v1");
    assert.equal(args.p_expected_assignment_version, 2); assert.equal(args.p_expected_workflow_cycle, 1);
    assert.equal(args.p_expected_lifecycle_version, 8); assert.equal(args.p_operation_id, operation);
    assert.deepEqual(args.p_payload, fields);
    return { data: receipt, error: null };
  });
  assert.equal(saved.workOrderStatus, "closed"); assert.equal(saved.csvExported, false);
});

test("unbilled completion validates only an open billing result, not a closure", async () => {
  const input = { ...fields, outcome: "send_to_billing", invoiceReference: "", billedOn: null };
  const attempt = createCapitalCloseOutAttempt(work, input, operation);
  const saved = await attempt(async () => ({ data: { ...receipt, outcome: "send_to_billing", workOrderStatus: "pending_invoice" }, error: null }));
  assert.equal(saved.workOrderStatus, "pending_invoice");
  await assert.rejects(attempt(async () => ({ data: { ...receipt, outcome: "send_to_billing" }, error: null })),
    (error: unknown) => error instanceof CapitalCloseOutError && error.uncertain);
});

test("a lost response retries the identical operation and never reinterprets changed inputs", async () => {
  const input = { ...fields }; const snapshot = { ...work };
  const attempt = createCapitalCloseOutAttempt(snapshot, input, operation);
  let original = "";
  await assert.rejects(attempt(async (_name, args) => {
    original = JSON.stringify(args); throw new Error("synthetic response lost");
  }), (error: unknown) => error instanceof CapitalCloseOutError && error.uncertain);
  input.invoiceReference = "A-DIFFERENT-INVOICE"; snapshot.workflowCycle = 10;
  const replay = await attempt(async (_name, args) => {
    assert.equal(JSON.stringify(args), original);
    return { data: { ...receipt, applied: false, reason: "already_applied" }, error: null };
  });
  assert.equal(replay.applied, false);
});

for (const patch of [{ operationId: document }, { workOrderId: "OTHER-WO" }, { assignmentVersion: 3 },
  { workflowCycle: 2 }, { lifecycleVersion: 8 }, { documentId: null }, { invoiceVersion: null },
  { invoiceVersion: 3 }, { invoiceCreated: true }, { csvExported: true }, { functionalStatus: "Work in Progress" }]) {
  test(`unverified receipt ${JSON.stringify(patch)} cannot be reported as saved`, async () => {
    const attempt = createCapitalCloseOutAttempt(work, fields, operation);
    await assert.rejects(attempt(async () => ({ data: { ...receipt, ...patch }, error: null })),
      (error: unknown) => error instanceof CapitalCloseOutError && error.uncertain);
  });
}

test("billing and confirmation requirements are strict and unbilled outcomes cannot carry billing facts", () => {
  for (const patch of [{ confirmed: false }, { invoiceReference: "" }, { billedOn: null }, { invoiceVersion: null },
    { documentId: null }, { unexpected: true }, { invoiceReference: "bad\u0000reference" }, { outcome: "send_to_billing" }]) {
    assert.equal(capitalCloseOutFieldsSchema.safeParse({ ...fields, ...patch }).success, false);
  }
});
