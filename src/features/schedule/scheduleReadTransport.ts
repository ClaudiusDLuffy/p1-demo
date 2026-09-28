import { supabase } from "../../lib/supabase/client";
import { normalizeUnknownError } from "../../lib/errors/normalizeUnknown";
import { scheduleSearchExpression, scheduleUtcEnvelope, validateScheduleRead, type ScheduleRead } from "./scheduleQueryModel";

// Explicit operational projection: no financial values, internal activity,
// profile/contact details, or assignment history are requested by the calendar.
export const SCHEDULE_COLUMNS = "id,status,priority,functional_status,store_number,city,address,store_state,store_timezone,summary,contractor_id,assigned_technician_profile_id,technician_on_job,eta,contractor_assignment_version,workflow_cycle,lifecycle_version,assignment_transfer_pending_visit";
export type ScheduleReadRequest = { filters: ScheduleRead; offset?: number; limit?: number; afterId?: string; countOnly?: boolean };
export type ScheduleReadResult = { rows: unknown; count: number | null };

export async function readScheduleRows(request: ScheduleReadRequest, signal?: AbortSignal, client: typeof supabase = supabase): Promise<ScheduleReadResult> {
  signal?.throwIfAborted();
  const filters = validateScheduleRead(request.filters);
  // Browser session + existing work_orders RLS remain authoritative, including
  // company/technician/team restrictions. Never use a service client here.
  let query = client().from("work_orders")
    .select(request.countOnly ? "id" : SCHEDULE_COLUMNS, { count: "exact", head: request.countOnly === true })
    .is("deleted_at", null)
    .neq("status", "closed");
  if (filters.contractorId) query = query.eq("contractor_id", filters.contractorId);
  if (filters.technicianId) query = query.eq("assigned_technician_profile_id", filters.technicianId);
  if (filters.technicianName) query = query.eq("technician_on_job", filters.technicianName);
  if (filters.status !== "all") query = query.eq("status", filters.status);
  if (filters.priority !== "all") query = query.eq("priority", filters.priority);
  if (filters.search.trim()) query = query.or(scheduleSearchExpression(filters.search));
  if (filters.kind === "unscheduled") {
    query = query.is("eta", null).eq("status", "assigned")
      .in("functional_status", ["New", "Dispatched"]).not("contractor_id", "is", null);
  }
  if (filters.kind === "progress") query = query.eq("status", "wip");
  if (filters.kind === "calendar" && filters.range) {
    const envelope = scheduleUtcEnvelope(filters.range);
    query = query.gte("eta", envelope.from).lt("eta", envelope.to);
  }
  if (request.afterId) query = query.gt("id", request.afterId);
  query = query.order("id", { ascending: true });
  if (!request.countOnly) query = query.range(request.offset ?? 0, (request.offset ?? 0) + (request.limit ?? 100) - 1);
  if (signal) query = query.abortSignal(signal);
  const { data, error, count } = await query;
  signal?.throwIfAborted();
  if (error) throw normalizeUnknownError(error);
  return { rows: data, count };
}
