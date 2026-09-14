import { z } from "zod";
import { AppError } from "../../../lib/errors/AppError";
import { MAX_PAGE_SIZE, type CursorPage } from "../../../lib/cursorPagination";
import type { VisitReadRow } from "./visitReadContracts";

const text = z.string();
const uuid = text.length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
// PostgreSQL JSON timestamps are complete ISO instants. Date.parse alone would
// accept numeric text and silently roll an impossible February date into March.
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
const hasOrderedVisitTimes = (start: string, end: string): boolean => {
  const startMilliseconds = Date.parse(start), endMilliseconds = Date.parse(end);
  if (!Number.isFinite(startMilliseconds) || !Number.isFinite(endMilliseconds)) return false;
  if (endMilliseconds !== startMilliseconds) return endMilliseconds > startMilliseconds;
  // SQL timestamps retain six fractional digits; Date.parse retains only three.
  const remainder = (value: string) => Number((/\.(\d{1,6})/.exec(value)?.[1] ?? "").padEnd(6, "0").slice(3));
  return remainder(end) >= remainder(start);
};
const count = z.number().refine(value => Number.isSafeInteger(value) && value >= 0);
const decimal = z.union([z.number().finite(), text.regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/)
  .refine(value => Number.isFinite(Number(value)))]);

// The fixed invoker RPC returns the current table row. Validate its privacy and
// closure evidence before discarding fields that the public mapper never exposed.
const rowSchema: z.ZodType<VisitReadRow> = z.object({
  id: uuid,
  work_order_id: text.min(1), // The relational parent key is TEXT, not a UUID.
  contractor_id: uuid,
  check_in_at: date,
  check_out_at: date.nullable(),
  checked_in_by: uuid,
  checked_out_by: uuid.nullable(),
  check_in_activity_id: uuid.nullable(),
  check_out_activity_id: uuid.nullable(),
  created_at: date,
  updated_at: date,
  closure_kind: z.literal("administrative_transfer").nullable(),
  duration_review_required: z.boolean(),
  administrative_closed_at: date.nullable(),
  administrative_closed_by: uuid.nullable(),
  administrative_close_reason: text.nullable(),
  administrative_transfer_operation_id: uuid.nullable(),
}).refine(row => row.check_out_at === null
  ? row.checked_out_by === null && row.check_out_activity_id === null
  : row.checked_out_by !== null && hasOrderedVisitTimes(row.check_in_at, row.check_out_at))
  .refine(row => row.closure_kind === null
    ? !row.duration_review_required && row.administrative_closed_at === null
      && row.administrative_closed_by === null && row.administrative_close_reason === null
      && row.administrative_transfer_operation_id === null
    : row.duration_review_required && row.check_out_at !== null && row.administrative_closed_at !== null
      && row.administrative_closed_by !== null && row.administrative_transfer_operation_id !== null
      && row.administrative_close_reason !== null
      // PostgreSQL btrim(text) removes ASCII spaces and length counts code points.
      && [...row.administrative_close_reason.replace(/^ +| +$/g, "")].length >= 1
      && [...row.administrative_close_reason.replace(/^ +| +$/g, "")].length <= 500)
  .transform(row => ({
    id: row.id, work_order_id: row.work_order_id, contractor_id: row.contractor_id,
    check_in_at: row.check_in_at, check_out_at: row.check_out_at,
    checked_in_by: row.checked_in_by, checked_out_by: row.checked_out_by,
    closure_kind: row.closure_kind, duration_review_required: row.duration_review_required,
    administrative_closed_at: row.administrative_closed_at, administrative_closed_by: row.administrative_closed_by,
  }));

const pageSchema = z.object({
  items: z.array(rowSchema).max(MAX_PAGE_SIZE)
    .refine(rows => new Set(rows.map(row => row.id.toLowerCase())).size === rows.length)
    .refine(rows => rows.filter(row => row.check_out_at === null).length <= 1),
  nextCursor: text.min(1).nullable(),
  hasMore: z.boolean(),
  totalCount: count.nullable().optional(),
  aggregates: z.record(text, decimal).nullable().optional(),
}).refine(page => page.hasMore === (page.nextCursor !== null));
const invalidResult = () => new AppError("INTERNAL_ERROR", { cause: new Error("Invalid visit read result") });

export function parseVisitReadRow(value: unknown, workOrderId: string): VisitReadRow {
  const result = rowSchema.safeParse(value);
  if (!result.success || result.data.work_order_id !== workOrderId) throw invalidResult();
  return result.data;
}

export function parseVisitReadPage(value: unknown, workOrderId: string): CursorPage<VisitReadRow> {
  let decoded: unknown = value;
  if (typeof value === "string") {
    try { decoded = JSON.parse(value); } catch { throw invalidResult(); }
  }
  const result = pageSchema.safeParse(decoded);
  if (!result.success || result.data.items.some(row => row.work_order_id !== workOrderId)) throw invalidResult();
  const page = result.data;
  return {
    items: page.items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    totalCount: page.totalCount ?? null,
    aggregates: page.aggregates ? Object.fromEntries(Object.entries(page.aggregates).map(([key, number]) => [key, Number(number || 0)])) : undefined,
  };
}
