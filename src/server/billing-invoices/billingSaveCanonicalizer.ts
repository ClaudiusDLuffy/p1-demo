import type { StaffInvoiceSaveCommand } from "../../lib/staffInvoiceContracts";
import type { BillingSourceReadModel } from "./billingSourceRepository";
import type { BillingFinancialInputReadModel } from "./billingFinancialInputRepository";

export type CanonicalBillingSaveCommand = StaffInvoiceSaveCommand;

/**
 * The database command remains authoritative for financial calculations.  This
 * pure seam preserves the validated command and binds it to the verified input
 * snapshot without duplicating any financial formulas.
 */
export function canonicalizeBillingSaveCommand(
  command: StaffInvoiceSaveCommand,
  sourceFacts: BillingSourceReadModel,
  financialFacts: BillingFinancialInputReadModel,
): CanonicalBillingSaveCommand {
  if ((command.workOrderId === null) !== (financialFacts.kind === "standalone")) {
    throw new Error("Financial input mode does not match save command");
  }
  if (command.workOrderId !== financialFacts.workOrderId) {
    throw new Error("Work-order input does not match save command");
  }
  const requestedSources = new Set(command.sourceInvoiceIds.map(id => id.toLowerCase()));
  if (sourceFacts.sourceInvoiceIds.some(id => !requestedSources.has(id.toLowerCase()))) {
    throw new Error("Source input does not match save command");
  }
  // Missing/live eligibility facts cannot preempt SQL's operation replay or
  // replace its established source rejection codes with a generic error.
  return {
    ...command,
    lines: command.lines.map(line => ({ ...line })),
    sourceInvoiceIds: [...command.sourceInvoiceIds],
  };
}
