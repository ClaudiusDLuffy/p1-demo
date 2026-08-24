import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStoreWorkOrderHistory,
  storeWorkOrderHistoryTotal,
} from "./storeWorkOrderHistory";

const current = {
  id: "WOT3",
  store: "35042",
  createdAt: "2026-08-24T12:00:00Z",
};

test("store history pins the current call and orders exact-store history newest first", () => {
  assert.deepEqual(
    buildStoreWorkOrderHistory(current, [
      { id: "OTHER", store: "99999", createdAt: "2026-08-24T13:00:00Z" },
      { id: "WOT1", store: "35042", createdAt: "2026-08-20T12:00:00Z" },
      { id: "WOT2", store: "35042", createdAt: "2026-08-23T12:00:00Z" },
      { ...current, summary: "stale list copy" },
    ]).map(workOrder => workOrder.id),
    ["WOT3", "WOT2", "WOT1"],
  );
});

test("store history is bounded and does not render without an exact store", () => {
  assert.deepEqual(
    buildStoreWorkOrderHistory({ id: "WOT3", store: null }, [current]),
    [],
  );
  assert.equal(
    buildStoreWorkOrderHistory(current, [
      { id: "WOT2", store: "35042" },
      { id: "WOT1", store: "35042" },
    ], 2).length,
    2,
  );
});

test("authorized server totals can exceed the compact visible preview", () => {
  const rows = buildStoreWorkOrderHistory(current, [], 5);
  assert.equal(storeWorkOrderHistoryTotal(rows, 18), 18);
  assert.equal(storeWorkOrderHistoryTotal(rows, Number.NaN), 1);
});
