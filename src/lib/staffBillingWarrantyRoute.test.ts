import assert from "node:assert/strict";
import test from "node:test";
import { billingRouteHarness, financialTestIds, validBillingRequest } from "./billingFinancialRouteTestHarness";

type Row = Record<string, unknown>;
const partId = "00000000-0000-4000-8000-000000000002";

// Real v4 route/application graph. Arithmetic below models synthetic SQL output,
// not route-owned calculations or proof of SQL security (the SQL harness owns it).
function routeHarness(options: { role?: string; permissions?: string[]; active?: boolean; rejectSource?: boolean } = {}) {
  const saves: Row[] = [];
  let invoiceLines: Row[] = [];
  const receipt: Row = {};
  const h = billingRouteHarness({
    role: options.role, active: options.active,
    controller: options.permissions?.includes("invoice_controller"),
    commandResultOverride: receipt,
    compactRpc: (name, args) => {
      if (name !== "save_staff_billing_invoice_v4") return undefined;
      assert.equal(args.p_actor_id, financialTestIds.actor);
      assert.equal(args.p_operation_id, financialTestIds.operation);
      assert.equal(args.p_expected_assignment_version, 0);
      assert.equal(args.p_expected_workflow_cycle, 0);
      assert.ok(typeof args.p_payload === "object" && args.p_payload !== null);
      const payload = args.p_payload as Row;
      saves.push(payload);
      assert.ok(Array.isArray(payload.lines));
      invoiceLines = payload.lines.map((line: unknown) => {
        assert.ok(typeof line === "object" && line !== null && "qty" in line && "rate" in line);
        assert.ok(typeof line.qty === "number" && typeof line.rate === "number");
        return { ...line, amount: Math.round(line.qty * line.rate * 100) / 100 };
      });
      if (options.rejectSource) return { data: null, error: { code: "23514", message: "Synthetic canonical source mismatch" } };
      return undefined;
    },
  });
  const request = async (method: "POST" | "PATCH", lines: unknown[], extra: Row = {}) => {
    const body = { ...validBillingRequest(), expectedInvoiceVersion: method === "PATCH" ? 1 : null,
      state: "submitted", terms: "Net 60", lines,
      ...(typeof extra.taxRateOverride === "number" ? { salesTaxOverride: null } : {}), ...extra };
    // The mock's declared SQL outcome is independent of production validation.
    const safeLines = lines.filter((line): line is Row => typeof line === "object" && line !== null);
    const subtotal = safeLines.reduce((sum, line) => sum + Math.round(Number(line.qty) * Number(line.rate) * 100), 0) / 100;
    const taxable = safeLines.reduce((sum, line) => sum + (line.isTaxable ? Number(line.qty) * Number(line.rate) : 0), 0);
    const salesTax = typeof extra.taxRateOverride === "number" ? taxable * extra.taxRateOverride / 100 : 0;
    Object.assign(receipt, { subtotal, salesTax, total: subtotal + salesTax });
    Object.assign(h.invoice, { subtotal, sales_tax: salesTax, total: subtotal + salesTax });
    const response = await h.handlers[method]!(h.request(method, body, `?id=${financialTestIds.invoice}`));
    const data: unknown = await response.json();
    return { response, data };
  };
  return { request, saves, invoiceLines: () => invoiceLines };
}

const warranty = { type: "Warranty", desc: "Warranty service — no charge", qty: 1, rate: 0, isTaxable: false };
const labor = { type: "Labor", desc: "Additional paid service", qty: 2, rate: 100, isTaxable: false };

