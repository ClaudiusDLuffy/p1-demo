import { boundedReadRpc } from "../../../lib/counts/readRpc";
import { clampPageSize, type CursorPage } from "../../../lib/cursorPagination";
import { timezoneForWorkOrder } from "../../../lib/billingRules";
import type { ActivityReadDependencies, ActivityReadModel, ActivityReadWorkOrder } from "./activityReadContracts";
import { mapActivityPageRow } from "./activityMappers";
import { parseActivityReadPage } from "./activityReadValidators";

/** One existing count-independent page RPC. Channel/assignment visibility remains authoritative in RLS. */
export function createActivityReadRepository(dependencies: ActivityReadDependencies = { read: boundedReadRpc }) {
  return {
    async loadWorkOrderActivitiesPage(workOrder: ActivityReadWorkOrder, cursor: string | null = null, limit = 30,
      signal?: AbortSignal): Promise<CursorPage<ActivityReadModel>> {
      if (!workOrder?.id) throw new Error("A work order ID is required");
      const data = await dependencies.read("list_work_order_activities_rows_v1", {
        p_work_order_id: workOrder.id, p_limit: clampPageSize(limit), p_cursor: cursor,
      }, signal);
      const page = parseActivityReadPage(data, workOrder.id);
      const timeZone = timezoneForWorkOrder(workOrder);
      return { ...page, items: page.items.map(row => mapActivityPageRow(row, timeZone)) };
    },
  };
}

const production = createActivityReadRepository();

export function loadWorkOrderActivitiesPage(workOrder: ActivityReadWorkOrder, cursor: string | null = null, limit = 30,
  signal?: AbortSignal): Promise<CursorPage<ActivityReadModel>> {
  return production.loadWorkOrderActivitiesPage(workOrder, cursor, limit, signal);
}

