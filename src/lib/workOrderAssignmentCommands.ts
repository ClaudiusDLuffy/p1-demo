import { z } from "zod";
import {
  assignmentContextSchema, assignmentTransitionResultSchema, assignmentRejectionResultSchema,
  assignmentDuplicateResultSchema, assignmentCreationResultSchema,
  administrativeTransferRequestSchema, administrativeTransferResultSchema,
  type AssignmentContext, type AssignmentFunctions,
} from "./workOrderAssignmentContracts";
import { lifecycleRpcContext } from "./workOrderLifecycleContracts";
import { lifecycleContextFor } from "./workOrderLifecycleCommands";
import type { Json } from "./supabase/database.types";

export type AssignmentTransport = <Name extends keyof AssignmentFunctions>(name: Name,
  args: AssignmentFunctions[Name]["Args"]) => PromiseLike<{ data: unknown; error: unknown }>;
export class AssignmentCommandError extends Error {
  constructor(readonly code: string, message: string, cause?: unknown) {
    super(message, { cause }); this.name = "AssignmentCommandError";
  }
}
export function safeAssignmentError(error: unknown): AssignmentCommandError {
  if (error instanceof AssignmentCommandError) return error;
  const parsed = z.object({ code: z.string().optional(), details: z.string().nullish() }).safeParse(error);
  const code = parsed.success ? parsed.data.code : undefined;
  if (code === "PT409" && parsed.success && parsed.data.details === "active_visit_requires_checkout") {
    return new AssignmentCommandError("active_visit_requires_checkout", "The current contractor or technician has an open visit and must check out before transfer. Authorized staff can use the separately confirmed emergency close-and-transfer action.", error);
  }
  if (code === "PT409" || code === "40001") return new AssignmentCommandError("PT409", "The work order changed. Refresh it and review the current assignment before trying again.", error);
  if (code === "42501" || code === "PT403") return new AssignmentCommandError("42501", "You are not authorized to change this assignment or reject this work order.", error);
  if (code === "22023" || code === "PT422") return new AssignmentCommandError("22023", "The assignment, work-order state, or rejection reason is not eligible. Review the work order and try again.", error);
  if (code === "23505") return new AssignmentCommandError("23505", "This work order already exists. Refresh and open the existing record.", error);
  if (code === "P0002") return new AssignmentCommandError("P0002", "This work order is no longer available. Refresh the list before trying again.", error);
  if (code === "PGRST202" || code === "42883") return new AssignmentCommandError("ASSIGNMENT_UNAVAILABLE", "Assignment changes are temporarily unavailable. Refresh or contact support; no raw-write fallback is available.", error);
  if (error instanceof z.ZodError) return new AssignmentCommandError("22023", "The assignment request is incomplete. Refresh the work order and try again.", error);
  return new AssignmentCommandError("ASSIGNMENT_UNCONFIRMED", "The assignment change could not be confirmed. Retry the unchanged action or refresh and review the work order.", error);
}

