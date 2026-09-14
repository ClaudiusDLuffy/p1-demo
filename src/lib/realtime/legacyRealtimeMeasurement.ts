// Test/performance only: executes the exact frozen pre-6B flush with the real
// installed TanStack Query and synthetic QueryObservers, never a provider.
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import type { QueryKey } from "@tanstack/react-query";
import { datasetsForRealtimeTables, type PortalRealtimeTable } from "../realtimeInvalidation";
import { LEGACY_REALTIME_FLUSH, LEGACY_REALTIME_FLUSH_SHA256 } from "./legacyRealtimeFixture";
import { observerFixture } from "./realtimeTestSupport";
const rootKeys = {
  PORTAL_NAVIGATION_SUMMARY_KEY: ["portal-navigation-summary"], CONTRACTOR_WORKLOAD_SUMMARY_KEY: ["contractor-workload-summary"],
  WORK_ORDERS_KEY: ["work-orders"], WORK_ORDER_PAGES_KEY: ["work-order-pages"], WORK_ORDER_BY_ID_KEY: ["work-order-by-id"],
  WORK_ORDER_DETAILS_KEY: ["work-order-details"], INVOICES_KEY: ["invoices"], INVOICE_PAGES_KEY: ["invoice-pages"], INVOICE_BY_ID_KEY: ["invoice-by-id"],
  BILLING_INVOICES_KEY: ["billing-invoices"], BILLING_INVOICE_PAGES_KEY: ["billing-invoice-pages"], BILLING_INVOICE_BY_ID_KEY: ["billing-invoice-by-id"],
  CONTRACTOR_ESTIMATES_KEY: ["contractor-estimates"], WO_PARTS_KEY: ["wo-parts"], STAFF_WORK_TODOS_KEY: ["staff-work-todos"], STAFF_NOTIFICATION_READS_KEY: ["staff-notification-reads"],
} satisfies Record<string, QueryKey>;
const keys: QueryKey[] = Object.entries(rootKeys).flatMap(([name, key]) => name === "WORK_ORDER_BY_ID_KEY" || name === "WORK_ORDER_DETAILS_KEY"
  ? [[...key, "WOT-A"], [...key, "WOT-B"]] : [key]);
export async function measureLegacyRealtime(tables: readonly PortalRealtimeTable[], foreground = false) {
  if (createHash("sha256").update(LEGACY_REALTIME_FLUSH).digest("hex") !== LEGACY_REALTIME_FLUSH_SHA256) throw new Error("Legacy flush checksum mismatch");
  const fixture = observerFixture(keys); const pending: Promise<void>[] = []; let invalidations = 0;
  try {
    // The former callback deduplicated tables and parent IDs in these Sets,
    // and never consulted document visibility before executing this flush.
    const context = { ...rootKeys, pendingTables: new Set(tables), pendingWorkOrderIds: new Set(["WOT-A"]),
      needsBroadDetailRefresh: false, flushTimer: null, datasetsForRealtimeTables,
      workOrderDetailsKey: (id: string) => ["work-order-details", id],
      qc: { invalidateQueries: (filters: Parameters<typeof fixture.client.invalidateQueries>[0]) => {
        invalidations += 1; const result = fixture.client.invalidateQueries(filters); pending.push(result); return result;
      } } };
    runInNewContext(`${LEGACY_REALTIME_FLUSH}\nflush();`, context);
    await Promise.all(pending);
    const eventRefetches = fixture.total();
    if (foreground) await fixture.client.invalidateQueries({ refetchType: "active" });
    return { events: tables.length, activeObservers: keys.length, invalidations, eventRefetches, foregroundRefetches: fixture.total() - eventRefetches };
  } finally { fixture.close(); }
}
