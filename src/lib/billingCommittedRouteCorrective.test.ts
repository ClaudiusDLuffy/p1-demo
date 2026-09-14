import assert from "node:assert/strict";
import test from "node:test";
import { billingRouteHarness, financialTestIds as ids, validBillingRequest } from "./billingFinancialRouteTestHarness";

const saveReceipt = () => ({
  applied: true, reason: "applied", invoiceId: ids.invoice, invoiceNum: "P1-SYNTHETIC", invoiceVersion: 2,
  operationId: ids.operation, workOrderId: "WOTSYNTHETIC", assignmentVersion: 0, workflowCycle: 0,
  state: "draft", subtotal: 10, salesTax: 0, total: 10, lineCount: 1, sourceInvoiceCount: 0, activityId: ids.operation,
});
const compactSummary = () => ({
  projection: "summary", id: ids.invoice, num: "P1-SYNTHETIC", invoice_type: "staff", state: "draft",
  invoice_version: 2, work_order_id: "WOTSYNTHETIC", subtotal: 10, sales_tax: 0, total: 10,
  review_revision: 1, line_count: 1, source_count: 0, contractor_assignment_version: 0, workflow_cycle: 0,
});
const commandName = "rpc:save_staff_billing_invoice_v4";
const summaryName = "rpc:get_invoice_summary_v1";

