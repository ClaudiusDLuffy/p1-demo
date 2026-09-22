import { z } from "zod";
import type { Database, Json } from "./supabase/database.types";

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
export const lifecycleContextSchema = z.object({
  workOrderId: z.string().trim().min(1),
  expectedAssignmentVersion: version,
  expectedWorkflowCycle: version,
  expectedLifecycleVersion: version,
  operationId: z.uuid(),
}).strict();
export type LifecycleContext = z.infer<typeof lifecycleContextSchema>;

export const lifecyclePartSchema = z.object({
  description: z.string().trim().min(1),
  partNumber: z.string().trim().default(""),
  qty: z.number().finite().positive().default(1),
  expectedReturnDate: z.iso.date().nullable().default(null),
}).strict();
export const etaCommandSchema = lifecycleContextSchema.extend({ eta: timestamp });
export const visitCommandSchema = lifecycleContextSchema.extend({
  checkedInAt: timestamp, notes: z.string(),
});
export const pauseCommandSchema = lifecycleContextSchema.extend({
  checkedOutAt: timestamp,
  reason: z.enum(["Awaiting parts", "Temporary fix", "Capital review"]),
  parts: z.array(lifecyclePartSchema),
  notes: z.string(),
  legacyPartNeeded: z.string().nullable(),
  legacyPartEta: z.iso.date().nullable(),
});
export const completionCommandSchema = lifecycleContextSchema.extend({
  completedAt: timestamp,
  assetMake: z.string().trim().min(1),
  assetModel: z.string().trim().min(1),
  assetSerial: z.string().trim().min(1),
  assetYear: z.number().int().nullable(),
  resolutionCode: z.string().nullable(),
  resolutionNotes: z.string().nullable(),
});

const resultFields = {
  workOrderId: z.string().min(1), operationId: z.uuid(),
  assignmentVersion: version, workflowCycle: version, lifecycleVersion: version,
  activityId: z.uuid(), visitId: z.uuid().nullable().optional(),
  workOrderStatus: z.string().min(1), functionalStatus: z.string().nullable(),
  // The adapter needs identifiers for refresh; row/provider details stay out
  // of the command contract. The parts query remains its display authority.
  parts: z.array(z.object({ id: z.uuid() })).default([]),
};
export const lifecycleResultSchema = z.discriminatedUnion("applied", [
  z.object({ applied: z.literal(true), reason: z.literal("applied"), ...resultFields }),
  z.object({ applied: z.literal(false), reason: z.literal("already_applied"), ...resultFields }),
]);
export type LifecycleResult = z.infer<typeof lifecycleResultSchema>;

type CommonArgs = {
  p_work_order_id: string;
  p_expected_assignment_version: number;
  p_expected_workflow_cycle: number;
  p_expected_lifecycle_version: number;
  p_operation_id: string;
};
type Routine<Args> = { Args: Args; Returns: Json };
export type LifecycleFunctions = {
  set_work_order_eta_v1: Routine<CommonArgs & { p_eta: string }>;
  start_work_order_visit_v1: Routine<CommonArgs & { p_check_in_at: string; p_notes: string }>;
  resume_work_order_visit_v1: Routine<CommonArgs & { p_check_in_at: string; p_notes: string }>;
  pause_work_order_for_parts_v1: Routine<CommonArgs & {
    p_check_out_at: string; p_reason: string; p_parts: Json; p_notes: string;
    p_legacy_part_needed: string | null; p_legacy_part_eta: string | null;
  }>;
  complete_work_order_field_v1: Routine<CommonArgs & {
    p_completed_at: string; p_asset_make: string; p_asset_model: string; p_asset_serial: string;
    p_asset_year: number | null; p_resolution_code: string | null; p_resolution_notes: string | null;
  }>;
  record_missed_work_order_visit_checkout_v1: Routine<Omit<CommonArgs, "p_work_order_id"> & {
    p_visit_id: string;
    p_check_out_at: string;
    p_reason: string;
  }>;
  mark_work_order_activity_synced_v1: Routine<{ p_activity_id: string; p_synced: boolean }>;
  flag_work_order_capital_v1: Routine<Omit<CommonArgs, "p_operation_id">>;
  return_completed_work_order_to_field_v1: Routine<CommonArgs & { p_reason: string }>;
};

// Forward-migration overlay: keep the generated baseline byte-identical.
// Retire this overlay after approved type generation from the deployed schema.
export type LifecycleDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Functions"> & {
    Functions: Database["public"]["Functions"] & LifecycleFunctions;
  };
};

export type LifecycleServerDatabase = Omit<LifecycleDatabase, "public"> & {
  public: Omit<LifecycleDatabase["public"], "Functions"> & {
    Functions: LifecycleDatabase["public"]["Functions"] & {
      record_email_capital_pending_v1: Routine<{ p_work_order_id: string }>;
    };
  };
};

export function lifecycleRpcContext(context: LifecycleContext): CommonArgs {
  return {
    p_work_order_id: context.workOrderId,
    p_expected_assignment_version: context.expectedAssignmentVersion,
    p_expected_workflow_cycle: context.expectedWorkflowCycle,
    p_expected_lifecycle_version: context.expectedLifecycleVersion,
    p_operation_id: context.operationId,
  };
}

export const RESERVED_LIFECYCLE_EVENTS = [
  "eta_updated", "check_in", "check_out", "job_paused", "job_completed", "visit_time_corrected",
] as const;
export function isReservedLifecycleEvent(eventKey: unknown): boolean {
  return RESERVED_LIFECYCLE_EVENTS.some(key => key === eventKey);
}
