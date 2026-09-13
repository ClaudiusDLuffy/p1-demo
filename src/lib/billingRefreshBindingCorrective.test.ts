import assert from "node:assert/strict";
import test from "node:test";
import { refreshCommittedBillingInvoice, validateBillingPostCommitDetail, validateCommittedBillingSummary } from "../server/billing-invoices/billingPostCommitResult";
import { billingRouteHarness, financialTestIds as ids, validBillingRequest } from "./billingFinancialRouteTestHarness";

globalThis.fetch = async () => { throw new Error("R3 refresh tests forbid external network"); };
const summary = (changes: Record<string, unknown> = {}) => ({
  projection: "summary", id: ids.invoice, num: "P1-SYNTHETIC", invoice_type: "staff", state: "draft",
  invoice_version: 2, work_order_id: "WOTSYNTHETIC", subtotal: 10, sales_tax: 0, total: 10,
  line_count: 1, source_count: 0, contractor_assignment_version: 0, workflow_cycle: 0,
  ...changes,
});
const dto = () => ({ projection: "summary", id: ids.invoice, num: "P1-SYNTHETIC", invoiceType: "staff",
  state: "draft", invoiceVersion: 2, workOrderId: "WOTSYNTHETIC", subtotal: 10, salesTax: 0, total: 10,
  lineCount: 1, sourceCount: 0, contractorAssignmentVersion: 0, workflowCycle: 0 });

for (const method of ["POST", "PATCH"] as const) {
  const checkUnavailable = async (detail: unknown) => {
    const h = billingRouteHarness({ compactRpc: name => name === "get_invoice_summary_v1"
      ? { data: detail, error: null } : undefined });
    const response = await h.handlers[method](h.request(method,
      { ...validBillingRequest(), expectedInvoiceVersion: method === "PATCH" ? 1 : null },
      method === "PATCH" ? `?id=${ids.invoice}` : ""));
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.deepEqual(body.refresh, { status: "unavailable", warning: "BILLING_REFRESH_UNAVAILABLE" });
    assert.equal(body.invoice.projection, "receipt");
    assert.equal(body.invoice.id, ids.invoice);
    assert.equal(body.invoice.invoiceVersion, 2);
    assert.equal(body.invoice.lineCount, 1);
    assert.equal(body.invoice.sourceCount, 0);
    assert.equal(body.command.applied, true);
    assert.equal(body.command.operationId, ids.operation);
    assert.equal(body.command.lineCount, 1);
    assert.equal(body.command.sourceInvoiceCount, 0);
    assert.equal(h.calls.filter(call => call.name === "rpc:save_staff_billing_invoice_v4").length, 1);
    assert.equal(h.calls.filter(call => call.name === "rpc:get_invoice_summary_v1").length, 1);
    assert.equal(h.calls.filter(call => /from:(invoice_lines|staff_invoice_sources)/.test(call.name)).length, 0);
    assert.ok(response.headers.get("x-request-id"));
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 8192);
    assert.doesNotMatch(JSON.stringify(body), /synthetic-private-refresh|stack|internal_sql_detail/);
    assert.ok(h.logs.length <= 1, "Secondary validation must not duplicate owner logging");
  };

  for (const [field, maximum] of [["line_count", 1000], ["source_count", 100]] as const) {
    for (const [label, invalid] of [
      ["missing", undefined], ["null", null], ["negative", -1], ["fractional", 0.5],
      ["numeric string", field === "line_count" ? "1" : "0"], ["above write bound", maximum + 1],
    ] as const) {
      test(`${method} R3 refresh ${field} ${label} remains a secondary failure`, async () => {
        await checkUnavailable(summary({ [field]: invalid, internal_sql_detail: "synthetic-private-refresh" }));
      });
    }
  }
  test(`${method} R3 both same-version counts contradicting the receipt are unusable`, async () => {
    await checkUnavailable(summary({ line_count: 0, source_count: 1 }));
  });
  for (const field of ["subtotal", "sales_tax", "total"] as const) {
    test(`${method} R3 same-version ${field} contradiction cannot override the receipt`, async () => {
      await checkUnavailable(summary({ [field]: 12.34 }));
    });
  }
  test(`${method} R3 wrong refresh envelope preserves one confirmed command`, async () => {
    await checkUnavailable([summary()]);
  });
}

test("R3 secondary DTO validation never defaults missing or malformed counts", async () => {
  for (const field of ["lineCount", "sourceCount"] as const) {
    for (const invalid of [undefined, null, -1, 0.5, "0", Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => validateCommittedBillingSummary({ ...dto(), [field]: invalid }, ids.invoice), `${field}: ${String(invalid)}`);
      const result = await refreshCommittedBillingInvoice(ids.invoice, null, async () => ({ ...dto(), [field]: invalid }));
      assert.deepEqual(result, { status: "unavailable", warning: "BILLING_REFRESH_UNAVAILABLE" });
    }
  }
});

test("R3 secondary DTO count boundaries are exact and validation is deterministic without mutation", () => {
  for (const counts of [{ lineCount: 0, sourceCount: 0 }, { lineCount: 1000, sourceCount: 100 }]) {
    const input = Object.freeze({ ...dto(), ...counts });
    const before = JSON.stringify(input);
    const first = validateCommittedBillingSummary(input, ids.invoice);
    assert.deepEqual(validateCommittedBillingSummary(input, ids.invoice), first);
    assert.equal(first.lineCount, counts.lineCount);
    assert.equal(first.sourceCount, counts.sourceCount);
    assert.equal(JSON.stringify(input), before);
  }
});

test("R3 pure receipt binding distinguishes stale, inconsistent and newer current detail", () => {
  const receipt = Object.freeze({ invoiceId: ids.invoice, invoiceVersion: 2, invoiceNum: "P1-SYNTHETIC",
    state: "draft" as const, workOrderId: "WOTSYNTHETIC", subtotal: 10, salesTax: 0, total: 10,
    lineCount: 1, sourceInvoiceCount: 0 });
  const detail = Object.freeze(validateCommittedBillingSummary(dto(), ids.invoice));
  const before = JSON.stringify({ receipt, detail });
  assert.equal(validateBillingPostCommitDetail(receipt, detail), "accepted");
  assert.equal(validateBillingPostCommitDetail(receipt, { ...detail, lineCount: 0 }), "inconsistent");
  assert.equal(validateBillingPostCommitDetail(receipt, { ...detail, sourceCount: 1 }), "inconsistent");
  assert.equal(validateBillingPostCommitDetail(receipt, { ...detail, id: ids.actor }), "inconsistent");
  assert.equal(validateBillingPostCommitDetail(receipt, { ...detail, invoiceVersion: 1 }), "stale");
  assert.equal(validateBillingPostCommitDetail(receipt, { ...detail, invoiceVersion: 1, lineCount: 4 }), "stale");
  assert.equal(validateBillingPostCommitDetail(receipt, { ...detail, workOrderId: "wotsynthetic" }), "inconsistent");
  assert.equal(validateBillingPostCommitDetail(receipt, { ...detail, contractorAssignmentVersion: 9, workflowCycle: 7 }), "accepted");
  assert.equal(validateBillingPostCommitDetail(receipt, { ...detail, invoiceVersion: 3, lineCount: 4,
    sourceCount: 1, state: "submitted", num: "P1-LATER-SYNTHETIC", subtotal: 20, total: 20 }), "newer_current_state");
  assert.equal(validateBillingPostCommitDetail(receipt, detail), "accepted");
  assert.equal(JSON.stringify({ receipt, detail }), before);
});
