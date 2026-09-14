import assert from "node:assert/strict";
import test from "node:test";
import { billingRouteHarness, financialTestIds, validBillingRequest } from "./billingFinancialRouteTestHarness";

for (const method of ["POST", "PATCH"] as const) {
  for (const loggingFailure of [false, true]) test(`${method} outer route logs a failure exactly once even when logging failure is ${loggingFailure}`, async () => {
    const h = billingRouteHarness({ commandError: { code: "PT409", message: "synthetic-private-error" }, loggingFailure });
    const response = await h.handlers[method](h.request(method,
      { ...validBillingRequest(), expectedInvoiceVersion: method === "POST" ? null : 1 },
      method === "PATCH" ? `?id=${financialTestIds.invoice}` : ""));
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "FINANCIAL_CONFLICT");
    assert.equal(body.correlationId, response.headers.get("x-request-id"));
    assert.equal(h.logs.length, 1);
    assert.equal(JSON.parse(h.logs[0]).correlationId, body.correlationId);
    assert.doesNotMatch(JSON.stringify([body, h.logs]), /synthetic-private-error|Synthetic logging failure/);
  });

  for (const [name, options, status] of [
    ["profile query failure", { profileError: true }, 500],
    ["permission query failure", { permissionError: true }, 500],
    ["different actor profile", { tableRows: { profiles: [{ id: financialTestIds.operation, role: "manager", active: true }] } }, 403],
  ] as const) test(`${method} outer route honors authorization fake ${name}`, async () => {
    const h = billingRouteHarness(options);
    const response = await h.handlers[method](h.request(method,
      { ...validBillingRequest(), expectedInvoiceVersion: method === "POST" ? null : 1 },
      method === "PATCH" ? `?id=${financialTestIds.invoice}` : ""));
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.correlationId, response.headers.get("x-request-id"));
    assert.equal(h.calls.filter(call => call.name === "rpc:save_staff_billing_invoice_v4").length, 0);
    assert.doesNotMatch(JSON.stringify(body), /Synthetic profile|permission lookup/);
  });
}

for (const [name, profile] of [
  ["string active flag", { id: financialTestIds.actor, role: "manager", active: "false" }],
  ["array active flag", { id: financialTestIds.actor, role: "manager", active: [] }],
] as const) test(`outer authorization rejects malformed ${name} without a save`, async () => {
  const h = billingRouteHarness({ tableRows: { profiles: [profile] } });
  const response = await h.handlers.POST(h.request("POST", validBillingRequest()));
  assert.equal(response.status, 500);
  assert.equal(h.calls.filter(call => call.name === "rpc:save_staff_billing_invoice_v4").length, 0);
});

test("outer authorization forwards the request signal to both supported profile and permission queries", async () => {
  const h = billingRouteHarness();
  const request = h.request("POST", validBillingRequest());
  const response = await h.handlers.POST(request);
  assert.equal(response.status, 200);
  for (const table of ["profiles", "staff_permission_grants"]) {
    const signals = h.calls.filter(call => call.name === `signal:${table}`);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].payload, request.signal);
  }
});
