import { z } from "zod";
import type { Json } from "./supabase/database.types";
import type { LifecycleDatabase } from "./workOrderLifecycleContracts";
import type { WorkOrderBillingFunctions } from "./workOrderBillingCommands";

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money = z.number().finite().nonnegative();
export const contractorInvoiceSnapshotSchema = z.object({
  workOrderId: z.string().trim().min(1), expectedAssignmentVersion: version,
  expectedWorkflowCycle: version, invoiceId: z.uuid().nullable(), expectedInvoiceVersion: version.nullable(),
}).strict().refine(value => (value.invoiceId === null) === (value.expectedInvoiceVersion === null),
  "Existing invoices require their captured version");
export type ContractorInvoiceSnapshot = z.infer<typeof contractorInvoiceSnapshotSchema>;
export const contractorInvoiceContextSchema = contractorInvoiceSnapshotSchema.safeExtend({ operationId: z.uuid() });
export type ContractorInvoiceContext = z.infer<typeof contractorInvoiceContextSchema>;

export const contractorInvoiceLineSchema = z.object({
  type: z.string().trim().min(1), description: z.string(), qty: money, rate: money,
}).strict();
const content = {
  num: z.string().trim().min(1), userTypedNum: z.boolean(), cme: z.string().nullable(),
  storeAddress: z.string().nullable(), invoiceDate: z.iso.date().nullable(), serviceDate: z.iso.date().nullable(),
  dueDate: z.iso.date().nullable(), terms: z.string().nullable(), salesTax: money,
  lines: z.array(contractorInvoiceLineSchema), pdfStoragePath: z.string().min(1).nullable(),
};
export const contractorInvoicePayloadSchema = z.discriminatedUnion("mode", [
  z.object({ ...content, mode: z.literal("line_items"), totalOverride: z.null() }).strict(),
  z.object({ ...content, mode: z.literal("manual_pdf_total"), totalOverride: money }).strict(),
]);
export type ContractorInvoicePayload = z.infer<typeof contractorInvoicePayloadSchema>;
export type ContractorInvoiceIntent = "draft" | "submit" | "revise";
export const contractorInvoiceResultSchema = z.object({
  applied: z.boolean(), reason: z.enum(["applied", "already_applied"]), invoiceId: z.uuid(),
  invoiceNum: z.string().min(1), workOrderId: z.string().min(1), operationId: z.uuid(),
  assignmentVersion: version, workflowCycle: version, invoiceVersion: version,
  state: z.enum(["draft", "submitted", "revised", "rejected", "approved", "paid"]),
  subtotal: money, salesTax: money, total: money, collidedFrom: z.string().nullable().optional(),
}).refine(result => result.applied === (result.reason === "applied"), "Inconsistent command outcome");
export type ContractorInvoiceResult = z.infer<typeof contractorInvoiceResultSchema>;

export type ContractorInvoiceArgs = {
  p_work_order_id: string; p_expected_assignment_version: number; p_expected_workflow_cycle: number;
  p_invoice_id: string | null; p_expected_invoice_version: number | null; p_operation_id: string; p_payload: Json;
};
type Routine<Args> = { Args: Args; Returns: Json };
export type ContractorInvoiceFunctions = {
  save_contractor_invoice_draft_v1: Routine<ContractorInvoiceArgs>;
  submit_contractor_invoice_v1: Routine<ContractorInvoiceArgs>;
  revise_contractor_invoice_v1: Routine<ContractorInvoiceArgs>;
  delete_own_contractor_invoice_v1: Routine<Omit<ContractorInvoiceArgs, "p_payload">>;
};
// Extend the existing generated/lifecycle contract, without regenerating or
// weakening either baseline. Remove only after approved schema type generation.
export type FinancialDatabase = Omit<LifecycleDatabase, "public"> & {
  public: Omit<LifecycleDatabase["public"], "Functions"> & {
    Functions: LifecycleDatabase["public"]["Functions"] & ContractorInvoiceFunctions & WorkOrderBillingFunctions;
  };
};
