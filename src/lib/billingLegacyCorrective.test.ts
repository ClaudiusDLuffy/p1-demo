import assert from "node:assert/strict";
import test from "node:test";
import { billingRouteHarness } from "./billingFinancialRouteTestHarness";

const invoiceId = "76900000-0000-4000-8000-000000000001";
const sourceId = "76900000-0000-4000-8000-000000000002";
const workOrderId = "11111111-1111-4111-8111-111111111111";
const header = (id: string, invoiceType: "staff" | "contractor") => ({
  id, num: invoiceType === "staff" ? "P1-700001" : "INV-700002",
  invoice_type: invoiceType, document_kind: "invoice", state: "submitted", invoice_version: 3,
  work_order_id: workOrderId, invoice_date: "2026-09-12", service_date: "2026-09-11",
  subtotal: invoiceType === "staff" ? 175 : 70, sales_tax: 0, total: invoiceType === "staff" ? 175 : 70,
  deleted_at: null,
});
const line = (id: string, parent: string, amount: number) => ({
  id, invoice_id: parent, position: 1, type: "Labor", description: "Synthetic legacy contract line",
  qty: 1, rate: amount, amount, is_taxable: false,
});

for (const mode of ["", "&response=rows"]) {
  test(`legacy GET restores separately loaded SQL line/source/work-order facts (${mode ? "rows" : "legacy"})`, async () => {
    // Actual list_staff_invoices_page/rows_v1 SQL emits invoice headers only.
    // Returning already-enriched rows here would conceal the production gap.
    const harness = billingRouteHarness({
      compactRpc: name => ["list_staff_invoices_page", "list_staff_invoices_rows_v1"].includes(name)
        ? { data: { items: [header(invoiceId, "staff")], hasMore: false, nextCursor: null, totalCount: 1 }, error: null }
        : undefined,
      tableRows: {
        invoices: [header(sourceId, "contractor")],
        invoice_lines: [line("76900000-0000-4000-8000-000000000003", invoiceId, 175),
          line("76900000-0000-4000-8000-000000000004", sourceId, 70)],
        staff_invoice_sources: [{ id: "76900000-0000-4000-8000-000000000005", staff_invoice_id: invoiceId, contractor_invoice_id: sourceId }],
        work_orders: [{ id: workOrderId, duplicate_root_work_order_id: "WOT-900001",
          contractor_assignment_version: 7, workflow_cycle: 4 }],
      },
    });
    const request = harness.request("GET", undefined, `?queue=all&limit=25${mode}`);
    request.headers.set("x-request-id", "76900000-0000-4000-8000-000000000009");
    const response = await harness.handlers.GET(request);
    assert.equal(response.status, 200);
    const body = await response.json();
    const invoice = body.items[0];
    assert.equal(invoice.lines.length, 1, "SQL headers require a real separate line query");
    assert.equal(invoice.lines[0].amount, 175);
    assert.deepEqual(invoice.sourceInvoiceIds, [sourceId]);
    assert.equal(invoice.sourceInvoices[0].lines[0].amount, 70);
    assert.equal(invoice.contractorCost, 70);
    assert.equal(invoice.grossProfit, 105);
    assert.equal(invoice.marginPercent, 60);
    assert.equal(invoice.workOrderId, workOrderId);
    assert.equal(invoice.externalWorkOrderId, "WOT-900001");
    assert.equal(invoice.assignmentVersion, 7);
    assert.equal(invoice.workflowCycle, 4);
    assert.equal(invoice.sourceInvoices[0].externalWorkOrderId, "WOT-900001");
    assert.equal(invoice.sourceInvoices[0].assignmentVersion, 7);
    assert.equal(response.headers.get("x-request-id"), "76900000-0000-4000-8000-000000000009");
    assert.equal(harness.calls.filter(call => call.name === "from:work_orders").length, 1);
    assert.equal(harness.calls.filter(call => call.name === "from:invoice_lines").length, 2);
    if (!mode) assert.deepEqual(body.invoices, body.items);
    else assert.equal("invoices" in body, false);
  });
}

test("legacy GET next-number rejects malformed provider data without exposing it", async () => {
  const harness = billingRouteHarness({ compactRpc: name => name === "peek_staff_invoice_num"
    ? { data: { sql: "Synthetic private provider detail" }, error: null } : undefined });
  const response = await harness.handlers.GET(harness.request("GET", undefined, "?nextNumber=1"));
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /Synthetic private provider detail|"sql"/);
});

