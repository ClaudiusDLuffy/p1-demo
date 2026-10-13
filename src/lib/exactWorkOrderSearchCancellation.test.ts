import assert from "node:assert/strict";
import test from "node:test";
import { createWorkOrderReadHarness, respond } from "./work-order-read-test-support/harness";

const row = (id: string) => ({ id, status: "assigned", priority: "p3",
  created_at: "2026-09-12T00:00:00.000Z", store_timezone: "America/New_York" });

test("exact search shares cancellation with candidate lookup and every authorized family header", async () => {
  const controller = new AbortController();
  const harness = createWorkOrderReadHarness([respond(row("WOT9999999-2")), respond(row("WOT9999999"))], undefined,
    () => ({ data: [{ id: "WOT9999999-2" }, { id: "WOT9999999" }], error: null }));
  const result = await harness.loadFamily("WOT9999999", controller.signal) as { id: string }[];
  assert.deepEqual(result.map(work => work.id), ["WOT9999999-2", "WOT9999999"]);
  assert.equal(harness.familyCalls[0].signal, controller.signal);
  assert.deepEqual(harness.familyCalls[0].filters, [["deleted_at", null],
    ["or", "id.eq.WOT9999999,duplicate_root_work_order_id.eq.WOT9999999"]]);
  assert.ok(harness.calls.every(call => call.signal === controller.signal));
});

test("already-cancelled exact search sends no candidate or header requests", async () => {
  const controller = new AbortController(); controller.abort();
  const harness = createWorkOrderReadHarness([], undefined, () => { throw new Error("Unexpected query"); });
  await assert.rejects(harness.loadFamily("WOT9999999", controller.signal), error => error === controller.signal.reason);
  assert.equal(harness.familyCalls.length, 0);
  assert.equal(harness.calls.length, 0);
});

test("changing WOT cancels the pending candidate lookup while a fresh search can complete", async () => {
  const old = new AbortController(); const fresh = new AbortController();
  let ready: (() => void) | undefined;
  const dispatched = new Promise<void>(done => { ready = done; });
  const harness = createWorkOrderReadHarness([respond(row("WOT8888888"))], undefined, call => {
    if (call.signal === fresh.signal) return { data: [{ id: "WOT8888888" }], error: null };
    ready?.();
    return new Promise(resolve => call.signal?.addEventListener("abort",
      () => resolve({ data: null, error: { name: "AbortError" } }), { once: true }));
  });
  const pending = harness.loadFamily("WOT9999999", old.signal);
  const cancelled = assert.rejects(pending, error => error === old.signal.reason);
  await dispatched; old.abort();
  const result = await harness.loadFamily("WOT8888888", fresh.signal) as { id: string }[];
  await cancelled;
  assert.deepEqual(result.map(work => work.id), ["WOT8888888"]);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].signal, fresh.signal);
});

test("navigation cancels in-flight family hydration and does not publish stale headers", async () => {
  const controller = new AbortController();
  let ready: (() => void) | undefined;
  const dispatched = new Promise<void>(done => { ready = done; });
  const harness = createWorkOrderReadHarness([call => {
    ready?.();
    return new Promise(resolve => call.signal?.addEventListener("abort",
      () => resolve({ data: row("WOT9999999"), error: null }), { once: true }));
  }], undefined, () => ({ data: [{ id: "WOT9999999" }], error: null }));
  const pending = harness.loadFamily("WOT9999999", controller.signal);
  const cancelled = assert.rejects(pending, error => error === controller.signal.reason);
  await dispatched; controller.abort(); await cancelled;
  assert.equal(harness.calls.length, 1);
});
