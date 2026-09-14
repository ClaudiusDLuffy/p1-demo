import assert from "node:assert/strict";
import test from "node:test";
import { workOrderDetailsKey } from "./counts/queryKeys";
import { measuredBatcher, routingEvent, syntheticScope } from "./realtime/realtimeTestSupport";

test("photo metadata fifty same-parent events still cause one invalidation and one actual affected refresh", async () => {
  const fixture = measuredBatcher();
  try {
    for (let index = 0; index < 50; index++) fixture.batcher.add(routingEvent("photos", `synthetic-photo-${index}`, "WOT-A"));
    await fixture.batcher.flush();
    assert.equal(fixture.total(), 1);
    assert.equal(fixture.batcher.stats().invalidations, 1);
    assert.equal(fixture.calls.get(JSON.stringify(workOrderDetailsKey("WOT-A", syntheticScope))), 1);
    assert.equal(fixture.calls.get(JSON.stringify(workOrderDetailsKey("WOT-B", syntheticScope))), 0);
    assert.ok([...fixture.calls.values()].every(count => count <= 1));
    await fixture.batcher.flush();
    assert.equal(fixture.total(), 1);
  } finally { fixture.close(); }
});

test("photo metadata hidden burst causes no immediate request and one affected foreground flush", async () => {
  const fixture = measuredBatcher();
  try {
    fixture.setVisible(false);
    for (let index = 0; index < 50; index++) fixture.batcher.add(routingEvent("photos", `synthetic-photo-${index}`, "WOT-A"));
    await fixture.batcher.flush();
    assert.equal(fixture.total(), 0);
    assert.equal(fixture.clock.stats().sets, 0);
    assert.equal(fixture.batcher.stats().invalidations, 0);
    fixture.setVisible(true);
    await Promise.all([fixture.batcher.refresh(), fixture.batcher.refresh()]);
    assert.equal(fixture.total(), 1);
    assert.equal(fixture.batcher.stats().invalidations, 1);
    assert.equal(fixture.calls.get(JSON.stringify(workOrderDetailsKey("WOT-A", syntheticScope))), 1);
    assert.equal(fixture.calls.get(JSON.stringify(workOrderDetailsKey("WOT-B", syntheticScope))), 0);
  } finally { fixture.close(); }
});