for (const method of ["POST", "PATCH"] as const) {
  test(`${method} retains an all-Warranty zero-rate invoice through the actual route and RPC mapping`, async () => {
    for (const state of ["draft", "submitted"]) {
      const h = routeHarness(); const { response, data } = await h.request(method, [{ ...warranty, isTaxable: true }], { state });
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(h.saves.length, 1); assert.equal(h.saves[0].salesTaxOverride, 0); assert.equal(h.saves[0].state, state);
      assert.equal(h.invoiceLines()[0].type, "Warranty"); assert.equal(h.invoiceLines()[0].rate, 0);
      assert.equal(h.invoiceLines()[0].amount, 0);
      assert.ok(typeof data === "object" && data !== null && "invoice" in data);
      assert.ok(typeof data.invoice === "object" && data.invoice !== null && "total" in data.invoice);
      assert.equal(data.invoice.total, 0);
    }
  });

  test(`${method} retains mixed Warranty and paid lines in order with unchanged tax input`, async () => {
    const h = routeHarness(); const { response, data } = await h.request(method, [warranty, { ...labor, isTaxable: true }], { taxRateOverride: 5 });
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.deepEqual(h.invoiceLines().map(line => line.type), ["Warranty", "Labor"]);
    assert.equal(h.saves[0].taxRateOverride, 5);
    assert.equal(h.saves[0].taxMode, "manual_rate");
  });

  test(`${method} preserves positive-rate precision and the existing optional Travel description`, async () => {
    const h = routeHarness(); const { response, data } = await h.request(method, [
      { ...labor, qty: 1.13, rate: 10.01 },
      { type: "Travel", desc: "", qty: 1, rate: 110 },
      { ...warranty, rate: 25 },
    ]);
    assert.equal(response.status, 200, JSON.stringify(data));
    const [rounded, travel, paidWarranty] = h.invoiceLines();
    assert.equal(rounded.qty, 1.13); assert.equal(rounded.rate, 10.01);
    assert.equal(travel.type, "Travel"); assert.equal(travel.description, ""); assert.equal(travel.rate, 110);
    assert.equal(paidWarranty.type, "Warranty"); assert.equal(paidWarranty.rate, 25);
  });

  test(`${method} rejects zero ordinary rates and malformed Warranty values instead of silently dropping a line`, async () => {
    for (const invalid of [
      { ...labor, rate: 0 }, { ...warranty, rate: -1 }, { ...warranty, rate: -0.001 },
      { ...labor, qty: 1.125 }, { ...labor, rate: 10.005 },
      { ...warranty, rate: Number.NaN }, { ...warranty, rate: Number.POSITIVE_INFINITY }, { ...warranty, rate: null },
      { ...warranty, rate: "0" }, { ...warranty, rate: false }, { ...warranty, rate: undefined },
      { type: "Warranty", desc: warranty.desc, qty: 1 }, { ...warranty, qty: 0 }, { ...warranty, qty: -1 },
      { ...warranty, qty: Number.POSITIVE_INFINITY }, { ...warranty, qty: Number.NaN }, { ...warranty, qty: "1" },
      { ...warranty, qty: Number.MAX_VALUE }, { ...warranty, desc: "   " }, { ...warranty, type: "Warranty coverage" },
    ]) {
      for (const lines of [[invalid], [labor, invalid]]) {
        const h = routeHarness(); const { response } = await h.request(method, lines);
        assert.equal(response.status, 422, `Malformed line must reject ${method}`);
        assert.equal(h.saves.length, 0);
      }
    }
  });
}

test("Warranty labeling cannot bypass the authoritative P1-part rejection or turn it into a client-priced save", async () => {
  const h = routeHarness({ rejectSource: true });
  const { response, data } = await h.request("POST", [{ ...warranty, sourceWorkOrderPartId: partId, sourceUnitCost: 100, markupPercent: 25 }]);
  assert.equal(response.status, 422, JSON.stringify(data));
  assert.equal(h.saves.length, 1);
  const [line] = h.invoiceLines();
  assert.equal(line.sourceWorkOrderPartId, partId);
  assert.equal(line.type, "Warranty");
  assert.equal(line.rate, 0);
  // No route rewrite/retry hides the SQL ownership contradiction. Positive
  // canonical quantity/type/cost/tax behavior is exercised by the SQL suite.
});

test("the Warranty path does not broaden inactive, contractor or invoice-controller route access", async () => {
  for (const options of [{ active: false }, { role: "contractor" }, { permissions: ["invoice_controller"] }]) {
    const h = routeHarness(options);
    for (const method of ["POST", "PATCH"] as const) {
      const { response } = await h.request(method, [warranty]);
      assert.equal(response.status, 403); assert.equal(h.saves.length, 0);
    }
  }
});
