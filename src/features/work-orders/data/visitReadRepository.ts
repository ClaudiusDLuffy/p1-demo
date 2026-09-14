import { boundedReadRpc } from "../../../lib/counts/readRpc";
import { clampPageSize, type CursorPage } from "../../../lib/cursorPagination";
import type { VisitReadModel } from "./visitReadContracts";
import { mapVisit } from "./visitMappers";
import { parseVisitReadPage } from "./visitReadValidators";

export type VisitReadDependencies = {
  read: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
};

/** Parent history includes an open row when visible; no separate current-visit API exists. */
export function createVisitReadRepository(dependencies: VisitReadDependencies = { read: boundedReadRpc }) {
  return {
    async loadWorkOrderVisitsPage(
      workOrderId: string, cursor: string | null = null, limit = 30, signal?: AbortSignal,
    ): Promise<CursorPage<VisitReadModel>> {
      if (!workOrderId) throw new Error("A work order ID is required");
      const data = await dependencies.read("list_work_order_visits_rows_v1", {
        p_work_order_id: workOrderId,
        p_limit: clampPageSize(limit),
        p_cursor: cursor,
      }, signal);
      const page = parseVisitReadPage(data, workOrderId);
      return { ...page, items: page.items.map(mapVisit) };
    },
  };
}

const production = createVisitReadRepository();

export function loadWorkOrderVisitsPage(
  workOrderId: string, cursor: string | null = null, limit = 30, signal?: AbortSignal,
): Promise<CursorPage<VisitReadModel>> {
  return production.loadWorkOrderVisitsPage(workOrderId, cursor, limit, signal);
}
