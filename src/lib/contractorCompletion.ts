export type ContractorCompletionControl = {
  visible: boolean;
  enabled: boolean;
  action: "complete" | null;
  label: string;
  blockedReason: string | null;
};

type ContractorCompletionInput = {
  isManager: boolean;
  billingOnly?: boolean | null;
  fieldWorkComplete: boolean;
  workOrderStatus?: string | null;
};

const COMPLETION_ALLOWED_WORK_ORDER_STATUSES = new Set([
  "wip",
  "pending_invoice",
  "pending_approval",
  "pending_payment",
]);

const INVOICE_WORKFLOW_STATUSES = new Set([
  "pending_invoice",
  "pending_approval",
  "pending_payment",
]);

/**
 * Field completion must not move a work order backwards after an invoice has
 * already advanced it into a staff or 7-Eleven billing queue.
 */
export const workOrderStatusAfterFieldCompletion = (
  workOrderStatus?: string | null,
): string => {
  const normalizedStatus = String(workOrderStatus || "").trim().toLowerCase();
  return INVOICE_WORKFLOW_STATUSES.has(normalizedStatus)
    ? normalizedStatus
    : "completed";
};

/**
 * Field completion is independent from invoice permissions and invoice state.
 * Invoice-capable field users must be able to close out their work before the
 * company finishes its separate contractor-invoice workflow.
 */
export const getContractorCompletionControl = ({
  isManager,
  billingOnly,
  fieldWorkComplete,
  workOrderStatus,
}: ContractorCompletionInput): ContractorCompletionControl => {
  const normalizedStatus = String(workOrderStatus || "").trim().toLowerCase();
  const visible = !isManager
    && !billingOnly
    && !fieldWorkComplete
    && COMPLETION_ALLOWED_WORK_ORDER_STATUSES.has(normalizedStatus);

  if (!visible) {
    return {
      visible: false,
      enabled: false,
      action: null,
      label: "Complete work & invoicing",
      blockedReason: null,
    };
  }

  return {
    visible: true,
    enabled: true,
    action: "complete",
    label: "Mark work complete",
    blockedReason: null,
  };
};
