import assert from "node:assert/strict";
import test from "node:test";
import { billingRouteHarness, financialTestIds, validBillingRequest } from "./billingFinancialRouteTestHarness";

test("valid billing create and edit retain the first-party invoice response", async () => {
  for (const method of ["POST", "PATCH"]) {
    const h = billingRouteHarness();
    const response = await h.handlers[method](h.request(method,
      { ...validBillingRequest(), expectedInvoiceVersion: method === "PATCH" ? 1 : null },
      method === "PATCH" ? "?id=" + financialTestIds.invoice : ""));
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.invoice.id, financialTestIds.invoice);
    assert.equal(result.invoice.total, 10);
    assert.ok(h.calls.some(call => call.name === "rpc:save_staff_billing_invoice_v4"));
    assert.ok(!h.calls.some(call => /^(insert|update):/.test(call.name)));
  }
});
test("financial save rejects mismatched command state, versions and target identities", async () => {
  for (const commandResultOverride of [{ state: "submitted" }, { assignmentVersion: 9 }, { workflowCycle: 9 },
    { invoiceVersion: 1 }, { invoiceId: financialTestIds.operation }, { operationId: financialTestIds.invoice }]) {
    const h = billingRouteHarness({ commandResultOverride });
    const response = await h.handlers.PATCH(h.request("PATCH", { ...validBillingRequest(), state: "draft", expectedInvoiceVersion: 1 },
      "?id=" + financialTestIds.invoice));
    assert.equal(response.status, 500);
    assert.equal((await response.json()).code, "FINANCIAL_RESULT_INVALID");
  }
});
test("financial deletion rejects mismatched versions without reporting confirmed success", async () => {
  for (const commandResultOverride of [{ assignmentVersion: 9 }, { workflowCycle: 9 }, { invoiceVersion: 1 }]) {
    const h = billingRouteHarness({ commandResultOverride });
    const response = await h.handlers.DELETE(h.request("DELETE", { operationId: financialTestIds.operation,
      expectedInvoiceVersion: 1, expectedAssignmentVersion: 0, expectedWorkflowCycle: 0 }, "?id=" + financialTestIds.invoice));
    assert.equal(response.status, 500);
    assert.equal((await response.json()).code, "FINANCIAL_RESULT_INVALID");
  }
});
type Mutation = (body: ReturnType<typeof validBillingRequest>) => unknown;
const malformed: [string, Mutation][] = [
  ...["false", "true", 0, 1, "0", "1", null].map(value => [
    "boolean " + JSON.stringify(value), (body: ReturnType<typeof validBillingRequest>) =>
      ({ ...body, lines: [{ ...body.lines[0], isTaxable: value }] }),
  ] as [string, Mutation]),
  ["unknown state", body => ({ ...body, state: "unexpected" })],
  ["missing state", body => ({ ...body, state: undefined })],
  ["unknown action", body => ({ ...body, action: "approve" })],
  ["one invalid line among valid lines", body => ({ ...body, lines: [...body.lines, { ...body.lines[0], qty: -1 }] })],
  ["null line", body => ({ ...body, lines: [...body.lines, null] })],
  ["empty lines", body => ({ ...body, lines: [] })],
  ["excess lines", body => ({ ...body, lines: Array.from({ length: 1001 }, () => body.lines[0]) })],
  ["numeric quantity string", body => ({ ...body, lines: [{ ...body.lines[0], qty: "1" }] })],
  ["infinite money JSON equivalent", body => ({ ...body, lines: [{ ...body.lines[0], rate: Infinity }] })],
  ["excess precision", body => ({ ...body, lines: [{ ...body.lines[0], rate: 1.001 }] })],
  ["excess money", body => ({ ...body, lines: [{ ...body.lines[0], rate: 100_000_000 }] })],
  ["numeric source", body => ({ ...body, sourceInvoiceIds: [123] })],
  ["invalid UUID source", body => ({ ...body, sourceInvoiceIds: ["invoice-not-uuid"] })],
  ["duplicate sources", body => ({ ...body, sourceInvoiceIds: [financialTestIds.invoice, financialTestIds.invoice] })],
  ["excess sources", body => ({ ...body, sourceInvoiceIds: Array(101).fill(financialTestIds.invoice) })],
  ["invalid operation UUID", body => ({ ...body, operationId: "not-uuid" })],
  ["invalid calendar date", body => ({ ...body, invoiceDate: "2026-02-30" })],
  ["malformed date", body => ({ ...body, invoiceDate: "09/08/2026" })],
  ["wrong version type", body => ({ ...body, expectedAssignmentVersion: "0" })],
  ["untrusted total", body => ({ ...body, total: 9999 })],
  ["tax string", body => ({ ...body, salesTaxOverride: "0" })],
  ["new invoice with edit version", body => ({ ...body, expectedInvoiceVersion: 4 })],
];
for (const [name, transform] of malformed) {
  test("rejects " + name + " before any database or auth provider access", async () => {
    const h = billingRouteHarness();
    const response = await h.handlers.POST(h.request("POST", transform(validBillingRequest())));
    assert.ok([400, 413, 422].includes(response.status), await response.clone().text());
    assert.equal((await response.json()).code.startsWith("FINANCIAL_"), true);
    assert.deepEqual(h.calls, []);
  });
}
test("PATCH rejects unknown states/actions and absent captured revision before reads", async () => {
  for (const body of [{ ...validBillingRequest(), expectedInvoiceVersion: 1, state: "other" }, { action: "other" }, validBillingRequest()]) {
    const h = billingRouteHarness();
    const response = await h.handlers.PATCH(h.request("PATCH", body, "?id=" + financialTestIds.invoice));
    assert.equal(response.status, 422);
    assert.deepEqual(h.calls, []);
  }
});
test("the bounded stream rejects excessive JSON before database access", async () => {
  const h = billingRouteHarness();
  const response = await h.handlers.POST(h.request("POST", { padding: "x".repeat(256 * 1024) }));
  assert.equal(response.status, 413);
  assert.deepEqual(h.calls, []);
});
const deleteBody = () => ({ operationId: financialTestIds.operation, expectedInvoiceVersion: 1,
  expectedAssignmentVersion: 0, expectedWorkflowCycle: 0 });
