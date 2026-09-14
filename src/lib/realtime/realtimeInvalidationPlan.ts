import type { QueryKey } from "@tanstack/react-query";
import { directoryScopeKey, type DirectoryActor } from "../../features/directory/contracts";
import { billingInvoiceByIdKey, billingInvoiceCountKey, billingInvoicePageKey } from "../../features/billing/billingQueryKeys";
import { directoryActorScope, invoiceByIdKey, invoiceCountKey, invoicePagesKey,
  portalNavigationSummaryKey, workOrderByIdKey, workOrderCountKey, workOrderDetailsKey,
  workOrderPagesKey, workOrderPartsKey, p1PartCostsKey, billableP1PartsKey, billingWorkOrderVisitsKey } from "../counts/queryKeys";
import type { NormalizedRealtimeEvent, RealtimeDomain } from "./realtimeEvent";

export type RealtimeFamily = "work_pages" | "work_counts" | "work_detail" | "work_children" | "child_counts" | "navigation"
  | "invoice_pages" | "invoice_counts" | "invoice_detail" | "billing_pages" | "billing_counts" | "billing_detail"
  | "parts" | "billing_parts" | "visits" | "estimates" | "staff_todos" | "staff_reads"
  | "holds" | "export_queue" | "receiving" | "financial" | "sms" | "directory" | "directory_workload";
export type InvalidationTarget = {
  readonly family: RealtimeFamily;
  readonly id?: string;
  readonly companyId?: string;
  readonly subset?: "staff" | "parts" | "current" | "notes";
};
export type RealtimeInvalidationPlan = { readonly targets: readonly InvalidationTarget[]; readonly refreshIdentity: boolean };
export const MAX_INVALIDATION_TARGETS = 256;

export function invalidationTargetIdentity(target: InvalidationTarget): string {
  return [target.family, target.id ?? "", target.companyId ?? "", target.subset ?? ""].join(":");
}
export function planRealtimeEvent(event: NormalizedRealtimeEvent, actor: DirectoryActor): RealtimeInvalidationPlan {
  const targets: InvalidationTarget[] = [];
  const add = (family: RealtimeFamily, id?: string, subset?: InvalidationTarget["subset"], companyId?: string) => {
    targets.push({ family, ...(id ? { id } : {}), ...(subset ? { subset } : {}), ...(companyId ? { companyId } : {}) });
  };
  const workIds = [...new Set([event.workOrderId, event.previousWorkOrderId].filter((id): id is string => id !== null))];
  const work = (family: RealtimeFamily) => workIds.length ? workIds.forEach(id => add(family, id)) : add(family);
  let refreshIdentity = false;
  switch (event.domain) {
    case "work_orders":
    case "assignments":
      add("work_pages"); add("work_counts"); add("navigation"); work("work_detail"); work("work_children");
      for (const id of new Set([event.companyId, event.previousCompanyId])) add("directory_workload", id ?? undefined);
      break;
    case "activities":
      work("child_counts");
      work("work_children"); work("work_detail");
      // Activities affect personal unread/7-Eleven queues, not ordinary list
      // membership. The authoritative work_orders event owns lifecycle moves.
      add("work_pages", undefined, "staff"); add("work_counts", undefined, "staff"); add("navigation");
      // The general operational table renders NewNotesDot, but its full total
      // does not depend on that display-only indicator.
      add("work_pages", undefined, "notes");
      if (event.requiresContractorAttention !== false && event.activityChannel !== "internal_note") {
        // Contractor attention is a displayed queue indicator. Missing flags
        // (e.g. DELETE primary-key-only) use this bounded list-domain fallback.
        add("work_pages", undefined, "current");
      }
      if (event.eventKey?.startsWith("invoice_") && event.invoiceId) add("financial", event.invoiceId, "current");
      break;
    case "visits": work("work_children"); work("work_detail"); work("visits"); work("child_counts"); break;
    case "photos": work("work_children"); work("child_counts"); break;
    case "parts":
      work("parts"); work("billing_parts"); work("work_children"); work("work_detail");
      add("work_pages", undefined, "parts"); add("work_counts", undefined, "parts"); add("navigation");
      break;
    case "invoices":
      if (event.invoiceType !== "staff") { add("invoice_pages"); add("invoice_counts"); add("invoice_detail", event.invoiceId ?? undefined); }
      if (event.invoiceType !== "contractor") { add("billing_pages"); add("billing_counts"); add("billing_detail", event.invoiceId ?? undefined); }
      // A PK-only invoice DELETE cannot identify its former work order. The
      // invoice-domain fallback must not turn into every cached WO detail;
      // any authoritative work-order state change emits its own row event.
      workIds.forEach(id => add("work_detail", id)); add("navigation"); add("export_queue");
      add("financial", event.invoiceId ?? undefined, "current");
      break;
    case "estimates": work("estimates"); break;
    case "staff_work":
    case "staff_reads":
      add(event.domain === "staff_work" ? "staff_todos" : "staff_reads");
      work("work_detail"); add("work_pages", undefined, "staff"); add("work_counts", undefined, "staff"); add("navigation");
      break;
    case "payment_holds":
      add("holds"); add("export_queue"); add("invoice_detail", event.invoiceId ?? undefined);
      add("financial", event.invoiceId ?? undefined, "current"); break;
    case "receiving_notifications": add("receiving", event.workOrderId ?? undefined); break;
    case "financial_notifications": add("financial", event.invoiceId ?? undefined); break;
    case "parts_sms": add("sms"); break;
    case "directories":
    case "permissions":
      add("directory", event.profileId ?? event.recordId ?? undefined, undefined, event.companyId ?? undefined);
      if (event.recordId && event.recordId !== event.profileId) add("directory", event.recordId, undefined, event.companyId ?? undefined);
      if (event.previousCompanyId && event.previousCompanyId !== event.companyId) add("directory", event.profileId ?? undefined, undefined, event.previousCompanyId);
      refreshIdentity = !event.profileId || event.profileId === actor.id;
      break;
  }
  return { targets, refreshIdentity };
}

