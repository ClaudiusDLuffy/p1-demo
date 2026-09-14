import { deleteFinancialCommand, type StaffFinancialCommandClient } from "../../lib/staffFinancialCommands";
import type { FinancialDeleteCommand } from "../../lib/staffInvoiceContracts";
import { reconcileBillingCommand } from "./billingCommandReconciliation";

export type BillingDeleteRepository = {
  deleteInvoice: (actorId: string, invoiceId: string, command: FinancialDeleteCommand,
    signal?: AbortSignal | null) => ReturnType<typeof deleteFinancialCommand>;
};

/** Focused adapter for the existing database-owned atomic delete command. */
export function createBillingDeleteRepository(
  dataSession: StaffFinancialCommandClient,
): BillingDeleteRepository {
  return {
    deleteInvoice: (actorId, invoiceId, command, signal = null) => {
      const captured = { ...command };
      return reconcileBillingCommand(attemptSignal => deleteFinancialCommand(dataSession, actorId, invoiceId,
        "staff", captured, { signal: attemptSignal }), signal);
    },
  };
}
