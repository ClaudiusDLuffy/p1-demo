import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { PORTAL_REALTIME_TABLES } from "../realtimeInvalidation";
import { normalizeRealtimeEvent, type NormalizedRealtimeEvent } from "./realtimeEvent";

export type RealtimeSubscriptionPorts = Pick<SupabaseClient, "channel" | "removeChannel">;
export type RealtimeSubscriptionCallbacks = {
  event(event: NormalizedRealtimeEvent): void;
  reconnect?(): void;
  error?(category: "connection" | "cleanup" | "invalid_event" | "callback"): void;
};
/** One channel. Supabase's existing bounded transport backoff owns reconnects. */
export function createPortalRealtimeSubscription(ports: RealtimeSubscriptionPorts, callbacks: RealtimeSubscriptionCallbacks): () => void {
  let closed = false; let connected = false; let disconnected = false;
  const reported = new Set<string>();
  const report = (category: Parameters<NonNullable<RealtimeSubscriptionCallbacks["error"]>>[0]) => {
    if (reported.has(category)) return;
    reported.add(category);
    try { callbacks.error?.(category); } catch { /* no payload/log failure can escape a provider callback */ }
  };
  let channel: RealtimeChannel | null = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (!channel) return;
    try { void ports.removeChannel(channel).catch(() => { report("cleanup"); }); }
    catch { report("cleanup"); }
  };
  try {
    channel = ports.channel("portal-changes");
    for (const table of PORTAL_REALTIME_TABLES) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, (raw: unknown) => {
        if (closed) return;
        const event = normalizeRealtimeEvent(raw, table);
        if (!event) { report("invalid_event"); return; }
        try { callbacks.event(event); } catch { report("callback"); }
      });
    }
    channel.subscribe(status => {
      if (closed) return;
      if (status === "SUBSCRIBED") {
        if (connected && disconnected) { try { callbacks.reconnect?.(); } catch { report("callback"); } }
        connected = true; disconnected = false;
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        disconnected = true; report("connection");
      }
    });
  } catch { report("connection"); cleanup(); }
  return cleanup;
}
