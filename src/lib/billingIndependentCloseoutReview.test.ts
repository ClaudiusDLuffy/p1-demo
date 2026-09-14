import assert from "node:assert/strict";
import test from "node:test";
import {
  billingRouteHarness,
  financialTestIds,
  validBillingRequest,
} from "./billingFinancialRouteTestHarness";

// Independent Stage A regression proof. These assertions express desired
// behavior, not acceptance of the defects. The unmodified harness executes the
// actual outer route, dispatcher, authorization, repositories and mappers with
// isolated synthetic ports. No real provider is contacted.
globalThis.fetch = async () => {
  throw new Error("Stage A billing probe forbids network access");
};

const invoiceId = "a6100000-abcd-4000-8abc-000000000001";
const sourceId = "a6100000-abcd-4000-8abc-000000000002";
const lineId = "a6100000-abcd-4000-8abc-000000000003";
const summary = (extra: Record<string, unknown> = {}) => ({
  projection: "summary", id: invoiceId, num: "P1-SYNTHETIC", state: "draft",
  invoice_type: "staff", work_order_id: "WOTSYNTHETIC", invoice_version: 2,
  subtotal: 10, sales_tax: 0, total: 10, line_count: 1, source_count: 0,
  contractor_assignment_version: 0, workflow_cycle: 0,
  source_invoice_ids: [], source_invoices: [], ...extra,
});

for (const kind of ["summary", "lines", "sources"] as const) {
  test(`independent Stage A compact GET ${kind} accepts SQL-equivalent uppercase UUID`, async t => {
    const run = async (requestedId: string) => {
      const h = billingRouteHarness({
        tableRows: { invoices: [{ id: invoiceId, invoice_type: "staff", state: "draft",
          invoice_version: 2, deleted_at: null }] },
        compactRpc: name => {
          if (name === "get_invoice_summary_v1") return { data: summary(), error: null };
          if (name === "get_invoice_source_summaries_v1") return {
            data: { invoices: [summary({ invoice_type: "contractor", state: "approved" })] }, error: null,
          };
          if (name === "list_invoice_lines_page_v1") return {
            data: { projection: "line_page", invoiceVersion: 2, pageSize: 50, hasMore: false, nextCursor: null,
              items: [{ id: lineId, invoice_id: invoiceId, position: 1, type: "Labor",
                description: "Synthetic service", qty: 1, rate: 10, amount: 10, is_taxable: false }] },
            error: null,
          };
          return undefined;
        },
      });
      const query = kind === "sources"
        ? `?contract=compact-v1&sourceInvoiceIds=${requestedId}`
        : `?contract=compact-v1&invoiceId=${requestedId}${kind === "lines" ? "&lines=1&expectedVersion=2" : ""}`;
      const response = await h.handlers.GET(h.request("GET", undefined, query));
      const body = await response.json();
      return { status: response.status, code: body.code ?? null,
        rpcCalls: h.calls.filter(call => call.name.startsWith("rpc:")).map(call => call.name),
        readCalls: h.calls.filter(call => call.name.startsWith("from:")).map(call => call.name) };
    };
    const lowercase = await run(invoiceId);
    const uppercase = await run(invoiceId.toUpperCase());
    const differentId = await run(sourceId);
    t.diagnostic(JSON.stringify({ observedAt: new Date().toISOString(), kind, lowercase, uppercase, differentId }));
    assert.equal(lowercase.status, 200, "The canonical lowercase control must work");
    assert.equal(differentId.status, 404, "A genuinely different UUID must remain denied");
    assert.equal(uppercase.status, 200, "The same SQL UUID must not become NOT_FOUND because its input letters are uppercase");
  });
}

