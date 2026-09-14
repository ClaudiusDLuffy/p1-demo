import assert from "node:assert/strict";
import test from "node:test";
import { createContractorInvoiceCommands, contractorInvoiceSnapshotFor, ContractorInvoiceCommandError } from "./contractorInvoiceCommands";
import { contractorInvoiceDraftCommand } from "./contractorInvoiceDraftAdapter";
import { createContractorInvoiceAttempts } from "./contractorInvoiceAttempts";
import type { ContractorInvoiceContext, ContractorInvoicePayload } from "./contractorInvoiceCommandContracts";

const context: ContractorInvoiceContext = { workOrderId: "WOTTEST001", expectedAssignmentVersion: 2,
  expectedWorkflowCycle: 1, invoiceId: null, expectedInvoiceVersion: null,
  operationId: "74000000-0000-4000-8000-000000000002" };
const invoiceId = "74000000-0000-4000-8000-000000000001";
const payload: ContractorInvoicePayload = { num: "TEST-1", userTypedNum: false, cme: null,
  storeAddress: null, invoiceDate: "2026-09-08", serviceDate: null, dueDate: null, terms: "Net 30",
  mode: "line_items", salesTax: 1.25, totalOverride: null, pdfStoragePath: null,
  lines: [{ type: "Labor", description: "Synthetic work", qty: 1.25, rate: 4.29 }] };
const result = { applied: true, reason: "applied", operationId: context.operationId, invoiceId,
  invoiceVersion: 1, invoiceNum: "TEST-1", state: "submitted", workOrderId: context.workOrderId,
  assignmentVersion: 2, workflowCycle: 1, subtotal: 5.36, salesTax: 1.25, total: 6.61 };
function fixture(data: unknown = result, error: unknown = null) {
  const calls: { name: string; args: unknown }[] = [];
  return { calls, commands: createContractorInvoiceCommands(async (name, args) => { calls.push({ name, args }); return { data, error }; }) };
}

test("contractor command sends captured versions and operation identity, without client financial totals or actor", async () => {
  const f = fixture(); await f.commands.save("submit", context, payload);
  assert.deepEqual(f.calls, [{ name: "submit_contractor_invoice_v1", args: {
    p_work_order_id: "WOTTEST001", p_expected_assignment_version: 2, p_expected_workflow_cycle: 1,
    p_invoice_id: null, p_expected_invoice_version: null, p_operation_id: context.operationId, p_payload: payload,
  } }]);
});

test("draft accepts empty and zero-valued partial lines while line-item submission rejects them", async () => {
  const f = fixture({ ...result, state: "draft" });
  const partial = { ...payload, lines: [{ type: "Other", description: "", qty: 0, rate: 0 }] };
  await f.commands.save("draft", context, partial);
  await f.commands.save("draft", context, { ...payload, lines: [] });
  await assert.rejects(f.commands.save("submit", context, partial), ContractorInvoiceCommandError);
  await assert.rejects(f.commands.save("submit", context, { ...payload, lines: [] }), ContractorInvoiceCommandError);
  assert.equal(f.calls.length, 2);
});

test("explicit manual PDF total permits zero extracted lines and post-save attachment", async () => {
  const f = fixture({ ...result, subtotal: 123.45, salesTax: 0, total: 123.45 });
  await f.commands.save("submit", context, { ...payload, mode: "manual_pdf_total", totalOverride: 123.45, salesTax: 0, lines: [], pdfStoragePath: null });
  assert.equal(f.calls.length, 1);
});

test("unknown fields, malformed dates, numeric strings and unmarked total overrides fail before transport", async () => {
  for (const bad of [{ ...payload, total: 999 }, { ...payload, userTypedNum: "false" },
    { ...payload, invoiceDate: "2026-02-30" }, { ...payload, totalOverride: 999 },
    { ...payload, salesTax: -1 }, { ...payload, salesTax: "1.25" },
    { ...payload, lines: [{ ...payload.lines[0], rate: Infinity }] }]) {
    const f = fixture();
    // Exercise the untrusted runtime boundary; no incompatible assertion is needed.
    await assert.rejects(Reflect.apply(f.commands.save, f.commands, ["submit", context, bad]), ContractorInvoiceCommandError);
    assert.equal(f.calls.length, 0);
  }
});

