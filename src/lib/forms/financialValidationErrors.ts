import { z } from "zod";
import { AppError } from "../errors/AppError";
import type { ValidationIssue } from "./validationErrors";

const labels: Record<string, string> = {
  num: "Invoice number",
  invoiceDate: "Invoice date",
  serviceDate: "Service date",
  dueDate: "Due date",
  workOrderId: "Work order",
  storeNumber: "Store number",
  storeAddress: "Store address",
  cme: "Notes / CME",
  terms: "Payment terms",
  territory: "Territory",
  equipmentTag: "Equipment tag",
  taxState: "Tax state",
  salesTaxOverride: "Sales tax",
  taxRateOverride: "Tax rate",
  sourceInvoiceIds: "Selected contractor invoices",
  expectedAssignmentVersion: "Work order",
  expectedWorkflowCycle: "Work order",
  expectedInvoiceVersion: "Invoice",
};

function labelForPath(path: string): string {
  const line = /^lines\.(\d+)\.([a-zA-Z0-9_]+)$/.exec(path);
  if (line) {
    const field = labels[line[2]] ?? ({
      type: "type",
      desc: "description",
      description: "description",
      qty: "quantity",
      rate: "rate",
      isTaxable: "tax setting",
      sourceInvoiceLineId: "contractor source",
      sourceWorkOrderPartId: "P1 part source",
      sourceUnitCost: "source cost",
      markupPercent: "markup",
    }[line[2]] ?? "value");
    return `Line ${Number(line[1]) + 1} ${field}`;
  }
  if (path === "lines" || path.startsWith("lines.")) return "Invoice line items";
  return labels[path] ?? "Invoice details";
}

function presentIssue(path: string, message: string): ValidationIssue {
  const cleanMessage = message.trim();
  const generic = cleanMessage === "Check this field."
    || cleanMessage === "Invalid input";
  return {
    path,
    message: generic
      ? `${labelForPath(path)} needs review.`
      : `${labelForPath(path)}: ${cleanMessage}`,
  };
}

/** Preserve local Zod detail, while server-projected errors remain limited to
 * their safe field path and fixed public message. */
export function firstFinancialValidationIssue(error: unknown): ValidationIssue | null {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (!issue) return null;
    return presentIssue(issue.path.map(segment => String(segment)).join(".") || "request", issue.message);
  }
  if (error instanceof AppError && error.fieldErrors?.length) {
    const issue = error.fieldErrors[0];
    return presentIssue(issue.path || "request", issue.message);
  }
  return null;
}

export function financialValidationFocusPath(path: string): string {
  if (["expectedAssignmentVersion", "expectedWorkflowCycle"].includes(path)) return "workOrderId";
  if (path === "expectedInvoiceVersion") return "num";
  if (/^lines\.\d+\.(sourceInvoiceLineId|sourceWorkOrderPartId|sourceUnitCost|markupPercent)$/.test(path)) {
    return path.replace(/\.(sourceInvoiceLineId|sourceWorkOrderPartId|sourceUnitCost|markupPercent)$/, ".rate");
  }
  return path;
}
