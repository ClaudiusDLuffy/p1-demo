import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { createEligibilityRepository, EXPORT_INVOICE_FIELDS } from "../server/controller-exports/eligibilityRepository";
import { createExportSnapshot, archiveFilename, controllerExportObjectPath } from "../server/controller-exports/snapshot";
import type { ControllerExportDocumentInput, ControllerExportDocumentSession } from "../server/controller-exports/exportDocumentRepository";
import { exportQueryFake, exportTestId, exportInvoiceRow, loadControllerOwner } from "./controller-export-test-support/ownersHarness";

const documentOwner = loadControllerOwner<typeof import("../server/controller-exports/exportDocumentRepository")>("src/server/controller-exports/exportDocumentRepository.ts");
const invoiceFacts = (index = 1): ControllerExportDocumentInput["invoice"] => ({ id: exportTestId(index), num: `INV-${700000 + index}`,
  workOrderId: "WOT900001-2", contractorId: exportTestId(900), storeNumber: "42", storeAddress: "Synthetic Store",
  invoiceDate: "2026-09-12", serviceDate: "2026-09-11", dueDate: "2026-10-12", terms: "Net 30", cme: null,
  subtotal: 123.45, salesTax: 6.55, total: 130, pdfStoragePath: null, updatedAt: "2026-09-12T00:00:00.000Z" });
const line = (index = 1, invoiceId = exportTestId(1)) => ({ id: exportTestId(1000 + index), invoice_id: invoiceId, position: index,
  type: "Labor", description: "Synthetic repair", qty: 2, rate: 61.725, amount: 123.45 });
const workOrder = { id: "WOT900001-2", duplicate_root_work_order_id: "WOT900001", line_of_service: "HVAC", business_service: null,
  category: null, sub_category: null, summary: "Store 42 HVAC Repair", description: "Distinct synthetic display label" };
const contractor = { id: exportTestId(900), name: "Synthetic Staff", company: "Synthetic Contractor", email: "contractor@example.invalid", phone: null };
const documentSession = (query: ReturnType<typeof exportQueryFake>, changes: Partial<ControllerExportDocumentSession> = {}): ControllerExportDocumentSession => ({
  ...query.session,
  rpc: async () => ({ data: { bindingId: exportTestId(800), bucket: "invoice-pdfs", objectPath: `${exportTestId(1)}/${exportTestId(801)}.pdf` }, error: null }),
  storage: { from: () => ({ download: () => ({ asStream: async () => ({ data: new Blob(["%PDF-synthetic"]).stream(), error: null }) }) }) }, ...changes,
});

for (const size of [1, 99, 100, 101, 500]) test(`controller eligibility ${size} selected IDs use bounded100-ID queries and deterministic order`, async () => {
  const rows = Array.from({ length: size }, (_, index) => exportInvoiceRow(index + 1));
  const ids = rows.map(row => row.id).reverse();
  const fake = exportQueryFake({ invoices: rows.reverse() });
  const result = await createEligibilityRepository(fake.session, null).loadSelected(ids);
  assert.deepEqual(result.map(row => row.id), ids.slice().sort());
  assert.equal(fake.dispatchCount(), 3 * Math.ceil(size / 100));
  assert.ok(fake.queries.every(query => query.fields !== "*" && query.filters.every(filter => filter.operator !== "in" || Array.isArray(filter.value) && filter.value.length <= 100)));
  assert.ok(fake.queries.filter(query => query.table === "invoices").every(query => query.fields === EXPORT_INVOICE_FIELDS));
});

