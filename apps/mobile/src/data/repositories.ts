import {
  clampPageSize, mapPublicError, mapWorkOrder, parseActivityPage, parsePhotoPage, parseVisitPage,
  parseWorkOrderPage, workOrderReadArgs, type ActivityItem, type CursorPage, type PhotoMetadata,
  type VisitItem, type WorkOrderSummary,
} from "@p1/mobile-contracts";
export type ReadRpc = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
export function createMobileRepositories(read: ReadRpc) {
  return {
    async workOrders(cursor: string | null, signal?: AbortSignal): Promise<CursorPage<WorkOrderSummary>> {
      return parseWorkOrderPage(await read("list_work_orders_rows_v1",
        workOrderReadArgs({ scope: "active", sort: "newest", limit: 25, cursor }), signal));
    },
    async workOrder(id: string, signal?: AbortSignal): Promise<WorkOrderSummary | null> {
      if (!id) return null;
      try {
        const data = await read("get_portal_work_order", { p_work_order_id: id }, signal);
        if (data == null) return null;
        const mapped = mapWorkOrder(data);
        if (mapped.id !== id) throw new Error("Parent mismatch");
        return mapped;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw mapPublicError(error);
      }
    },
    async activity(id: string, cursor: string | null, signal?: AbortSignal): Promise<CursorPage<ActivityItem>> {
      return parseActivityPage(await read("list_work_order_activities_rows_v1",
        { p_work_order_id: id, p_limit: clampPageSize(30), p_cursor: cursor }, signal), id);
    },
    async visits(id: string, cursor: string | null, signal?: AbortSignal): Promise<CursorPage<VisitItem>> {
      return parseVisitPage(await read("list_work_order_visits_rows_v1",
        { p_work_order_id: id, p_limit: clampPageSize(30), p_cursor: cursor }, signal), id);
    },
    async photos(id: string, cursor: string | null, signal?: AbortSignal): Promise<CursorPage<PhotoMetadata>> {
      return parsePhotoPage(await read("list_work_order_photos_rows_v1",
        { p_work_order_id: id, p_limit: clampPageSize(24), p_cursor: cursor }, signal), id);
    },
  };
}
