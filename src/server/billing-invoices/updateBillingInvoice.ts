import type { StaffInvoicePatchSchema } from "../../lib/staffInvoiceContracts";
import type { z } from "zod";
import type { AuthorizedBillingSaveContext } from "./billingMutationContext";
import { mapBillingSaveResult, mapBillingUpdateActionResult } from "./billingSaveResultMapper";
import { refreshCommittedBillingInvoice } from "./billingPostCommitResult";
import type { BillingUpdateCommandRepository } from "./billingUpdateCommandRepository";
export type ParsedBillingUpdateCommand = z.infer<typeof StaffInvoicePatchSchema>;
export type BillingUpdateDependencies = { commandRepository: BillingUpdateCommandRepository; loadCommittedInvoice: (id: string) => Promise<unknown> };
export async function updateBillingInvoice(command: ParsedBillingUpdateCommand, invoiceId: string, context: AuthorizedBillingSaveContext, dependencies: BillingUpdateDependencies) {
  if ("action" in command) {
    const result = await dependencies.commandRepository.action(command.action, invoiceId, context);
    const refresh = await refreshCommittedBillingInvoice(invoiceId, context.signal, dependencies.loadCommittedInvoice);
    return mapBillingUpdateActionResult(command.action, invoiceId, result, refresh);
  }
  const result = await dependencies.commandRepository.save(command, invoiceId, context);
  const refresh = await refreshCommittedBillingInvoice(result.invoiceId, context.signal, dependencies.loadCommittedInvoice, result);
  return mapBillingSaveResult(result, refresh, command);
}
