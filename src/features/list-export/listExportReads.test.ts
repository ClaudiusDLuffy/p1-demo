import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as collection from "./listExport";
import { AppError } from "../../lib/errors/AppError";
import type * as Reads from "./listExportReads";

function harness() {
  const calls: { boundary: string; params: Record<string, unknown>; signal: AbortSignal }[] = [];
  const read = (boundary: string) => async (params: Record<string, unknown>, signal: AbortSignal) => {
    calls.push({ boundary, params, signal });
    return params.cursor ? { items: [{ id: "TWO" }], hasMore: false, nextCursor: null }
      : { items: [{ id: "ONE" }], hasMore: true, nextCursor: "next" };
  };
  const exports = {} as typeof Reads;
  const code = ts.transpileModule(readFileSync(resolve("src/features/list-export/listExportReads.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, { exports, require: (name: string) => {
    if (name === "../../lib/db") return { loadInvoicesPage: read("contractor"),
      loadWorkOrderFamily: async (id: string, signal: AbortSignal) => {
        calls.push({ boundary: "exact-family", params: { id }, signal }); return [{ id }];
      } };
    if (name.endsWith("/workOrderReadRepository")) return { loadWorkOrdersPage: read("work-orders") };
    if (name.endsWith("/billingReads")) return { readBillingRows: read("billing") };
    if (name === "./listExport") return collection;
    if (name.endsWith("/AppError")) return { AppError };
    throw new Error(`Unexpected test boundary: ${name}`);
  } });
  return { calls, reads: exports, signal: new AbortController().signal };
}

test("work-order exports preserve the visible read filters and sort across every page", async () => {
  const h = harness(); const params = { scope: "all" as const, search: "SYNTHETIC", state: "TX", storeNumber: "123",
    ntePendingApproval: true, summaryFilter: "repair", tableSortColumn: "store" as const, tableSortDirection: "asc" as const };
  const rows = await h.reads.exportWorkOrderRows(params, h.signal, () => undefined);
  assert.deepEqual(rows.map(row => row.id), ["ONE", "TWO"]);
  for (const [index, call] of h.calls.entries()) {
    assert.equal(call.boundary, "work-orders"); assert.equal(call.signal, h.signal);
    assert.deepEqual({ ...call.params }, { ...params, limit: 100, cursor: index ? "next" : null });
  }
});
test("exact WO exports use only the existing authorized family reader", async () => {
  const h = harness(); await h.reads.exportWorkOrderRows({ state: "TX" }, h.signal, () => undefined, "WOT-SYNTHETIC");
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].boundary, "exact-family");
  assert.equal(h.calls[0].params.id, "WOT-SYNTHETIC"); assert.equal(h.calls[0].signal, h.signal);
});
test("contractor invoice export retains state, search and order in the same scoped read", async () => {
  const h = harness(); const params = { state: "approved" as const, search: "SYNTHETIC", sort: "invoice" as const, direction: "asc" as const };
  await h.reads.exportContractorInvoiceRows(params, h.signal, () => undefined);
  assert.equal(h.calls.length, 2);
  for (const call of h.calls) {
    assert.equal(call.boundary, "contractor"); assert.equal(call.params.state, "approved");
    assert.equal(call.params.search, "SYNTHETIC"); assert.equal(call.params.sort, "invoice");
    assert.equal(call.params.direction, "asc"); assert.equal(call.params.limit, 100);
  }
});
test("billing exports retain exact queue membership; unsupported queues fail closed", async () => {
  for (const queue of ["all", "draft", "submitted", "sent"]) {
    const h = harness(); await h.reads.exportBillingBucketRows(queue, { search: "SYNTHETIC", sort: "total", direction: "desc" }, h.signal, () => undefined);
    assert.equal(h.calls.length, 2);
    for (const call of h.calls) {
      assert.equal(call.boundary, "billing"); assert.equal(call.params.queue, queue);
      assert.equal(call.params.search, "SYNTHETIC"); assert.equal(call.params.sort, "total");
    }
  }
  const h = harness();
  assert.throws(() => h.reads.exportBillingBucketRows("unrecognized", {}, h.signal, () => undefined), AppError);
  assert.equal(h.calls.length, 0);
});