test("controller eligibility duplicate selection preserves existing deduplication without duplicate rows", async () => {
  const fake = exportQueryFake({ invoices: [exportInvoiceRow(1)] });
  const result = await createEligibilityRepository(fake.session, null).loadSelected([exportTestId(1), exportTestId(1)]);
  assert.equal(result.length, 1); assert.equal(fake.dispatchCount(), 3);
});
test("controller UUID selection follows PostgreSQL identity case without losing or duplicating an invoice", async () => {
  const id = "abcdefab-cdef-4abc-8abc-abcdefabcdef";
  const fake = exportQueryFake({ invoices: [exportInvoiceRow(1, { id })] });
  const result = await createEligibilityRepository(fake.session, null).loadSelected([id.toUpperCase(), id]);
  assert.deepEqual(result.map(row => row.id), [id]);
  assert.equal(fake.dispatchCount(), 3);
});
test("controller queue summary uses head counts instead of collecting a large eligible population", async () => {
  const fake = exportQueryFake({ invoices: Array.from({ length: 3000 }, (_, index) => exportInvoiceRow(index + 1)) });
  assert.deepEqual(await createEligibilityRepository(fake.session, null).queueSummary(), { count: 3000, pendingCount: 0, oldestPendingAt: null });
  const invoiceQueries = fake.queries.filter(query => query.table === "invoices");
  assert.equal(invoiceQueries.length, 1);
  assert.equal(fake.dispatchCount(), 3);
  assert.equal(invoiceQueries[0].range, undefined);
  assert.equal(invoiceQueries[0].head, true);
  assert.equal(invoiceQueries[0].count, "exact");
});
test("controller queue summary merges paged duplicate pending and held UUIDs into exact bounded exclusions", async () => {
  const invoices = Array.from({ length: 1500 }, (_, index) => exportInvoiceRow(index + 1));
  const pending = Array.from({ length: 1001 }, (_, index) => ({ invoice_id: exportTestId(Math.floor(index / 2) + 1), batch_id: exportTestId(index + 2000),
    controller_invoice_export_batches: { status: "pending", created_at: index === 1000 ? "2026-09-09T00:00:00.000Z" : "2026-09-10T00:00:00.000Z" } }));
  const held = Array.from({ length: 250 }, (_, index) => ({ invoice_id: exportTestId(index + 401) }));
  // An excluded row that is not otherwise eligible must not lower the count.
  held.push({ invoice_id: exportTestId(9999) });
  const fake = exportQueryFake({ invoices, controller_invoice_export_items: pending, contractor_invoice_payment_holds: held });
  assert.deepEqual(await createEligibilityRepository(fake.session, null).queueSummary(), { count: 850, pendingCount: 501, oldestPendingAt: "2026-09-09T00:00:00.000Z" });
  assert.equal(fake.dispatchCount(), 11); // 1 base HEAD + 2 pending pages + 1 hold page + 7 exclusion HEADs.
  const counted = fake.queries.filter(query => query.table === "invoices");
  assert.ok(counted.every(query => query.head && query.count === "exact"));
  const excludedIds = counted.flatMap(query => query.filters.filter(filter => filter.operator === "in").flatMap(filter => Array.isArray(filter.value) ? filter.value : []));
  assert.equal(excludedIds.length, 651); assert.equal(new Set(excludedIds).size, 651);
  assert.ok(counted.every(query => query.filters.every(filter => filter.operator !== "in" || Array.isArray(filter.value) && filter.value.length <= 100)));
});
test("controller queue head count rejects missing, negative, string, and provider counts safely", async () => {
  for (const response of [{ data: null, error: null }, { data: null, error: null, count: -1 }, { data: null, error: null, count: "3" }, { data: null, error: { message: "PRIVATE PROVIDER" }, count: null }]) {
    const fake = exportQueryFake({}, () => response);
    await assert.rejects(createEligibilityRepository(fake.session, null).queueSummary(), error => error instanceof Error && !error.message.includes("PRIVATE"));
    assert.equal(fake.dispatchCount(), 1);
  }
});
test("controller installed PostgREST queue counts use HEAD and forward exact cancellation without invoice data", async () => {
  const controller = new AbortController(); const calls: { url: string; method: string | undefined; signal: unknown }[] = [];
  const client = createClient("https://synthetic.invalid", "synthetic-publishable", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url, init) => {
    calls.push({ url: String(url), method: init?.method, signal: init?.signal });
    return init?.method === "HEAD" ? new Response(null, { headers: { "content-range": "*/3000" } }) : new Response("[]", { headers: { "content-type": "application/json" } });
  } } });
  assert.deepEqual(await createEligibilityRepository(client, controller.signal).queueSummary(), { count: 3000, pendingCount: 0, oldestPendingAt: null });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].method, "HEAD"); assert.ok(calls.every(call => call.signal === controller.signal));
  assert.ok(!calls.some(call => call.url.includes("/invoices?") && call.method !== "HEAD"));
});
for (const ids of [[], ["invalid"], Array.from({ length: 501 }, (_, index) => exportTestId(index + 1))]) test(`controller invalid selection ${ids.length} stops before query dispatch`, async () => {
  const fake = exportQueryFake({});
  await assert.rejects(createEligibilityRepository(fake.session, null).loadSelected(ids));
  assert.equal(fake.queries.length, 0);
});
for (const table of ["contractor_invoice_payment_holds", "controller_invoice_export_items"]) for (const position of [1, 150, 500]) {
  test(`controller exclusion ${table} in position ${position} denies before invoice/document work`, async () => {
    const invoices = Array.from({ length: 500 }, (_, index) => exportInvoiceRow(index + 1));
    const fake = exportQueryFake({ invoices, [table]: [{ invoice_id: exportTestId(position), controller_invoice_export_batches: { status: "pending" } }] });
    await assert.rejects(createEligibilityRepository(fake.session, null).loadSelected(invoices.map(row => row.id)), { code: "CONFLICT" });
    assert.ok(!fake.queries.some(query => query.table === "invoices"));
  });
}
test("controller middle-chunk database failure does not issue later chunks or expose provider content", async () => {
  const ids = Array.from({ length: 500 }, (_, index) => exportTestId(index + 1));
  const fake = exportQueryFake({}, (_query, dispatch) => dispatch === 3 ? { data: null, error: { message: "PRIVATE SQL CANARY" } } : undefined);
  await assert.rejects(createEligibilityRepository(fake.session, null).loadSelected(ids), error => error instanceof Error && !error.message.includes("PRIVATE"));
  assert.equal(fake.dispatchCount(), 4);
});
test("controller cancellation between chunks forwards identity and prevents later queries", async () => {
  const controller = new AbortController();
  const fake = exportQueryFake({}, (query, count) => { assert.equal(query.signal, controller.signal); if (count === 2) controller.abort(); });
  await assert.rejects(createEligibilityRepository(fake.session, controller.signal).loadSelected(Array.from({ length: 500 }, (_, index) => exportTestId(index + 1))), { name: "AbortError" });
  assert.equal(fake.dispatchCount(), 2);
});
for (const extra of [{ total: "130" }, { updated_at: false }, { contractor_id: "not-uuid" }, { invoice_date: "2026-02-30" }, { work_order_id: 42 }]) test(`controller eligibility rejects malformed wire ${Object.keys(extra)[0]}`, async () => {
  const fake = exportQueryFake({ invoices: [exportInvoiceRow(1, extra)] });
  await assert.rejects(createEligibilityRepository(fake.session, null).loadSelected([exportTestId(1)]), { code: "INTERNAL_ERROR" });
});
test("controller eligibility missing or stale selected rows conflict without false success", async () => {
  for (const rows of [[], [exportInvoiceRow(1, { state: "draft" })], [exportInvoiceRow(1, { deleted_at: "2026-09-12T01:00:00Z" })], [exportInvoiceRow(1, { updated_at: null })]]) {
    const fake = exportQueryFake({ invoices: rows });
    await assert.rejects(createEligibilityRepository(fake.session, null).loadSelected([exportTestId(1)]), { code: "CONFLICT" });
  }
});
test("controller automatic queue excludes holds and pending rows while counting all eligible rows", async () => {
  const fake = exportQueryFake({ invoices: [exportInvoiceRow(1), exportInvoiceRow(2), exportInvoiceRow(3)],
    contractor_invoice_payment_holds: [{ invoice_id: exportTestId(2) }],
    controller_invoice_export_items: [{ invoice_id: exportTestId(3), batch_id: exportTestId(800), controller_invoice_export_batches: { status: "pending", created_at: "2026-09-10T00:00:00.000Z" } }] });
  const repo = createEligibilityRepository(fake.session, null);
  assert.deepEqual((await repo.loadAutomatic()).map(row => row.id), [exportTestId(1)]);
  assert.deepEqual(await repo.queueSummary(), { count: 1, pendingCount: 1, oldestPendingAt: "2026-09-10T00:00:00.000Z" });
});
test("controller automatic queue rejects501 without truncating the selection", async () => {
  const fake = exportQueryFake({ invoices: Array.from({ length: 501 }, (_, index) => exportInvoiceRow(index + 1)) });
  await assert.rejects(createEligibilityRepository(fake.session, null).loadAutomatic(), { code: "CONFLICT" });
});
test("controller installed PostgREST transport receives exact abort signal for every eligible/exclusion query", async () => {
  const controller = new AbortController(); const signals: unknown[] = [];
  const client = createClient("https://synthetic.invalid", "synthetic-publishable", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url, init) => {
    signals.push(init?.signal);
    return new Response(JSON.stringify(String(url).includes("/invoices?") ? [exportInvoiceRow(1)] : []), { headers: { "content-type": "application/json" } });
  } } });
  await createEligibilityRepository(client, controller.signal).loadSelected([exportTestId(1)]);
  assert.equal(signals.length, 3); assert.ok(signals.every(signal => signal === controller.signal));
});
test("controller installed PostgREST read failure is not silently retried by the SDK", async () => {
  let requests = 0;
  const client = createClient("https://synthetic.invalid", "synthetic-publishable", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async () => {
    requests += 1; throw new Error("Synthetic transport failure");
  } } });
  await assert.rejects(createEligibilityRepository(client, null).loadSelected([exportTestId(1)]));
  assert.equal(requests, 2); // One pending and one held request; no internal retry.
});

