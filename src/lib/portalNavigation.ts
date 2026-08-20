export type PortalViewState = {
  page: string;
  selectedWorkOrderId: string | null;
  selectedInvoiceId: string | null;
  selectedBillingInvoiceId: string | null;
  returnWorkOrderId: string | null;
  returnWorkOrderPage: string | null;
};

export const PORTAL_HISTORY_KEY = "p1PortalView";

type PortalHistoryWriter = {
  replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
  pushState: (data: unknown, unused: string, url?: string | URL | null) => void;
};

export const writePortalHistoryStateSafely = (
  history: PortalHistoryWriter,
  method: "replaceState" | "pushState",
  state: unknown,
  url?: string | URL | null,
) => {
  try {
    history[method].call(history, state, "", url);
    return true;
  } catch {
    // Mobile Safari rate-limits History API writes. Navigation and scrolling
    // must remain usable even when it declines a non-essential state update.
    return false;
  }
};

const clean = (value: unknown) => {
  const normalized = String(value ?? "").trim();
  return normalized || null;
};

export const portalViewKey = (view: PortalViewState) => JSON.stringify([
  view.page,
  view.selectedWorkOrderId,
  view.selectedInvoiceId,
  view.selectedBillingInvoiceId,
  view.returnWorkOrderId,
  view.returnWorkOrderPage,
]);

export const portalViewFromHistoryState = (
  state: unknown,
): PortalViewState | null => {
  if (!state || typeof state !== "object") return null;
  const candidate = (state as Record<string, unknown>)[PORTAL_HISTORY_KEY];
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Record<string, unknown>;
  const page = clean(value.page);
  if (!page) return null;
  return {
    page,
    selectedWorkOrderId: clean(value.selectedWorkOrderId),
    selectedInvoiceId: clean(value.selectedInvoiceId),
    selectedBillingInvoiceId: clean(value.selectedBillingInvoiceId),
    returnWorkOrderId: clean(value.returnWorkOrderId),
    returnWorkOrderPage: clean(value.returnWorkOrderPage),
  };
};

export const portalUrlForView = (
  currentUrl: string,
  view: PortalViewState,
) => {
  const url = new URL(currentUrl);
  const fields: Array<[string, string | null]> = [
    ["portal", view.page === "dashboard" ? null : view.page],
    ["wo", view.selectedWorkOrderId],
    ["invoice", view.selectedInvoiceId],
    ["billingInvoice", view.selectedBillingInvoiceId],
    ["returnWo", view.returnWorkOrderId],
    ["returnPage", view.returnWorkOrderPage],
  ];

  for (const [key, value] of fields) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }

  return `${url.pathname}${url.search}${url.hash}`;
};
