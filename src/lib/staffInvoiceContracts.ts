import { z } from "zod";
import { QUICKBOOKS_EQUIPMENT_TAGS } from "./quickBooksEquipmentTags";
import { isValidStaffBillingRate, normalizeStaffBillingLineType } from "./staffBilling";

export const FINANCIAL_BODY_BYTES = 256 * 1024;
export const FINANCIAL_MAX_LINES = 1000;
export const FINANCIAL_MAX_SOURCES = 100;

// Count decimal places without a floating-point monetary calculation.
function decimalScale(value: number): number {
  const [coefficient, exponent = "0"] = value.toString().toLowerCase().split("e");
  return Math.max(0, (coefficient.split(".")[1]?.length || 0) - parseInt(exponent, 10));
}
const decimal = (maximum: number, scale: number) => z.number().finite().min(0).max(maximum)
  .refine(value => decimalScale(value) <= scale, `At most ${scale} decimal places are allowed`);
const money = decimal(99_999_999.99, 2);
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = (max: number) => z.string().trim().max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Control characters are not allowed");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Date is invalid");
const optionalDate = z.union([date, z.literal(""), z.null()]).optional()
  .transform(value => value || null);
const optionalText = (max: number) => text(max).nullable().optional().transform(value => value || null);
const optionalUuid = z.string().uuid().nullable().optional().transform(value => value ?? null);

/**
 * The untransformed staff line contract is shared with the editor so values
 * that pass its visible form validation cannot be rejected immediately by the
 * command boundary for different precision, length, or source-ID rules.
 */
export const StaffFinancialLineInputSchema = z.object({
  type: text(80).min(1), desc: text(4000).optional(), description: text(4000).optional(),
  qty: money.refine(value => value > 0, "Quantity must be positive"),
  rate: money,
  isTaxable: z.boolean().default(false),
  // Explicit UI-only field; never authorizes or changes persisted tax policy.
  taxTreatmentManual: z.boolean().optional(),
  sourceInvoiceLineId: optionalUuid, sourceWorkOrderPartId: optionalUuid,
  sourceUnitCost: money.nullable().optional().transform(value => value ?? null),
  markupPercent: decimal(999, 1).nullable().optional().transform(value => value ?? null),
}).strict().superRefine((line, context) => {
  if (!isValidStaffBillingRate(line.type, line.rate)) {
    context.addIssue({ code: "custom", path: ["rate"], message: "A zero rate is allowed only for Warranty" });
  }
  if (line.desc !== undefined && line.description !== undefined && line.desc !== line.description) {
    context.addIssue({ code: "custom", path: ["description"], message: "Conflicting descriptions" });
  }
  if (!(line.desc || line.description) && !/^(travel|truck charge)$/i.test(line.type)) {
    context.addIssue({ code: "custom", path: ["desc"], message: "Description is required" });
  }
  if (line.sourceInvoiceLineId && line.sourceWorkOrderPartId) {
    context.addIssue({ code: "custom", path: ["sourceWorkOrderPartId"], message: "A line cannot have two source owners" });
  }
});

export const StaffFinancialLineSchema = StaffFinancialLineInputSchema.transform(line => ({
  type: normalizeStaffBillingLineType(line.type), description: line.desc ?? line.description ?? "",
  qty: line.qty, rate: line.rate, isTaxable: line.isTaxable,
  sourceInvoiceLineId: line.sourceInvoiceLineId, sourceWorkOrderPartId: line.sourceWorkOrderPartId,
  sourceUnitCost: line.sourceUnitCost, markupPercent: line.markupPercent,
}));

