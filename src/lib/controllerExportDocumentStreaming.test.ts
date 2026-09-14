import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import type { ControllerExportDocumentInput } from "../server/controller-exports/exportDocumentRepository";
import { exportInvoiceRow, exportQueryFake, exportTestId, loadControllerOwner } from "./controller-export-test-support/ownersHarness";
import { createEligibilityRepository } from "../server/controller-exports/eligibilityRepository";

const owner = loadControllerOwner<typeof import("../server/controller-exports/exportDocumentRepository")>("src/server/controller-exports/exportDocumentRepository.ts");
const byteOwner = loadControllerOwner<typeof import("../server/controller-exports/boundedObjectDownload")>("src/server/controller-exports/boundedObjectDownload.ts");
const facts = async (count: number) => createEligibilityRepository(exportQueryFake({ invoices: Array.from({ length: count }, (_, index) => exportInvoiceRow(index + 1)) }).session, null)
  .loadSelected(Array.from({ length: count }, (_, index) => exportTestId(index + 1)));

test("controller document iterator yields before loading later line pages and retains one invoice at a time", async () => {
  const rows = Array.from({ length: 1002 }, (_, index) => ({ id: exportTestId(5000 + index), invoice_id: exportTestId(index < 1000 ? 1 : 2),
    position: index < 1000 ? index : index - 1000, type: "Labor", description: "Synthetic", qty: 1, rate: 1, amount: 1 }));
  const fake = exportQueryFake({ invoice_lines: rows });
  const repo = owner.createExportDocumentRepository(fake.session, null);
  assert.equal(typeof repo.iterateInputs, "function");
  const iterator = repo.iterateInputs(await facts(2))[Symbol.asyncIterator]();
  const first = await iterator.next(); assert.equal(first.done, false);
  assert.equal(first.value.lines.length, 1000);
  assert.equal(fake.queries.filter(query => query.table === "invoice_lines").length, 2);
  const next = await iterator.next(); assert.equal(next.done, false); assert.equal(next.value.lines.length, 2);
  assert.equal((await iterator.next()).done, true);
});

test("controller stored PDF download cancels at byte limit without eagerly buffering the remainder", async () => {
  const [invoice] = await facts(1); const path = `${invoice.id}/${exportTestId(801)}.pdf`;
  const input: ControllerExportDocumentInput = { invoice: { ...invoice, pdfStoragePath: path }, lines: [], contractor: null, workOrder: null, useStoredOriginal: true };
  let pulled = 0; let cancelled = false;
  const client = createClient("https://synthetic.invalid", "synthetic-publishable", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async url => {
    if (String(url).includes("/rpc/")) return Response.json({ bindingId: exportTestId(800), bucket: "invoice-pdfs", objectPath: path });
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(64)); if (pulled === 5) controller.close(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }));
  } } });
  await assert.rejects(owner.createExportDocumentRepository(client, null).loadBytes(input, 64), { code: "CONFLICT" });
  assert.equal(cancelled, true); assert.equal(pulled, 2);
});

test("controller bounded stream preserves bytes and zero-length documents while rejecting malformed chunks", async () => {
  assert.deepEqual(await byteOwner.readBoundedObjectBytes(new Blob([new Uint8Array([0, 255, 128])]).stream(), 3, null), new Uint8Array([0, 255, 128]));
  assert.equal((await byteOwner.readBoundedObjectBytes(new Blob().stream(), 0, null)).byteLength, 0);
  let cancelled = false;
  const malformed = new ReadableStream<unknown>({ start(controller) { controller.enqueue("not bytes"); }, cancel() { cancelled = true; } });
  await assert.rejects(byteOwner.readBoundedObjectBytes(malformed, 100, null), { code: "INTERNAL_ERROR" });
  assert.equal(cancelled, true);
});

test("controller abort during a stalled byte read cancels the actual stream and preserves AbortError", async () => {
  const controller = new AbortController(); let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({ pull() { controller.abort(); }, cancel() { cancelled = true; } });
  await assert.rejects(byteOwner.readBoundedObjectBytes(stalled, 100, controller.signal), { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("controller byte-limit failure is not blocked by an unresponsive stream cancellation acknowledgement", async () => {
  let cancelDispatched = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2)); },
    cancel() { cancelDispatched = true; return new Promise<void>(() => undefined); } });
  const result = await Promise.race([
    byteOwner.readBoundedObjectBytes(stream, 1, null).then(() => "unexpected_success", error => error instanceof Error ? error.message : "unexpected_error"),
    new Promise<string>(resolve => setTimeout(() => resolve("timed_out"), 100)),
  ]);
  assert.notEqual(result, "timed_out"); assert.notEqual(result, "unexpected_success"); assert.equal(cancelDispatched, true);
});

test("controller streaming input bound rejects1001 lines and prevents later groups after cancellation", async () => {
  const invoices = await facts(2);
  const rows = Array.from({ length: 1001 }, (_, index) => ({ id: exportTestId(5000 + index), invoice_id: exportTestId(1),
    position: index, type: "Labor", description: "Synthetic", qty: 1, rate: 1, amount: 1 }));
  const fake = exportQueryFake({ invoice_lines: rows });
  const repo = owner.createExportDocumentRepository(fake.session, null);
  await assert.rejects(async () => { for await (const input of repo.iterateInputs(invoices)) assert.fail(`Unexpected input ${input.invoice.id}`); }, { code: "CONFLICT" });
  await assert.rejects(repo.loadInputs(Array.from({ length: 101 }, () => invoices[0])), { code: "INVALID_REQUEST" });
  const controller = new AbortController();
  const cancelled = exportQueryFake({}, (query, count) => { assert.equal(query.signal, controller.signal); if (count === 1) controller.abort(); });
  await assert.rejects(async () => { for await (const input of owner.createExportDocumentRepository(cancelled.session, controller.signal).iterateInputs(invoices)) assert.fail(`Unexpected input ${input.invoice.id}`); }, { name: "AbortError" });
  assert.equal(cancelled.dispatchCount(), 1);
});

test("controller document streaming handles500 invoices without an all-line collector or per-invoice query", async () => {
  const invoices = await facts(500);
  const rows = invoices.map((invoice, index) => ({ id: exportTestId(5000 + index), invoice_id: invoice.id, position: 0,
    type: "Labor", description: "Synthetic", qty: 1, rate: 1, amount: 1 }));
  const fake = exportQueryFake({ invoice_lines: rows });
  let count = 0;
  for await (const input of owner.createExportDocumentRepository(fake.session, null).iterateInputs(invoices)) { count += 1; assert.equal(input.lines.length, 1); }
  assert.equal(count, 500);
  assert.equal(fake.dispatchCount(), 20); // Four scoped families per100 IDs, not one query per invoice.
  assert.equal(fake.queries.filter(query => query.table === "invoice_lines").length, 5);
});
