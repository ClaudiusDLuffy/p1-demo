import { directoryScopeKey, type DirectoryActor } from "../../features/directory/contracts";

/** Cache scope only. Database authorization never trusts this client value. */
export const directoryActorScope = (actor?: DirectoryActor | null): string => JSON.stringify(directoryScopeKey(actor));
export const workOrderPagesKey = (scope: string, params?: object) => params === undefined
  ? ["work-order-pages", scope] as const : ["work-order-pages", scope, params] as const;
export const workOrderCountKey = (scope: string, filters?: object) => filters === undefined
  ? ["work-order-count", scope] as const : ["work-order-count", scope, filters] as const;
export const workOrderByIdKey = (id: string, scope?: string) => scope === undefined
  ? ["work-order-by-id", id] as const : ["work-order-by-id", id, scope] as const;
export const workOrderDetailsKey = (id: string, scope?: string) => scope === undefined
  ? ["work-order-details", id] as const : ["work-order-details", id, scope] as const;
export const workOrderFamilyKey = (id: string, scope?: string) => scope === undefined
  ? ["work-order-by-id", "family", id] as const : ["work-order-by-id", "family", id, scope] as const;
export const workOrderChildCountKey = (scope: string, id?: string, section?: string) => id === undefined
  ? ["work-order-child-count", scope] as const : section === undefined
    ? ["work-order-child-count", scope, id] as const : ["work-order-child-count", scope, id, section] as const;
export const invoicePagesKey = (scope: string, params?: object) => params === undefined
  ? ["invoice-pages", scope] as const : ["invoice-pages", scope, params] as const;
export const invoiceCountKey = (scope: string, filters?: object) => filters === undefined
  ? ["invoice-count", scope] as const : ["invoice-count", scope, filters] as const;
export const invoiceByIdKey = (id: string, scope?: string) => scope === undefined
  ? ["invoice-by-id", id] as const : ["invoice-by-id", id, scope] as const;
export const portalNavigationSummaryKey = (scope: string) => ["portal-navigation-summary", scope, "v2"] as const;
export const workOrderPartsKey = (id: string, scope: string) => ["wo-parts", id, scope] as const;
export const p1PartCostsKey = (id: string, scope: string) => ["p1-part-costs", id, scope] as const;
export const billableP1PartsKey = (id: string, excludedInvoiceId: string | null, scope: string) => ["billable-p1-parts", id, excludedInvoiceId, scope] as const;
export const billingWorkOrderVisitsKey = (id: string | null | undefined, scope: string) => ["work-order-visits", "billing", id ?? null, scope] as const;
