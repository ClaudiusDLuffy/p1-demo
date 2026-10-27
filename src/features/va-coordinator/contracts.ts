import { z } from "zod";
import type { CursorPage } from "../../lib/cursorPagination";
import { workOrderStatusSchema } from "../../lib/schemas/workOrderStatus";

export const VA_COORDINATOR_ROLE = "va_coordinator" as const;
export const VA_COORDINATOR_LABEL = "VA Coordinator" as const;
export const VA_COORDINATOR_PAGE_SIZE = 25;
export const VA_COORDINATOR_CHILD_LIMIT = 100;
export const VA_COORDINATOR_SEARCH_LIMIT = 120;

const text = z.string();
const optionalText = text.nullable();
const timestamp = z.iso.datetime({ offset: true }).nullable();
const workOrderId = text.min(1).max(128);
const uuid = text.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const vaCoordinatorWorkOrderSchema = z.object({
  id: workOrderId,
  storeNumber: optionalText,
  city: optionalText,
  state: optionalText,
  summary: optionalText,
  functionalStatus: z.enum(["New", "Dispatched", "Work in Progress", "Pending Capital Approval",
    "Pending Capital Completion", "Awaiting Parts", "Completed", "Cancelled"]).nullable(),
  status: workOrderStatusSchema.nullable(),
  priority: z.enum(["p1", "p2", "p3", "p4", "p5"]).nullable(),
  assetMake: optionalText,
  assetModel: optionalText,
  assetSerial: optionalText,
  updatedAt: timestamp,
  technicianName: optionalText,
});
export type VaCoordinatorWorkOrder = z.infer<typeof vaCoordinatorWorkOrderSchema>;

export const vaCoordinatorWorkOrderDetailSchema = vaCoordinatorWorkOrderSchema.extend({
  address: optionalText,
  description: optionalText,
  assetYear: z.number().int().nullable(),
});
export type VaCoordinatorWorkOrderDetail = z.infer<typeof vaCoordinatorWorkOrderDetailSchema>;

export const vaCoordinatorNoteSchema = z.object({
  id: uuid,
  workOrderId,
  text: text,
  createdAt: timestamp,
  authorName: text,
  syncedToSevenElevenAt: timestamp,
  syncedById: uuid.nullable(),
  syncedByName: optionalText,
  requiresSevenElevenSync: z.boolean(),
});
export type VaCoordinatorNote = z.infer<typeof vaCoordinatorNoteSchema>;

export const vaCoordinatorAttachmentSchema = z.object({
  id: uuid,
  workOrderId,
  storagePath: text.min(1),
  caption: optionalText,
  createdAt: timestamp,
  uploaderName: optionalText,
});
export type VaCoordinatorAttachment = z.infer<typeof vaCoordinatorAttachmentSchema>;

const cursorSchema = z.object({ updatedAt: z.iso.datetime({ offset: true }), id: workOrderId });
const pageSchema = z.object({
  items: z.array(vaCoordinatorWorkOrderSchema).max(VA_COORDINATOR_PAGE_SIZE)
    .refine(rows => new Set(rows.map(row => row.id)).size === rows.length),
  nextCursor: cursorSchema.nullable(),
  hasMore: z.boolean(),
}).refine(page => page.hasMore === (page.nextCursor !== null));

export function parseVaCoordinatorWorkOrderPage(value: unknown): CursorPage<VaCoordinatorWorkOrder> {
  let decoded: unknown = value;
  if (typeof value === "string") {
    try { decoded = JSON.parse(value); } catch { throw new Error("The work-order results could not be verified."); }
  }
  const result = pageSchema.safeParse(decoded);
  if (!result.success) throw new Error("The work-order results could not be verified.");
  return { ...result.data, nextCursor: result.data.nextCursor ? JSON.stringify(result.data.nextCursor) : null, totalCount: null };
}

export function parseVaCoordinatorWorkOrderDetail(value: unknown, expectedId: string): VaCoordinatorWorkOrderDetail {
  const result = vaCoordinatorWorkOrderDetailSchema.safeParse(value);
  if (!result.success || result.data.id !== expectedId) throw new Error("The work-order details could not be verified.");
  return result.data;
}

export function parseVaCoordinatorNotes(value: unknown, expectedWorkOrderId: string): VaCoordinatorNote[] {
  const result = z.array(vaCoordinatorNoteSchema).max(VA_COORDINATOR_CHILD_LIMIT).safeParse(value);
  if (!result.success || result.data.some(row => row.workOrderId !== expectedWorkOrderId)
    || new Set(result.data.map(row => row.id)).size !== result.data.length) throw new Error("The technician notes could not be verified.");
  return result.data;
}

export function parseVaCoordinatorAttachments(value: unknown, expectedWorkOrderId: string): VaCoordinatorAttachment[] {
  const result = z.array(vaCoordinatorAttachmentSchema).max(VA_COORDINATOR_CHILD_LIMIT).safeParse(value);
  if (!result.success || result.data.some(row => row.workOrderId !== expectedWorkOrderId
    || !row.storagePath.startsWith(`wo/${expectedWorkOrderId}/`))
    || new Set(result.data.map(row => row.id)).size !== result.data.length) throw new Error("The work-order attachments could not be verified.");
  return result.data;
}