for (const method of ["POST", "PATCH"] as const) {
  const run = async (extra: Record<string, unknown> = {}) => {
    const h = billingRouteHarness({ compactRpc: name => name === "get_invoice_summary_v1"
      ? { data: summary({ id: financialTestIds.invoice, ...extra }), error: null }
      : undefined });
    const response = await h.handlers[method](h.request(method, {
      ...validBillingRequest(), expectedInvoiceVersion: method === "PATCH" ? 1 : null,
    }, method === "PATCH" ? `?id=${financialTestIds.invoice}` : ""));
    const body = await response.json();
    return { status: response.status, refresh: body.refresh,
      invoice: { invoiceVersion: body.invoice?.invoiceVersion, lineCount: body.invoice?.lineCount,
        sourceCount: body.invoice?.sourceCount, projection: body.invoice?.projection },
      command: { invoiceVersion: body.command?.invoiceVersion, lineCount: body.command?.lineCount,
        sourceInvoiceCount: body.command?.sourceInvoiceCount, applied: body.command?.applied },
      commandCalls: h.calls.filter(call => call.name === "rpc:save_staff_billing_invoice_v4").length,
      summaryCalls: h.calls.filter(call => call.name === "rpc:get_invoice_summary_v1").length };
  };

  test(`independent Stage A ${method} consistent same-version summary control remains available`, async t => {
    const observed = await run();
    t.diagnostic(JSON.stringify({ observedAt: new Date().toISOString(), method, control: true, ...observed }));
    assert.equal(observed.status, 200);
    assert.equal(observed.refresh.status, "available");
    assert.equal(observed.invoice.lineCount, observed.command.lineCount);
    assert.equal(observed.invoice.sourceCount, observed.command.sourceInvoiceCount);
    assert.equal(observed.commandCalls, 1);
    assert.equal(observed.summaryCalls, 1);
  });

  test(`independent Stage A ${method} later-version summary may have changed document counts`, async t => {
    const observed = await run({ invoice_version: 3, line_count: 2,
      source_count: 1, source_invoice_ids: [sourceId], source_invoices: [] });
    t.diagnostic(JSON.stringify({ observedAt: new Date().toISOString(), method, laterVersionControl: true, ...observed }));
    assert.equal(observed.status, 200);
    assert.equal(observed.refresh.status, "available");
    assert.equal(observed.invoice.invoiceVersion, 3);
    assert.equal(observed.command.invoiceVersion, 2);
    assert.equal(observed.invoice.lineCount, 2);
    assert.equal(observed.invoice.sourceCount, 1);
    assert.equal(observed.command.lineCount, 1);
    assert.equal(observed.command.sourceInvoiceCount, 0);
    assert.equal(observed.command.applied, true);
    assert.equal(observed.commandCalls, 1);
    assert.equal(observed.summaryCalls, 1);
  });

  // Deliberately malformed secondary wire data, NOT evidence that normal SQL
  // emits these contradictory counts. This tests the closeout's validation
  // claim and preserves the validated authoritative command receipt.
  for (const [label, extra] of [
    ["line count", { line_count: 0 }],
    ["source count", { source_count: 1, source_invoice_ids: [sourceId], source_invoices: [] }],
  ] as const) {
    test(`independent Stage A ${method} contradictory same-version ${label} must preserve receipt with warning`, async t => {
      const observed = await run(extra);
      t.diagnostic(JSON.stringify({ observedAt: new Date().toISOString(), method, contradiction: label, ...observed }));
      assert.equal(observed.status, 200, "The committed financial result must remain a success");
      assert.equal(observed.command.applied, true);
      assert.equal(observed.commandCalls, 1);
      assert.equal(observed.summaryCalls, 1);
      assert.equal(observed.refresh.status, "unavailable", "Contradictory same-version document counts must not be published as available");
      assert.equal(observed.refresh.warning, "BILLING_REFRESH_UNAVAILABLE");
      assert.equal(observed.invoice.projection, "receipt");
      assert.equal(observed.invoice.lineCount, observed.command.lineCount);
      assert.equal(observed.invoice.sourceCount, observed.command.sourceInvoiceCount);
    });
  }
}
