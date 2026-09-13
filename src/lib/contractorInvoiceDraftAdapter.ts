import { z } from "zod";
import { contractorInvoiceContextSchema, contractorInvoicePayloadSchema, type ContractorInvoiceResult } from "./contractorInvoiceCommandContracts";
import { ContractorInvoiceCommandError } from "./contractorInvoiceCommands";

const legacyHeader = z.object({
  num: z.string().trim().min(1), userTypedNum: z.boolean().optional(), cme: z.string().nullable().optional(),
  invoiceDate: z.string().nullable().optional(), serviceDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(), terms: z.string().nullable().optional(),
  storeAddr: z.string().nullable().optional(), state: z.enum(["draft", "submitted"]).optional(),
  salesTax: z.union([z.number(), z.string()]).optional(), tax: z.union([z.number(), z.string()]).optional(),
  totalOverride: z.number().optional().nullable(), pdfStoragePath: z.string().nullable().optional(),
  commandContext: contractorInvoiceContextSchema,
});
const legacyLine = z.object({ type: z.string(), desc: z.string().optional(), description: z.string().optional(), qty: z.number(), rate: z.number() });

export function contractorInvoiceDraftCommand(headerInput: unknown, lineInput: unknown, expectedInvoiceId: string | null) {
  const header = legacyHeader.parse(headerInput);
  if (header.commandContext.invoiceId !== expectedInvoiceId) throw new ContractorInvoiceCommandError("PT409",
    "Reopen this invoice form before saving. The selected invoice changed.");
  const taxInput = header.salesTax ?? header.tax ?? 0;
  // HTML tax fields are text; the transport itself receives only a finite JSON
  // number. Never accept parseFloat prefixes such as "5wrong".
  const tax = typeof taxInput === "string" && taxInput.trim() === "" ? 0 : Number(taxInput);
  const mode = header.totalOverride == null ? "line_items" : "manual_pdf_total";
  const payload = contractorInvoicePayloadSchema.parse({
    num: header.num, userTypedNum: header.userTypedNum ?? false, cme: header.cme || null,
    storeAddress: header.storeAddr || null, invoiceDate: header.invoiceDate || null,
    serviceDate: header.serviceDate || null, dueDate: header.dueDate || null, terms: header.terms || null,
    mode, salesTax: tax, totalOverride: header.totalOverride ?? null,
    lines: z.array(legacyLine).parse(lineInput).map(line => ({
      type: line.type, description: line.desc ?? line.description ?? "", qty: line.qty, rate: line.rate,
    })), pdfStoragePath: header.pdfStoragePath || null,
  });
  return { context: header.commandContext, payload, intent: header.state === "draft" ? "draft" as const : "submit" as const };
}

export function compatibleContractorInvoiceResult(result: ContractorInvoiceResult, requestedNum: string) {
  const collidedFrom = result.invoiceNum !== requestedNum ? requestedNum : null;
  return { ...result, id: result.invoiceId, num: result.invoiceNum,
    collidedFrom, _collidedFrom: collidedFrom };
}

export function invoiceDeletionSnapshotFor(input: unknown, operationId: string) {
  const source = z.object({ id: z.uuid(), wot: z.string().nullable().optional(), invoiceVersion: z.number().int().nonnegative(),
    contractorAssignmentVersion: z.number().int().nonnegative().nullable().optional(),
    workflowCycle: z.number().int().nonnegative().nullable().optional(),
  }).safeParse(input);
  if (!source.success) throw new ContractorInvoiceCommandError("PT409", "Refresh the invoice before deleting it. Its current version is unavailable.");
  return { workOrderId: source.data.wot || null, invoiceId: source.data.id,
    expectedInvoiceVersion: source.data.invoiceVersion,
    expectedAssignmentVersion: source.data.contractorAssignmentVersion ?? null,
    expectedWorkflowCycle: source.data.workflowCycle ?? null, operationId: z.uuid().parse(operationId) };
}
export type InvoiceDeletionSnapshot = ReturnType<typeof invoiceDeletionSnapshotFor>;
