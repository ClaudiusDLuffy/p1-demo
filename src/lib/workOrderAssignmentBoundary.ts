import type { WorkOrderViewRow } from "./workOrderView";

export const assignmentBoundaryPatch = (
  workOrder: Pick<WorkOrderViewRow, "contractor">,
  transition: {
    contractorId: string | null;
    assignmentVersion: number;
    assignmentStartedAt: string | null;
    dispatchedAt: string | null;
    status: string;
    functionalStatus: string | null;
    isCapital: boolean;
    capitalStatus: string | null;
  },
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {
    contractor: transition.contractorId,
    contractorAssignmentVersion: transition.assignmentVersion,
    contractorAssignmentStartedAt: transition.assignmentStartedAt,
    dispatchedAt: transition.dispatchedAt,
    status: transition.status,
    functionalStatus: transition.functionalStatus,
    isCapital: transition.isCapital,
    capitalStatus: transition.capitalStatus,
  };

  if (!workOrder.contractor) return patch;

  return {
    ...patch,
    eta: null,
    startTime: null,
    startTimeRaw: null,
    endTime: null,
    endTimeRaw: null,
    technicianOnJob: null,
    assignedTechnicianProfileId: null,
    technicianAssignedAt: null,
    technicianAssignedBy: null,
    assetMake: null,
    assetModel: null,
    assetSerial: null,
    assetYear: null,
    resolutionCode: null,
    resolutionNotes: null,
    partNeeded: null,
    partEta: null,
    invoiceTotal: null,
    repairQuote: null,
    installQuote: null,
    capitalNotes: null,
    nteFlagged: false,
    nteFlagAmount: null,
    contractorInvoicingCompletedAt: null,
    contractorInvoicingCompletedBy: null,
    contractorInvoicingAssignmentVersion: null,
    contractorInvoicingWorkflowCycle: null,
    contractorInvoicingCompletionSource: null,
  };
};
