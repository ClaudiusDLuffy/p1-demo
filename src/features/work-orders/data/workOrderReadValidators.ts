import { z } from "zod";
import { AppError } from "../../../lib/errors/AppError";
import { MAX_PAGE_SIZE, type CursorPage } from "../../../lib/cursorPagination";
import type { WorkOrderReadRow, WorkOrderReadJson, WorkOrderIncidentReuse } from "./workOrderReadContracts";

const text = z.string();
const optionalText = text.nullable().optional();
const parentId = text.min(1); // Relational work-order IDs are TEXT, including legacy and suffixed IDs.
const uuid = text.length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const optionalUuid = uuid.nullable().optional();
const date = text.refine(value => Number.isFinite(Date.parse(value)));
const optionalDate = date.nullable().optional();
const integer = z.number().refine(Number.isSafeInteger);
const count = integer.refine(value => value >= 0);
const optionalInteger = integer.nullable().optional();
const optionalCount = count.nullable().optional();
const optionalBoolean = z.boolean().nullable().optional();
// Keep decimal text as text: legacy mapping distinguishes numeric zero from "0".
const decimal = z.union([z.number().finite(), text.regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/)
  .refine(value => Number.isFinite(Number(value)))]);
const optionalDecimal = decimal.nullable().optional();
const jsonShape = z.json();
// JSON snapshots are returned verbatim by the existing mapper. Validation must
// not reorder nested keys, clone into a different representation, or drop keys.
const json = z.custom<WorkOrderReadJson>(value => jsonShape.safeParse(value).success);
const incidentShape = z.object({ incidentId: text, relatedWorkOrderIds: z.array(parentId), crossesState: z.boolean() });
const incidentReuse = z.custom<WorkOrderIncidentReuse>(value => incidentShape.safeParse(value).success && jsonShape.safeParse(value).success);
const assignment = z.object({
  id: uuid, contractor_id: uuid, next_contractor_id: optionalUuid, assignment_version: integer,
  assignment_started_at: optionalDate, assignment_ended_at: date, assignment_ended_by: optionalUuid,
  workflow_snapshot: json.optional(),
});
const todo = z.object({
  id: uuid, work_order_id: parentId, owner_id: uuid, created_by: uuid, note: optionalText,
  created_at: date, updated_at: date,
});

