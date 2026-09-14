import { z } from "zod";
import { MobileContractError } from "./errors";
import { clampPageSize, cursorPageSchema, decodePage, type CursorPage } from "./pagination";

export const workOrderStatusSchema = z.enum(["unassigned", "assigned", "wip", "parts", "capital", "pending_capital_completion", "completed", "pending_invoice", "pending_approval", "pending_payment", "closed"]);
export const workOrderPrioritySchema = z.enum(["p1", "p2", "p3", "p4", "p5"]);
export type WorkOrderStatus = z.infer<typeof workOrderStatusSchema>;
export type WorkOrderPriority = z.infer<typeof workOrderPrioritySchema>;
const nullableText = z.string().nullable().optional();
const nullableDate = z.string().refine(value => Number.isFinite(Date.parse(value))).nullable().optional();
const numeric = z.union([z.number(), z.string().refine(value => Number.isFinite(Number(value)))]).nullable().optional();
const rowSchema = z.object({
  id: z.string().min(1), status: workOrderStatusSchema, priority: workOrderPrioritySchema,
  functional_status: z.string().nullable().optional(), store_number: nullableText, city: nullableText,
  address: nullableText, store_state: nullableText, store_timezone: nullableText, store_postal_code: nullableText,
  summary: nullableText, description: nullableText, contractor_id: z.uuid().nullable().optional(),
  technician_on_job: nullableText, assigned_technician_profile_id: z.uuid().nullable().optional(),
  contractor_assignment_version: z.number().int().nullable().optional(),
  lifecycle_version: z.number().int().nonnegative().nullable().optional(),
  duplicate_root_work_order_id: nullableText, parts_total: z.number().int().nonnegative().nullable().optional(),
  parts_received: z.number().int().nonnegative().nullable().optional(), created_at: nullableDate,
  updated_at: nullableDate, dispatched_at: nullableDate, sla_started_at: nullableDate,
  response_breach_at: nullableDate, resolution_breach_at: nullableDate, nte: numeric,
  part_needed: nullableText, part_eta: nullableText,
}).passthrough();
export type WorkOrderSummary = {
  id: string; externalWorkOrderId: string; status: WorkOrderStatus; priority: WorkOrderPriority;
  functionalStatus: string | null; storeNumber: string | null; city: string | null; address: string | null;
  state: string | null; postalCode: string | null; summary: string | null; description: string | null;
  contractorId: string | null; technicianName: string | null; technicianProfileId: string | null;
  assignmentVersion: number; lifecycleVersion: number | null; partsTotal: number; partsReceived: number;
  createdAt: string | null; updatedAt: string | null; dispatchedAt: string | null; slaStartedAt: string | null;
  responseBreachAt: string | null; resolutionBreachAt: string | null; nte: number;
  partNeeded: string | null; partEta: string | null;
};
export type WorkOrderPageParams = { scope?: "active"; sort?: "newest"; limit?: number; cursor?: string | null };
export const workOrderReadArgs = (params: WorkOrderPageParams = {}) => ({
  p_scope: params.scope ?? "active", p_search: null, p_contractor_id: null, p_priority: null, p_status: null,
  p_state: null, p_resolution: null, p_from: null, p_to: null, p_needs_action: false,
  p_sort: params.sort ?? "newest", p_pending_first: false, p_limit: clampPageSize(params.limit),
  p_cursor: params.cursor ?? null, p_store_number: null, p_contractor_ids: null,
});
export function mapWorkOrder(value: unknown): WorkOrderSummary {
  const parsed = rowSchema.safeParse(value);
  if (!parsed.success) throw new MobileContractError("invalid_response");
  const row = parsed.data;
  return {
    id: row.id, externalWorkOrderId: row.duplicate_root_work_order_id ?? row.id, status: row.status,
    priority: row.priority, functionalStatus: row.functional_status ?? null, storeNumber: row.store_number ?? null,
    city: row.city ?? null, address: row.address ?? null, state: row.store_state ?? null,
    postalCode: row.store_postal_code ?? null, summary: row.summary ?? null, description: row.description ?? null,
    contractorId: row.contractor_id ?? null, technicianName: row.technician_on_job ?? null,
    technicianProfileId: row.assigned_technician_profile_id ?? null,
    assignmentVersion: row.contractor_assignment_version ?? 0, lifecycleVersion: row.lifecycle_version ?? null,
    partsTotal: row.parts_total ?? 0, partsReceived: row.parts_received ?? 0, createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null, dispatchedAt: row.dispatched_at ?? null,
    slaStartedAt: row.sla_started_at ?? null, responseBreachAt: row.response_breach_at ?? null,
    resolutionBreachAt: row.resolution_breach_at ?? null, nte: Number(row.nte ?? 0),
    partNeeded: row.part_needed ?? null, partEta: row.part_eta ?? null,
  };
}
export function parseWorkOrderPage(value: unknown): CursorPage<WorkOrderSummary> {
  const result = cursorPageSchema(rowSchema).safeParse(decodePage(value));
  if (!result.success || new Set(result.data.items.map(row => row.id)).size !== result.data.items.length) {
    throw new MobileContractError("invalid_response");
  }
  return { items: result.data.items.map(mapWorkOrder), nextCursor: result.data.nextCursor,
    hasMore: result.data.hasMore, totalCount: result.data.totalCount ?? null };
}
