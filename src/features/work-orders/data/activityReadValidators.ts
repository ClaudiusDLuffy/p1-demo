import { z } from "zod";
import { AppError } from "../../../lib/errors/AppError";
import { MAX_PAGE_SIZE, type CursorPage } from "../../../lib/cursorPagination";
import type { ActivityReadJson, ActivityReadRow } from "./activityReadContracts";

const text = z.string();
const uuid = text.length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
// Keep the original PostgreSQL ISO bytes while rejecting calendar rollover.
const isDatabaseTimestamp = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= (days.at(month - 1) ?? 0)
    && hour <= 23 && minute <= 59 && second <= 59 && Number.isFinite(Date.parse(value));
};
const date = text.refine(isDatabaseTimestamp);
// Both counters are PostgreSQL integers, with no nonnegative schema constraint.
const integer = z.number().int().min(-2147483648).max(2147483647);
const count = z.number().refine(Number.isSafeInteger).refine(value => value >= 0);
const decimal = z.union([z.number().finite(), text.regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/)
  .refine(value => Number.isFinite(Number(value)))]);
const jsonShape = z.json();
// Preserve JSON key order and scalar forms; do not rebuild event payloads.
const json = z.custom<ActivityReadJson>(value => jsonShape.safeParse(value).success);
const rowSchema = z.object({
  id: uuid, work_order_id: text.min(1), author_id: uuid.nullable(), author_name: text,
  created_at: date.nullable(), text, type: text.nullable(),
  activity_channel: z.enum(["field_note", "internal_note", "contractor_message", "system_event", "legacy"]),
  entered_by_role: z.enum(["manager", "dispatcher", "back_office", "contractor", "system"]),
  is_staff_override: z.boolean(), is_staff_only: z.boolean(), override_for_contractor_id: uuid.nullable(),
  event_key: text, event_data: json, requires_7eleven_sync: z.boolean(),
  synced_to_7eleven_at: date.nullable(), synced_to_7eleven_by: uuid.nullable(),
  requires_contractor_attention: z.boolean(), contractor_attention_acknowledged_at: date.nullable(),
  contractor_attention_acknowledged_by: uuid.nullable(), workflow_cycle: integer, contractor_assignment_version: integer,
  deleted_at: z.null(), // Every current activity page RPC filters deleted_at IS NULL.
}).refine(row => row.requires_7eleven_sync === (row.activity_channel === "field_note"))
  .refine(row => row.activity_channel !== "internal_note" || (row.is_staff_only && !row.requires_contractor_attention))
  // An explicit required-field projection also keeps the repository's non-strict
  // compiler compatible with Zod's nullable-field inference; no value is coerced.
  .transform((row): ActivityReadRow => ({
    id: row.id, work_order_id: row.work_order_id, author_id: row.author_id, author_name: row.author_name,
    created_at: row.created_at, text: row.text, type: row.type, activity_channel: row.activity_channel,
    entered_by_role: row.entered_by_role, is_staff_override: row.is_staff_override, is_staff_only: row.is_staff_only,
    override_for_contractor_id: row.override_for_contractor_id, event_key: row.event_key, event_data: row.event_data,
    requires_7eleven_sync: row.requires_7eleven_sync, synced_to_7eleven_at: row.synced_to_7eleven_at,
    synced_to_7eleven_by: row.synced_to_7eleven_by, requires_contractor_attention: row.requires_contractor_attention,
    contractor_attention_acknowledged_at: row.contractor_attention_acknowledged_at,
    contractor_attention_acknowledged_by: row.contractor_attention_acknowledged_by,
    workflow_cycle: row.workflow_cycle, contractor_assignment_version: row.contractor_assignment_version, deleted_at: row.deleted_at,
  }));
const pageSchema = z.object({
  items: z.array(rowSchema).max(MAX_PAGE_SIZE).refine(rows => new Set(rows.map(row => row.id.toLowerCase())).size === rows.length),
  nextCursor: text.min(1).nullable(), hasMore: z.boolean(), totalCount: count.nullable().optional(),
  aggregates: z.record(text, decimal).nullable().optional(),
}).refine(page => page.hasMore === (page.nextCursor !== null));
const invalidResult = () => new AppError("INTERNAL_ERROR", { cause: new Error("Invalid activity read result") });

export function parseActivityReadRow(value: unknown): ActivityReadRow {
  const result = rowSchema.safeParse(value);
  if (!result.success) throw invalidResult();
  return result.data;
}

export function parseActivityReadPage(value: unknown, workOrderId: string): CursorPage<ActivityReadRow> {
  let decoded: unknown = value;
  if (typeof value === "string") {
    try { decoded = JSON.parse(value); } catch { throw invalidResult(); }
  }
  const result = pageSchema.safeParse(decoded);
  if (!result.success || result.data.items.some(row => row.work_order_id !== workOrderId)) throw invalidResult();
  const page = result.data;
  return {
    items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore, totalCount: page.totalCount ?? null,
    aggregates: page.aggregates ? Object.fromEntries(Object.entries(page.aggregates).map(([key, value]) => [key, Number(value || 0)])) : undefined,
  };
}
