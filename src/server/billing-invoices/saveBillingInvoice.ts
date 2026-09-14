import type { StaffInvoiceSaveCommand } from "../../lib/staffInvoiceContracts";
import type { BillingSourceRepository } from "./billingSourceRepository";
import type { BillingFinancialInputRepository } from "./billingFinancialInputRepository";
import type { BillingSaveCommandRepository } from "./billingSaveCommandRepository";
import { mapBillingSaveResult, type BillingSaveApplicationResult } from "./billingSaveResultMapper";
import { canonicalizeBillingSaveCommand } from "./billingSaveCanonicalizer";
import { refreshCommittedBillingInvoice } from "./billingPostCommitResult";
import type { AuthorizedBillingSaveContext } from "./billingMutationContext";

export type BillingSaveDependencies = {
  loadCommittedInvoice: (invoiceId: string) => Promise<unknown>;
  sourceRepository: BillingSourceRepository;
  financialInputRepository: BillingFinancialInputRepository;
  canonicalizer?: { canonicalize: typeof canonicalizeBillingSaveCommand };
  commandRepository?: BillingSaveCommandRepository;
};

export async function saveBillingInvoice(command: StaffInvoiceSaveCommand, context: AuthorizedBillingSaveContext, dependencies: BillingSaveDependencies): Promise<BillingSaveApplicationResult> {
  const sourceFacts = await dependencies.sourceRepository.loadForSave({ workOrderId: command.workOrderId, sourceInvoiceIds: command.sourceInvoiceIds }, context);
  const financialFacts = await dependencies.financialInputRepository.loadForSave({ workOrderId: command.workOrderId, storeNumber: command.storeNumber, territory: command.territory }, context);
  const canonicalCommand = (dependencies.canonicalizer ?? { canonicalize: canonicalizeBillingSaveCommand }).canonicalize(command, sourceFacts, financialFacts);
  const commandRepository = dependencies.commandRepository;
  if (!commandRepository) throw new Error("Billing save command repository is required");
  const result = await commandRepository.execute(canonicalCommand, context);
  const refresh = await refreshCommittedBillingInvoice(result.invoiceId, context.signal, dependencies.loadCommittedInvoice, result);
  return mapBillingSaveResult(result, refresh, canonicalCommand);
}
