export type ContractorInvoiceReviewState =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "revised"
  | "paid";

type ContractorInvoiceReviewRecord = {
  wot?: string | null;
  state?: ContractorInvoiceReviewState | string | null;
};

/**
 * Mirrors public.contractor_invoice_work_order_status(). Drafts do not enter
 * review. Every other invoice must be approved or paid before the work order
 * can move to P1 billing.
 */
export function contractorInvoiceWorkOrderStatus(
  invoices: ContractorInvoiceReviewRecord[],
  workOrderId: string,
): "pending_invoice" | "pending_approval" | null {
  const liveInvoices = (invoices || []).filter(
    invoice => invoice.wot === workOrderId && invoice.state !== "draft",
  );

  if (liveInvoices.length === 0) return null;
  return liveInvoices.every(
    invoice => invoice.state === "approved" || invoice.state === "paid",
  )
    ? "pending_invoice"
    : "pending_approval";
}

export function canEditRejectedContractorInvoice(
  invoice: ContractorInvoiceReviewRecord | null | undefined,
) {
  return invoice?.state === "rejected";
}
