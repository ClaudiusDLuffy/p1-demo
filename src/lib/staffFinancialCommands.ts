import { z } from "zod";
import type { Json } from "./supabase/database.types";
import type { LifecycleServerDatabase } from "./workOrderLifecycleContracts";
import type { ContractorInvoiceFunctions } from "./contractorInvoiceCommandContracts";
import { FinancialRequestError } from "./financialHttpBoundary";
import { staffInvoiceRpcPayload, type FinancialDeleteCommand, type StaffInvoiceSaveCommand } from "./staffInvoiceContracts";

type SaveArgs = {
  p_actor_id: string; p_work_order_id: string | null; p_expected_assignment_version: number | null;
  p_expected_workflow_cycle: number | null; p_invoice_id: string | null;
  p_expected_invoice_version: number | null; p_operation_id: string; p_payload: Json;
};
type DeleteArgs = {
  p_actor_id: string; p_invoice_id: string; p_invoice_type: "staff" | "contractor";
  p_expected_invoice_version: number; p_operation_id: string;
  p_expected_assignment_version: number | null; p_expected_workflow_cycle: number | null; p_reason: string | null;
};
type CommandResponse = { data: unknown; error: unknown };
export type StaffFinancialRpcQuery = PromiseLike<CommandResponse> & {
  abortSignal(signal: AbortSignal): PromiseLike<CommandResponse>;
};
/** Narrow command transport implemented by the authorized server client. */
export interface StaffFinancialCommandClient {
  rpc(name: "save_staff_billing_invoice_v4", args: SaveArgs): StaffFinancialRpcQuery;
  rpc(name: "delete_invoice_admin_v1", args: DeleteArgs): StaffFinancialRpcQuery;
  rpc(name: "mark_staff_invoice_ready" | "mark_staff_invoice_billed",
    args: { p_invoice_id: string; p_actor_id: string }): StaffFinancialRpcQuery;
}
export type StaffFinancialCommandOptions = { signal?: AbortSignal | null };

/** Use only after UUID validation. PostgreSQL uuid identity is case-insensitive;
 * relational work-order TEXT and the dispatched payload remain untouched. */
export function matchesFinancialUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
const commandResponse = z.object({
  data: z.unknown(),
  error: z.union([z.null(), z.object({ code: z.string(), message: z.string() })]),
});

/** SDK envelopes are also untrusted at injected/network boundaries. Falsy
 * non-null errors are malformed, not evidence of successful execution. */
export function parseStaffFinancialRpcResponse(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !Object.hasOwn(value, "data") || !Object.hasOwn(value, "error")) {
    throw new FinancialRequestError("FINANCIAL_RESULT_INVALID", "The billing command response could not be verified", 500);
  }
  const parsed = commandResponse.safeParse(value);
  if (!parsed.success || (parsed.data.error !== null && parsed.data.data !== null)) {
    throw new FinancialRequestError("FINANCIAL_RESULT_INVALID", "The billing command response could not be verified", 500);
  }
  return parsed.data;
}
export type StaffFinancialDatabase = Omit<LifecycleServerDatabase, "public"> & {
  public: Omit<LifecycleServerDatabase["public"], "Functions"> & {
    Functions: LifecycleServerDatabase["public"]["Functions"] & ContractorInvoiceFunctions & {
      save_staff_billing_invoice_v4: { Args: SaveArgs; Returns: Json };
      delete_invoice_admin_v1: { Args: DeleteArgs; Returns: Json };
    };
  };
};
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money = z.number().finite().nonnegative().max(99_999_999.99)
  .refine(value => /^\d+(?:\.\d{1,2})?$/.test(String(value)), "Money must have at most two decimal places");
const identity = {
  applied: z.boolean(), reason: z.enum(["applied", "already_applied"]),
  operationId: z.string().uuid(), invoiceId: z.string().uuid(), invoiceVersion: version,
  // Shared receipts include deletion of legacy stored numbers. Preserve the
  // established result contract; strict new-number limits belong to input/SQL.
  invoiceNum: z.string().min(1), workOrderId: z.string().nullable(),
  assignmentVersion: version.nullable(), workflowCycle: version.nullable(),
};
const saveResult = z.object({ ...identity, state: z.enum(["draft", "submitted"]),
  subtotal: money, salesTax: money, total: money, lineCount: version.min(1).max(1000), sourceInvoiceCount: version.max(100),
  activityId: z.string().uuid().nullable(),
}).refine(result => result.applied === (result.reason === "applied"));
const deleteResult = z.object({ ...identity, deletedAt: z.string().datetime({ offset: true }),
  invoiceType: z.enum(["staff", "contractor"]), activityId: z.string().uuid().nullable(),
}).refine(result => result.applied === (result.reason === "applied")
  && (result.activityId === null) === (result.workOrderId === null));

