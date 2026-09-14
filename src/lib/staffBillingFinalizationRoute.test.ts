import assert from "node:assert/strict";
import test from "node:test";
import { billingRouteHarness, financialTestIds } from "./billingFinancialRouteTestHarness";

type Row = Record<string, unknown>;
const invoiceId = financialTestIds.invoice;

// Exercise the thin route AND its real application/command boundaries. Only
// authenticated database IO is synthetic; incomplete legacy receipts are not
// substituted for the strict authoritative finalization contract.
function routeHarness(options: {
  rpcError?: unknown; rpcThrows?: boolean; reloadError?: unknown;
  missingAfterBilling?: boolean; active?: boolean; role?: string;
  controller?: boolean; finalization?: Row;
} = {}) {
  const h = billingRouteHarness({
    active: options.active, role: options.role, controller: options.controller,
    commandResultOverride: options.finalization,
    compactRpc: (name, args) => {
      if (name === "mark_staff_invoice_billed") {
        assert.equal(args.p_invoice_id, invoiceId);
        assert.equal(args.p_actor_id, financialTestIds.actor);
        if (options.rpcThrows) throw options.rpcError;
        if (options.rpcError) return { data: null, error: options.rpcError };
      }
      if (name === "get_invoice_summary_v1" && (options.reloadError || options.missingAfterBilling)) {
        return { data: null, error: options.reloadError ?? null };
      }
      return undefined;
    },
  });
  return { get calls() { return h.calls.map(call => call.name.replace(/^rpc:/, "")); },
    request: () => h.handlers.PATCH!(h.request("PATCH", { action: "mark_billed" }, `?id=${invoiceId}`)) };
}

const guards = [
  ["23514", 'new row for relation "work_order_visits" violates check constraint "work_order_visits_checkout_complete"', "BILLING_VISIT_TIME_REVIEW_REQUIRED", 409, /open visit.*check-in time or checkout details.*review/i],
  ["40001", "This billing document belongs to a prior workflow cycle and cannot close the reopened work order", "BILLING_PRIOR_WORKFLOW", 409, /creation date.*missing or predates reopening/i],
  ["23514", "Only a billing document ready for 7-Eleven can be submitted", "BILLING_NOT_READY", 409, /not ready/i],
  ["23514", "Current reopened workflow metadata is missing", "BILLING_WORKFLOW_REVIEW_REQUIRED", 409, /history.*incomplete/i],
  ["23514", "Billing audit state does not match the invoice state", "BILLING_AUDIT_REVIEW_REQUIRED", 409, /do not match/i],
  ["23514", "This work order was closed without additional billing; reopen it before billing another invoice", "BILLING_WORK_ORDER_CLOSED", 409, /closed without additional billing/i],
  ["23514", "Capital quote is not linked to an active capital work order", "BILLING_CAPITAL_LINK_REQUIRED", 409, /active capital work order/i],
  ["42501", "Staff access required", "BILLING_FORBIDDEN", 403, /permission/i],
  ["42501", "Operational staff access required", "BILLING_FORBIDDEN", 403, /permission/i],
  ["P0002", "Billing invoice not found", "BILLING_NOT_FOUND", 404, /not found/i],
] as const;

for (const [code, message, publicCode, status, safeMessage] of guards) {
  test(`mark_billed explains ${publicCode} from a plain PostgREST error without exposing details`, async () => {
    const h = routeHarness({ rpcError: { code, message, details: "PRIVATE-SYNTHETIC-DETAIL", hint: "PRIVATE-SYNTHETIC-HINT" } });
    const response = await h.request();
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.code, publicCode);
    assert.match(body.error, safeMessage);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE-SYNTHETIC/);
    assert.equal(h.calls.filter(call => call === "mark_staff_invoice_billed").length, 1);
    assert.ok(h.calls.includes("from:profiles"));
    assert.ok(!h.calls.includes("get_invoice_summary_v1"));
  });
}

test("unknown, altered and thrown provider errors stay safe without an automatic mutation retry", async () => {
  for (const rpcError of [
    { code: "23514", message: "PRIVATE-SYNTHETIC-CONSTRAINT", details: "private" },
    { code: "XX000", message: guards[0][1] },
    { code: "40001", message: `${guards[0][1]} PRIVATE-SYNTHETIC` },
    new Error("PRIVATE-SYNTHETIC-TRANSPORT"), null, "PRIVATE-SYNTHETIC-TEXT",
  ]) {
    const h = routeHarness({ rpcError, rpcThrows: true });
    const response = await h.request();
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.code, "BILLING_FINALIZATION_UNCONFIRMED");
    assert.match(body.error, /refresh.*before trying again/i);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE-SYNTHETIC|workflow cycle/);
    assert.equal(h.calls.filter(call => call === "mark_staff_invoice_billed").length, 1);
  }
});

test("a successful transaction followed by reload failure is not reported as a failed billing transaction", async () => {
  for (const options of [
    { reloadError: { message: "PRIVATE-SYNTHETIC-READ-FAILURE" } },
    { missingAfterBilling: true },
    { reloadError: { message: "PRIVATE-SYNTHETIC-READ-FAILURE" }, finalization: { applied: false, reason: "already_billed", transitioned: false, visitsClosed: 0 } },
    { reloadError: { message: "PRIVATE-SYNTHETIC-READ-FAILURE" }, finalization: { applied: false, reason: "already_submitted", documentKind: "capital_quote", transitioned: false, visitsClosed: 0 } },
  ]) {
    const h = routeHarness(options);
    const response = await h.request();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.refresh.status, "unavailable");
    assert.equal(body.invoice.projection, "receipt");
    assert.equal(body.finalization.invoiceId, invoiceId);
    assert.match(body.refresh.warning, /refresh/i);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE-SYNTHETIC/);
    assert.equal(h.calls.filter(call => call === "mark_staff_invoice_billed").length, 1);
  }
});

test("normal, capital and replay billing success retain the invoice/finalization response", async () => {
  for (const finalization of [
    { applied: true, workOrderClosed: true, pendingCapitalCompletion: false },
    { applied: true, reason: "submitted", documentKind: "capital_quote", workOrderClosed: false, pendingCapitalCompletion: true, workOrderStatus: "pending_capital_completion" },
    { applied: false, reason: "already_billed", workOrderClosed: false, transitioned: false, visitsClosed: 0 },
  ]) {
    const h = routeHarness({ finalization });
    const response = await h.request();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.invoice.id, invoiceId);
    for (const [key, value] of Object.entries(finalization)) assert.equal(body.finalization[key], value);
    assert.equal(body.finalization.invoiceId, invoiceId);
  }
});

test("billing error handling does not broaden active operational staff authorization", async () => {
  for (const options of [{ active: false }, { role: "contractor" }, { controller: true }]) {
    const h = routeHarness(options);
    assert.equal((await h.request()).status, 403);
    assert.ok(h.calls.includes("from:profiles"));
    assert.ok(!h.calls.includes("mark_staff_invoice_billed"));
  }
});
