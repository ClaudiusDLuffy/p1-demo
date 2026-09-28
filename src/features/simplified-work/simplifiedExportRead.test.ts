import assert from "node:assert/strict";
import test from "node:test";
import { collectSimplifiedExport, EXPORT_ROW_LIMIT, SimplifiedExportLimitError } from "./simplifiedExportRead";
import type { WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";

const row = (id: string) => ({ id, status: "assigned", priority: "p3" }) as WorkOrderReadModel;
const page = (ids: string[], nextCursor: string | null = null) => ({ items: ids.map(row), nextCursor, hasMore: Boolean(nextCursor), totalCount: null });

test("export reads every matching page with unchanged filters and deduplicates boundaries", async () => {
  const params = { scope: "capital" as const, status: "capital_equipment_ordered", search: "test", contractorId: "actor" };
  const cursors: Array<string | null | undefined> = [];
  const counts: number[] = [];
  const signal = new AbortController().signal;
  const rows = await collectSimplifiedExport(params, signal, count => counts.push(count), async (query, suppliedSignal) => {
    assert.equal(suppliedSignal, signal);
    assert.deepEqual(query, { ...params, cursor: cursors.length ? "next" : null, limit: 100 });
    cursors.push(query?.cursor);
    return cursors.length === 1 ? page(["one", "two"], "next") : page(["two", "three"]);
  });
  assert.deepEqual(rows.map(value => value.id), ["one", "two", "three"]);
  assert.deepEqual(counts, [2, 3]);
});

test("empty export returns no rows", async () => {
  assert.deepEqual(await collectSimplifiedExport({}, new AbortController().signal, () => {}, async () => page([])), []);
});

test("later page failure rejects the entire export", async () => {
  await assert.rejects(collectSimplifiedExport({}, new AbortController().signal, () => {}, async params => {
    if (params?.cursor) throw new Error("synthetic read failed");
    return page(["one"], "next");
  }), /synthetic read failed/);
});

test("abort before and during a page prevents returning private rows", async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(collectSimplifiedExport({}, before.signal, () => {}, async () => { throw new Error("must not fetch"); }), { name: "AbortError" });
  const during = new AbortController();
  await assert.rejects(collectSimplifiedExport({}, during.signal, () => { throw new Error("must not report progress"); }, async () => {
    during.abort(); return page(["one"]);
  }), { name: "AbortError" });
});

test("repeated, cycling, absent and empty-page cursors fail closed", async () => {
  for (const malformed of [
    async () => page(["one"], "repeat"),
    async (params?: { cursor?: string | null }) => page(["one"], params?.cursor === "a" ? "b" : "a"),
    async () => ({ ...page(["one"]), hasMore: true }),
    async () => page([], "next"),
  ]) await assert.rejects(collectSimplifiedExport({}, new AbortController().signal, () => {}, malformed), { code: "INTERNAL_ERROR" });
});

test("resource limit is explicit and never returns a truncated successful export", async () => {
  let requests = 0;
  await assert.rejects(collectSimplifiedExport({}, new AbortController().signal, () => {}, async () => {
    const first = requests++ * 100;
    return page(Array.from({ length: 100 }, (_, index) => String(first + index)), String(requests));
  }), SimplifiedExportLimitError);
  assert.equal(requests, EXPORT_ROW_LIMIT / 100);
});

test("exactly 10,000 rows can succeed when the final page is complete", async () => {
  let requests = 0;
  const rows = await collectSimplifiedExport({}, new AbortController().signal, () => {}, async () => {
    const first = requests++ * 100;
    return page(Array.from({ length: 100 }, (_, index) => String(first + index)), requests === 100 ? null : String(requests));
  });
  assert.equal(rows.length, EXPORT_ROW_LIMIT);
});

test("continually changing cursors cannot keep an export running without progress", async () => {
  let requests = 0;
  await assert.rejects(collectSimplifiedExport({}, new AbortController().signal, () => {}, async () =>
    page(["same-row"], String(++requests))), { code: "INTERNAL_ERROR" });
  assert.equal(requests, EXPORT_ROW_LIMIT / 100);
});
