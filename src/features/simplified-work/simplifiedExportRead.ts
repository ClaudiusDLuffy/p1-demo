import { AppError } from "../../lib/errors/AppError";
import { loadWorkOrdersPage } from "../work-orders/data/workOrderReadRepository";
import type { WorkOrderPageParams, WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";

export const EXPORT_ROW_LIMIT = 10_000;
export class SimplifiedExportLimitError extends Error {
  constructor() { super("This export exceeds 10,000 work orders. Narrow the filters and try again. No partial file was downloaded."); }
}

/** Explicit user-requested export; keep ordinary list reads paginated and role scoped. */
export async function collectSimplifiedExport(
  params: Omit<WorkOrderPageParams, "cursor" | "limit">,
  signal: AbortSignal,
  onProgress: (count: number) => void,
  loadPage: typeof loadWorkOrdersPage = loadWorkOrdersPage,
): Promise<WorkOrderReadModel[]> {
  const rows = new Map<string, WorkOrderReadModel>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal.throwIfAborted();
    const page = await loadPage({ ...params, cursor, limit: 100 }, signal);
    signal.throwIfAborted();
    for (const row of page.items) rows.set(row.id, row);
    if (rows.size > EXPORT_ROW_LIMIT) throw new SimplifiedExportLimitError();
    onProgress(rows.size);
    if (!page.hasMore) return [...rows.values()];
    if (!page.nextCursor || cursors.has(page.nextCursor) || page.items.length === 0) {
      throw new AppError("INTERNAL_ERROR");
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
    if (rows.size === EXPORT_ROW_LIMIT) throw new SimplifiedExportLimitError();
    if (cursors.size >= EXPORT_ROW_LIMIT / 100) throw new AppError("INTERNAL_ERROR");
  } while (cursor);
  throw new AppError("INTERNAL_ERROR");
}