for (const method of ["POST", "PATCH"] as const) {
  const body = () => ({ ...validBillingRequest(), expectedInvoiceVersion: method === "PATCH" ? 1 : null });
  const query = method === "PATCH" ? `?id=${ids.invoice}` : "";

  test(`${method} committed route: late cancellation preserves the verified receipt and skips refresh`, async () => {
    const controller = new AbortController();
    const h = billingRouteHarness({ compactRpc: name => {
      if (name !== "save_staff_billing_invoice_v4") return undefined;
      // The receipt becomes available before cancellation; a late signal must
      // not revoke it. Other tests use the installed fetch transport directly.
      queueMicrotask(() => controller.abort());
      return { data: saveReceipt(), error: null };
    } });
    const response = await h.handlers[method](h.request(method, body(), query, { signal: controller.signal }));
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.command.invoiceId, ids.invoice);
    assert.equal(result.command.operationId, ids.operation);
    assert.equal(result.invoice.id, ids.invoice);
    assert.equal(result.invoice.invoiceVersion, 2);
    assert.equal(result.refresh.status, "not_attempted");
    assert.equal(h.calls.filter(call => call.name === commandName).length, 1);
    assert.equal(h.calls.filter(call => call.name === summaryName).length, 0);
    assert.ok(response.headers.get("x-request-id"));
  });

  for (const [label, malformed] of [
    ["missing detail", null],
    ["unknown state", { ...compactSummary(), state: "untrusted", internal_sql_detail: "synthetic-private-canary" }],
    ["wrong invoice", { ...compactSummary(), id: ids.operation }],
    ["malformed version", { ...compactSummary(), invoice_version: "bad" }],
  ] as const) {
    test(`${method} committed route: ${label} is only a secondary refresh failure`, async () => {
      const h = billingRouteHarness({ compactRpc: name => name === "get_invoice_summary_v1"
        ? { data: malformed, error: null } : undefined });
      const response = await h.handlers[method](h.request(method, body(), query));
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.equal(result.invoice.id, ids.invoice);
      assert.equal(result.invoice.invoiceVersion, 2);
      assert.equal(result.command.applied, true);
      assert.deepEqual(result.refresh, { status: "unavailable", warning: "BILLING_REFRESH_UNAVAILABLE" });
      assert.equal(h.calls.filter(call => call.name === commandName).length, 1);
      assert.equal(h.calls.filter(call => call.name === summaryName).length, 1);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-private-canary|internal_sql_detail/);
    });
  }

  test(`${method} committed route: thrown refresh failure cannot turn a financial commit into failure`, async () => {
    const h = billingRouteHarness({ compactRpc: name => {
      if (name === "get_invoice_summary_v1") throw new Error("synthetic-private-canary");
      return undefined;
    } });
    const response = await h.handlers[method](h.request(method, body(), query));
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.command.invoiceVersion, 2);
    assert.equal(result.refresh.status, "unavailable");
    assert.equal(h.calls.filter(call => call.name === commandName).length, 1);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-canary/);
  });

  test(`${method} committed route: lost command response reconciles once with identical operation and payload`, async () => {
    let attempts = 0;
    const h = billingRouteHarness({ compactRpc: name => {
      if (name === "get_invoice_summary_v1") return { data: compactSummary(), error: null };
      if (name !== "save_staff_billing_invoice_v4") return undefined;
      attempts++;
      return attempts === 1
        ? { data: null, error: { code: "", message: "synthetic-private-canary" } }
        : { data: { ...saveReceipt(), applied: false, reason: "already_applied" }, error: null };
    } });
    const response = await h.handlers[method](h.request(method, body(), query));
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.command.reason, "already_applied");
    assert.equal(result.command.operationId, ids.operation);
    const calls = h.calls.filter(call => call.name === commandName);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].payload, calls[0].payload);
    assert.equal(h.calls.filter(call => call.name === summaryName).length, 1);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-canary/);
  });

  for (const secondCode of ["", "PT409"]) {
    test(`${method} committed route: unresolved outcome with reconciliation code ${secondCode || "transport"} never refreshes`, async () => {
      let attempts = 0;
      const h = billingRouteHarness({ compactRpc: name => {
        if (name !== "save_staff_billing_invoice_v4") return undefined;
        attempts++;
        return { data: null, error: { code: attempts === 1 ? "" : secondCode, message: "synthetic-private-canary" } };
      } });
      const response = await h.handlers[method](h.request(method, body(), query));
      assert.equal(response.status, 500);
      const result = await response.json();
      assert.equal(result.code, "FINANCIAL_COMMAND_FAILED");
      assert.ok(result.correlationId);
      assert.equal(result.correlationId, response.headers.get("x-request-id"));
      assert.equal("invoice" in result, false);
      assert.equal(h.calls.filter(call => call.name === commandName).length, 2);
      assert.equal(h.calls.filter(call => call.name === summaryName).length, 0);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-private-canary|stack|hint/);
    });
  }

  for (const [label, detail] of [
    ["version older than the committed receipt", { ...compactSummary(), invoice_version: 1 }],
    ["conflicting state at the committed version", { ...compactSummary(), state: "approved" }],
  ] as const) {
    test(`${method} committed route: ${label} must not overwrite the receipt`, async () => {
      const h = billingRouteHarness({ compactRpc: name => name === "get_invoice_summary_v1"
        ? { data: detail, error: null } : undefined });
      const response = await h.handlers[method](h.request(method, body(), query));
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.refresh.status, "unavailable");
      assert.equal(result.invoice.invoiceVersion, 2);
      assert.equal(result.invoice.state, "draft");
      assert.equal(h.calls.filter(call => call.name === commandName).length, 1);
    });
  }
}

for (const action of ["mark_ready", "mark_billed"] as const) {
  for (const value of [null, [], { invoiceId: ids.invoice }, { invoiceId: ids.invoice,
    state: "submitted", transitioned: "true", internal_sql_detail: "synthetic-private-canary" }]) {
    test(`PATCH ${action} committed route: malformed receipt cannot become HTTP success ${JSON.stringify(value)}`, async () => {
      const rpc = action === "mark_ready" ? "mark_staff_invoice_ready" : "mark_staff_invoice_billed";
      const h = billingRouteHarness({ compactRpc: name => name === rpc ? { data: value, error: null } : undefined });
      const response = await h.handlers.PATCH(h.request("PATCH", { action }, `?id=${ids.invoice}`));
      assert.equal(response.status, 500);
      const result = await response.json();
      assert.equal(result.code, "FINANCIAL_RESULT_INVALID");
      assert.ok(result.correlationId);
      assert.equal(result.correlationId, response.headers.get("x-request-id"));
      assert.equal(h.calls.filter(call => call.name === `rpc:${rpc}`).length, 1);
      assert.equal(h.calls.filter(call => call.name === summaryName).length, 0);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-private-canary|internal_sql_detail|stack/);
    });
  }
}
