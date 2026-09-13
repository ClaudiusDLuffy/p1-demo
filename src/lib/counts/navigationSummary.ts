import { AppError } from "../errors/AppError";

export const NAVIGATION_METRICS = {
  staff: ["openCount", "p1UnassignedCount", "capitalCount", "pendingApprovalCount",
    "historyCount", "slaBreachedCount", "staffUnreadCount", "myTodoCount",
    "readyToBillCount", "staffWorkCount"],
  contractor: ["contractorActiveCount", "historyCount", "contractorAttentionCount", "contractorInvoiceCount"],
} as const;

export type NavigationMetric = typeof NAVIGATION_METRICS[keyof typeof NAVIGATION_METRICS][number];
export type NavigationMetrics = Partial<Record<NavigationMetric, number>>;
export type NavigationSummary = { scope: keyof typeof NAVIGATION_METRICS; metrics: NavigationMetrics };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Missing non-rendered metrics are intentionally absent, never fabricated zero. */
export function parseNavigationSummaryV2(value: unknown): NavigationSummary {
  if (!isRecord(value) || Object.keys(value).length !== 2
    || (value.scope !== "staff" && value.scope !== "contractor") || !isRecord(value.metrics)) {
    throw new AppError("INTERNAL_ERROR");
  }
  const expected = NAVIGATION_METRICS[value.scope];
  const actualKeys = Object.keys(value.metrics);
  if (actualKeys.some(key => !expected.some(allowed => allowed === key))) throw new AppError("INTERNAL_ERROR");
  const metrics: NavigationMetrics = {};
  for (const key of expected) {
    // Report-only members do not render an invoice badge and the server does
    // not execute its full count. Omission is not a claimed zero.
    if (value.scope === "contractor" && key === "contractorInvoiceCount"
      && !Object.hasOwn(value.metrics, key)) continue;
    const metric = value.metrics[key];
    if (typeof metric !== "number" || !Number.isSafeInteger(metric) || metric < 0) {
      throw new AppError("INTERNAL_ERROR");
    }
    metrics[key] = metric;
  }
  return { scope: value.scope, metrics };
}
