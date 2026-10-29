import assert from "node:assert/strict";
import test from "node:test";
import { loadWorkOrderNteWaitIndicatorIds } from "./workOrderNteWaitIndicatorRepository";

const ids = ["E2E-NTE-A", "E2E-NTE-B"];

function client(responses: Array<{ data: unknown; error: unknown }>) {
  const calls: Array<{ table: string; columns: string; waiting: boolean; ids: string[]; offset: number }> = [];
  let offset = 0;
  let currentIds: string[] = [];
  let waiting = false;
  const result = {
    eq(_column: string, value: boolean) { waiting = value; return result; },
    in(_column: string, value: string[]) { currentIds = value; return result; },
    order() { return result; },
    range(from: number) { offset = from; return result; },
    abortSignal(signal: AbortSignal) {
      signal.throwIfAborted();
      calls.push({ table: "staff_invoice_nte_wait_flags", columns: "invoices!inner(work_order_id)", waiting, ids: currentIds, offset });
      return Promise.resolve(responses.shift() || { data: [], error: null });
    },
  };
  return {
    calls,
    from(table: string) {
      return { select(columns: string) {
        assert.equal(table, "staff_invoice_nte_wait_flags");
        assert.equal(columns, "invoices!inner(work_order_id)");
        return result;
      } };
    },
  };
}

test("NTE marker read binds the visible work-order page and returns only waiting IDs", async () => {
  const signal = new AbortController().signal;
  const h = client([{ data: [
    { invoices: { work_order_id: ids[1] } },
    { invoices: { work_order_id: ids[0] } },
    { invoices: { work_order_id: ids[1] } },
  ], error: null }]);
  const result = await loadWorkOrderNteWaitIndicatorIds(h, ids, signal);
  assert.deepEqual(result, ids);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], {
    table: "staff_invoice_nte_wait_flags",
    columns: "invoices!inner(work_order_id)",
    waiting: true,
    ids,
    offset: 0,
  });
});

test("NTE marker read short-circuits empty pages and rejects invalid scope or receipts", async () => {
  const empty = client([]);
  assert.deepEqual(await loadWorkOrderNteWaitIndicatorIds(empty, [], new AbortController().signal), []);
  assert.equal(empty.calls.length, 0);
  await assert.rejects(loadWorkOrderNteWaitIndicatorIds(client([]), [ids[0], ids[0]], new AbortController().signal), { code: "INVALID_REQUEST" });
  await assert.rejects(loadWorkOrderNteWaitIndicatorIds(client([{ data: [
    { invoices: { work_order_id: "OUTSIDE-PAGE" } },
  ], error: null }]), ids, new AbortController().signal), { code: "INTERNAL_ERROR" });
  await assert.rejects(loadWorkOrderNteWaitIndicatorIds(client([{ data: null, error: { code: "42501" } }]), ids, new AbortController().signal));
});

test("NTE marker read paginates large results rather than silently dropping later work orders", async () => {
  const firstPage = Array.from({ length: 500 }, () => ({ invoices: { work_order_id: ids[0] } }));
  const h = client([
    { data: firstPage, error: null },
    { data: [{ invoices: { work_order_id: ids[1] } }], error: null },
  ]);
  assert.deepEqual(await loadWorkOrderNteWaitIndicatorIds(h, ids, new AbortController().signal), ids);
  assert.deepEqual(h.calls.map(call => call.offset), [0, 500]);
});
