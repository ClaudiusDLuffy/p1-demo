import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./supabase/database.types";
import { loadStaffInvoiceById } from "../server/billing-invoices/billingPostReadAfterWrite";
import { refreshCommittedBillingInvoice } from "../server/billing-invoices/billingPostCommitResult";

const invoiceId = "76100000-0000-4000-8000-000000000101";
const sourceId = "76100000-0000-4000-8000-000000000102";
const summary = (changes: Record<string, unknown> = {}) => ({
  projection: "summary", id: invoiceId, num: "INV-SYNTHETIC-700001", state: "draft",
  invoice_type: "staff", work_order_id: "internal-synthetic-id", external_work_order_id: "WOT-900001",
  subtotal: 10.25, sales_tax: 0.84, total: 11.09, invoice_version: 2,
  contractor_assignment_version: 3, workflow_cycle: 4, line_count: 1000, source_count: 0,
  source_invoice_ids: [], source_invoices: [], ...changes,
});
function transport(value: unknown, onFetch?: (signal: AbortSignal | null | undefined) => void) {
  const calls: { url: string; body: unknown; signal: AbortSignal | null | undefined }[] = [];
  const client = createClient<Database>("https://synthetic.invalid", "synthetic-public-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      calls.push({ url: String(input), body: init?.body, signal: init?.signal });
      onFetch?.(init?.signal);
      return Response.json(value);
    } },
  });
  return { client, calls };
}

test("post-commit installed transport uses one exact summary RPC with the identical request signal", async () => {
  const controller = new AbortController();
  const h = transport(summary());
  const result = await loadStaffInvoiceById(h.client, invoiceId, controller.signal);
  assert.equal(result.id, invoiceId);
  assert.equal(result.workOrderId, "internal-synthetic-id");
  assert.equal(result.externalWorkOrderId, "WOT-900001");
  assert.equal(result.contractorAssignmentVersion, 3);
  assert.equal(result.lineCount, 1000);
  assert.equal("lines" in result, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "https://synthetic.invalid/rest/v1/rpc/get_invoice_summary_v1");
  assert.equal(h.calls[0].body, JSON.stringify({ p_invoice_id: invoiceId }));
  assert.equal(h.calls[0].signal, controller.signal);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024);
});

for (const [name, changes] of [
  ["wrong invoice UUID", { id: sourceId }],
  ["wrong family", { invoice_type: "contractor" }],
  ["unknown state", { state: "private-provider-state" }],
  ["malformed assignment version", { contractor_assignment_version: 1.5 }],
  ["negative workflow version", { workflow_cycle: -1 }],
  ["invalid source identity", { source_invoice_ids: ["private-provider-identity"] }],
  ["duplicated source summaries", { source_count: 2, source_invoice_ids: [sourceId], source_invoices: [
    { id: sourceId, num: "SYNTHETIC-SOURCE", state: "approved", subtotal: 1, sales_tax: 0, total: 1, invoice_version: 1, work_order_id: "internal-synthetic-id" },
    { id: sourceId, num: "SYNTHETIC-SOURCE", state: "approved", subtotal: 1, sales_tax: 0, total: 1, invoice_version: 1, work_order_id: "internal-synthetic-id" },
  ] }],
  ["oversized summary", { store_address: "x".repeat(204801) }],
] as const) test(`post-commit malformed ${name} is a secondary unavailable result`, async () => {
  const controller = new AbortController();
  const h = transport(summary(changes));
  const result = await refreshCommittedBillingInvoice(invoiceId, controller.signal,
    id => loadStaffInvoiceById(h.client, id, controller.signal));
  assert.deepEqual(result, { status: "unavailable", warning: "BILLING_REFRESH_UNAVAILABLE" });
  assert.equal(h.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-provider/);
});

test("post-commit cancellation before refresh prevents the optional request", async () => {
  const controller = new AbortController(); controller.abort();
  const h = transport(summary());
  const result = await refreshCommittedBillingInvoice(invoiceId, controller.signal,
    id => loadStaffInvoiceById(h.client, id, controller.signal));
  assert.deepEqual(result, { status: "not_attempted" });
  assert.equal(h.calls.length, 0);
});

test("post-commit abort during supported transport becomes a secondary outcome", async () => {
  const controller = new AbortController();
  const h = transport(summary(), signal => { assert.equal(signal, controller.signal); controller.abort(); });
  const result = await refreshCommittedBillingInvoice(invoiceId, controller.signal,
    id => loadStaffInvoiceById(h.client, id, controller.signal));
  assert.deepEqual(result, { status: "unavailable", warning: "BILLING_REFRESH_UNAVAILABLE" });
  assert.equal(h.calls.length, 1);
});

test("post-commit malformed falsy error envelope is not evidence of available detail", async () => {
  const controller = new AbortController();
  const read = Object.assign(Promise.resolve({ data: summary(), error: false }), {
    abortSignal: (signal: AbortSignal) => { assert.equal(signal, controller.signal); return read; },
  });
  // Deliberately malformed transport port. This capability assertion only
  // admits the negative fixture; the response must be validated in production.
  const client = { rpc: () => read } as unknown as Parameters<typeof loadStaffInvoiceById>[0];
  const result = await refreshCommittedBillingInvoice(invoiceId, controller.signal,
    id => loadStaffInvoiceById(client, id, controller.signal));
  assert.deepEqual(result, { status: "unavailable", warning: "BILLING_REFRESH_UNAVAILABLE" });
});
