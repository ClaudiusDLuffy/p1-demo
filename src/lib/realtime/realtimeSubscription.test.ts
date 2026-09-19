import assert from "node:assert/strict";
import test from "node:test";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createPortalRealtimeSubscription, type RealtimeSubscriptionPorts } from "./realtimeSubscription";
import { PORTAL_REALTIME_TABLES } from "../realtimeInvalidation";
import { createPortalRealtimeSession } from "./realtimeSession";
import { observerFixture, currentMeasurementKeys, syntheticActor, testTimer } from "./realtimeTestSupport";

function subscriptionFixture(failure?: "on" | "cleanup") {
  const callbacks: ((event: unknown) => void)[] = []; const tables: string[] = [];
  let status: (value: string) => void = () => undefined; let channels = 0; let removals = 0;
  // Typed structural test port; SDK generic overloads are not reimplemented.
  const channel = { on(_kind: string, filter: { table: string }, callback: (event: unknown) => void) {
    if (failure === "on") throw new Error("synthetic registration failure");
    tables.push(filter.table); callbacks.push(callback); return channel;
  }, subscribe(callback: (value: string) => void) { status = callback; return channel; } };
  const ports = { channel() { channels += 1; return channel as unknown as RealtimeChannel; },
    removeChannel: async () => { removals += 1; if (failure === "cleanup") throw new Error("synthetic cleanup failure"); return "ok" as const; } } as RealtimeSubscriptionPorts;
  return { ports, tables, callbacks, status(value: string) { status(value); }, counts: () => ({ channels, removals }) };
}
test("one subscription registers exactly existing ten tables and guards callbacks after Strict Mode cleanup", () => {
  const fixture = subscriptionFixture(); let events = 0;
  const first = createPortalRealtimeSubscription(fixture.ports, { event() { events += 1; } });
  assert.deepEqual(fixture.tables, [...PORTAL_REALTIME_TABLES]); first(); first();
  fixture.callbacks[0]({ eventType: "INSERT", new: { id: "WOT-A" } }); assert.equal(events, 0);
  const next = createPortalRealtimeSubscription(fixture.ports, { event() { events += 1; } });
  fixture.callbacks[0]({ eventType: "INSERT", new: { id: "WOT-A" } });
  fixture.callbacks[10]({ eventType: "INSERT", new: { id: "WOT-B" } });
  assert.equal(events, 1); next(); assert.deepEqual(fixture.counts(), { channels: 2, removals: 2 });
});
test("reconnect flushes once after a real disconnection; provider errors are logged once without rows", () => {
  const fixture = subscriptionFixture(); let reconnects = 0; const errors: string[] = [];
  const stop = createPortalRealtimeSubscription(fixture.ports, { event() {}, reconnect() { reconnects += 1; }, error: category => { errors.push(category); } });
  fixture.status("SUBSCRIBED"); fixture.status("SUBSCRIBED"); assert.equal(reconnects, 0);
  fixture.status("CHANNEL_ERROR"); fixture.status("TIMED_OUT"); fixture.status("SUBSCRIBED"); fixture.status("SUBSCRIBED");
  assert.equal(reconnects, 1); assert.deepEqual(errors, ["connection"]);
  fixture.callbacks[0]({ eventType: "bad", notes: "sensitive-canary" }); fixture.callbacks[0](null);
  assert.deepEqual(errors, ["connection", "invalid_event"]); stop(); fixture.status("SUBSCRIBED"); assert.equal(reconnects, 1);
});
test("partial registration and cleanup failure do not retain active callbacks or reject unhandled", async () => {
  for (const failure of ["on", "cleanup"] as const) {
    const fixture = subscriptionFixture(failure); const errors: string[] = [];
    const stop = createPortalRealtimeSubscription(fixture.ports, { event() {}, error: category => errors.push(category) });
    stop(); await Promise.resolve(); await Promise.resolve();
    assert.equal(fixture.counts().removals, 1); assert.ok(errors.includes(failure === "on" ? "connection" : "cleanup"));
  }
});
test("session owns one channel/timer: hidden storm waits, focus plus visibility flushes once, logout cancels everything", async () => {
  const provider = subscriptionFixture(); const fixture = observerFixture(currentMeasurementKeys); const clock = testTimer();
  let visible = false; let notify: () => void = () => undefined; let unsubscribed = 0; let repeats = 0; let clearRepeats = 0; let selfReads = 0;
  const session = createPortalRealtimeSession({ client: fixture.client, actor: syntheticActor, timer: clock.timer, subscription: provider.ports,
    visibility: { visible: () => visible, online: () => true, subscribe(fn) { notify = fn; return () => { unsubscribed += 1; }; } },
    refreshIdentity: async () => { selfReads += 1; return true; }, report() {},
    repeat(_fn, delay) { assert.equal(delay, 180000); repeats += 1; return repeats; }, clearRepeat() { clearRepeats += 1; } });
  for (let i = 0; i < 50; i++) provider.callbacks[4]({ eventType: "INSERT", new: { id: `photo-${i}`, work_order_id: "WOT-A" } });
  assert.equal(fixture.total(), 0); assert.equal(clock.stats().sets, 0);
  visible = true; notify(); notify(); notify(); assert.equal(clock.stats().sets, 1);
  clock.run(); await session.refresh(); assert.equal(selfReads, 1); assert.equal(fixture.total(), 1); assert.equal(session.stats().invalidations, 1);
  provider.callbacks[4]({ eventType: "INSERT", new: { id: "photo-next", work_order_id: "WOT-A" } });
  session.stop(); session.stop(); clock.run(); await session.refresh(); assert.equal(fixture.total(), 1);
  assert.equal(unsubscribed, 1); assert.equal(repeats, 1); assert.equal(clearRepeats, 1); assert.equal(provider.counts().removals, 1); fixture.close();
});
test("realtime connection loss immediately falls back to one bounded visible HTTP refresh", async () => {
  const provider = subscriptionFixture(); const fixture = observerFixture(currentMeasurementKeys); const clock = testTimer();
  const errors: string[] = [];
  const session = createPortalRealtimeSession({ client: fixture.client, actor: syntheticActor, timer: clock.timer,
    subscription: provider.ports, visibility: { visible: () => true, online: () => true, subscribe: () => () => undefined },
    refreshIdentity: async () => true, report: category => errors.push(category), repeat: () => 1, clearRepeat() {} });
  provider.status("SUBSCRIBED"); provider.status("CHANNEL_ERROR"); provider.status("TIMED_OUT");
  assert.deepEqual(errors, ["connection"]); assert.equal(clock.stats().sets, 1);
  clock.run(); await session.refresh();
  assert.equal(fixture.total(), currentMeasurementKeys.length);
  session.stop(); fixture.close();
});
test("session cleanup attempts all resources despite visibility and interval cleanup failures", () => {
  const provider = subscriptionFixture(); const fixture = observerFixture([]); const clock = testTimer(); const errors: string[] = []; let intervalsCleared = 0;
  const session = createPortalRealtimeSession({ client: fixture.client, actor: syntheticActor, timer: clock.timer, subscription: provider.ports,
    visibility: { visible: () => true, online: () => true, subscribe() { return () => { throw new Error("synthetic visibility cleanup failure"); }; } },
    refreshIdentity: async () => true, report: category => errors.push(category), repeat: () => 1,
    clearRepeat() { intervalsCleared += 1; throw new Error("synthetic interval cleanup failure"); } });
  session.stop(); session.stop(); assert.equal(intervalsCleared, 1); assert.equal(provider.counts().removals, 1);
  assert.deepEqual(errors, ["cleanup"]); assert.equal(session.stats().closed, true); fixture.close();
});
test("session setup failure after channel creation tears down partial resources and denies inactive startup", () => {
  for (const failure of ["visibility", "interval", "inactive"] as const) {
    const provider = subscriptionFixture(); const fixture = observerFixture([]); const clock = testTimer(); const errors: string[] = []; let visibilityCleared = 0;
    const session = createPortalRealtimeSession({ client: fixture.client, actor: failure === "inactive" ? { ...syntheticActor, active: false } : syntheticActor,
      timer: clock.timer, subscription: provider.ports, visibility: { visible: () => true, online: () => true, subscribe() {
        if (failure === "visibility") throw new Error("synthetic subscribe failure");
        return () => { visibilityCleared += 1; }; } },
      refreshIdentity: async () => true, report: category => errors.push(category), repeat() { throw new Error("synthetic interval failure"); }, clearRepeat() {} });
    session.stop(); assert.equal(session.stats().closed, true);
    assert.equal(provider.counts().removals, failure === "inactive" ? 0 : 1);
    assert.equal(visibilityCleared, failure === "interval" ? 1 : 0);
    assert.deepEqual(errors, failure === "inactive" ? [] : ["setup"]); fixture.close();
  }
});
