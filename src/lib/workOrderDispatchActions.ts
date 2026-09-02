const DUPLICABLE_WORK_ORDER_STATUSES = new Set([
  "assigned",
  "wip",
  "parts",
  "completed",
  "pending_invoice",
  "pending_approval",
  "pending_payment",
]);

type StaffActionContext = {
  isOperationalStaff: boolean;
  isInvoiceController?: boolean;
};

export type RejectWorkOrderEligibility = StaffActionContext & {
  status?: string | null;
  functionalStatus?: string | null;
  contractorId?: string | null;
  assignedTechnicianProfileId?: string | null;
  technicianOnJob?: string | null;
  contractorAssignmentVersion?: number | null;
  contractorAssignmentStartedAt?: string | null;
  dispatchedAt?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  billingOnly?: boolean | null;
  hasActiveInvoices?: boolean;
};

export function canRejectUnassignedWorkOrder(
  input: RejectWorkOrderEligibility,
): boolean {
  return input.isOperationalStaff
    && !input.isInvoiceController
    && input.status === "unassigned"
    && input.functionalStatus === "New"
    && !input.contractorId
    && !input.assignedTechnicianProfileId
    && !input.technicianOnJob
    && Number(input.contractorAssignmentVersion || 0) === 0
    && !input.contractorAssignmentStartedAt
    && !input.dispatchedAt
    && !input.startTime
    && !input.endTime
    && !input.billingOnly
    && !input.hasActiveInvoices;
}

export type DuplicateWorkOrderEligibility = StaffActionContext & {
  workOrderId?: string | null;
  duplicateRootWorkOrderId?: string | null;
  status?: string | null;
  contractorId?: string | null;
  contractorAssignmentVersion?: number | null;
  billingOnly?: boolean | null;
  isCapital?: boolean | null;
};

export function canDuplicateWorkOrderForReassignment(
  input: DuplicateWorkOrderEligibility,
): boolean {
  const externalWorkOrderId = String(
    input.duplicateRootWorkOrderId || input.workOrderId || "",
  ).trim();
  return input.isOperationalStaff
    && !input.isInvoiceController
    && !input.billingOnly
    && !input.isCapital
    && Boolean(input.contractorId)
    && Number(input.contractorAssignmentVersion || 0) > 0
    && /^WOT\d{6,12}$/i.test(externalWorkOrderId)
    && DUPLICABLE_WORK_ORDER_STATUSES.has(String(input.status || ""));
}
