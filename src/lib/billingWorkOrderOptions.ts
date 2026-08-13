export type BillingWorkOrderOption = {
  id: string;
  incidentId?: string | null;
  store?: string | null;
  city?: string | null;
  addr?: string | null;
  summary?: string | null;
};

const searchableWorkOrderText = (workOrder: BillingWorkOrderOption) => [
  workOrder.id,
  workOrder.incidentId,
  workOrder.store,
  workOrder.city,
  workOrder.addr,
  workOrder.summary,
]
  .filter(Boolean)
  .join(" ")
  .toLowerCase();

/**
 * Limits the selector without ever dropping its current value. Browsers show
 * a controlled select as blank when its value has no matching option, which
 * was why older work orders appeared to need a second click.
 */
export function billingWorkOrderOptions<T extends BillingWorkOrderOption>(
  workOrders: T[],
  search: string,
  selectedWorkOrderId?: string | null,
  limit = 80,
) {
  const safeLimit = Math.max(1, Math.floor(limit));
  const query = search.trim().toLowerCase();
  if (query) {
    return workOrders
      .filter(workOrder => searchableWorkOrderText(workOrder).includes(query))
      .slice(0, safeLimit);
  }

  const options = workOrders.slice(0, safeLimit);
  const selected = selectedWorkOrderId
    ? workOrders.find(workOrder => workOrder.id === selectedWorkOrderId)
    : null;
  if (!selected || options.some(workOrder => workOrder.id === selected.id)) {
    return options;
  }

  return [selected, ...options.slice(0, safeLimit - 1)];
}