test("controller document facts preserve complete ordered lines and exact WOT/contractor metadata", async () => {
  const fake = exportQueryFake({ invoice_lines: [line(2), line(1)], profiles: [contractor], work_orders: [workOrder] });
  const inputs = await documentOwner.createExportDocumentRepository(documentSession(fake), null).loadInputs([invoiceFacts()]);
  assert.deepEqual(inputs[0].lines.map(row => row.position), [1, 2]);
  assert.equal(inputs[0].workOrder?.id, "WOT900001-2"); assert.equal(inputs[0].workOrder?.duplicate_root_work_order_id, "WOT900001");
  assert.equal(inputs[0].useStoredOriginal, false); assert.equal(inputs[0].contractor?.company, "Synthetic Contractor");
  assert.ok(fake.queries.every(query => query.fields !== "*"));
});
test("controller document original-upload provenance retains exact selected invoice association", async () => {
  const facts = { ...invoiceFacts(), pdfStoragePath: `${exportTestId(1)}/${exportTestId(801)}.pdf` };
  const fake = exportQueryFake({ invoice_lines: [line()], activities: [{ id: exportTestId(2000), work_order_id: facts.workOrderId,
    event_key: "invoice_uploaded", deleted_at: null, event_data: { invoiceId: facts.id } }] });
  const result = await documentOwner.createExportDocumentRepository(documentSession(fake), null).loadInputs([facts]);
  assert.equal(result[0].useStoredOriginal, true);
  assert.ok(fake.queries.find(query => query.table === "activities")?.filters.some(filter => filter.column === "event_data->>invoiceId"));
});
test("controller document UUID relations preserve line, contractor, and original-upload identity case", async () => {
  const id = "abcdefab-cdef-4abc-8abc-abcdefabcdef";
  const contractorId = "fedcbafe-dcba-4fed-8fed-fedcbafedcba";
  const facts = { ...invoiceFacts(), id: id.toUpperCase(), contractorId: contractorId.toUpperCase(), pdfStoragePath: "synthetic.pdf" };
  const fake = exportQueryFake({ invoice_lines: [line(1, id)], profiles: [{ ...contractor, id: contractorId }],
    activities: [{ id: exportTestId(2000), work_order_id: facts.workOrderId, event_key: "invoice_uploaded", deleted_at: null, event_data: { invoiceId: id } }] });
  const [input] = await documentOwner.createExportDocumentRepository(documentSession(fake), null).loadInputs([facts]);
  assert.equal(input.lines.length, 1);
  assert.equal(input.contractor?.id, contractorId);
  assert.equal(input.useStoredOriginal, true);
});
test("controller document missing source rejects; malformed line fails rather than being filtered", async () => {
  for (const rows of [[], [line(1, exportTestId(1)), { ...line(2), qty: "2" }]]) {
    const fake = exportQueryFake({ invoice_lines: rows });
    await assert.rejects(documentOwner.createExportDocumentRepository(documentSession(fake), null).loadInputs([invoiceFacts()]));
  }
});
test("controller generated PDF adapter passes stored money and existing canonical-generator inputs unchanged", async () => {
  const fake = exportQueryFake({ invoice_lines: [line()], profiles: [contractor], work_orders: [workOrder] });
  const calls: unknown[][] = [];
  const repo = documentOwner.createExportDocumentRepository(documentSession(fake), null, { generatePdf: (...args) => { calls.push(args); return new Blob(["%PDF-synthetic-generated"]); } });
  const [input] = await repo.loadInputs([invoiceFacts()]);
  assert.equal(new TextDecoder().decode(await repo.loadBytes(input, 1000)), "%PDF-synthetic-generated");
  assert.deepEqual(calls[0], [{ num: "INV-700001", wot: "WOT900001-2", store: "42", storeAddr: "Synthetic Store", invoiceDate: "2026-09-12",
    serviceDate: "2026-09-11", terms: "Net 30", cme: undefined, lines: [{ type: "Labor", desc: "Synthetic repair", qty: 2, rate: 61.725, amount: 123.45 }],
    subtotal: 123.45, salesTax: 6.55, total: 130 }, null, { perspective: "contractor", fromName: "Synthetic Contractor", fromEmail: "contractor@example.invalid", fromPhone: "" }]);
});
test("controller verified stored PDF uses exact binding and actual supported Storage signal", async () => {
  const controller = new AbortController(); const calls: unknown[] = [];
  const facts = { ...invoiceFacts(), pdfStoragePath: `${exportTestId(1)}/${exportTestId(801)}.pdf` };
  const session = documentSession(exportQueryFake({}), { rpc: async (name, args) => { calls.push([name, args]); return { data: { bindingId: exportTestId(800), bucket: "invoice-pdfs", objectPath: facts.pdfStoragePath }, error: null }; },
    storage: { from: bucket => ({ download: (path, _options, parameters) => ({ asStream: async () => { calls.push([bucket, path, parameters?.signal]); return { data: new Blob(["%PDF-original"]).stream(), error: null }; } }) }) } });
  const repo = documentOwner.createExportDocumentRepository(session, controller.signal);
  const [input] = await repo.loadInputs([facts]);
  assert.equal(new TextDecoder().decode(await repo.loadBytes(input, 1000)), "%PDF-original");
  assert.deepEqual(calls, [["get_verified_invoice_object_v1", { p_invoice_id: facts.id }], ["invoice-pdfs", facts.pdfStoragePath, controller.signal]]);
});
test("controller malformed or foreign PDF binding prevents Storage access", async () => {
  for (const data of [null, { bindingId: exportTestId(800), bucket: "invoice-pdfs", objectPath: "foreign.pdf" }, { bindingId: "bad", bucket: "invoice-pdfs", objectPath: "x" }]) {
    let downloads = 0;
    const session = documentSession(exportQueryFake({}), { rpc: async () => ({ data, error: null }), storage: { from: () => ({ download: () => ({ asStream: async () => { downloads += 1; return { data: new Blob().stream(), error: null }; } }) }) } });
    const repo = documentOwner.createExportDocumentRepository(session, null);
    const [input] = await repo.loadInputs([{ ...invoiceFacts(), pdfStoragePath: "expected.pdf" }]);
    await assert.rejects(repo.loadBytes(input, 1000)); assert.equal(downloads, 0);
  }
});
test("controller document byte budget accepts exact bound and rejects one over before second allocation", async () => {
  const repo = documentOwner.createExportDocumentRepository(documentSession(exportQueryFake({ invoice_lines: [line()] })), null,
    { generatePdf: () => new Blob([new Uint8Array(1024)]) });
  const [input] = await repo.loadInputs([invoiceFacts()]);
  assert.equal((await repo.loadBytes(input, 1024)).byteLength, 1024);
  await assert.rejects(repo.loadBytes(input, 1023));
});
test("controller snapshot preserves canonical WOT, portal identity, exact CSV bytes and deterministic filenames", () => {
  const input: ControllerExportDocumentInput = { invoice: invoiceFacts(), lines: [], contractor, workOrder, useStoredOriginal: false };
  const original = structuredClone(input);
  const first = createExportSnapshot([input]); const second = createExportSnapshot([input]);
  const path = `Contractor-Bill-PDFs/Invoice-INV-700001-WOT900001-${exportTestId(1)}.pdf`;
  assert.deepEqual(first, second); assert.deepEqual(input, original);
  assert.deepEqual(first.sources, [{ invoiceId: exportTestId(1), updatedAt: "2026-09-12T00:00:00.000Z" }]);
  assert.deepEqual(first.pdfEntries, [{ invoiceId: exportTestId(1), name: path }]);
  const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(first.manifest);
  assert.equal(csv, `\uFEFFReference Only,Portal Invoice ID,Contractor Invoice Number,Contractor,Contractor Email,7-Eleven Work Order,P1 Portal Work Order,Store,Equipment Tag,Invoice Date,Service Date,Due Date,Subtotal,Sales Tax,Total,Source PDF\r\nNot a QuickBooks import file,${exportTestId(1)},INV-700001,Synthetic Contractor,contractor@example.invalid,WOT900001,WOT900001-2,42,7-ELEVEN: HVAC,2026-09-12,2026-09-11,2026-10-12,123.45,6.55,130.00,${path}`);
  assert.equal(archiveFilename(exportTestId(800), "reference_manifest_v2", "2026-09-12T00:00:00Z"), "Contractor-Bills-2026-09-12-95100000-000.zip");
  assert.equal(controllerExportObjectPath(exportTestId(800), new Date("2026-09-12T00:00:00Z")), `2026-09-12/${exportTestId(800)}.zip`);
});
