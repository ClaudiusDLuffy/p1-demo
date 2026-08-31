export type ContractorCompletionControl = {
  visible: boolean;
  enabled: boolean;
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

const BLOCKING_INVOICE_STATES = new Set(["draft", "rejected"]);

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
  const hasBlockingInvoice = normalizedInvoiceStates.some(state =>
    BLOCKING_INVOICE_STATES.has(state)
  );

  if (hasBlockingInvoice) {
    return {
      visible: true,
      enabled: false,
      label: "Finish invoice to complete job",
      blockedReason: "Submit or delete drafts and resolve rejected invoices before completing work and invoicing.",
    };
  }

  if (!hasReadyInvoice) {
    return {
      visible: true,
      enabled: false,
      label: "Create invoice to complete job",
      blockedReason: "Submit at least one contractor invoice before completing work and invoicing.",
    };
  }

  return {
    visible: true,
    enabled: true,
    label: "Complete work & invoicing",
    blockedReason: null,
  };
};
