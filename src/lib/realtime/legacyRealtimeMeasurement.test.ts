import assert from "node:assert/strict";
import test from "node:test";
import { measureLegacyRealtime } from "./legacyRealtimeMeasurement";
test("frozen original flush reproduces actual 18-observer hidden fanout and unscoped foreground refresh", async () => {
  const photo = await measureLegacyRealtime(Array.from({ length: 50 }, () => "photos"), true);
  assert.deepEqual(photo, { events: 50, activeObservers: 18, invalidations: 3, eventRefetches: 3, foregroundRefetches: 18 });
  const activities = await measureLegacyRealtime(Array.from({ length: 50 }, () => "activities"));
  assert.equal(activities.invalidations, 6); assert.equal(activities.eventRefetches, 7);
  const mixed = await measureLegacyRealtime(Array.from({ length: 50 }, (_, i) => i % 2 ? "photos" : "invoices"));
  assert.equal(mixed.invalidations, 9); assert.equal(mixed.eventRefetches, 9);
});
