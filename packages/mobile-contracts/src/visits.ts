import { z } from "zod";
import { MobileContractError } from "./errors";
import { cursorPageSchema, decodePage, type CursorPage } from "./pagination";
const rowSchema = z.object({
  id: z.uuid(), work_order_id: z.string().min(1), contractor_id: z.uuid(), check_in_at: z.string(),
  check_out_at: z.string().nullable(), checked_in_by: z.uuid(), checked_out_by: z.uuid().nullable(),
  check_in_activity_id: z.uuid().nullable(), check_out_activity_id: z.uuid().nullable(),
  created_at: z.string(), updated_at: z.string(), closure_kind: z.literal("administrative_transfer").nullable(),
  duration_review_required: z.boolean(), administrative_closed_at: z.string().nullable(),
  administrative_closed_by: z.uuid().nullable(), administrative_close_reason: z.string().nullable(),
  administrative_transfer_operation_id: z.uuid().nullable(),
});
export type VisitItem = {
  id: string; checkInAt: string; checkOutAt: string | null;
  closureKind: "administrative_transfer" | null; durationReviewRequired: boolean;
};
export function parseVisitPage(value: unknown, workOrderId: string): CursorPage<VisitItem> {
  const result = cursorPageSchema(rowSchema).safeParse(decodePage(value));
  if (!result.success || result.data.items.some(row => row.work_order_id !== workOrderId)) {
    throw new MobileContractError("invalid_response");
  }
  return { items: result.data.items.map(row => ({ id: row.id, checkInAt: row.check_in_at,
    checkOutAt: row.check_out_at, closureKind: row.closure_kind,
    durationReviewRequired: row.duration_review_required })), nextCursor: result.data.nextCursor,
    hasMore: result.data.hasMore, totalCount: result.data.totalCount ?? null };
}
