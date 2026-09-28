import { AppError } from "../../lib/errors/AppError";
import { parseWorkOrderReadRow } from "../work-orders/data/workOrderReadValidators";
import { mapWorkOrderListRow } from "../work-orders/data/workOrderMappers";
import type { WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";
import { scheduleItemsFor } from "./scheduleModel";
import { MAX_SCHEDULE_ROWS, SCHEDULE_BATCH_SIZE, UNSCHEDULED_PAGE_SIZE, validateScheduleRead, type ScheduleRead } from "./scheduleQueryModel";
import { readScheduleRows, type ScheduleReadRequest, type ScheduleReadResult } from "./scheduleReadTransport";

export class ScheduleCapacityError extends Error {
  constructor() { super("Too many scheduled jobs. Choose a week or day, or narrow the filters."); }
}

function checkedCount(count: number | null): number {
  if (count === null || !Number.isSafeInteger(count) || count < 0) throw new AppError("INTERNAL_ERROR");
  return count;
}
function parseRows(rows: unknown, max: number) {
  if (!Array.isArray(rows) || rows.length > max) throw new AppError("INTERNAL_ERROR");
  const parsed = rows.map(row => mapWorkOrderListRow(parseWorkOrderReadRow(row), Date.now()));
  if (new Set(parsed.map(row => row.id)).size !== parsed.length) throw new AppError("INTERNAL_ERROR");
  return parsed;
}

export function createScheduleReadRepository(read: (request: ScheduleReadRequest, signal?: AbortSignal) => Promise<ScheduleReadResult> = readScheduleRows) {
  return {
    async calendar(filters: ScheduleRead, signal?: AbortSignal) {
      validateScheduleRead(filters);
      if (filters.kind !== "calendar" || !filters.range) throw new AppError("INVALID_REQUEST");
      const range = filters.range;
      const rows: WorkOrderReadModel[] = [];
      const seen = new Set<string>();
      let afterId: string | undefined;
      // Bounded, ordered keyset traversal of ONLY this ETA window. Never publish
      // partial events/counts as a complete calendar after a failed continuation.
      for (let batch = 0; batch <= MAX_SCHEDULE_ROWS / SCHEDULE_BATCH_SIZE; batch += 1) {
        signal?.throwIfAborted();
        const result = await read({ filters, afterId, limit: SCHEDULE_BATCH_SIZE }, signal);
        signal?.throwIfAborted();
        const count = checkedCount(result.count);
        if (rows.length + count > MAX_SCHEDULE_ROWS) throw new ScheduleCapacityError();
        const page = parseRows(result.rows, SCHEDULE_BATCH_SIZE);
        if ((count > 0 && page.length === 0) || page.length > count || page.some(row => seen.has(row.id))) throw new AppError("INTERNAL_ERROR");
        page.forEach(row => seen.add(row.id));
        rows.push(...page);
        if (count <= page.length) {
          return scheduleItemsFor(rows).filter(item => item.date >= range.from && item.date < range.to);
        }
        afterId = page.at(-1)?.id;
      }
      throw new ScheduleCapacityError();
    },
    async unscheduled(filters: ScheduleRead, page: number, signal?: AbortSignal) {
      validateScheduleRead(filters);
      if (filters.kind !== "unscheduled" || !Number.isSafeInteger(page) || page < 0) throw new AppError("INVALID_REQUEST");
      const result = await read({ filters, offset: page * UNSCHEDULED_PAGE_SIZE, limit: UNSCHEDULED_PAGE_SIZE }, signal);
      signal?.throwIfAborted();
      return { items: parseRows(result.rows, UNSCHEDULED_PAGE_SIZE), total: checkedCount(result.count) };
    },
    async count(filters: ScheduleRead, signal?: AbortSignal) {
      validateScheduleRead(filters);
      const result = await read({ filters, countOnly: true }, signal);
      signal?.throwIfAborted();
      return checkedCount(result.count);
    },
  };
}

export const scheduleReadRepository = createScheduleReadRepository();
