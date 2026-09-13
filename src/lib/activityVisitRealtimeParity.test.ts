import assert from "node:assert/strict";
import test from "node:test";
import { workOrderDetailsKey } from "./counts/queryKeys";
import { measuredBatcher, routingEvent, syntheticScope } from "./realtime/realtimeTestSupport";

for (const [table, expected] of [["activities", 6], ["work_order_visits", 2]] as const) {
  test(`${table} read extraction preserves hidden burst zero requests and one affected foreground flush`, async () => {
    const fixture = measuredBatcher();
    try {
      fixture.setVisible(false);
      for (let index = 0; index < 50; index++) fixture.batcher.add(routingEvent(table, `synthetic-child-${index}`, "WOT-A"));
      await fixture.batcher.flush();
      assert.equal(fixture.total(), 0);
      assert.equal(fixture.clock.stats().sets, 0);
      assert.equal(fixture.batcher.stats().invalidations, 0);
      fixture.setVisible(true);
      await Promise.all([fixture.batcher.refresh(), fixture.batcher.refresh()]);
      assert.equal(fixture.total(), expected);
      assert.equal(fixture.batcher.stats().invalidations, 1);
      assert.ok([...fixture.calls.values()].every(count => count <= 1));
      assert.equal(fixture.calls.get(JSON.stringify(workOrderDetailsKey("WOT-B", syntheticScope))), 0);
      await fixture.batcher.flush();
      assert.equal(fixture.total(), expected);
    } finally { fixture.close(); }
  });
}
