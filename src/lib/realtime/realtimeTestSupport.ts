import { QueryClient, QueryObserver, type QueryKey } from "@tanstack/react-query";
import type { DirectoryActor } from "../../features/directory/contracts";
import { directoryActorScope, invoiceByIdKey, invoiceCountKey, invoicePagesKey, portalNavigationSummaryKey,
  workOrderByIdKey, workOrderCountKey, workOrderDetailsKey, workOrderPagesKey } from "../counts/queryKeys";
import { billingInvoiceCountKey, billingInvoicePageKey, billingInvoiceByIdKey } from "../../features/billing/billingQueryKeys";
import { normalizeRealtimeEvent } from "./realtimeEvent";
import { createRealtimeBatcher, type RealtimeTimer } from "./realtimeBatcher";
export const syntheticActor: DirectoryActor = { id: "synthetic-actor-a", role: "manager", active: true, staffPermissions: [] };
export const syntheticScope = directoryActorScope(syntheticActor);
export function routingEvent(table: string, id = "row-a", workOrderId = "WOT-A", extra: Record<string, unknown> = {}) {
  const event = normalizeRealtimeEvent({ table, eventType: "UPDATE", new: { id, work_order_id: workOrderId, ...extra }, old: {} });
  if (!event) throw new Error("Invalid synthetic event");
  return event;
}
export function testTimer() {
  let callback: (() => void) | null = null; let sets = 0; let clears = 0;
  const timer: RealtimeTimer = { set(fn, delay) { if (delay !== 250) throw new Error("Unexpected timer window"); callback = fn; sets += 1; return sets; },
    clear() { callback = null; clears += 1; } };
  return { timer, run() { const fn = callback; callback = null; fn?.(); }, stats: () => ({ sets, clears, pending: callback !== null }) };
}
export function observerFixture(keys: readonly QueryKey[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } } });
  const calls = new Map<string, number>(); const cleanup: (() => void)[] = [];
  for (const key of keys) {
    const hash = JSON.stringify(key); client.setQueryData(key, { synthetic: true }); calls.set(hash, 0);
    const observer = new QueryObserver(client, { queryKey: key, queryFn: async () => { calls.set(hash, (calls.get(hash) ?? 0) + 1); return { synthetic: true }; }, staleTime: Infinity });
    cleanup.push(observer.subscribe(() => undefined));
  }
  return { client, calls, total: () => [...calls.values()].reduce((sum, n) => sum + n, 0),
    close() { cleanup.forEach(fn => fn()); client.clear(); } };
}
export const currentMeasurementKeys: readonly QueryKey[] = [
  portalNavigationSummaryKey(syntheticScope), workOrderPagesKey(syntheticScope, { scope: "active" }), workOrderCountKey(syntheticScope, { scope: "active" }),
  workOrderPagesKey(syntheticScope, { scope: "staff_work" }), workOrderCountKey(syntheticScope, { scope: "staff_work" }),
  workOrderByIdKey("WOT-A", syntheticScope), workOrderByIdKey("WOT-B", syntheticScope),
  workOrderDetailsKey("WOT-A", syntheticScope), workOrderDetailsKey("WOT-B", syntheticScope),
  invoicePagesKey(syntheticScope), invoiceCountKey(syntheticScope), invoiceByIdKey("invoice-a", syntheticScope), invoiceByIdKey("invoice-b", syntheticScope),
  billingInvoicePageKey(syntheticScope), billingInvoiceCountKey(syntheticScope), billingInvoiceByIdKey("invoice-a", syntheticScope),
  ["receiving-dispatch", syntheticActor.id, syntheticActor.role, "unresolved"],
  ["financial-notifications", syntheticActor.id, syntheticActor.role, "unresolved"],
  ["parts-sms", syntheticActor.id, syntheticActor.role, "queue"],
];
export function measuredBatcher(keys: readonly QueryKey[] = currentMeasurementKeys) {
  const fixture = observerFixture(keys); const clock = testTimer(); let visible = true; let online = true;
  const batcher = createRealtimeBatcher({ client: fixture.client, actor: syntheticActor, visible: () => visible, online: () => online, timer: clock.timer });
  return { ...fixture, batcher, clock, setVisible(value: boolean) { visible = value; batcher.visibilityChanged(); }, setOnline(value: boolean) { online = value; batcher.visibilityChanged(); },
    close() { batcher.stop(); fixture.close(); } };
}
