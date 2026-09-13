import { saveStaffFinancialCommand, type StaffFinancialCommandClient } from "../../lib/staffFinancialCommands";
import type { StaffInvoiceSaveCommand } from "../../lib/staffInvoiceContracts";
import type { CanonicalBillingSaveCommand } from "./billingSaveCanonicalizer";
import { reconcileBillingCommand } from "./billingCommandReconciliation";

export type BillingSaveCommandResult = Awaited<ReturnType<typeof saveStaffFinancialCommand>>;
export type BillingSaveCommandContext = { actor: { userId: string }; signal: AbortSignal | null };
export interface BillingSaveCommandRepository {
  execute(command: CanonicalBillingSaveCommand, context: BillingSaveCommandContext): Promise<BillingSaveCommandResult>;
}

export function executeBillingSaveCommand(dataSession: StaffFinancialCommandClient, actorId: string,
  invoiceId: string | null, command: StaffInvoiceSaveCommand, signal: AbortSignal | null): Promise<BillingSaveCommandResult> {
  // Capture the canonical payload once. Reconciliation must not observe later
  // mutation of caller-owned arrays or generate another operation identity.
  const captured = { ...command, lines: command.lines.map(line => ({ ...line })),
    sourceInvoiceIds: [...command.sourceInvoiceIds] };
  return reconcileBillingCommand(attemptSignal => saveStaffFinancialCommand(dataSession, actorId, invoiceId,
    captured, { signal: attemptSignal }), signal);
}

export function createBillingSaveCommandRepository(dataSession: StaffFinancialCommandClient): BillingSaveCommandRepository {
  return {
    execute: (command, context) => executeBillingSaveCommand(dataSession, context.actor.userId, null, command, context.signal),
  };
}