const commandIdentity = {
  operationId: z.string().uuid(), expectedInvoiceVersion: version.nullable(),
  expectedAssignmentVersion: version.nullable(), expectedWorkflowCycle: version.nullable(),
};
export const StaffInvoiceSaveSchema = z.object({
  ...commandIdentity,
  num: text(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Invoice number is invalid").default(""), userTypedNum: z.boolean().default(false),
  workOrderId: optionalText(120), storeNumber: text(80).min(1), storeAddress: optionalText(1000),
  cme: optionalText(200), invoiceDate: date, serviceDate: optionalDate, dueDate: optionalDate,
  terms: text(200).min(1), state: z.enum(["draft", "submitted"]),
  territory: text(200).min(1), equipmentTag: z.enum(QUICKBOOKS_EQUIPMENT_TAGS),
  taxState: z.union([z.string().regex(/^[A-Z]{2}$/), z.literal(""), z.null()]).optional().transform(value => value || null),
  salesTaxOverride: money.nullable().optional().transform(value => value ?? null),
  taxRateOverride: decimal(100, 6).nullable().optional().transform(value => value ?? null),
  lines: z.array(StaffFinancialLineSchema).min(1).max(FINANCIAL_MAX_LINES),
  sourceInvoiceIds: z.array(z.string().uuid()).max(FINANCIAL_MAX_SOURCES).default([]).transform(ids => [...ids].sort()),
}).strict().superRefine((command, context) => {
  if (command.userTypedNum && !command.num) context.addIssue({ code: "custom", path: ["num"], message: "Invoice number is required" });
  if (Boolean(command.workOrderId) !== (command.expectedAssignmentVersion !== null && command.expectedWorkflowCycle !== null)) {
    context.addIssue({ code: "custom", path: ["expectedAssignmentVersion"], message: "Work-order version snapshot is required for a linked invoice" });
  }
  if (!command.workOrderId && (command.expectedAssignmentVersion !== null || command.expectedWorkflowCycle !== null || command.sourceInvoiceIds.length)) {
    context.addIssue({ code: "custom", path: ["workOrderId"], message: "Source invoices and work-order versions require a linked work order" });
  }
  if (new Set(command.sourceInvoiceIds).size !== command.sourceInvoiceIds.length) {
    context.addIssue({ code: "custom", path: ["sourceInvoiceIds"], message: "Duplicate sources are not allowed" });
  }
  for (const key of ["sourceInvoiceLineId", "sourceWorkOrderPartId"] as const) {
    const references = command.lines.flatMap(line => line[key] ? [line[key]] : []);
    if (new Set(references).size !== references.length) context.addIssue({ code: "custom", path: ["lines"], message: "Duplicate source line references are not allowed" });
  }
});
export type StaffInvoiceSaveCommand = z.infer<typeof StaffInvoiceSaveSchema>;
export const StaffInvoiceActionSchema = z.object({ action: z.enum(["mark_ready", "mark_billed"]) }).strict();
export const StaffInvoicePatchSchema = z.union([StaffInvoiceActionSchema, StaffInvoiceSaveSchema]);
export const FinancialDeleteSchema = z.object({
  ...commandIdentity, expectedInvoiceVersion: version,
  reason: optionalText(2000),
}).strict();
export type FinancialDeleteCommand = z.infer<typeof FinancialDeleteSchema>;
export const FinancialInvoiceIdSchema = z.string().uuid();

export function staffInvoiceRpcPayload(command: StaffInvoiceSaveCommand) {
  return {
    num: command.num, userTypedNum: command.userTypedNum, storeNumber: command.storeNumber,
    storeAddress: command.storeAddress, cme: command.cme, invoiceDate: command.invoiceDate,
    serviceDate: command.serviceDate, dueDate: command.dueDate, terms: command.terms, state: command.state,
    territory: command.territory, equipmentTag: command.equipmentTag, taxState: command.taxState,
    taxMode: command.salesTaxOverride !== null ? "manual_amount" : command.taxRateOverride !== null ? "manual_rate" : "active_db_rate",
    salesTaxOverride: command.salesTaxOverride, taxRateOverride: command.taxRateOverride,
    lines: command.lines, sourceInvoiceIds: [...command.sourceInvoiceIds].sort(),
  };
}
