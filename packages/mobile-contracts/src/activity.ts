import { z } from "zod";
import { MobileContractError } from "./errors";
import { cursorPageSchema, decodePage, type CursorPage } from "./pagination";
export const activityChannelSchema = z.enum(["field_note", "internal_note", "contractor_message", "system_event", "legacy"]);
const rowSchema = z.object({
  id: z.uuid(), work_order_id: z.string().min(1), author_id: z.uuid().nullable(), author_name: z.string(),
  created_at: z.string().nullable(), text: z.string(), type: z.string().nullable(), activity_channel: activityChannelSchema,
  entered_by_role: z.enum(["manager", "dispatcher", "back_office", "contractor", "system"]),
  is_staff_override: z.boolean(), is_staff_only: z.boolean(), override_for_contractor_id: z.uuid().nullable(),
  event_key: z.string(), event_data: z.json(), requires_7eleven_sync: z.boolean(),
  synced_to_7eleven_at: z.string().nullable(), synced_to_7eleven_by: z.uuid().nullable(),
  requires_contractor_attention: z.boolean(), contractor_attention_acknowledged_at: z.string().nullable(),
  contractor_attention_acknowledged_by: z.uuid().nullable(), workflow_cycle: z.number().int(),
  contractor_assignment_version: z.number().int(), deleted_at: z.null(),
}).refine(row => row.activity_channel !== "internal_note" || row.is_staff_only);
export type ActivityItem = {
  id: string; author: string; createdAt: string | null; text: string;
  channel: z.infer<typeof activityChannelSchema>; eventKey: string;
};
export function parseActivityPage(value: unknown, workOrderId: string): CursorPage<ActivityItem> {
  const result = cursorPageSchema(rowSchema).safeParse(decodePage(value));
  if (!result.success || result.data.items.some(row => row.work_order_id !== workOrderId
    || row.activity_channel === "internal_note" || row.is_staff_only)) {
    throw new MobileContractError("invalid_response");
  }
  return { items: result.data.items.map(row => ({ id: row.id, author: row.author_name,
    createdAt: row.created_at, text: row.text, channel: row.activity_channel, eventKey: row.event_key })),
    nextCursor: result.data.nextCursor, hasMore: result.data.hasMore, totalCount: result.data.totalCount ?? null };
}
