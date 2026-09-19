import type { QueryClient } from "@tanstack/react-query";
import type { DirectoryActor } from "../../features/directory/contracts";
import type { PortalVisibility } from "./browserVisibility";
import { PORTAL_AUTO_REFRESH_MS } from "../portalRefresh";
import { createRealtimeBatcher, type RealtimeTimer } from "./realtimeBatcher";
import { createPortalRealtimeSubscription, type RealtimeSubscriptionPorts } from "./realtimeSubscription";
export type PortalSessionDependencies = {
  client: QueryClient; actor: DirectoryActor; visibility: PortalVisibility; timer: RealtimeTimer;
  subscription: RealtimeSubscriptionPorts; refreshIdentity(): Promise<boolean>; report(category: string): void;
  repeat(callback: () => void, delay: number): unknown; clearRepeat(handle: unknown): void;
};
/** Lifecycle owner, injectable for Strict Mode/account/visibility lab tests. */
export function createPortalRealtimeSession(deps: PortalSessionDependencies) {
  const reported = new Set<string>();
  const report = (category: string) => {
    if (reported.has(category)) return;
    reported.add(category); try { deps.report(category); } catch { /* diagnostics are not lifecycle authority */ }
  };
  const current = createRealtimeBatcher({ client: deps.client, actor: deps.actor, timer: deps.timer,
    visible: deps.visibility.visible, online: deps.visibility.online,
    refreshIdentity: deps.refreshIdentity, onError: report });
  let unsubscribe: () => void = () => undefined;
  let visibilityUnsubscribe: () => void = () => undefined;
  let interval: unknown; let intervalStarted = false;
  let closed = false;
  const cleanup = (operation: () => void) => { try { operation(); } catch { report("cleanup"); } };
  const stop = () => {
    if (closed) return;
    closed = true;
    // Each resource gets its own cleanup attempt even if another throws.
    cleanup(current.stop); cleanup(visibilityUnsubscribe);
    if (intervalStarted) cleanup(() => deps.clearRepeat(interval));
    cleanup(unsubscribe);
  };
  if (!deps.actor.id || deps.actor.active !== true) stop();
  else try {
    unsubscribe = createPortalRealtimeSubscription(deps.subscription, {
      event: event => current.add(event), reconnect: () => current.requestRefresh(true), error: category => {
        report(category);
        // WebSocket connectivity and ordinary HTTPS reads can fail
        // independently. Recover the visible screen through the bounded HTTP
        // read path immediately while the provider owns channel reconnection.
        if (category === "connection") current.requestRefresh(true);
      },
    });
    visibilityUnsubscribe = deps.visibility.subscribe(() => {
      current.visibilityChanged();
      // Focus, visibility and online share the same fixed first-trigger batch.
      // Count hooks may enable immediately; the later stale-only pass does not
      // duplicate an already-completed focus fetch of a fresh count.
      if (deps.visibility.visible() && deps.visibility.online()) current.requestRefresh();
    });
    interval = deps.repeat(() => {
      if (deps.visibility.visible() && deps.visibility.online()) current.requestRefresh();
    }, PORTAL_AUTO_REFRESH_MS);
    intervalStarted = true;
  } catch { report("setup"); stop(); }
  return { refresh: () => current.refresh(true), stats: current.stats, stop };
}