test("legacy facade retains normalized inputs but never replaces a zero draft quantity with one", () => {
  const command = contractorInvoiceDraftCommand({ num: "TEST-1", state: "draft", commandContext: context, tax: "" },
    [{ type: "Other", desc: "", qty: 0, rate: 0 }], null);
  assert.equal(command.payload.lines[0].qty, 0);
  assert.equal(command.payload.salesTax, 0);
  assert.throws(() => contractorInvoiceDraftCommand({ num: "TEST-1", commandContext: context, tax: "5wrong" }, [], null));
});

test("same authoritative replay outcome is accepted; changed response identity is rejected", async () => {
  const replay = fixture({ ...result, applied: false, reason: "already_applied" });
  assert.equal((await replay.commands.save("submit", context, payload)).reason, "already_applied");
  for (const data of [null, {}, { ...result, operationId: invoiceId }, { ...result, workOrderId: "OTHER" },
    { ...result, assignmentVersion: 3 }, { ...result, applied: false }]) {
    const f = fixture(data); await assert.rejects(f.commands.save("submit", context, payload), error =>
      error instanceof ContractorInvoiceCommandError && error.code === "INVOICE_COMMAND_UNCONFIRMED");
  }
});

test("revise preserves the selected identity and requires an existing version", async () => {
  const f = fixture({ ...result, state: "revised", invoiceVersion: 4 });
  await f.commands.save("revise", { ...context, invoiceId, expectedInvoiceVersion: 3 }, payload);
  assert.equal(f.calls[0].name, "revise_contractor_invoice_v1");
  await assert.rejects(f.commands.save("revise", context, payload), ContractorInvoiceCommandError);
});

test("provider errors are safe, preserve cause, and never automatically retry", async () => {
  for (const code of ["42501", "PT409", "22023", "23505", "XX000"]) {
    const cause = { code, message: "private SQL path secret details" };
    const f = fixture(null, cause);
    await assert.rejects(f.commands.save("submit", context, payload), error => error instanceof ContractorInvoiceCommandError
      && error.cause === cause && !/private|secret|SQL/.test(error.message));
    assert.equal(f.calls.length, 1);
  }
});

test("snapshot rejects absent versions instead of replacing stale edits with a fresh token", () => {
  assert.throws(() => contractorInvoiceSnapshotFor({ id: "WOTTEST001" }), ContractorInvoiceCommandError);
  const snapshot = contractorInvoiceSnapshotFor({ id: "WOTTEST001", contractorAssignmentVersion: 2, workflowCycle: 1 }, { id: invoiceId, invoiceVersion: 3 });
  assert.equal(snapshot.expectedInvoiceVersion, 3);
});

test("self-delete carries invoice and parent snapshots and verifies its returned identity", async () => {
  const input = { ...context, invoiceId, expectedInvoiceVersion: 3 };
  const f = fixture({ ...result, invoiceVersion: 4, deletedAt: "2026-09-08T10:00:00Z" });
  await f.commands.deleteOwn(input);
  assert.deepEqual(f.calls, [{ name: "delete_own_contractor_invoice_v1", args: {
    p_work_order_id: context.workOrderId, p_expected_assignment_version: 2, p_expected_workflow_cycle: 1,
    p_invoice_id: invoiceId, p_expected_invoice_version: 3, p_operation_id: context.operationId,
  } }]);
  const wrong = fixture({ ...result, invoiceVersion: 4, workOrderId: "OTHER", deletedAt: "2026-09-08T10:00:00Z" });
  await assert.rejects(wrong.commands.deleteOwn(input), error =>
    error instanceof ContractorInvoiceCommandError && error.code === "INVOICE_COMMAND_UNCONFIRMED");
  await assert.rejects(fixture(null).commands.deleteOwn(input), error =>
    error instanceof ContractorInvoiceCommandError && error.code === "INVOICE_COMMAND_UNCONFIRMED");
});

test("unknown-outcome retry retains operation payload and replacement PDF without overlapping calls", () => {
  const tracker = createContractorInvoiceAttempts();
  tracker.begin(context.operationId, payload);
  assert.throws(() => tracker.begin(context.operationId, payload), ContractorInvoiceCommandError);
  tracker.rememberPdf(context.operationId, `${invoiceId}/synthetic.pdf`);
  tracker.finish(context.operationId, new Error("Connection lost"));
  assert.throws(() => tracker.begin(context.operationId, { ...payload, num: "Changed" }), ContractorInvoiceCommandError);
  tracker.begin(context.operationId, payload);
  assert.equal(tracker.pdfPath(context.operationId), `${invoiceId}/synthetic.pdf`);
  tracker.finish(context.operationId, { code: "22023" });
  tracker.begin(context.operationId, { ...payload, num: "Corrected" });
});
