export type StoreHistoryWorkOrder = {
  id: string;
  store?: string | null;
  status?: string | null;
  isCapital?: boolean | null;
  priority?: string | null;
  category?: string | null;
  subCategory?: string | null;
  summary?: string | null;
  description?: string | null;
  contractor?: string | null;
  assetModel?: string | null;
  assetSerial?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

/**
 * Recognizes an exact numeric 7-Eleven store lookup entered into the shared
 * work-order search. Free-text and six-plus-digit legacy references remain
 * ordinary searches instead of silently changing list scope.
 */
export function normalizeExactStoreNumberSearch(
  value: string | null | undefined,
): string | null {
  const match = String(value || "").trim().match(/^(?:store\s*#?\s*)?(\d{1,5})$/i);
  return match?.[1] || null;
}

const workOrderTime = (workOrder: StoreHistoryWorkOrder): number => {
  const value = workOrder.createdAt || workOrder.updatedAt || "";
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

/**
 * Builds the compact dispatch history shown on a work-order detail page.
 * The current call is deliberately pinned first; prior calls remain newest
 * first and are restricted to the exact store number.
 */
export function buildStoreWorkOrderHistory(
  currentWorkOrder: StoreHistoryWorkOrder | null | undefined,
  candidates: StoreHistoryWorkOrder[],
  limit = 5,
): StoreHistoryWorkOrder[] {
  if (!currentWorkOrder?.id || !currentWorkOrder.store || limit <= 0) return [];

  const storeNumber = String(currentWorkOrder.store);
  const seen = new Set([currentWorkOrder.id]);
  const previous = candidates
    .filter(candidate => {
      if (!candidate?.id || seen.has(candidate.id)) return false;
      if (String(candidate.store || "") !== storeNumber) return false;
      seen.add(candidate.id);
      return true;
    })
    .sort((left, right) => workOrderTime(right) - workOrderTime(left));

  return [currentWorkOrder, ...previous].slice(0, limit);
}

export function storeWorkOrderHistoryTotal(
  visibleRows: StoreHistoryWorkOrder[],
  authorizedQueryTotal: number | null | undefined,
): number | null {
  // A compact preview is not proof of a full authorized total. Keep the
  // pinned-row safeguard only when a real separate count has been received.
  if (typeof authorizedQueryTotal !== "number" || !Number.isSafeInteger(authorizedQueryTotal)
    || authorizedQueryTotal < 0) return null;
  const queryTotal = authorizedQueryTotal;
  return Math.max(
    visibleRows.length,
    Number.isFinite(queryTotal) && queryTotal >= 0 ? queryTotal : 0,
  );
}
