import assert from "node:assert/strict";
import test from "node:test";

import {
  REALTIME_INVALIDATION_BATCH_MS,
  datasetsForRealtimeTables,
  workOrderIdFromRealtimeChange,
} from "./realtimeInvalidation";

test("realtime invalidation maps each table only to affected datasets", () => {
  assert.deepEqual(
    datasetsForRealtimeTables(["activities"]),
    ["workOrders", "workOrderDetails"],
  );
  assert.deepEqual(
    datasetsForRealtimeTables(["invoices"]),
    ["invoices", "billingInvoices"],
  );
  assert.deepEqual(
    datasetsForRealtimeTables(["photos"]),
    ["workOrderDetails"],
  );
});

test("batched tables produce a distinct targeted dataset union", () => {
  assert.equal(REALTIME_INVALIDATION_BATCH_MS, 250);
  assert.deepEqual(
    datasetsForRealtimeTables(["photos", "activities", "photos"]),
    ["workOrderDetails", "workOrders"],
  );
});

test("work-order IDs are extracted from new and delete payloads", () => {
  assert.equal(workOrderIdFromRealtimeChange({
    table: "work_orders",
    eventType: "UPDATE",
    new: { id: "WOT1" },
    old: {},
  }), "WOT1");
  assert.equal(workOrderIdFromRealtimeChange({
    table: "activities",
    eventType: "DELETE",
    new: {},
    old: { work_order_id: "WOT2" },
  }), "WOT2");
  assert.equal(workOrderIdFromRealtimeChange({
    table: "photos",
    eventType: "DELETE",
    new: {},
    old: {},
  }), null);
});
