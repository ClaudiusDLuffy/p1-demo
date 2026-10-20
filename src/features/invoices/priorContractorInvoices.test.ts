import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPriorInvoiceDraftAttempt, createPriorInvoiceSubmitAttempt, priorInvoiceFieldsSchema,
  priorInvoiceError, type PriorInvoiceContext } from "./priorContractorInvoices";

const context: PriorInvoiceContext = { workOrderId: "SYNTHETIC-PRIOR", assignmentVersion: 2, workflowCycle: 0,
  assignments: [{ id: randomUUID(), contractorId: randomUUID(), contractorName: "Synthetic previous contractor",
    assignmentVersion: 1, startedAt: null, endedAt: "2026-10-01T00:00:00Z" }], drafts: [] };
const fields = { num: "SYNTHETIC-001", invoiceDate: "2026-10-01", total: 125.5, salesTax: 5.5, note: "Earlier synthetic assignment" };
const receipt = (operationId: string, extra = {}) => ({ operationId, workOrderId: context.workOrderId,
  assignmentVersion: 2, workflowCycle: 0, assignmentId: context.assignments[0].id, invoiceId: randomUUID(),
  invoiceNum: fields.num, total: fields.total, invoiceVersion: 1, state: "draft", applied: true, activityId: randomUUID(), ...extra });
test("prior invoice fields enforce real amounts, tax, precision and required audit note", () => {
  assert.ok(priorInvoiceFieldsSchema.safeParse(fields).success);
  for (const extra of [{ total: 0 }, { total: 1.001 }, { salesTax: 999 }, { note: "x" }, { invoiceDate: "invalid" }, { num: "\n" }])
    assert.equal(priorInvoiceFieldsSchema.safeParse({ ...fields, ...extra }).success, false);
});
test("draft attempts freeze the normalized payload and reuse the same operation", async () => {
  const op = randomUUID(); const mutable = { ...fields }; const attempt = createPriorInvoiceDraftAttempt(context, context.assignments[0].id, mutable, null, op);
  mutable.total = 999; const calls: unknown[] = [];
  const transport = async (_name: unknown, args: unknown) => { calls.push(args); return { data: receipt(op), error: null }; };
  await attempt(transport); await attempt(transport);
  assert.deepEqual(calls[0], calls[1]); assert.equal((calls[0] as { p_payload: typeof fields }).p_payload.total, fields.total);
});
test("arbitrary contractor selections and mismatched draft receipts fail closed", async () => {
  assert.throws(() => createPriorInvoiceDraftAttempt(context, randomUUID(), fields));
  for (const extra of [{ workOrderId: "OTHER" }, { assignmentId: randomUUID() }, { state: "approved" }, { total: 1 }, { operationId: randomUUID() }]) {
    const op = randomUUID(); const attempt = createPriorInvoiceDraftAttempt(context, context.assignments[0].id, fields, null, op);
    await assert.rejects(attempt(async () => ({ data: receipt(op, extra), error: null })));
  }
});
test("submission checks the exact invoice and version without billing or payment", async () => {
  const id = randomUUID(), op = randomUUID(); const attempt = createPriorInvoiceSubmitAttempt(context, { id, invoiceVersion: 2 }, op);
  await attempt(async () => ({ data: receipt(op, { invoiceId: id, invoiceVersion: 3, state: "submitted" }), error: null }));
  await assert.rejects(attempt(async () => ({ data: receipt(op, { invoiceId: id, invoiceVersion: 2, state: "submitted" }), error: null })));
});
test("errors are safe and distinguish permission, duplicate, stale and uncertain outcomes", () => {
  assert.match(priorInvoiceError({ code: "23505" }).message, /already exists/);
  assert.match(priorInvoiceError({ code: "42501" }).message, /Only active/);
  assert.match(priorInvoiceError({ code: "PT409" }).message, /changed/);
  assert.equal(priorInvoiceError({ message: "private detail" }).uncertain, true);
  assert.equal(priorInvoiceError({ message: "private detail" }).message.includes("private detail"), false);
});
test("malformed successful responses remain uncertain, not input-validation errors", async () => {
  const attempt = createPriorInvoiceDraftAttempt(context, context.assignments[0].id, fields);
  await assert.rejects(attempt(async () => ({ data: {}, error: null })), (error: unknown) =>
    priorInvoiceError(error).uncertain);
});
