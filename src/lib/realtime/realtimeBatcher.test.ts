import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { normalizeRealtimeEvent } from "./realtimeEvent";
import { createRealtimeBatcher, MAX_PENDING_REALTIME_EVENTS } from "./realtimeBatcher";
import { matchesRealtimePlan, planRealtimeEvent, MAX_INVALIDATION_TARGETS } from "./realtimeInvalidationPlan";
import { directoryActorScope, invoiceByIdKey, workOrderByIdKey, workOrderDetailsKey, workOrderPagesKey } from "../counts/queryKeys";
import { directoryScopeKey } from "../../features/directory/contracts";
import { currentMeasurementKeys, measuredBatcher, observerFixture, routingEvent, syntheticActor, syntheticScope, testTimer } from "./realtimeTestSupport";

for (const [table, expected] of [["photos", 1], ["work_order_visits", 2], ["activities", 6], ["work_orders", 7]] as const) {
  test(`50 ${table} events perform one invalidation, one refetch per affected visible query`, async () => {
    const fixture = measuredBatcher();
    try {
      for (let i = 0; i < 50; i++) fixture.batcher.add(routingEvent(table, table === "work_orders" ? "WOT-A" : "row-a"));
      assert.equal(fixture.batcher.stats().pendingEvents, 1); assert.equal(fixture.clock.stats().sets, 1);
      await fixture.batcher.flush(); assert.equal(fixture.batcher.stats().invalidations, 1);
      assert.equal(fixture.total(), expected); assert.ok([...fixture.calls.values()].every(n => n <= 1));
      assert.equal(fixture.calls.get(JSON.stringify(workOrderDetailsKey("WOT-B", syntheticScope))), 0);
    } finally { fixture.close(); }
  });
}
test("50 mixed events deduplicate targets across domains without touching unrelated details or providers", async () => {
  const fixture = measuredBatcher();
  try {
    for (let i = 0; i < 50; i++) fixture.batcher.add(routingEvent(i % 2 ? "photos" : "invoices", i % 2 ? "photo-a" : "invoice-a"));
    await fixture.batcher.flush(); assert.equal(fixture.batcher.stats().invalidations, 1);
    assert.ok([...fixture.calls.values()].every(n => n <= 1));
    for (const root of ["receiving-dispatch", "financial-notifications", "parts-sms"]) assert.equal(fixture.calls.get(JSON.stringify(currentMeasurementKeys.find(k => k[0] === root))), 0);
    assert.equal(fixture.calls.get(JSON.stringify(invoiceByIdKey("invoice-b", syntheticScope))), 0);
  } finally { fixture.close(); }
});
test("50 distinct activities for one parent deduplicate targets without premature overflow", async () => {
  const fixture = measuredBatcher();
  try {
    for (let i = 0; i < 50; i++) fixture.batcher.add(routingEvent("activities", `activity-${i}`));
    assert.equal(fixture.batcher.stats().overflowCount, 0); assert.equal(fixture.batcher.stats().pendingEvents, 50);
    assert.ok(fixture.batcher.stats().retainedTargets < 15);
    await fixture.batcher.flush(); assert.equal(fixture.total(), 6);
    assert.equal(fixture.calls.get(JSON.stringify(workOrderDetailsKey("WOT-B", syntheticScope))), 0);
  } finally { fixture.close(); }
});
test("hidden burst sends zero requests; foreground and duplicate flush share one refresh", async () => {
  const fixture = measuredBatcher();
  try {
    fixture.setVisible(false);
    for (let i = 0; i < 50; i++) fixture.batcher.add(routingEvent("photos", `photo-${i}`));
    await fixture.batcher.flush(); assert.equal(fixture.total(), 0); assert.equal(fixture.clock.stats().sets, 0);
    fixture.setVisible(true); await Promise.all([fixture.batcher.refresh(), fixture.batcher.refresh()]);
    assert.equal(fixture.total(), 1); assert.equal(fixture.batcher.stats().invalidations, 1);
    await fixture.batcher.flush(); assert.equal(fixture.total(), 1);
  } finally { fixture.close(); }
});
test("overflow remains bounded and collapses only affected domains", async () => {
  const fixture = measuredBatcher();
  try {
    fixture.setVisible(false);
    for (let i = 0; i < 5000; i++) fixture.batcher.add(routingEvent("photos", `photo-${i}`, `WOT-${i}`));
    assert.ok(fixture.batcher.stats().pendingEvents <= MAX_PENDING_REALTIME_EVENTS);
    assert.ok(fixture.batcher.stats().pendingTargets <= MAX_INVALIDATION_TARGETS);
    assert.equal(fixture.batcher.stats().overflowCount, 1); assert.equal(fixture.total(), 0);
    fixture.setVisible(true); await fixture.batcher.refresh(); assert.equal(fixture.total(), 2);
  } finally { fixture.close(); }
});
test("logout and late callback cannot flush into another identity", async () => {
  const fixture = measuredBatcher();
  fixture.batcher.add(routingEvent("photos")); fixture.batcher.stop();
  fixture.batcher.add(routingEvent("invoices")); fixture.clock.run(); await fixture.batcher.refresh();
  assert.equal(fixture.total(), 0); assert.equal(fixture.batcher.stats().pendingEvents, 0); fixture.close();
});
test("scoped plans exclude another actor and company; selected exact rows survive pagination", () => {
  const event = routingEvent("work_orders", "WOT-A"); const plan = planRealtimeEvent(event, syntheticActor);
  assert.equal(matchesRealtimePlan(workOrderPagesKey(directoryActorScope({ ...syntheticActor, id: "other" }), { scope: "active" }), plan, syntheticActor), false);
  assert.equal(matchesRealtimePlan(workOrderByIdKey("WOT-B", syntheticScope), plan, syntheticActor), false);
  const teamPlan = planRealtimeEvent(routingEvent("contractor_technicians", "tech-a", "WOT-A", { contractor_id: "company-a", profile_id: "profile-a" }), syntheticActor);
  assert.equal(matchesRealtimePlan(["directory", directoryScopeKey(syntheticActor), "page", "company_technicians", "company-b"], teamPlan, syntheticActor), false);
  assert.equal(matchesRealtimePlan(["directory", directoryScopeKey(syntheticActor), "selection", "technician_profile", "company-a", "profile-a"], teamPlan, syntheticActor), true);
});
test("private notification routing never crosses delivery domains", () => {
  for (const [table, root] of [["financial_notification_deliveries", "financial-notifications"], ["contractor_receiving_dispatch_deliveries", "receiving-dispatch"], ["p1_parts_alert_deliveries", "parts-sms"]]) {
    const plan = planRealtimeEvent(routingEvent(table), syntheticActor);
    const matches = currentMeasurementKeys.filter(key => matchesRealtimePlan(key, plan, syntheticActor));
    assert.equal(matches.length, 1); assert.equal(matches[0][0], root);
  }
});
test("invoice DELETE with only its primary key never refreshes unrelated work-order details", () => {
  const event = normalizeRealtimeEvent({ table: "invoices", eventType: "DELETE", old: { id: "invoice-a" } }); assert.ok(event);
  const plan = planRealtimeEvent(event, syntheticActor);
  assert.equal(matchesRealtimePlan(invoiceByIdKey("invoice-a", syntheticScope), plan, syntheticActor), true);
  for (const id of ["WOT-A", "WOT-B"]) assert.equal(matchesRealtimePlan(workOrderByIdKey(id, syntheticScope), plan, syntheticActor), false);
});
test("authorization refresh revoked while flush is waiting prevents old-scope work", async () => {
  const fixture = observerFixture(currentMeasurementKeys); const clock = testTimer();
  const batcher = createRealtimeBatcher({ client: fixture.client, actor: syntheticActor, visible: () => true, online: () => true, timer: clock.timer, refreshIdentity: async () => false });
  batcher.add(routingEvent("photos")); await batcher.refresh(); assert.equal(fixture.total(), 0); batcher.stop(); fixture.close();
});
test("failed authorization check remains pending for explicit recovery, with no unbounded retry timer", async () => {
  const fixture = observerFixture(currentMeasurementKeys); const clock = testTimer(); let errors = 0;
  const batcher = createRealtimeBatcher({ client: fixture.client, actor: syntheticActor, visible: () => true, online: () => true, timer: clock.timer,
    refreshIdentity: async () => { throw new Error("synthetic failure"); }, onError: () => { errors += 1; } });
  await batcher.refresh(); assert.equal(errors, 1); assert.equal(clock.stats().pending, false); assert.equal(fixture.total(), 0);
  batcher.stop(); fixture.close();
});
test("inactive cached queries become stale but do not refetch during an active event", async () => {
  const fixture = measuredBatcher([workOrderDetailsKey("WOT-A", syntheticScope)]);
  fixture.client.setQueryData(workOrderDetailsKey("WOT-B", syntheticScope), { synthetic: true });
  fixture.batcher.add(routingEvent("photos", "photo-a", "WOT-A")); await fixture.batcher.flush();
  assert.equal(fixture.total(), 1); assert.equal(fixture.client.getQueryState(workOrderDetailsKey("WOT-B", syntheticScope))?.isInvalidated, false);
  fixture.close();
});
test("manual refresh overlapping 50-event flush joins it instead of forcing a second refetch", async () => {
  const client = new QueryClient(); const key = workOrderDetailsKey("WOT-A", syntheticScope); let calls = 0;
  let resolveRead: (value: number) => void = () => undefined;
  client.setQueryData(key, 0);
  const observer = new QueryObserver(client, { queryKey: key, staleTime: Infinity,
    queryFn: () => { calls += 1; return new Promise<number>(resolve => { resolveRead = resolve; }); } });
  const unsubscribe = observer.subscribe(() => undefined); const clock = testTimer();
  const batcher = createRealtimeBatcher({ client, actor: syntheticActor, timer: clock.timer, visible: () => true, online: () => true });
  for (let i = 0; i < 50; i++) batcher.add(routingEvent("photos", `photo-${i}`));
  const pending = batcher.flush(); const manual = batcher.refresh(true);
  resolveRead(1); await Promise.all([pending, manual]); clock.run(); await batcher.flush();
  assert.equal(calls, 1); assert.equal(clock.stats().pending, false); assert.equal(batcher.stats().invalidations, 1);
  batcher.stop(); unsubscribe(); client.clear();
});
test("a stale count enabled at foreground is not cancelled/restarted by the pending event batch", async () => {
  const client = new QueryClient(); const key = ["work-order-count", syntheticScope, { scope: "active" }]; let calls = 0; let aborted = 0;
  let resolveRead: (value: number) => void = () => undefined;
  client.setQueryData(key, 0);
  const options = { queryKey: key, staleTime: 0, queryFn: ({ signal }: { signal: AbortSignal }) => {
    calls += 1; signal.addEventListener("abort", () => { aborted += 1; }); return new Promise<number>(resolve => { resolveRead = resolve; }); } };
  const observer = new QueryObserver(client, { ...options, enabled: false }); const unsubscribe = observer.subscribe(() => undefined);
  let visible = false; const clock = testTimer(); const batcher = createRealtimeBatcher({ client, actor: syntheticActor, timer: clock.timer, visible: () => visible, online: () => true });
  batcher.add(routingEvent("work_orders", "WOT-A")); visible = true; observer.setOptions({ ...options, enabled: true });
  const pending = batcher.refresh(); assert.equal(calls, 1); resolveRead(1); await pending;
  assert.equal(calls, 1); assert.equal(aborted, 0); batcher.stop(); unsubscribe(); client.clear();
});
test("events arriving during a flush schedule one later bounded batch without recursive refetch", async () => {
  const client = new QueryClient(); const key = workOrderDetailsKey("WOT-A", syntheticScope); let calls = 0;
  let resolveRead: (value: number) => void = () => undefined;
  client.setQueryData(key, 0);
  const observer = new QueryObserver(client, { queryKey: key, staleTime: Infinity, queryFn: () => {
    calls += 1; return new Promise<number>(resolve => { resolveRead = resolve; }); } });
  const unsubscribe = observer.subscribe(() => undefined); const clock = testTimer();
  const batcher = createRealtimeBatcher({ client, actor: syntheticActor, timer: clock.timer, visible: () => true, online: () => true });
  batcher.add(routingEvent("photos")); const first = batcher.flush(); batcher.add(routingEvent("photos", "later"));
  resolveRead(1); await first; assert.equal(calls, 1); const second = batcher.flush(); resolveRead(2); await second;
  assert.equal(calls, 2); assert.equal(batcher.stats().batches, 2); batcher.stop(); unsubscribe(); client.clear();
});
test("a held async flush does not arm repeated timers for incoming events", async () => {
  const client = new QueryClient(); const key = workOrderDetailsKey("WOT-A", syntheticScope); let calls = 0;
  let resolveRead: (value: number) => void = () => undefined;
  client.setQueryData(key, 0);
  const observer = new QueryObserver(client, { queryKey: key, staleTime: Infinity, queryFn: () => {
    calls += 1; return new Promise<number>(resolve => { resolveRead = resolve; }); } });
  const unsubscribe = observer.subscribe(() => undefined); const clock = testTimer();
  const batcher = createRealtimeBatcher({ client, actor: syntheticActor, timer: clock.timer, visible: () => true, online: () => true });
  try {
    batcher.add(routingEvent("photos", "initial")); const first = batcher.flush();
    for (let i = 0; i < 50; i++) batcher.add(routingEvent("photos", `later-${i}`));
    for (let i = 0; i < 20; i++) { clock.run(); assert.equal(batcher.flush(), first); }
    assert.equal(calls, 1); assert.equal(clock.stats().sets, 1);
    assert.equal(clock.stats().pending, false); assert.equal(batcher.stats().pendingEvents, 50);
    resolveRead(1); await first;
    assert.equal(clock.stats().sets, 2); assert.equal(clock.stats().pending, true);
    clock.run(); const second = batcher.flush(); assert.equal(calls, 2);
    resolveRead(2); await second;
    assert.equal(clock.stats().sets, 2); assert.equal(clock.stats().pending, false);
    assert.equal(batcher.stats().invalidations, 2); assert.equal(batcher.stats().pendingEvents, 0);
  } finally { batcher.stop(); unsubscribe(); client.clear(); }
});
