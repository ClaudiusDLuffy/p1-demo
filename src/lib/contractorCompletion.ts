export type ContractorCompletionControl = {
  visible: boolean;
  /** Whether the atomic complete-work-and-invoicing action is currently valid. */
  enabled: boolean;
  action: "create_invoice" | "finish_invoice" | "correct_invoice" | "complete" | null;
  label: string;
  blockedReason: string | null;
};

type ContractorCompletionInput = {
  isManager: boolean;
  canInvoice: boolean;
  billingOnly?: boolean | null;
  invoicingComplete: boolean;
  workOrderStatus?: string | null;
  invoiceStates: Array<string | null | undefined>;
};

const COMPLETION_BLOCKED_WORK_ORDER_STATUSES = new Set([
  "assigned",
  "parts",
  "closed",
  "capital",
  "pending_capital_completion",
]);

const READY_INVOICE_STATES = new Set([
  "submitted",
  "revised",
  "approved",
  "paid",
]);

/**
 * Keeps the contractor's final action discoverable without weakening the
 * atomic completion rule enforced by complete_contractor_work_and_invoicing.
 */
export const getContractorCompletionControl = ({
  isManager,
  canInvoice,
  billingOnly,
  invoicingComplete,
  workOrderStatus,
  invoiceStates,
}: ContractorCompletionInput): ContractorCompletionControl => {
  const normalizedStatus = String(workOrderStatus || "").trim().toLowerCase();
  const visible = !isManager
    && canInvoice
    && !billingOnly
    && !invoicingComplete
    && !COMPLETION_BLOCKED_WORK_ORDER_STATUSES.has(normalizedStatus);

  if (!visible) {
    return {
      visible: false,
      enabled: false,
      action: null,
      label: "Complete work & invoicing",
      blockedReason: null,
    };
  }

  const normalizedInvoiceStates = invoiceStates.map(state =>
    String(state || "").trim().toLowerCase()
  );
  const hasReadyInvoice = normalizedInvoiceStates.some(state =>
    READY_INVOICE_STATES.has(state)
  );
  const hasDraftInvoice = normalizedInvoiceStates.includes("draft");
  const hasRejectedInvoice = normalizedInvoiceStates.includes("rejected");

  if (hasRejectedInvoice) {
    return {
      visible: true,
      enabled: false,
      action: "correct_invoice",
      label: "Correct invoice to complete job",
      blockedReason: "Correct or delete rejected invoices before completing work and invoicing.",
    };
  }

  if (hasDraftInvoice) {
    return {
      visible: true,
      enabled: false,
      action: "finish_invoice",
      label: "Finish invoice to complete job",
      blockedReason: "Submit or delete drafts before completing work and invoicing.",
    };
  }

  if (!hasReadyInvoice) {
    return {
      visible: true,
      enabled: false,
      action: "create_invoice",
      label: "Create invoice to complete job",
      blockedReason: "Submit at least one contractor invoice before completing work and invoicing.",
    };
  }

  return {
    visible: true,
    enabled: true,
    action: "complete",
    label: "Complete work & invoicing",
    blockedReason: null,
  };
};
