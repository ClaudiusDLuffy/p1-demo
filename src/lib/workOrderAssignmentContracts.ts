import { z } from "zod";
import type { Json } from "./supabase/database.types";
import type { FinancialDatabase } from "./contractorInvoiceCommandContracts";
import type { StaffFinancialDatabase } from "./staffFinancialCommands";
import { lifecycleContextSchema, lifecycleRpcContext } from "./workOrderLifecycleContracts";

export const assignmentContextSchema = lifecycleContextSchema;
export type AssignmentContext = z.infer<typeof assignmentContextSchema>;
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const deliveryStatus = z.enum(["pending", "claimed", "sent", "unknown", "skipped"]);
const common = {
  applied: z.boolean(), reason: z.enum(["assigned", "reassigned", "unassigned", "rejected", "duplicated", "created", "already_applied"]),
  workOrderId: z.string().min(1), operationId: z.uuid(), assignmentVersion: version,
  workflowCycle: version, lifecycleVersion: version, activityId: z.uuid().nullable(),
};
const delivery = { deliveryId: z.uuid().nullable(), deliveryStatus: deliveryStatus.nullable() };
export const assignmentTransitionResultSchema = z.object({
  ...common, ...delivery, contractorId: z.uuid().nullable(), status: z.string().min(1),
  reason: z.enum(["assigned", "reassigned", "unassigned", "already_applied"]),
  functionalStatus: z.string().nullable(), isCapital: z.boolean(), capitalStatus: z.string().nullable(),
  assignmentStartedAt: z.iso.datetime({ offset: true }).nullable(), dispatchedAt: z.iso.datetime({ offset: true }).nullable(),
  receivingVisitRequired: z.boolean().optional(),
});
export const administrativeTransferRequestSchema = z.object({
  contractorId: z.uuid().nullable(), reason: z.string().trim().min(1).max(500), confirmed: z.literal(true),
}).strict();
export const administrativeTransferResultSchema = assignmentTransitionResultSchema.extend({
  status: z.enum(["wip", "capital", "pending_capital_completion"]),
  functionalStatus: z.enum(["Work in Progress", "Pending Capital Approval", "Pending Capital Completion"]),
  receivingVisitRequired: z.literal(true),
  administrativeClosedVisitId: z.uuid(), administrativeClosedAt: z.iso.datetime({ offset: true }),
  administrativeClosureActivityId: z.uuid(), durationReviewRequired: z.literal(true),
}).superRefine((result, context) => {
  const validParentState = result.status === "wip"
    ? result.functionalStatus === "Work in Progress"
    : result.status === "capital"
      ? ["Work in Progress", "Pending Capital Approval"].includes(result.functionalStatus)
      : result.functionalStatus === "Pending Capital Completion";
  if (!validParentState) {
    context.addIssue({
      code: "custom",
      path: ["functionalStatus"],
      message: "Administrative transfer did not preserve a valid field state",
    });
  }
});
export const assignmentRejectionResultSchema = z.object({
  ...common, rejectedAt: z.iso.datetime({ offset: true }), rejectedBy: z.uuid(),
  reason: z.enum(["rejected", "already_applied"]),
});
export const assignmentDuplicateResultSchema = z.object({
  ...common, ...delivery, sourceWorkOrderId: z.string().min(1), rootWorkOrderId: z.string().min(1),
  duplicateSequence: z.number().int().positive(),
  reason: z.enum(["duplicated", "already_applied"]),
});
export const assignmentCreationResultSchema = z.object({ ...common, contractorId: z.uuid().nullable(), reason: z.enum(["created", "already_applied"]) });
export type WorkOrderContractorTransitionResult = z.infer<typeof assignmentTransitionResultSchema>;
export type RejectUnassignedWorkOrderResult = z.infer<typeof assignmentRejectionResultSchema>;
export type DuplicateWorkOrderForReassignmentResult = z.infer<typeof assignmentDuplicateResultSchema>;
export type AssignmentTransitionDeliveryStatus = z.infer<typeof deliveryStatus>;

type ContextArgs = ReturnType<typeof lifecycleRpcContext>;
type Routine<Args> = { Args: Args; Returns: Json };
export type AssignmentFunctions = {
  transition_work_order_contractor_v1: Routine<ContextArgs & { p_new_contractor_id: string | null }>;
  administrative_close_visit_and_transfer_v1: Routine<ContextArgs & { p_new_contractor_id: string | null; p_reason: string; p_confirmed: boolean }>;
  reject_unassigned_work_order_v1: Routine<ContextArgs & { p_reason: string }>;
  duplicate_work_order_for_reassignment_v1: Routine<Omit<ContextArgs, "p_work_order_id"> & { p_source_work_order_id: string }>;
  create_work_order_with_assignment_v1: Routine<{ p_operation_id: string; p_work_order: Json }>;
};
export type AssignmentDatabase = Omit<FinancialDatabase, "public"> & {
  public: Omit<FinancialDatabase["public"], "Functions"> & {
    Functions: FinancialDatabase["public"]["Functions"] & AssignmentFunctions;
  };
};
export type AssignmentServerDatabase = Omit<StaffFinancialDatabase, "public"> & {
  public: Omit<StaffFinancialDatabase["public"], "Functions"> & {
    Functions: StaffFinancialDatabase["public"]["Functions"] & {
      create_email_work_order_with_assignment_v1: Routine<{ p_operation_id: string; p_work_order: Json }>;
    };
  };
};