test("both administrative deletions fail safely when transactional audit creation fails", async () => {
  for (const contractor of [false, true]) {
    const h = billingRouteHarness({ contractor, auditFailure: true });
    const response = await h.handlers.DELETE(h.request("DELETE", deleteBody(), "?id=" + financialTestIds.invoice));
    assert.equal(response.status, 422);
    assert.equal(h.invoice.deleted_at, null);
    assert.ok(!h.calls.some(call => /^(update|insert):/.test(call.name)));
    assert.doesNotMatch(await response.text(), /private|database detail|constraint/);
  }
});
test("successful soft-delete preserves the invoice response and delegates the expected invoice kind", async () => {
  for (const contractor of [false, true]) {
    const h = billingRouteHarness({ contractor });
    const response = await h.handlers.DELETE(h.request("DELETE", deleteBody(), "?id=" + financialTestIds.invoice));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).invoice.id, financialTestIds.invoice);
    assert.equal((h.calls.find(call => call.name === "rpc:delete_invoice_admin_v1")?.payload as Record<string, unknown>).p_invoice_type, contractor ? "contractor" : "staff");
  }
});
test("controller mutation denial and existing paginated GET response are preserved", async () => {
  const h = billingRouteHarness({ controller: true });
  const response = await h.handlers.POST(h.request("POST", validBillingRequest()));
  assert.equal(response.status, 403);
  assert.ok(!h.calls.some(call => call.name.startsWith("rpc:")));
  const list = await h.handlers.GET(h.request("GET", undefined, "?queue=active&limit=25"));
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { invoices: [], items: [], nextCursor: null, hasMore: false, totalCount: 0 });
});
