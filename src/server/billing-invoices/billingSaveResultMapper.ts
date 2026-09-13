import type { BillingSaveCommandResult } from "./billingSaveCommandRepository";
import type { StaffInvoiceSaveCommand } from "../../lib/staffInvoiceContracts";
import type { BillingPostCommitRefresh } from "./billingPostCommitResult";
import { invoiceSummaryForLegacyUi } from "../../features/invoices/invoiceReadContracts";
import type { BillingUpdateActionResult } from "./billingUpdateCommandRepository";

export function mapBillingSaveResult(command: BillingSaveCommandResult, refresh: BillingPostCommitRefresh, input: StaffInvoiceSaveCommand) {
  const invoice = refresh.status === "available" ? invoiceSummaryForLegacyUi(refresh.invoice) : {
    projection: "receipt", id: command.invoiceId, num: command.invoiceNum,
    wot: command.workOrderId, workOrderId: command.workOrderId,
    invoiceType: "staff", state: command.state, invoiceVersion: command.invoiceVersion,
    assignmentVersion: command.assignmentVersion, workflowCycle: command.workflowCycle,
    subtotal: command.subtotal, salesTax: command.salesTax, total: command.total,
    lineCount: command.lineCount, sourceCount: command.sourceInvoiceCount,
    store: input.storeNumber, territory: input.territory,
  };
  return { invoice, command, refresh: refresh.status === "unavailable"
    ? { status: refresh.status, warning: refresh.warning } : { status: refresh.status } };
}

export type BillingSaveApplicationResult = ReturnType<typeof mapBillingSaveResult>;

export function mapBillingUpdateActionResult(action: "mark_ready" | "mark_billed", invoiceId: string, result: BillingUpdateActionResult, refresh: BillingPostCommitRefresh) {
  const invoice = refresh.status === "available" ? invoiceSummaryForLegacyUi(refresh.invoice) : { id: invoiceId, projection: "receipt" };
  const secondary = refresh.status === "unavailable" ? { status: refresh.status, warning: refresh.warning } : { status: refresh.status };
  return action === "mark_ready" ? { invoice, readiness: result, refresh: secondary } : { invoice, finalization: result, refresh: secondary };
}
