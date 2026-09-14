import { z } from "zod";
import {
  contractorInvoiceContextSchema, contractorInvoicePayloadSchema, contractorInvoiceResultSchema,
  contractorInvoiceSnapshotSchema, type ContractorInvoiceContext, type ContractorInvoiceFunctions,
  type ContractorInvoiceIntent, type ContractorInvoicePayload, type ContractorInvoiceSnapshot,
} from "./contractorInvoiceCommandContracts";

export type ContractorInvoiceTransport = <Name extends keyof ContractorInvoiceFunctions>(
  name: Name, args: ContractorInvoiceFunctions[Name]["Args"],
) => PromiseLike<{ data: unknown; error: unknown }>;

export class ContractorInvoiceCommandError extends Error {
  constructor(public readonly code: string, message: string, cause?: unknown) {
    super(message, { cause }); this.name = "ContractorInvoiceCommandError";
  }
}
export function safeContractorInvoiceError(cause: unknown): ContractorInvoiceCommandError {
  if (cause instanceof ContractorInvoiceCommandError) return cause;
  const parsed = z.object({ code: z.string().optional() }).safeParse(cause);
  const code = parsed.success ? parsed.data.code : undefined;
  if (code === "PT409" || code === "40001") return new ContractorInvoiceCommandError("PT409",
    "Invoice changed in another session. Refresh and review it before trying again.", cause);
  if (code === "23505") return new ContractorInvoiceCommandError("INVOICE_NUM_CONFLICT",
    "That invoice number already exists for this contractor.", cause);
  if (code === "42501") return new ContractorInvoiceCommandError(code,
    "You no longer have permission to change this invoice. Refresh the work order.", cause);
  if (code === "22023" || cause instanceof z.ZodError) return new ContractorInvoiceCommandError("22023",
    "Check the invoice dates, line items, tax, and total, then try again.", cause);
  return new ContractorInvoiceCommandError("INVOICE_COMMAND_UNCONFIRMED",
    "The invoice change could not be confirmed. Retry the same unchanged action or refresh and review the invoice before making another change.", cause);
}

export function contractorInvoiceSnapshotFor(workOrder: unknown, invoice: unknown = null): ContractorInvoiceSnapshot {
  const work = z.object({ id: z.string(), contractorAssignmentVersion: z.number(), workflowCycle: z.number() }).safeParse(workOrder);
  const existing = invoice == null ? null : z.object({ id: z.uuid(), invoiceVersion: z.number() }).safeParse(invoice);
  if (!work.success || (existing && !existing.success)) throw new ContractorInvoiceCommandError("PT409",
    "Refresh the work order and reopen this invoice form. Its current version is unavailable.");
  return contractorInvoiceSnapshotSchema.parse({
    workOrderId: work.data.id, expectedAssignmentVersion: work.data.contractorAssignmentVersion,
    expectedWorkflowCycle: work.data.workflowCycle,
    invoiceId: existing?.success ? existing.data.id : null,
    expectedInvoiceVersion: existing?.success ? existing.data.invoiceVersion : null,
  });
}

export function createContractorInvoiceCommands(transport: ContractorInvoiceTransport) {
  return {
    async save(intent: ContractorInvoiceIntent, inputContext: ContractorInvoiceContext, input: ContractorInvoicePayload) {
      try {
        const context = contractorInvoiceContextSchema.parse(inputContext);
        const payload = contractorInvoicePayloadSchema.parse(input);
        if (intent !== "draft") {
          if (payload.mode === "line_items" && (payload.lines.length === 0 || payload.lines.some(line =>
            line.qty <= 0 || (!line.description.trim() && !/^(travel|truck charge)$/i.test(line.type))))) {
            throw new z.ZodError([]);
          }
          if (payload.mode === "manual_pdf_total" && payload.totalOverride <= 0) throw new z.ZodError([]);
        }
        if (intent === "revise" && context.invoiceId === null) throw new z.ZodError([]);
        const name = intent === "draft" ? "save_contractor_invoice_draft_v1"
          : intent === "revise" ? "revise_contractor_invoice_v1" : "submit_contractor_invoice_v1";
        const { data, error } = await transport(name, {
          p_work_order_id: context.workOrderId, p_expected_assignment_version: context.expectedAssignmentVersion,
          p_expected_workflow_cycle: context.expectedWorkflowCycle, p_invoice_id: context.invoiceId,
          p_expected_invoice_version: context.expectedInvoiceVersion, p_operation_id: context.operationId, p_payload: payload,
        });
        if (error) throw error;
        const response = contractorInvoiceResultSchema.safeParse(data);
        if (!response.success) throw new ContractorInvoiceCommandError("INVOICE_COMMAND_UNCONFIRMED",
          "The invoice response could not be verified. Retry the unchanged action or refresh and review the invoice.", response.error);
        const result = response.data;
        if (result.workOrderId !== context.workOrderId || result.operationId !== context.operationId
          || (context.invoiceId !== null && result.invoiceId !== context.invoiceId)
          || result.assignmentVersion !== context.expectedAssignmentVersion || result.workflowCycle !== context.expectedWorkflowCycle
          || result.state !== (intent === "draft" ? "draft" : intent === "revise" ? "revised" : "submitted")
          || (context.expectedInvoiceVersion !== null && result.invoiceVersion <= context.expectedInvoiceVersion)) {
          throw new ContractorInvoiceCommandError("INVOICE_COMMAND_UNCONFIRMED", "The invoice response could not be verified. Refresh and review the invoice.");
        }
        return result;
      } catch (error) { throw safeContractorInvoiceError(error); }
    },
    async deleteOwn(input: ContractorInvoiceContext) {
      try {
        const request = contractorInvoiceContextSchema.parse(input);
        if (request.invoiceId === null || request.expectedInvoiceVersion === null) throw new z.ZodError([]);
        const { data, error } = await transport("delete_own_contractor_invoice_v1", {
          p_invoice_id: request.invoiceId, p_expected_invoice_version: request.expectedInvoiceVersion, p_operation_id: request.operationId,
          p_work_order_id: request.workOrderId, p_expected_assignment_version: request.expectedAssignmentVersion,
          p_expected_workflow_cycle: request.expectedWorkflowCycle,
        });
        if (error) throw error;
        const response = z.object({ invoiceId: z.uuid(), operationId: z.uuid(), deletedAt: z.string().min(1),
          workOrderId: z.string().min(1), assignmentVersion: z.number().int().nonnegative(),
          workflowCycle: z.number().int().nonnegative(), invoiceVersion: z.number().int().nonnegative(),
        }).safeParse(data);
        if (!response.success) throw new ContractorInvoiceCommandError("INVOICE_COMMAND_UNCONFIRMED",
          "The deletion response could not be verified. Retry the unchanged action or refresh and review the invoice.", response.error);
        const result = response.data;
        if (result.invoiceId !== request.invoiceId || result.operationId !== request.operationId
          || result.workOrderId !== request.workOrderId || result.assignmentVersion !== request.expectedAssignmentVersion
          || result.workflowCycle !== request.expectedWorkflowCycle || result.invoiceVersion <= request.expectedInvoiceVersion) {
          throw new ContractorInvoiceCommandError("INVOICE_COMMAND_UNCONFIRMED", "The deletion response could not be verified. Refresh and review the invoice.");
        }
        return result;
      } catch (error) { throw safeContractorInvoiceError(error); }
    },
  };
}
