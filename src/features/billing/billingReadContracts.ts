import { AppError } from "../../lib/errors/AppError";
import { clampPageSize } from "../../lib/cursorPagination";

export type BillingInvoicePageParams = {
  queue: "active" | "all" | "draft" | "submitted" | "sent" | "work_order";
  search?: string;
  sort?: "invoice" | "date" | "work_order" | "store" | "territory" | "total" | "status" | "recent";
  direction?: "asc" | "desc";
  limit?: number;
  cursor?: string | null;
  workOrderId?: string | null;
};
export type BillingCountFilters = Pick<BillingInvoicePageParams, "queue" | "search" | "workOrderId">;
export type BillingReadInput = {
  queue: BillingInvoicePageParams["queue"];
  search: string | null;
  sort: NonNullable<BillingInvoicePageParams["sort"]>;
  direction: "asc" | "desc";
  limit: number;
  cursor: string | null;
  workOrderId: string | null;
  response: "legacy" | "rows" | "count";
};
const queues = ["active", "all", "draft", "submitted", "sent", "work_order"] as const;
const sorts = ["invoice", "date", "work_order", "store", "territory", "total", "status", "recent"] as const;
const isQueue = (value: string): value is BillingReadInput["queue"] => queues.some(item => item === value);
const isSort = (value: string): value is BillingReadInput["sort"] => sorts.some(item => item === value);

/** The opt-in contract is strict; old first-page defaults remain compatible.
 * Every continuation is rows-only, including an old client's continuation. */
export function parseBillingReadInput(search: URLSearchParams): BillingReadInput {
  const mode = search.get("response");
  if (mode !== null && mode !== "rows" && mode !== "count") throw new AppError("INVALID_REQUEST");
  const modern = mode !== null;
  for (const key of ["response", "queue", "search", "sort", "direction", "limit", "cursor", "workOrderId"]) {
    if (search.getAll(key).length > 1) throw new AppError(key === "cursor" ? "INVALID_CURSOR" : "INVALID_REQUEST");
  }
  const queue = (search.get("queue") || "active").toLowerCase();
  const sort = (search.get("sort") || "invoice").toLowerCase();
  const direction = search.get("direction") || "desc";
  const rawLimit = search.get("limit") ?? "25";
  if (modern && (!isQueue(queue) || !isSort(sort) || !["asc", "desc"].includes(direction)
    || !/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100)) throw new AppError("INVALID_REQUEST");
  const query = search.get("search")?.trim() || null;
  const workOrderId = search.get("workOrderId")?.trim() || null;
  if (modern && [query, workOrderId].some(value => value !== null
    && (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)))) throw new AppError("INVALID_REQUEST");
  const cursor = search.get("cursor")?.trim() || null;
  // Existing RPC cursors are opaque encoded JSON, not private row contents.
  if (cursor !== null && (cursor.length > 8192 || /[\u0000-\u0020\u007f]/.test(cursor))) throw new AppError("INVALID_CURSOR");
  if (mode === "count" && cursor !== null) throw new AppError("INVALID_REQUEST");
  return {
    queue: isQueue(queue) ? queue : "active", search: query,
    sort: isSort(sort) ? sort : "invoice", direction: direction === "asc" ? "asc" : "desc",
    limit: clampPageSize(Number(rawLimit)), cursor, workOrderId,
    response: mode === "count" ? "count" : mode === "rows" || cursor !== null ? "rows" : "legacy",
  };
}

export function billingCountFilters(params: BillingCountFilters): BillingCountFilters {
  return { queue: params.queue, search: params.search?.trim() || "", workOrderId: params.workOrderId || null };
}
export function billingReadUrl(params: BillingInvoicePageParams, response: "rows" | "count"): string {
  const search = new URLSearchParams({ response, queue: params.queue });
  if (response === "rows") search.set("contract", "compact-v1");
  if (params.search?.trim()) search.set("search", params.search.trim());
  if (params.workOrderId) search.set("workOrderId", params.workOrderId);
  if (response === "rows") {
    search.set("sort", params.sort || "invoice");
    search.set("direction", params.direction || "desc");
    search.set("limit", String(params.limit ?? 25));
    if (params.cursor) search.set("cursor", params.cursor);
  }
  return `/api/billing-invoices?${search.toString()}`;
}

export type BillingRowsPage = {
  items: (Record<string, unknown> & { id: string })[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number | null;
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("INTERNAL_ERROR");
  return value as Record<string, unknown>;
};
export function parseBillingCount(value: unknown): { totalCount: number } {
  const count = record(value).totalCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new AppError("INTERNAL_ERROR");
  return { totalCount: count };
}
export function parseBillingRows(value: unknown): BillingRowsPage {
  const page = record(value);
  const items = page.items ?? page.invoices;
  if (!Array.isArray(items) || items.length > 100 || typeof page.hasMore !== "boolean"
    || (page.hasMore ? !items.length || typeof page.nextCursor !== "string" || !page.nextCursor.length
      || page.nextCursor.length > 8192 : page.nextCursor !== null)) throw new AppError("INTERNAL_ERROR");
  const rows = items.map(value => {
    const item = record(value);
    if (typeof item.id !== "string" || !item.id.length || item.id.length > 200) throw new AppError("INTERNAL_ERROR");
    return { ...item, id: item.id };
  });
  if (new Set(rows.map(item => item.id)).size !== rows.length) throw new AppError("INTERNAL_ERROR");
  return { items: rows, nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null,
    hasMore: page.hasMore, totalCount: page.totalCount == null ? null : parseBillingCount(page).totalCount };
}