for (const field of ["duplicate_root_work_order_id", "contractor_assignment_version", "workflow_cycle"] as const) {
  test(`legacy GET rejects missing selected work-order ${field} instead of defaulting it`, async () => {
    const workOrder: Record<string, unknown> = { id: workOrderId, duplicate_root_work_order_id: "WOT-900001",
      contractor_assignment_version: 7, workflow_cycle: 4 };
    delete workOrder[field];
    const harness = billingRouteHarness({ compactRpc: rpc => rpc === "list_staff_invoices_rows_v1"
      ? { data: { items: [header(invoiceId, "staff")], hasMore: false, nextCursor: null }, error: null } : undefined,
      tableRows: { work_orders: [workOrder] } });
    const response = await harness.handlers.GET(harness.request("GET", undefined, "?response=rows"));
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /workflow_cycle|contractor_assignment_version|ZodError/);
  });
}

test("legacy GET accepts selected historical NULL work-order facts without inventing versions", async () => {
  const harness = billingRouteHarness({ compactRpc: rpc => rpc === "list_staff_invoices_rows_v1"
    ? { data: { items: [header(invoiceId, "staff")], hasMore: false, nextCursor: null }, error: null } : undefined,
    tableRows: { work_orders: [{ id: workOrderId, duplicate_root_work_order_id: null,
      contractor_assignment_version: null, workflow_cycle: null }] } });
  const response = await harness.handlers.GET(harness.request("GET", undefined, "?response=rows"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items[0].assignmentVersion, null);
  assert.equal(body.items[0].workflowCycle, null);
});

test("legacy exact GET binds uppercase UUID input to the SQL canonical invoice identity", async () => {
  const canonical = "abcdef00-abcd-4abc-8abc-abcdef000001";
  const harness = billingRouteHarness({ tableRows: { invoices: [header(canonical, "staff")],
    invoice_lines: [line("abcdef00-abcd-4abc-8abc-abcdef000002", canonical, 175)], work_orders: [] } });
  const response = await harness.handlers.GET(harness.request("GET", undefined, `?invoiceId=${canonical.toUpperCase()}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.invoice.id, canonical);
  assert.equal(body.invoice.lines[0].amount, 175);
});

test("legacy source GET binds uppercase UUIDs while preserving selection order and TEXT work-order case", async () => {
  const first = "abcdef00-abcd-4abc-8abc-abcdef000003";
  const second = "abcdef00-abcd-4abc-8abc-abcdef000004";
  const textWorkOrder = "Wot-CaseSensitive-A";
  const harness = billingRouteHarness({ tableRows: {
    invoices: [{ ...header(first, "contractor"), work_order_id: textWorkOrder },
      { ...header(second, "contractor"), work_order_id: textWorkOrder }],
    invoice_lines: [line("abcdef00-abcd-4abc-8abc-abcdef000005", first, 71),
      line("abcdef00-abcd-4abc-8abc-abcdef000006", second, 72)],
    work_orders: [{ id: textWorkOrder, duplicate_root_work_order_id: "WOT-900005", contractor_assignment_version: 9, workflow_cycle: 5 }],
  } });
  const response = await harness.handlers.GET(harness.request("GET", undefined,
    `?sourceInvoiceIds=${second.toUpperCase()},${first.toUpperCase()}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.invoices.map((invoice: { id: string }) => invoice.id), [second, first]);
  assert.deepEqual(body.invoices.map((invoice: { lines: { amount: number }[] }) => invoice.lines[0].amount), [72, 71]);
  assert.equal(body.invoices[0].workOrderId, textWorkOrder);
  assert.equal(body.invoices[0].assignmentVersion, 9);
});

for (const field of ["invoice_version", "subtotal", "sales_tax", "total"] as const) {
  test(`legacy SQL page rejects missing ${field} instead of manufacturing a version or zero`, async () => {
    const row: Record<string, unknown> = { ...header(invoiceId, "staff") };
    delete row[field];
    const harness = billingRouteHarness({ compactRpc: rpc => rpc === "list_staff_invoices_rows_v1"
      ? { data: { items: [row], hasMore: false, nextCursor: null }, error: null } : undefined });
    const response = await harness.handlers.GET(harness.request("GET", undefined, "?response=rows"));
    assert.equal(response.status, 500);
    assert.equal(harness.calls.some(call => call.name === "from:invoice_lines"), false);
  });
}

test("legacy exact invoice GET retains the complete staff document, not compact aliases", async () => {
  const harness = billingRouteHarness({ compactRpc: name => name === "get_invoice_summary_v1"
    ? { data: { ...header(invoiceId, "staff"), projection: "summary", line_count: 1, source_count: 1 }, error: null } : undefined,
    tableRows: {
    invoices: [header(invoiceId, "staff"), header(sourceId, "contractor")],
    invoice_lines: [line("76900000-0000-4000-8000-000000000003", invoiceId, 175),
      line("76900000-0000-4000-8000-000000000004", sourceId, 70)],
    staff_invoice_sources: [{ id: "76900000-0000-4000-8000-000000000005", staff_invoice_id: invoiceId, contractor_invoice_id: sourceId }],
    work_orders: [{ id: workOrderId, duplicate_root_work_order_id: "WOT-900001", contractor_assignment_version: 7, workflow_cycle: 4 }],
  } });
  const response = await harness.handlers.GET(harness.request("GET", undefined, `?invoiceId=${invoiceId}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.invoice.id, invoiceId);
  assert.ok(Array.isArray(body.invoice.lines));
  assert.equal(body.invoice.lines.length, 1);
  assert.deepEqual(body.invoice.sourceInvoiceIds, [sourceId]);
  assert.equal(body.invoice.sourceInvoices[0].lines.length, 1);
  assert.equal(body.invoice.assignmentVersion, 7);
  assert.equal(body.invoice.workflowCycle, 4);
  assert.equal(body.invoice.externalWorkOrderId, "WOT-900001");
  assert.equal(harness.calls.some(call => call.name === "rpc:get_invoice_summary_v1"), false);
});

test("legacy source-document GET preserves deduplication, selection order, and source mode precedence", async () => {
  const harness = billingRouteHarness({ tableRows: {
    invoices: [header(sourceId, "contractor")],
    invoice_lines: [line("76900000-0000-4000-8000-000000000004", sourceId, 70)],
    work_orders: [{ id: workOrderId, duplicate_root_work_order_id: "WOT-900001", contractor_assignment_version: 7, workflow_cycle: 4 }],
  } });
  const response = await harness.handlers.GET(harness.request("GET", undefined,
    `?sourceInvoiceIds=${sourceId},${sourceId}&invoiceId=${invoiceId}&nextNumber=1`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["invoices"]);
  assert.equal(body.invoices.length, 1);
  assert.equal(body.invoices[0].id, sourceId);
  assert.equal(body.invoices[0].lines[0].amount, 70);
  assert.equal(body.invoices[0].externalWorkOrderId, "WOT-900001");
  assert.equal(body.invoices[0].assignmentVersion, 7);
  assert.equal(harness.calls.some(call => call.name.startsWith("rpc:")), false);
});

test("legacy exact document preserves source binding IDs when the linked source is no longer visible", async () => {
  const harness = billingRouteHarness({ tableRows: {
    invoices: [{ ...header(invoiceId, "staff"), document_kind: "capital_quote" }], invoice_lines: [], work_orders: [],
    staff_invoice_sources: [{ id: "76900000-0000-4000-8000-000000000005", staff_invoice_id: invoiceId, contractor_invoice_id: sourceId }],
  } });
  const response = await harness.handlers.GET(harness.request("GET", undefined, `?invoiceId=${invoiceId}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.invoice.documentKind, "capital_quote");
  assert.deepEqual(body.invoice.sourceInvoiceIds, [sourceId]);
  assert.deepEqual(body.invoice.sourceInvoices, []);
  assert.equal(body.invoice.contractorCost, 0);
});

for (const [name, table, value] of [
  ["string boolean", "invoice_lines", { ...line("76900000-0000-4000-8000-000000000003", invoiceId, 175), is_taxable: "false" }],
  ["malformed decimal", "invoice_lines", { ...line("76900000-0000-4000-8000-000000000003", invoiceId, 175), amount: "NaN" }],
  ["malformed source binding", "staff_invoice_sources", { id: "bad", staff_invoice_id: invoiceId, contractor_invoice_id: sourceId }],
  ["string assignment version", "work_orders", { id: workOrderId, contractor_assignment_version: "7", workflow_cycle: 4 }],
] as const) {
  test(`legacy GET rejects ${name} repository facts without public details`, async () => {
    const harness = billingRouteHarness({ compactRpc: rpc => rpc === "list_staff_invoices_rows_v1"
      ? { data: { items: [header(invoiceId, "staff")], hasMore: false, nextCursor: null }, error: null } : undefined,
      tableRows: { invoices: [], invoice_lines: [], staff_invoice_sources: [], work_orders: [], [table]: [value] } });
    const response = await harness.handlers.GET(harness.request("GET", undefined, "?response=rows"));
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.doesNotMatch(body, /Synthetic legacy contract line|ZodError|invoice_lines|staff_invoice_sources|workflow_cycle/);
    assert.equal(JSON.parse(body).correlationId, response.headers.get("x-request-id"));
    assert.ok(response.headers.get("x-request-id"));
  });
}

test("legacy GET forwards the request signal to every supported fact query and uses explicit projections", async () => {
  const harness = billingRouteHarness({ compactRpc: rpc => rpc === "list_staff_invoices_rows_v1"
    ? { data: { items: [header(invoiceId, "staff")], hasMore: false, nextCursor: null }, error: null } : undefined,
    tableRows: {
      invoices: [header(sourceId, "contractor")], invoice_lines: [],
      staff_invoice_sources: [{ id: "76900000-0000-4000-8000-000000000005", staff_invoice_id: invoiceId, contractor_invoice_id: sourceId }],
      work_orders: [{ id: workOrderId, duplicate_root_work_order_id: "WOT-900001", contractor_assignment_version: 7, workflow_cycle: 4 }],
    } });
  const request = harness.request("GET", undefined, "?response=rows");
  const response = await harness.handlers.GET(request);
  assert.equal(response.status, 200);
  for (const table of ["invoice_lines", "staff_invoice_sources", "invoices", "work_orders"]) {
    assert.ok(harness.calls.some(call => call.name === `signal:${table}` && call.payload === request.signal), table);
    for (const call of harness.calls.filter(call => call.name === `select:${table}`)) assert.doesNotMatch(String(call.payload), /\*/);
  }
});

test("legacy GET cancelled before data dispatch does not start line/source/work-order queries", async () => {
  const harness = billingRouteHarness();
  const abort = new AbortController();
  abort.abort();
  const response = await harness.handlers.GET(harness.request("GET", undefined, "?response=rows", { signal: abort.signal }));
  assert.notEqual(response.status, 200);
  assert.equal(harness.calls.filter(call => call.name.startsWith("rpc:")).length, 0);
  assert.equal(harness.calls.filter(call => /^from:(invoices|invoice_lines|staff_invoice_sources|work_orders)$/.test(call.name)).length, 0);
});

for (const state of ["draft", "submitted", "rejected", "revised", "approved", "paid"] as const) {
  test(`legacy controller source-document access preserves current ${state} policy`, async () => {
    const allowed = state === "approved" || state === "paid";
    const harness = billingRouteHarness({ controller: true, tableRows: {
      invoices: [{ ...header(sourceId, "contractor"), state }], invoice_lines: [], work_orders: [],
    } });
    const response = await harness.handlers.GET(harness.request("GET", undefined, `?sourceInvoiceIds=${sourceId}`));
    assert.equal(response.status, allowed ? 200 : 500, "Legacy failure remains a non-leaking safe internal response; compact-v1 keeps separate403 policy");
    assert.equal(harness.calls.some(call => call.name === "from:invoice_lines"), allowed);
  });
}

for (const row of [null, { ...header(invoiceId, "staff"), deleted_at: "2026-09-12T00:00:00Z" }, header(invoiceId, "contractor")]) {
  test(`legacy exact staff document is non-leaking for ${row === null ? "missing" : row.deleted_at ? "deleted" : "wrong family"}`, async () => {
    const harness = billingRouteHarness({ tableRows: { invoices: row ? [row] : [] } });
    const response = await harness.handlers.GET(harness.request("GET", undefined, `?invoiceId=${invoiceId}`));
    assert.equal(response.status, 404);
    assert.equal(harness.calls.some(call => call.name === "from:invoice_lines"), false);
  });
}

for (const count of [1000, 1001]) {
  test(`legacy explicit complete-document read ${count === 1000 ? "retains exact" : "rejects excess"} write-bound lines (${count})`, async () => {
    const lines = Array.from({ length: count }, (_, index) => ({ ...line(`76900000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}`, invoiceId, 1), position: index + 1 }));
    const harness = billingRouteHarness({ tableRows: { invoices: [header(invoiceId, "staff")], invoice_lines: lines,
      staff_invoice_sources: [], work_orders: [] } });
    const response = await harness.handlers.GET(harness.request("GET", undefined, `?invoiceId=${invoiceId}`));
    assert.equal(response.status, count === 1000 ? 200 : 500);
    if (count === 1000) {
      const body = await response.json();
      assert.equal(body.invoice.lines.length, 1000);
      assert.equal(body.invoice.lines[999].id, lines[999].id);
      assert.ok(Buffer.byteLength(JSON.stringify(body), "utf8") < 500_000);
    }
    assert.ok(harness.calls.filter(call => call.name === "from:invoice_lines").length <= 2);
  });
}