export async function saveStaffFinancialCommand(
  sb: StaffFinancialCommandClient, actorId: string, invoiceId: string | null, command: StaffInvoiceSaveCommand,
  options: StaffFinancialCommandOptions = {},
) {
  if ((invoiceId === null) !== (command.expectedInvoiceVersion === null)) {
    throw new FinancialRequestError("FINANCIAL_VALIDATION_FAILED", "An edit requires the invoice version captured when it was opened", 422);
  }
  options.signal?.throwIfAborted();
  const query = sb.rpc("save_staff_billing_invoice_v4", {
    p_actor_id: actorId, p_work_order_id: command.workOrderId,
    p_expected_assignment_version: command.expectedAssignmentVersion,
    p_expected_workflow_cycle: command.expectedWorkflowCycle, p_invoice_id: invoiceId,
    p_expected_invoice_version: command.expectedInvoiceVersion, p_operation_id: command.operationId,
    p_payload: staffInvoiceRpcPayload(command),
  });
  const { data, error } = parseStaffFinancialRpcResponse(await (options.signal ? query.abortSignal(options.signal) : query));
  if (error) throw error;
  const parsed = saveResult.safeParse(data);
  if (!parsed.success || !matchesFinancialUuid(parsed.data.operationId, command.operationId)
    || parsed.data.workOrderId !== command.workOrderId || (invoiceId !== null && !matchesFinancialUuid(parsed.data.invoiceId, invoiceId))
    || parsed.data.state !== command.state || parsed.data.assignmentVersion !== command.expectedAssignmentVersion
    || parsed.data.workflowCycle !== command.expectedWorkflowCycle
    || parsed.data.sourceInvoiceCount !== command.sourceInvoiceIds.length
    || parsed.data.lineCount < command.lines.length
    || (parsed.data.activityId === null) !== (command.workOrderId === null)
    || parsed.data.invoiceVersion <= (command.expectedInvoiceVersion ?? 0)) {
    throw new FinancialRequestError("FINANCIAL_RESULT_INVALID", "The save result could not be verified. Check the invoice before retrying", 500);
  }
  return { ...parsed.data, workOrderId: parsed.data.workOrderId ?? null,
    assignmentVersion: parsed.data.assignmentVersion ?? null, workflowCycle: parsed.data.workflowCycle ?? null };
}

export async function deleteFinancialCommand(
  sb: StaffFinancialCommandClient, actorId: string, invoiceId: string,
  invoiceType: "staff" | "contractor", command: FinancialDeleteCommand,
  options: StaffFinancialCommandOptions = {},
) {
  options.signal?.throwIfAborted();
  const query = sb.rpc("delete_invoice_admin_v1", {
    p_actor_id: actorId, p_invoice_id: invoiceId, p_invoice_type: invoiceType,
    p_expected_invoice_version: command.expectedInvoiceVersion, p_operation_id: command.operationId,
    p_expected_assignment_version: command.expectedAssignmentVersion,
    p_expected_workflow_cycle: command.expectedWorkflowCycle, p_reason: command.reason,
  });
  const { data, error } = parseStaffFinancialRpcResponse(await (options.signal ? query.abortSignal(options.signal) : query));
  if (error) throw error;
  const parsed = deleteResult.safeParse(data);
  if (!parsed.success || !matchesFinancialUuid(parsed.data.invoiceId, invoiceId)
    || !matchesFinancialUuid(parsed.data.operationId, command.operationId) || parsed.data.invoiceType !== invoiceType
    || parsed.data.assignmentVersion !== command.expectedAssignmentVersion || parsed.data.workflowCycle !== command.expectedWorkflowCycle
    || (parsed.data.workOrderId === null) !== (command.expectedAssignmentVersion === null && command.expectedWorkflowCycle === null)
    || parsed.data.invoiceVersion <= command.expectedInvoiceVersion) {
    throw new FinancialRequestError("FINANCIAL_RESULT_INVALID", "The delete result could not be verified. Check the invoice before retrying", 500);
  }
  // Validate transaction-owned evidence internally while preserving DELETE's
  // established public receipt, which did not expose activityId.
  const result = parsed.data;
  return { applied: result.applied, reason: result.reason, operationId: result.operationId,
    invoiceId: result.invoiceId, invoiceVersion: result.invoiceVersion, invoiceNum: result.invoiceNum,
    workOrderId: result.workOrderId ?? null, assignmentVersion: result.assignmentVersion ?? null,
    workflowCycle: result.workflowCycle ?? null, deletedAt: result.deletedAt, invoiceType: result.invoiceType };
}
