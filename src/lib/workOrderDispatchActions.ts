const DUPLICABLE_WORK_ORDER_STATUSES = new Set([
  "assigned",
  "wip",
  "parts",
  "completed",
  "pending_invoice",
  "pending_approval",
  "pending_payment",
]);

const ASSIGNABLE_ACTIVE_STATUSES = new Set([
  "assigned",
  "wip",
  "parts",
  "capital",
  "pending_capital_completion",
]);

const CAPITAL_ASSIGNMENT_STATUSES = new Set([
  "capital",
  "pending_capital_completion",
]);

type StaffActionContext = {
  isOperationalStaff: boolean;
  isInvoiceController?: boolean;
};

export type WorkOrderAssignmentEligibility = StaffActionContext & {
  assignmentTransferPendingVisit?: boolean;
  status?: string | null;
  functionalStatus?: string | null;
  contractorId?: string | null;
  billingOnly?: boolean | null;
};

export type WorkOrderVisitEligibility = {
  assignmentTransferPendingVisit?: boolean | null;
  status?: string | null;
  functionalStatus?: string | null;
  contractorId?: string | null;
};

export type WorkOrderVisitAction = "start" | "resume" | "receiving_start";

/**
 * Mirrors the authoritative visit-state boundary. Email-intake assignments
 * intentionally remain `assigned / New` until their first field action, while
 * manually created assignments begin as `assigned / Dispatched`.
 */
export function workOrderVisitAction(
  input: WorkOrderVisitEligibility,
): WorkOrderVisitAction | null {
  if (!input.contractorId) return null;
  if (input.assignmentTransferPendingVisit === true
      && input.status === "wip"
      && input.functionalStatus === "Work in Progress") {
    return "receiving_start";
  }
  if (input.status === "parts" && input.functionalStatus === "Awaiting Parts") {
    return "resume";
  }
  if (input.status === "assigned"
      && ["New", "Dispatched"].includes(String(input.functionalStatus || ""))) {
    return "start";
  }
  return null;
}

export function canSetWorkOrderEta(
  input: WorkOrderVisitEligibility,
): boolean {
  return Boolean(input.contractorId)
    && input.status === "assigned"
    && ["New", "Dispatched"].includes(String(input.functionalStatus || ""));
}

const hasOperationalAssignmentAccess = (
  input: WorkOrderAssignmentEligibility,
) => input.isOperationalStaff
  && !input.isInvoiceController
  && !input.billingOnly;

export function canAssignWorkOrder(
  input: WorkOrderAssignmentEligibility,
): boolean {
  if (!hasOperationalAssignmentAccess(input) || input.contractorId) return false;

  const status = String(input.status || "");
  return CAPITAL_ASSIGNMENT_STATUSES.has(status)
    || (input.assignmentTransferPendingVisit === true && status === "wip" && input.functionalStatus === "Work in Progress")
    || (status === "unassigned" && input.functionalStatus === "New");
}

export function canChangeWorkOrderAssignment(
  input: WorkOrderAssignmentEligibility,
): boolean {
  return hasOperationalAssignmentAccess(input)
    && Boolean(input.contractorId)
    && ASSIGNABLE_ACTIVE_STATUSES.has(String(input.status || ""));
}

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
