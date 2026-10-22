import { boundedReadRpc } from "../../../lib/counts/readRpc";
import { clampPageSize, type CursorPage } from "../../../lib/cursorPagination";
import { AppError } from "../../../lib/errors/AppError";
import {
  parseVaCoordinatorAttachments,
  parseVaCoordinatorNotes,
  parseVaCoordinatorWorkOrderDetail,
  parseVaCoordinatorWorkOrderPage,
  type VaCoordinatorAttachment,
  type VaCoordinatorNote,
  type VaCoordinatorWorkOrder,
  type VaCoordinatorWorkOrderDetail,
} from "../contracts";

export type VaCoordinatorReadDependencies = Readonly<{
  read: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}>;

const invalidResult = () => new AppError("INTERNAL_ERROR", { cause: new Error("Invalid VA coordinator read result") });

export function createVaCoordinatorReadRepository(dependencies: VaCoordinatorReadDependencies = { read: boundedReadRpc }) {
  return {
    async loadWorkOrders(search: string, cursor: string | null, limit: number, signal?: AbortSignal): Promise<CursorPage<VaCoordinatorWorkOrder>> {
      let decodedCursor: unknown = null;
      if (cursor) {
        try { decodedCursor = JSON.parse(cursor); } catch { throw invalidResult(); }
      }
      const result = await dependencies.read("list_va_coordinator_work_orders_v1", {
        p_search: search.trim() || null,
        p_limit: clampPageSize(limit),
        p_cursor: decodedCursor,
      }, signal);
      try { return parseVaCoordinatorWorkOrderPage(result); } catch { throw invalidResult(); }
    },
    async loadWorkOrder(workOrderId: string, signal?: AbortSignal): Promise<VaCoordinatorWorkOrderDetail | null> {
      if (!workOrderId) return null;
      const result = await dependencies.read("get_va_coordinator_work_order_v1", { p_work_order_id: workOrderId }, signal);
      if (result === null) return null;
      try { return parseVaCoordinatorWorkOrderDetail(result, workOrderId); } catch { throw invalidResult(); }
    },
    async loadTechnicianNotes(workOrderId: string, limit: number, signal?: AbortSignal): Promise<VaCoordinatorNote[]> {
      if (!workOrderId) throw new AppError("INTERNAL_ERROR");
      const result = await dependencies.read("list_va_coordinator_technician_notes_v1", {
        p_work_order_id: workOrderId, p_limit: clampPageSize(limit),
      }, signal);
      try { return parseVaCoordinatorNotes(result, workOrderId); } catch { throw invalidResult(); }
    },
    async loadAttachments(workOrderId: string, limit: number, signal?: AbortSignal): Promise<VaCoordinatorAttachment[]> {
      if (!workOrderId) throw new AppError("INTERNAL_ERROR");
      const result = await dependencies.read("list_va_coordinator_photos_v1", {
        p_work_order_id: workOrderId, p_limit: clampPageSize(limit),
      }, signal);
      try { return parseVaCoordinatorAttachments(result, workOrderId); } catch { throw invalidResult(); }
    },
  };
}

const production = createVaCoordinatorReadRepository();
export const loadVaCoordinatorWorkOrders = production.loadWorkOrders;
export const loadVaCoordinatorWorkOrder = production.loadWorkOrder;
export const loadVaCoordinatorTechnicianNotes = production.loadTechnicianNotes;
export const loadVaCoordinatorAttachments = production.loadAttachments;
