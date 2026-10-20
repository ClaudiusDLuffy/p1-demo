import { z } from "zod";
import type { Database } from "../../lib/supabase/database.types";

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money = z.number().finite().min(0).max(99999999.99).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001);
export const priorInvoiceFieldsSchema = z.object({
  num: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/u),
  invoiceDate: z.iso.date(), total: money.refine(value => value > 0), salesTax: money,
  note: z.string().trim().min(5).max(1000),
}).refine(value => value.salesTax <= value.total);
export type PriorInvoiceFields = z.infer<typeof priorInvoiceFieldsSchema>;
export const priorInvoiceContextSchema = z.object({
  workOrderId: z.string().min(1), assignmentVersion: version, workflowCycle: version,
  assignments: z.array(z.object({ id: z.uuid(), contractorId: z.uuid(), contractorName: z.string().nullable(),
    assignmentVersion: version, startedAt: z.string().nullable(), endedAt: z.string() })).max(100),
  drafts: z.array(z.object({ id: z.uuid(), assignmentId: z.uuid(), num: z.string(), invoiceDate: z.iso.date(),
    total: money, salesTax: money, note: z.string(), state: z.enum(["draft", "rejected"]), invoiceVersion: version, hasPdf: z.boolean() })).max(100),
});
export type PriorInvoiceContext = z.infer<typeof priorInvoiceContextSchema>;
export const priorInvoiceReceiptSchema = z.object({
  invoiceId: z.uuid(), invoiceNum: z.string(), workOrderId: z.string(), assignmentId: z.uuid(),
  assignmentVersion: version, workflowCycle: version, invoiceVersion: version, total: money,
  state: z.enum(["draft", "rejected", "submitted", "revised"]), operationId: z.uuid(), applied: z.boolean(), activityId: z.uuid(),
});
export type PriorInvoiceReceipt = z.infer<typeof priorInvoiceReceiptSchema>;
type Functions = Database["public"]["Functions"];
type CommandName = "save_prior_contractor_invoice_v1" | "submit_prior_contractor_invoice_v1";
type Transport = <Name extends CommandName>(name: Name, args: Functions[Name]["Args"])
  => PromiseLike<{ data: unknown; error: unknown }>;
export class PriorInvoiceError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message); }
}
export function priorInvoiceError(cause: unknown): PriorInvoiceError {
  if (cause instanceof PriorInvoiceError) return cause;
  if (cause instanceof z.ZodError) return new PriorInvoiceError("Enter the invoice number, valid date, actual total and tax, and a note of 5–1,000 characters.");
  const parsed = z.object({ code: z.string().optional() }).safeParse(cause);
  const code = parsed.success ? parsed.data.code : "";
  if (code === "42501") return new PriorInvoiceError("Only active operational P1 staff can record prior contractor invoices.");
  if (code === "23505") return new PriorInvoiceError("That invoice number already exists for this contractor. Review the existing bill instead of uploading it again.");
  if (["PT409", "40001"].includes(code || "")) return new PriorInvoiceError("The invoice or assignment changed. Close and reopen this form to review the current record.");
  if (["22023", "23514", "22007", "22008"].includes(code || "")) return new PriorInvoiceError("Check the past assignment, invoice date, amount and tax. A verified original PDF is required before review.");
  if (code === "PGRST202") return new PriorInvoiceError("The prior-contractor invoice database update is not installed yet.");
  if (code === "P0002") return new PriorInvoiceError("This work order or prior invoice is no longer available. Refresh and review its history.");
  return new PriorInvoiceError("The save could not be confirmed. Retry the same unchanged request; do not create another bill.", true);
}
export function createPriorInvoiceDraftAttempt(context: PriorInvoiceContext, assignmentId: string, fields: PriorInvoiceFields,
  existing: { id: string; invoiceVersion: number } | null = null, operationId = crypto.randomUUID()) {
  const c = priorInvoiceContextSchema.parse(context); const payload = priorInvoiceFieldsSchema.parse(fields);
  if (!c.assignments.some(assignment => assignment.id === assignmentId)) throw new PriorInvoiceError("Select a recorded past assignment on this work order.");
  const args: Functions["save_prior_contractor_invoice_v1"]["Args"] = { p_work_order_id: c.workOrderId,
    p_expected_assignment_version: c.assignmentVersion, p_expected_workflow_cycle: c.workflowCycle,
    p_assignment_id: assignmentId, p_invoice_id: existing?.id ?? null, p_expected_invoice_version: existing?.invoiceVersion ?? null,
    p_operation_id: operationId, p_payload: payload };
  return async (transport: Transport) => {
    try {
      const { data, error } = await transport("save_prior_contractor_invoice_v1", args); if (error) throw error;
      const parsed = priorInvoiceReceiptSchema.safeParse(data);
      if (!parsed.success) throw new PriorInvoiceError("The save response could not be verified. Retry the same request.", true);
      const result = parsed.data;
      if (result.operationId !== operationId || result.workOrderId !== c.workOrderId || result.assignmentId !== assignmentId
        || result.assignmentVersion !== c.assignmentVersion || result.workflowCycle !== c.workflowCycle
        || result.invoiceNum !== payload.num || result.total !== payload.total || !["draft", "rejected"].includes(result.state)
        || (existing && (result.invoiceId !== existing.id || result.invoiceVersion <= existing.invoiceVersion))) {
        throw new PriorInvoiceError("The save response did not match this invoice. Retry the same request.", true);
      }
      return result;
    } catch (cause) { throw priorInvoiceError(cause); }
  };
}
export function createPriorInvoiceSubmitAttempt(context: PriorInvoiceContext, invoice: { id: string; invoiceVersion: number },
  operationId = crypto.randomUUID()) {
  const c = priorInvoiceContextSchema.parse(context);
  const args = { p_invoice_id: invoice.id, p_expected_invoice_version: invoice.invoiceVersion,
    p_expected_assignment_version: c.assignmentVersion, p_expected_workflow_cycle: c.workflowCycle, p_operation_id: operationId };
  return async (transport: Transport) => {
    try {
      const { data, error } = await transport("submit_prior_contractor_invoice_v1", args); if (error) throw error;
      const parsed = priorInvoiceReceiptSchema.safeParse(data);
      if (!parsed.success) throw new PriorInvoiceError("The submission response could not be verified. Retry the same request.", true);
      const result = parsed.data;
      if (result.operationId !== operationId || result.invoiceId !== invoice.id || result.workOrderId !== c.workOrderId
        || result.assignmentVersion !== c.assignmentVersion || result.workflowCycle !== c.workflowCycle
        || result.invoiceVersion <= invoice.invoiceVersion || !["submitted", "revised"].includes(result.state)) {
        throw new PriorInvoiceError("The submission could not be verified. Retry the same request.", true);
      }
      return result;
    } catch (cause) { throw priorInvoiceError(cause); }
  };
}