const rowSchema: z.ZodType<WorkOrderReadRow> = z.object({
  id: parentId,
  status: z.enum(["unassigned", "assigned", "wip", "parts", "capital", "pending_capital_completion", "completed",
    "pending_invoice", "pending_approval", "pending_payment", "closed"]),
  priority: z.enum(["p1", "p2", "p3", "p4", "p5"]),
  functional_status: z.enum(["New", "Dispatched", "Work in Progress", "Pending Capital Approval", "Pending Capital Completion",
    "Awaiting Parts", "Completed", "Cancelled"]).nullable().optional(),
  capital_status: z.enum(["Pending approval", "Approved - work authorized", "Equipment ordered", "Equipment received",
    "Installation scheduled", "Installed"]).nullable().optional(),
  contractor_invoicing_completion_source: z.enum(["contractor", "staff_override", "legacy"]).nullable().optional(),
  incident_id: optionalText,
  store_number: optionalText,
  city: optionalText,
  address: optionalText,
  store_state: optionalText,
  store_timezone: optionalText,
  store_county: optionalText,
  store_postal_code: optionalText,
  line_of_service: optionalText,
  business_service: optionalText,
  category: optionalText,
  sub_category: optionalText,
  summary: optionalText,
  description: optionalText,
  contractor_id: optionalUuid,
  afm_name: optionalText,
  afm_email: optionalText,
  nte: optionalDecimal,
  nte_flag_threshold: optionalDecimal,
  nte_flagged: optionalBoolean,
  nte_flag_amount: optionalDecimal,
  invoice_total: optionalDecimal,
  // These RPC fields retain their database timestamp/date types. A UI fallback
  // for legacy display text does not authorize malformed raw database values.
  eta: optionalDate,
  dispatched_at: optionalDate,
  start_time: optionalDate,
  end_time: optionalDate,
  asset_make: optionalText,
  asset_model: optionalText,
  asset_serial: optionalText,
  asset_year: optionalInteger,
  repair_quote: optionalDecimal,
  install_quote: optionalDecimal,
  capital_notes: optionalText,
  is_capital: optionalBoolean,
  resolution_code: optionalText,
  resolution_notes: optionalText,
  part_needed: optionalText,
  part_eta: z.iso.date().nullable().optional(),
  source: optionalText,
  billing_only: optionalBoolean,
  billing_ready_at: optionalDate,
  billing_ready_by: optionalUuid,
  contractor_assignment_started_at: optionalDate,
  contractor_assignment_version: optionalInteger,
  assignment_transfer_pending_visit: optionalBoolean,
  duplicated_from_work_order_id: optionalText,
  duplicate_root_work_order_id: optionalText,
  duplicate_sequence: integer.refine(value => value > 0).nullable().optional(),
  workflow_cycle: optionalInteger,
  lifecycle_version: optionalCount,
  contractor_invoicing_completed_at: optionalDate,
  contractor_invoicing_completed_by: optionalUuid,
  contractor_invoicing_assignment_version: optionalInteger,
  contractor_invoicing_workflow_cycle: optionalInteger,
  staff_notes_seen_at: optionalDate,
  technician_on_job: optionalText,
  assigned_technician_profile_id: optionalUuid,
  technician_assigned_at: optionalDate,
  technician_assigned_by: optionalUuid,
  created_at: optionalDate,
  updated_at: optionalDate,
  closed_at: optionalDate,
  sla_started_at: optionalDate,
  response_breach_at: optionalDate,
  resolution_breach_at: optionalDate,
  latest_note_at: optionalDate,
  latest_contractor_activity_at: optionalDate,
  pending_7eleven_sync_count: optionalCount,
  pending_contractor_attention_count: optionalCount,
  history_invoice_total: optionalDecimal,
  history_invoice_count: optionalCount,
  billing_invoice_id: optionalUuid,
  parts_total: optionalCount,
  parts_received: optionalCount,
  staff_read_through_at: optionalDate,
  assignment_history: z.array(assignment).nullable().optional(),
  staff_todo: todo.nullable().optional(),
  incident_reuse: incidentReuse.nullable().optional(),
}).refine(row => !row.staff_todo || row.staff_todo.work_order_id === row.id);

const pageSchema = z.object({
  items: z.array(rowSchema).max(MAX_PAGE_SIZE).refine(rows => new Set(rows.map(row => row.id)).size === rows.length),
  nextCursor: text.min(1).nullable(),
  hasMore: z.boolean(),
  totalCount: count.nullable().optional(),
  aggregates: z.record(text, decimal).nullable().optional(),
}).refine(page => page.hasMore === (page.nextCursor !== null));
const invalidResult = () => new AppError("INTERNAL_ERROR", { cause: new Error("Invalid work-order read result") });

export function parseWorkOrderReadRow(value: unknown): WorkOrderReadRow {
  const result = rowSchema.safeParse(value);
  if (!result.success) throw invalidResult();
  return result.data;
}

export function parseWorkOrderReadPage(value: unknown): CursorPage<WorkOrderReadRow> {
  let decoded: unknown = value;
  if (typeof value === "string") {
    try { decoded = JSON.parse(value); } catch { throw invalidResult(); }
  }
  const result = pageSchema.safeParse(decoded);
  if (!result.success) throw invalidResult();
  const page = result.data;
  return {
    items: page.items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    totalCount: page.totalCount ?? null,
    aggregates: page.aggregates ? Object.fromEntries(Object.entries(page.aggregates).map(([key, number]) => [key, Number(number || 0)])) : undefined,
  };
}
