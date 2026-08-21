export const WORK_ORDER_REOPEN_REASON_MIN_LENGTH = 3;
export const WORK_ORDER_REOPEN_REASON_MAX_LENGTH = 1000;

export const WORK_ORDER_REOPEN_MODE = {
  resumeWork: "resume_work",
  billingFollowUp: "billing_follow_up",
} as const;

export type WorkOrderReopenMode =
  typeof WORK_ORDER_REOPEN_MODE[keyof typeof WORK_ORDER_REOPEN_MODE];

export type ReopenableWorkOrder = {
  billingOnly?: boolean | null;
  isCapital?: boolean | null;
};

export type WorkOrderReopenOption = {
  value: WorkOrderReopenMode;
  label: string;
  description: string;
  disabled: boolean;
  disabledReason?: string;
};

export function normalizeWorkOrderReopenReason(reason: string): string {
  return reason.trim();
}

export function validateWorkOrderReopenReason(reason: string): string | null {
  const normalized = normalizeWorkOrderReopenReason(reason);
  if (normalized.length < WORK_ORDER_REOPEN_REASON_MIN_LENGTH) {
    return `Enter a reason of at least ${WORK_ORDER_REOPEN_REASON_MIN_LENGTH} characters.`;
  }
  if (normalized.length > WORK_ORDER_REOPEN_REASON_MAX_LENGTH) {
    return `Keep the reason to ${WORK_ORDER_REOPEN_REASON_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

export function workOrderReopenOptions(
  workOrder: ReopenableWorkOrder | null | undefined,
): WorkOrderReopenOption[] {
  const billingOnly = Boolean(workOrder?.billingOnly);
  const capital = Boolean(workOrder?.isCapital);

  return [
    {
      value: WORK_ORDER_REOPEN_MODE.billingFollowUp,
      label: "Continue billing or corrections",
      description: capital
        ? "Returns the capital order to final billing. Its approved quote and every invoice remain unchanged."
        : "Returns the order to invoice review or Ready to Bill. Every invoice remains unchanged.",
      disabled: false,
    },
    {
      value: WORK_ORDER_REOPEN_MODE.resumeWork,
      label: capital ? "Resume capital work" : "Resume field work",
      description: capital
        ? "Returns the order to its capital quote/completion stage without changing its contractor or prior visits."
        : "Returns the order to its current contractor, or Unassigned when it has no contractor. Prior visits stay closed.",
      disabled: billingOnly,
      disabledReason: billingOnly
        ? "Billing-only orders have no field assignment and can only reopen for billing follow-up."
        : undefined,
    },
  ];
}
