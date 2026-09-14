import { z } from "zod";
import { AppError } from "../../../lib/errors/AppError";
import { MAX_PAGE_SIZE, type CursorPage } from "../../../lib/cursorPagination";
import type { PhotoMetadataRow } from "./photoMetadataContracts";

const text = z.string();
const uuid = text.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const count = z.number().refine(Number.isSafeInteger).refine(value => value >= 0);
const decimal = z.union([z.number().finite(), text.regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/)
  .refine(value => Number.isFinite(Number(value)))]);
const rowSchema = z.object({
  id: uuid, work_order_id: text.min(1), storage_path: text.min(1), uploader_id: uuid.nullable(),
  uploader_name: text.nullable(), caption: text.nullable(), created_at: z.iso.datetime({ offset: true }).nullable(),
}).transform((row): PhotoMetadataRow => ({
  id: row.id, work_order_id: row.work_order_id, storage_path: row.storage_path,
  uploader_id: row.uploader_id, uploader_name: row.uploader_name, caption: row.caption, created_at: row.created_at,
}));
const pageSchema = z.object({
  items: z.array(rowSchema).max(MAX_PAGE_SIZE)
    .refine(rows => new Set(rows.map(row => row.id.toLowerCase())).size === rows.length),
  nextCursor: text.min(1).nullable(), hasMore: z.boolean(), totalCount: count.nullable().optional(),
  aggregates: z.record(text, decimal).nullable().optional(),
}).refine(page => page.hasMore === (page.nextCursor !== null));
const invalid = () => new AppError("INTERNAL_ERROR", { cause: new Error("Invalid photo metadata result") });

/** Validate shape and exact returned parent; authorization remains in the existing RPC/RLS. */
export function parsePhotoMetadataPage(value: unknown, workOrderId: string): CursorPage<PhotoMetadataRow> {
  let decoded: unknown = value;
  if (typeof value === "string") {
    try { decoded = JSON.parse(value); } catch { throw invalid(); }
  }
  const result = pageSchema.safeParse(decoded);
  if (!result.success || result.data.items.some(row => row.work_order_id !== workOrderId
    || !(row.storage_path === `wo/${workOrderId}` || row.storage_path.startsWith(`wo/${workOrderId}/`)))) throw invalid();
  const page = result.data;
  return {
    items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore, totalCount: page.totalCount ?? null,
    aggregates: page.aggregates
      ? Object.fromEntries(Object.entries(page.aggregates).map(([key, value]) => [key, Number(value || 0)])) : undefined,
  };
}
