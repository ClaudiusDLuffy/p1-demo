import type { QueryClient } from "@tanstack/react-query";
import type { DirectoryActor } from "../../features/directory/contracts";
import { realtimeEventIdentity, type NormalizedRealtimeEvent } from "./realtimeEvent";
import { collapseRealtimeTargets, foregroundRealtimePlan, invalidationTargetIdentity, matchesRealtimePlan, planRealtimeEvent,
  MAX_INVALIDATION_TARGETS, type InvalidationTarget, type RealtimeInvalidationPlan } from "./realtimeInvalidationPlan";

// Retains the previous fixed first-event window; repeated events cannot push
// the deadline out indefinitely. Caps count identities, never raw row payloads.
export const REALTIME_BATCH_MS = 250;
export const MAX_PENDING_REALTIME_EVENTS = 128;
export type RealtimeTimer = { set(callback: () => void, delay: number): unknown; clear(handle: unknown): void };
export type RealtimeBatchDependencies = {
  client: QueryClient; actor: DirectoryActor; visible(): boolean; online(): boolean;
  timer: RealtimeTimer; refreshIdentity?(): Promise<boolean>;
  onError?(category: "flush" | "timer"): void;
};
export function createRealtimeBatcher(deps: RealtimeBatchDependencies) {
  const eventIds = new Set<string>();
  const targets = new Map<string, InvalidationTarget>();
  let identityPending = false;
  let collapsed = false;
  let timer: unknown;
  let timerPending = false;
  let closed = false;
  let flushing: Promise<void> | null = null;
  let refreshPending = false;
  let forcePending = false;
  let accepted = 0; let batches = 0; let invalidations = 0; let overflowCount = 0;
  const safeError = (category: "flush" | "timer") => { try { deps.onError?.(category); } catch { /* logging cannot break cleanup */ } };
  const cancelTimer = () => {
    if (!timerPending) return;
    timerPending = false;
    try { deps.timer.clear(timer); } catch { safeError("timer"); }
  };
  const pending = () => targets.size > 0 || identityPending || refreshPending;
  const schedule = () => {
    // A held query refresh owns the flush. Its finally block schedules any
    // later events once; no timer should wake repeatedly while it is waiting.
    if (closed || flushing || timerPending || !pending() || !deps.visible() || !deps.online()) return;
    try { timerPending = true; timer = deps.timer.set(() => { timerPending = false; void flush(); }, REALTIME_BATCH_MS); }
    catch { timerPending = false; safeError("timer"); }
  };
  const flush = (): Promise<void> => {
    if (closed || !deps.visible() || !deps.online()) { cancelTimer(); return Promise.resolve(); }
    if (flushing) return flushing;
    cancelTimer();
    if (!pending()) return Promise.resolve();
    const plan: RealtimeInvalidationPlan = { targets: [...targets.values()], refreshIdentity: identityPending };
    const refresh = refreshPending; const force = forcePending;
    eventIds.clear(); targets.clear(); identityPending = false; collapsed = false; refreshPending = false; forcePending = false;
    let failed = false;
    flushing = (async () => {
      try {
        if ((refresh || plan.refreshIdentity) && deps.refreshIdentity && !await deps.refreshIdentity()) return;
        if (closed) return;
        // Visibility may change while self authorization refresh is in flight.
        const visible = deps.visible() && deps.online();
        batches += 1;
        if (plan.targets.length || refresh) {
          invalidations += 1;
          await deps.client.invalidateQueries({ predicate: query => matchesRealtimePlan(query.queryKey, plan, deps.actor)
            || (refresh && query.isActive() && (force || query.isStale()) && matchesRealtimePlan(query.queryKey, foregroundRealtimePlan, deps.actor)),
          refetchType: visible ? "active" : "none" }, { cancelRefetch: false });
        }
        if (!visible) { refreshPending = true; }
      } catch { failed = true; safeError("flush"); refreshPending = true; }
    })().finally(() => { flushing = null; if (!closed && !failed) schedule(); });
    return flushing;
  };
  return {
    add(event: NormalizedRealtimeEvent) {
      if (closed) return;
      accepted += 1;
      const plan = planRealtimeEvent(event, deps.actor);
      identityPending ||= plan.refreshIdentity;
      // Event identities are a bounded dedup/sample set, not stored events.
      // Past its cap we still union known exact targets. Fifty distinct notes
      // for one parent must not collapse into every parent's detail query.
      if (eventIds.size < MAX_PENDING_REALTIME_EVENTS) eventIds.add(realtimeEventIdentity(event));
      for (const target of plan.targets) {
        if (collapsed) targets.set(target.family, { family: target.family });
        else {
          targets.set(invalidationTargetIdentity(target), target);
          if (targets.size > MAX_INVALIDATION_TARGETS) {
            const fallback = collapseRealtimeTargets([...targets.values()]); targets.clear();
            fallback.forEach(value => targets.set(value.family, value)); collapsed = true; overflowCount += 1;
          }
        }
      }
      schedule();
    },
    flush,
    refresh(force = false) {
      if (closed) return Promise.resolve();
      // Manual/focus/reconnect during an active flush joins that batch. Do not
      // schedule a second forced refresh of the same just-refetched keys.
      if (flushing) return flushing;
      refreshPending = true; forcePending ||= force;
      return flush();
    },
    requestRefresh(force = false) {
      if (closed || flushing) return;
      refreshPending = true; forcePending ||= force; schedule();
    },
    visibilityChanged() { if (!deps.visible() || !deps.online()) cancelTimer(); },
    stop() { closed = true; cancelTimer(); eventIds.clear(); targets.clear(); identityPending = false; refreshPending = false; forcePending = false; },
    stats() { return { accepted, batches, invalidations, pendingEvents: eventIds.size, pendingTargets: targets.size,
      retainedTargets: targets.size, overflowCount, timerPending, closed }; },
  };
}

/** Successful local mutations reuse routing, but never manufacture provider events. */
export async function invalidatePortalPlan(client: QueryClient, actor: DirectoryActor, plan: RealtimeInvalidationPlan, visible: boolean): Promise<void> {
  await client.invalidateQueries({ predicate: query => matchesRealtimePlan(query.queryKey, plan, actor), refetchType: visible ? "active" : "none" }, { cancelRefetch: false });
}
