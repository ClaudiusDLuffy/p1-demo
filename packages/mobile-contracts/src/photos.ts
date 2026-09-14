import { z } from "zod";
import { MobileContractError } from "./errors";
import { cursorPageSchema, decodePage, type CursorPage } from "./pagination";
const rowSchema = z.object({
  id: z.uuid(), work_order_id: z.string().min(1), storage_path: z.string().min(1),
  uploader_id: z.uuid().nullable(), uploader_name: z.string().nullable(),
  caption: z.string().nullable(), created_at: z.string().nullable(),
});
export type PhotoMetadata = {
  id: string; workOrderId: string; path: string; uploaderName: string | null;
  caption: string | null; createdAt: string | null;
};
export function parsePhotoPage(value: unknown, workOrderId: string): CursorPage<PhotoMetadata> {
  const result = cursorPageSchema(rowSchema).safeParse(decodePage(value));
  if (!result.success || result.data.items.some(row => row.work_order_id !== workOrderId
    || !(row.storage_path === `wo/${workOrderId}` || row.storage_path.startsWith(`wo/${workOrderId}/`)))) {
    throw new MobileContractError("invalid_response");
  }
  return { items: result.data.items.map(row => ({ id: row.id, workOrderId: row.work_order_id,
    path: row.storage_path, uploaderName: row.uploader_name, caption: row.caption,
    createdAt: row.created_at })), nextCursor: result.data.nextCursor,
    hasMore: result.data.hasMore, totalCount: result.data.totalCount ?? null };
}
