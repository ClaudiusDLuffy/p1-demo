import assert from "node:assert/strict";
import test from "node:test";
import { billingRouteHarness, financialTestIds } from "./billingFinancialRouteTestHarness";

const command = () => ({ operationId: financialTestIds.operation, expectedInvoiceVersion: 1,
  expectedAssignmentVersion: 0, expectedWorkflowCycle: 0 });
test("contractor invoice deletion is authenticated active operational staff-only server work", async () => {
  for (const options of [{ controller: true }, { active: false }, { role: "contractor" }]) {
    const h = billingRouteHarness({ ...options, contractor: true });
    const response = await h.handlers.DELETE(h.request("DELETE", command(), "?id=" + financialTestIds.invoice));
    assert.equal(response.status, 403);
    assert.ok(!h.calls.some(call => call.name === "rpc:delete_invoice_admin_v1"));
  }
  const h = billingRouteHarness({ contractor: true });
  const request = h.request("DELETE", command(), "?id=" + financialTestIds.invoice);
  request.headers.delete("authorization");
  assert.equal((await h.handlers.DELETE(request)).status, 401);
  assert.deepEqual(h.calls, []);
});
test("deletion respects a transaction-owned linked-source conflict without a raw update", async () => {
  const h = billingRouteHarness({ contractor: true, commandError: { code: "55000", message: "Synthetic active staff-source restriction" } });
  const response = await h.handlers.DELETE(h.request("DELETE", command(), "?id=" + financialTestIds.invoice));
  assert.equal(response.status, 409);
  assert.equal(h.invoice.deleted_at, null);
  assert.ok(!h.calls.some(call => call.name.startsWith("update:")));
});
test("an audit failure cannot be reported as a successful financial deletion", async () => {
  for (const contractor of [false, true]) {
    const h = billingRouteHarness({ contractor, auditFailure: true });
    const response = await h.handlers.DELETE(h.request("DELETE", command(), "?id=" + financialTestIds.invoice));
    assert.equal(response.status, 422);
    assert.equal(h.invoice.deleted_at, null);
    assert.equal(h.calls.filter(call => call.name === "rpc:delete_invoice_admin_v1").length, 1);
    assert.ok(!h.calls.some(call => call.name === "insert:activities"));
  }
  // Actual transaction rollback (not the synthetic port's behavior) is also
  // executed by scripts/verify-invoice-integrity.mjs against isolated Postgres.
});