export function collapseRealtimeTargets(targets: readonly InvalidationTarget[]): InvalidationTarget[] {
  // Overflow loses specificity only inside already-affected families.
  return [...new Set(targets.map(target => target.family))].map(family => ({ family }));
}
export function mergeRealtimePlans(plans: readonly RealtimeInvalidationPlan[]): RealtimeInvalidationPlan {
  const map = new Map<string, InvalidationTarget>();
  let overflow = false;
  let refreshIdentity = false;
  for (const plan of plans) {
    refreshIdentity ||= plan.refreshIdentity;
    for (const target of plan.targets) {
      if (overflow) map.set(target.family, { family: target.family });
      else {
        map.set(invalidationTargetIdentity(target), target);
        if (map.size > MAX_INVALIDATION_TARGETS) {
          const collapsed = collapseRealtimeTargets([...map.values()]); map.clear();
          collapsed.forEach(target => map.set(target.family, target)); overflow = true;
        }
      }
    }
  }
  return { targets: [...map.values()], refreshIdentity };
}

// These legacy feature roots have no separate pure factory yet. This adapter
// centralizes their exact shape; new page/count/detail keys use their factories.
const roots = {
  parts: "wo-parts", estimates: "contractor-estimates", staff_todos: "staff-work-todos", staff_reads: "staff-notification-reads",
  holds: "controller-invoice-payment-holds", export_queue: "controller-export-queue",
  receiving: "receiving-dispatch", financial: "financial-notifications", sms: "parts-sms", directory: "directory",
} as const;
function begins(key: QueryKey, prefix: QueryKey): boolean {
  return prefix.every((value, index) => JSON.stringify(key[index]) === JSON.stringify(value));
}
function paramsFor(key: QueryKey): Record<string, unknown> {
  const value = key[key.length - 1];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function subsetMatches(key: QueryKey, subset: InvalidationTarget["subset"], actor: DirectoryActor): boolean {
  if (!subset) return true;
  const scope = paramsFor(key).scope;
  if (subset === "staff") return typeof scope !== "string" || scope.startsWith("staff_work") || scope === "dashboard_seven_eleven_updates";
  if (subset === "parts") return typeof scope !== "string" || scope === "dashboard_p1_parts_to_order" || scope === "dashboard_awaiting_parts";
  if (subset === "notes") return actor.role !== "contractor" && (scope === "active" || scope === "all");
  return actor.role === "contractor" && scope === "active";
}
function exactScoped(key: QueryKey, root: string, id: string | undefined, scope: string): boolean {
  return key[0] === root && key[2] === scope && (!id || key[1] === id);
}
function noticeScope(key: QueryKey, root: string, actor: DirectoryActor): number | null {
  const prefix = [root, actor.id, actor.role, ...[...(actor.staffPermissions ?? [])].sort()];
  return begins(key, prefix) ? prefix.length : null;
}
export function matchesRealtimeTarget(key: QueryKey, target: InvalidationTarget, actor: DirectoryActor): boolean {
  if (!actor.id || actor.active !== true) return false;
  const scope = directoryActorScope(actor);
  switch (target.family) {
    case "work_pages": return (begins(key, workOrderPagesKey(scope)) && subsetMatches(key, target.subset, actor))
      || (key[0] === workOrderByIdKey("")[0] && key[1] === "family" && key[3] === scope && (!target.subset || target.subset === "notes"));
    case "work_counts": return begins(key, workOrderCountKey(scope)) && subsetMatches(key, target.subset, actor);
    case "work_detail": return exactScoped(key, workOrderByIdKey("")[0], target.id, scope)
      || (key[0] === workOrderByIdKey("")[0] && key[1] === "family" && key[3] === scope && (!target.id || key[2] === target.id));
    case "work_children": return exactScoped(key, workOrderDetailsKey("")[0], target.id, scope);
    case "child_counts": return key[0] === "work-order-child-count" && key[1] === scope && (!target.id || key[2] === target.id);
    case "navigation": return begins(key, portalNavigationSummaryKey(scope));
    case "invoice_pages": return begins(key, invoicePagesKey(scope));
    case "invoice_counts": return begins(key, invoiceCountKey(scope));
    case "invoice_detail": return exactScoped(key, invoiceByIdKey("")[0], target.id, scope);
    case "billing_pages": return begins(key, billingInvoicePageKey(scope));
    case "billing_counts": return begins(key, billingInvoiceCountKey(scope));
    case "billing_detail": return exactScoped(key, billingInvoiceByIdKey("", scope)[0], target.id, scope);
    case "parts": return key[0] === workOrderPartsKey("", scope)[0] && key.at(-1) === scope && (!target.id || key[1] === target.id);
    case "estimates": return key[0] === roots.estimates && key[2] === scope && (!target.id || key[1] === target.id);
    case "billing_parts": return [p1PartCostsKey("", scope)[0], billableP1PartsKey("", null, scope)[0]].some(root => key[0] === root) && key.at(-1) === scope && (!target.id || key[1] === target.id);
    case "visits": return begins(key, billingWorkOrderVisitsKey(target.id, scope).slice(0, 2)) && key[3] === scope && (!target.id || key[2] === target.id);
    case "staff_todos": case "staff_reads": return key[0] === roots[target.family] && key[1] === scope;
    case "holds": return key[0] === roots.holds && Array.isArray(key[1]) && key[1][0] === actor.id && key[1][1] === actor.role;
    case "export_queue": return (key[0] === roots.export_queue || key[0] === "controller-export-history") && key[1] === scope;
    case "receiving": case "financial": case "sms": {
      const start = noticeScope(key, roots[target.family], actor);
      if (start === null) return false;
      const kind = key[start];
      if (target.subset === "current") return kind === "status" && (!target.id || key[start + 1] === target.id);
      if ((kind === "current" || kind === "status") && target.id) return key[start + 1] === target.id;
      // Private attempts may omit the parent event identity; only this notice
      // family's current visible queue/history refresh, never other providers.
      return true;
    }
    case "directory": case "directory_workload": {
      if (!begins(key, [roots.directory, directoryScopeKey(actor)])) return false;
      const kind = key[2]; const domain = key[3];
      if (target.family === "directory_workload") {
        return domain === "contractor_directory" && (kind === "page" || (kind === "selection" && (!target.id || key[5] === target.id)));
      }
      if (kind === "labels") return !target.id || (Array.isArray(key[3]) && key[3].includes(target.id));
      if (kind === "selection") return (!target.id || key[5] === target.id) && (!target.companyId || !key[4] || key[4] === target.companyId);
      if (kind !== "page") return false;
      return !target.companyId || !["company_technicians", "technician_management", "legacy_team"].includes(String(domain)) || key[4] === target.companyId;
    }
  }
}
export const ALL_REALTIME_FAMILIES: readonly RealtimeFamily[] = ["work_pages", "work_counts", "work_detail", "work_children", "child_counts", "navigation",
  "invoice_pages", "invoice_counts", "invoice_detail", "billing_pages", "billing_counts", "billing_detail", "parts", "billing_parts", "visits", "estimates",
  "staff_todos", "staff_reads", "holds", "export_queue", "receiving", "financial", "sms", "directory", "directory_workload"];
/** Foreground/manual fallback is finite, actor scoped, and active-query-only. */
export const foregroundRealtimePlan: RealtimeInvalidationPlan = { targets: ALL_REALTIME_FAMILIES.map(family => ({ family })), refreshIdentity: false };
export function matchesRealtimePlan(key: QueryKey, plan: RealtimeInvalidationPlan, actor: DirectoryActor): boolean {
  return plan.targets.some(target => matchesRealtimeTarget(key, target, actor));
}

export const REALTIME_DOMAINS: readonly RealtimeDomain[] = ["work_orders", "activities", "visits", "parts", "photos", "invoices",
  "estimates", "assignments", "staff_work", "staff_reads", "payment_holds", "receiving_notifications", "financial_notifications", "parts_sms", "directories", "permissions"];
