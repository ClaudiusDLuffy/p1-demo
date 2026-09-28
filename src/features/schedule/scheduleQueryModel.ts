import { z } from "zod";
import { AppError } from "../../lib/errors/AppError";
import { addDays, monthDateKeys, weekDateKeys, type CalendarView } from "./scheduleModel";

export const SCHEDULE_STATUSES = [
  ["all", "All active work"], ["assigned", "Assigned"], ["wip", "In progress"],
  ["parts", "Awaiting parts"], ["capital", "Capital"], ["completed", "Completed"],
] as const;
export type ScheduleStatus = typeof SCHEDULE_STATUSES[number][0];
export type ScheduleFilters = {
  search: string;
  status: ScheduleStatus;
  priority: "all" | "p1" | "p2" | "p3" | "p4" | "p5";
  contractorId: string | null;
  technicianId: string | null;
  technicianName: string | null;
  technicianDirectoryId?: string | null;
};
export type ScheduleRange = { from: string; to: string };
export type ScheduleRead = ScheduleFilters & {
  kind: "calendar" | "unscheduled" | "progress";
  range?: ScheduleRange;
};
export const UNSCHEDULED_PAGE_SIZE = 3;
export const SCHEDULE_BATCH_SIZE = 100;
export const MAX_SCHEDULE_ROWS = 2000;

export function visibleScheduleRange(date: string, view: CalendarView): ScheduleRange {
  const dates = view === "month" ? monthDateKeys(date) : view === "week" ? weekDateKeys(date) : [date];
  return { from: dates[0], to: addDays(dates[dates.length - 1], 1) };
}

const filtersSchema = z.object({
  search: z.string().max(200).regex(/^[^\u0000-\u001f\u007f]*$/),
  status: z.enum(["all", "assigned", "wip", "parts", "capital", "completed"]),
  priority: z.enum(["all", "p1", "p2", "p3", "p4", "p5"]),
  contractorId: z.uuid().nullable(), technicianId: z.uuid().nullable(),
  technicianName: z.string().min(1).max(200).nullable(),
  kind: z.enum(["calendar", "unscheduled", "progress"]),
  range: z.object({ from: z.iso.date(), to: z.iso.date() }).optional(),
});

export function validateScheduleRead(input: ScheduleRead): ScheduleRead {
  const parsed = filtersSchema.safeParse(input);
  if (!parsed.success) throw new AppError("INVALID_REQUEST");
  const { range, kind } = parsed.data;
  if (kind === "calendar" && (!range || range.to <= range.from
    || Date.parse(range.to) - Date.parse(range.from) > 42 * 86400000)) throw new AppError("INVALID_REQUEST");
  return { ...parsed.data, contractorId: parsed.data.contractorId ?? null,
    technicianId: parsed.data.technicianId ?? null, technicianName: parsed.data.technicianName ?? null };
}

/** Bound the database read by ETA, not creation date. The one-day envelope
 * covers every IANA UTC offset; final membership uses the shared store-zone
 * formatter, including historical state/address fallback and DST rules. */
export function scheduleUtcEnvelope(range: ScheduleRange) {
  return { from: `${addDays(range.from, -1)}T00:00:00Z`, to: `${addDays(range.to, 1)}T00:00:00Z` };
}

/** PostgREST quoted values protect OR syntax; LIKE metacharacters stay literal. */
export function scheduleSearchExpression(search: string): string {
  const literal = search.trim().replace(/\\/g, "\\\\").replace(/[%_*]/g, "\\$&").replace(/"/g, '\\"');
  return ["id", "store_number", "city"].map(column => `${column}.ilike."%${literal}%"`).join(",");
}
