import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { normalizeRealtimeEvent } from "../src/lib/realtime/realtimeEvent";
import { planRealtimeEvent } from "../src/lib/realtime/realtimeInvalidationPlan";
import { measuredBatcher, routingEvent, syntheticActor } from "../src/lib/realtime/realtimeTestSupport";
import { measureLegacyRealtime } from "../src/lib/realtime/legacyRealtimeMeasurement";
import { LEGACY_REALTIME_FLUSH_SHA256, LEGACY_REALTIME_SOURCE_SHA256 } from "../src/lib/realtime/legacyRealtimeFixture";
import { workOrderDetailsKey } from "../src/lib/counts/queryKeys";
import { syntheticScope } from "../src/lib/realtime/realtimeTestSupport";

const distribution = (samples: number[]) => {
  const ordered = [...samples].sort((a, b) => a - b);
  return { p50: ordered[Math.ceil(ordered.length * .5) - 1], p95: ordered[Math.ceil(ordered.length * .95) - 1], max: ordered.at(-1) };
};
async function main() {
const legacy = {
  onePhoto: await measureLegacyRealtime(["photos"]),
  fiftyPhotosHidden: await measureLegacyRealtime(Array.from({ length: 50 }, () => "photos"), true),
  fiftyActivities: await measureLegacyRealtime(Array.from({ length: 50 }, () => "activities")),
  fiftyMixed: await measureLegacyRealtime(Array.from({ length: 50 }, (_, i) => i % 2 ? "photos" : "invoices")),
};
const normalization: number[] = []; const planning: number[] = []; const flush: number[] = [];
for (let sample = -5; sample < 25; sample++) {
  const events = []; const start = performance.now();
  for (let i = 0; i < 50; i++) {
    const event = normalizeRealtimeEvent({ table: "photos", eventType: "INSERT", new: { id: `photo-${i}`, work_order_id: `WOT-${i % 10}` } });
    assert.ok(event); events.push(event);
  }
  const normalized = performance.now();
  events.forEach(event => planRealtimeEvent(event, syntheticActor));
  const planned = performance.now(); const fixture = measuredBatcher(Array.from({ length: 10 }, (_, i) => workOrderDetailsKey(`WOT-${i}`, syntheticScope)));
  const beforeFlush = performance.now(); events.forEach(event => fixture.batcher.add(event)); await fixture.batcher.flush();
  if (sample >= 0) { normalization.push(normalized - start); planning.push(planned - normalized); flush.push(performance.now() - beforeFlush); }
  assert.equal(fixture.batcher.stats().invalidations, 1); assert.ok([...fixture.calls.values()].every(count => count <= 1)); fixture.close();
}
async function currentCase(kind: "photo" | "activity" | "mixed" | "ten-work-orders", hidden = false) {
  const fixture = kind === "ten-work-orders" ? measuredBatcher(Array.from({ length: 10 }, (_, i) => workOrderDetailsKey(`WOT-${i}`, syntheticScope))) : measuredBatcher();
  try {
    fixture.setVisible(!hidden);
    for (let i = 0; i < 50; i++) fixture.batcher.add(kind === "mixed" ? routingEvent(i % 2 ? "photos" : "invoices", i % 2 ? "photo-a" : "invoice-a")
      : routingEvent(kind === "activity" ? "activities" : "photos", `row-${i}`, kind === "ten-work-orders" ? `WOT-${i % 10}` : "WOT-A"));
    await fixture.batcher.flush(); const immediate = fixture.total();
    if (hidden) { fixture.setVisible(true); await Promise.all([fixture.batcher.refresh(), fixture.batcher.refresh()]); }
    assert.ok([...fixture.calls.values()].every(count => count <= 1)); if (hidden) assert.equal(immediate, 0);
    return { events: 50, immediateRefetches: immediate, foregroundRefetches: fixture.total() - immediate, ...fixture.batcher.stats() };
  } finally { fixture.close(); }
}
const bounded = measuredBatcher(); bounded.setVisible(false);
const heapBeforeStress = process.memoryUsage().heapUsed;
let peakSampledHeap = heapBeforeStress;
for (let i = 0; i < 10000; i++) {
  bounded.batcher.add(routingEvent("photos", `photo-${i}`, `WOT-${i}`));
  if ((i + 1) % 100 === 0) peakSampledHeap = Math.max(peakSampledHeap, process.memoryUsage().heapUsed);
}
const heapAfterStress = process.memoryUsage().heapUsed;
peakSampledHeap = Math.max(peakSampledHeap, heapAfterStress);
const memoryObservation = {
  evidence: "LOCAL_MEASURED",
  metric: "process.memoryUsage().heapUsed",
  events: 10000,
  sampleEveryEvents: 100,
  beforeBytes: heapBeforeStress,
  afterStressBytes: heapAfterStress,
  peakSampledBytes: peakSampledHeap,
  observedAllocationDeltaBytes: heapAfterStress - heapBeforeStress,
  observedPeakSampledDeltaBytes: peakSampledHeap - heapBeforeStress,
  interpretation: "Observed process-wide allocation delta only; garbage collection was not forced and may occur between samples. Not retained-memory, leak, or browser-memory proof; structural buffer limits are asserted separately.",
};
const bounds = bounded.batcher.stats(); bounded.close();
assert.ok(bounds.pendingEvents <= 128 && bounds.pendingTargets <= 256);
assert.equal(bounds.invalidations, 0);
assert.ok(Number.isSafeInteger(heapBeforeStress) && Number.isSafeInteger(heapAfterStress) && peakSampledHeap >= heapBeforeStress);
process.stdout.write(`${JSON.stringify({ evidence: "LOCAL_MEASURED", method: "Installed TanStack Query with real synthetic QueryObservers; 5 warmups, 25 samples; no browser/provider/network",
  legacySourceSha256: LEGACY_REALTIME_SOURCE_SHA256, legacyFlushSha256: LEGACY_REALTIME_FLUSH_SHA256, legacy,
  current: { photos: await currentCase("photo"), activities: await currentCase("activity"), mixed: await currentCase("mixed"), tenWorkOrders: await currentCase("ten-work-orders"), hidden: await currentCase("mixed", true) },
  timingsMs: { normalize50: distribution(normalization), plan50: distribution(planning), enqueueAndFlush50: distribution(flush) },
  bounds, memoryObservation, limitations: ["Not browser network/render timing", "Legacy 18 observers; new 19 observers with separate counts", "No hosted p95 certification", "Heap samples are process-wide observations without forced garbage collection, not retained-memory or leak proof"] })}\n`);
}
void main().catch(() => { process.stderr.write("Local Realtime performance verification failed.\n"); process.exitCode = 1; });