function verifyResult(result: { applied: boolean; reason: string; workOrderId: string; operationId: string },
  operationId: string, workOrderId?: string) {
  if (result.operationId !== operationId || (workOrderId !== undefined && result.workOrderId !== workOrderId)
      || result.applied === (result.reason === "already_applied")) throw new Error("Invalid assignment command response");
}
function parseResponse<Output>(schema: z.ZodType<Output>, data: unknown): Output {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new AssignmentCommandError("ASSIGNMENT_UNCONFIRMED",
    "The assignment result could not be confirmed. Retry the unchanged action or reload and review the work order.", parsed.error);
  return parsed.data;
}
export function createAssignmentCommands(transport: AssignmentTransport) {
  return {
    async administrativeTransfer(input: AssignmentContext, request: unknown) {
      try {
        const context = assignmentContextSchema.parse(input);
        const payload = administrativeTransferRequestSchema.parse(request);
        const { data, error } = await transport("administrative_close_visit_and_transfer_v1", {
          ...lifecycleRpcContext(context), p_new_contractor_id: payload.contractorId,
          p_reason: payload.reason, p_confirmed: payload.confirmed,
        });
        if (error) throw error;
        const result = parseResponse(administrativeTransferResultSchema, data);
        verifyResult(result, context.operationId, context.workOrderId);
        if (result.contractorId !== payload.contractorId || result.assignmentVersion !== context.expectedAssignmentVersion + 1
            || result.workflowCycle !== context.expectedWorkflowCycle
            || result.lifecycleVersion !== context.expectedLifecycleVersion + 1) throw new Error("Invalid administrative transfer response");
        return { ...result, contractorId: result.contractorId ?? null, functionalStatus: result.functionalStatus ?? null,
          assignmentStartedAt: result.assignmentStartedAt ?? null, dispatchedAt: result.dispatchedAt ?? null,
          capitalStatus: result.capitalStatus ?? null };
      } catch (error) { throw safeAssignmentError(error); }
    },
    async transition(input: AssignmentContext, contractorId: string | null) {
      try {
        const context = assignmentContextSchema.parse(input);
        const target = z.uuid().nullable().parse(contractorId);
        const { data, error } = await transport("transition_work_order_contractor_v1", { ...lifecycleRpcContext(context), p_new_contractor_id: target });
        if (error) throw error;
        const result = parseResponse(assignmentTransitionResultSchema, data);
        verifyResult(result, context.operationId, context.workOrderId);
        if (result.contractorId !== target || result.assignmentVersion !== context.expectedAssignmentVersion + 1
            || result.workflowCycle !== context.expectedWorkflowCycle
            || result.lifecycleVersion !== context.expectedLifecycleVersion + 1) throw new Error("Invalid assignment command response");
        return { ...result, contractorId: result.contractorId ?? null, functionalStatus: result.functionalStatus ?? null,
          assignmentStartedAt: result.assignmentStartedAt ?? null, dispatchedAt: result.dispatchedAt ?? null,
          capitalStatus: result.capitalStatus ?? null };
      } catch (error) { throw safeAssignmentError(error); }
    },
    async reject(input: AssignmentContext, reason: string) {
      try {
        const context = assignmentContextSchema.parse(input);
        const parsedReason = z.string().trim().min(5).max(500).parse(reason);
        const { data, error } = await transport("reject_unassigned_work_order_v1", { ...lifecycleRpcContext(context), p_reason: parsedReason });
        if (error) throw error;
        const result = parseResponse(assignmentRejectionResultSchema, data);
        verifyResult(result, context.operationId, context.workOrderId);
        if (result.assignmentVersion !== context.expectedAssignmentVersion || result.workflowCycle !== context.expectedWorkflowCycle
            || result.lifecycleVersion !== context.expectedLifecycleVersion) throw new Error("Invalid rejection command response");
        return result;
      } catch (error) { throw safeAssignmentError(error); }
    },
    async duplicate(input: AssignmentContext) {
      try {
        const context = assignmentContextSchema.parse(input);
        const { p_work_order_id, ...args } = lifecycleRpcContext(context);
        const { data, error } = await transport("duplicate_work_order_for_reassignment_v1", { ...args, p_source_work_order_id: p_work_order_id });
        if (error) throw error;
        const result = parseResponse(assignmentDuplicateResultSchema, data);
        verifyResult(result, context.operationId);
        if (result.sourceWorkOrderId !== context.workOrderId || result.workOrderId === context.workOrderId
            || result.workOrderId !== `${result.rootWorkOrderId}-${result.duplicateSequence}`
            || result.assignmentVersion !== 0 || result.workflowCycle !== 0 || result.lifecycleVersion !== 0) throw new Error("Invalid duplication command response");
        return result;
      } catch (error) { throw safeAssignmentError(error); }
    },
    async create(operationId: string, row: Record<string, Json | undefined>) {
      try {
        z.uuid().parse(operationId);
        const workOrderId = z.string().trim().min(1).parse(row.id);
        const contractorId = z.uuid().nullable().parse(row.contractor_id ?? null);
        const { data, error } = await transport("create_work_order_with_assignment_v1", { p_operation_id: operationId, p_work_order: row });
        if (error) throw error;
        const result = parseResponse(assignmentCreationResultSchema, data);
        verifyResult(result, operationId, workOrderId);
        if (result.contractorId !== contractorId || result.assignmentVersion !== (contractorId === null ? 0 : 1)
            || result.workflowCycle !== 0 || result.lifecycleVersion !== 0
            || (contractorId !== null && result.activityId === null)) throw new Error("Invalid creation command response");
        return result;
      } catch (error) { throw safeAssignmentError(error); }
    },
  };
}

// Per mounted hook. No automatic transport retry. An uncertain outcome keeps
// its captured UUID, versions and payload until the caller reconciles/remounts.
export function createAssignmentAttempts() {
  const attempts = new Map<string, { fingerprint: string; context: AssignmentContext; active: boolean }>();
  return {
    async run<Result>(workOrder: unknown, family: string, payload: unknown,
      execute: (context: AssignmentContext) => Promise<Result>): Promise<Result> {
      const candidate = lifecycleContextFor(workOrder);
      const prior = attempts.get(candidate.workOrderId);
      const fingerprint = JSON.stringify([family, payload, candidate.expectedAssignmentVersion, candidate.expectedWorkflowCycle, candidate.expectedLifecycleVersion]);
      if (prior?.active) throw new AssignmentCommandError("ASSIGNMENT_BUSY", "An assignment change is already in progress.");
      if (prior && prior.fingerprint !== fingerprint) throw new AssignmentCommandError("PT409", "An earlier assignment change is unconfirmed. Retry it unchanged, or reload the page and review the work order before choosing another action.");
      const attempt = prior ?? { fingerprint, context: candidate, active: false };
      attempts.set(candidate.workOrderId, attempt);
      attempt.active = true;
      try {
        const result = await execute(attempt.context);
        attempts.delete(candidate.workOrderId);
        return result;
      } catch (error) {
        const safe = safeAssignmentError(error);
        if (["PT409", "42501", "22023", "23505", "P0002", "ASSIGNMENT_UNAVAILABLE", "active_visit_requires_checkout"].includes(safe.code)) attempts.delete(candidate.workOrderId);
        throw safe;
      } finally { attempt.active = false; }
    },
  };
}
