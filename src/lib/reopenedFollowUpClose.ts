export const FOLLOW_UP_CLOSE_REASON_MIN_LENGTH = 3;
export const FOLLOW_UP_CLOSE_REASON_MAX_LENGTH = 1000;

const FOLLOW_UP_CLOSE_STATUSES = new Set([
  "unassigned",
  "assigned",
  "wip",
  "parts",
  "completed",
]);

const FOLLOW_UP_BILLING_ACTIVITY_EVENTS = new Set([
  "staff_billing",
  "staff_invoice_ready",
  "invoice_draft",
  "invoice_submitted",
  "invoice_resubmitted",
  "invoice_uploaded",
  "invoice_approved",
  "invoice_rejected",
  "invoice_rejection_retracted",
  "invoice_deleted",
  "invoice_deleted_by_contractor",
]);

type ActivityLike = {
  eventKey?: string | null;
  event_key?: string | null;
  eventData?: unknown;
  event_data?: unknown;
  workflowCycle?: number | null;
  workflow_cycle?: number | null;
  createdAt?: string | null;
  created_at?: string | null;
  deletedAt?: string | null;
  deleted_at?: string | null;
};

type InvoiceLike = {
  id?: string | null;
  state?: string | null;
  documentKind?: string | null;
  document_kind?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
  deletedAt?: string | null;
  deleted_at?: string | null;
};

type WorkOrderLike = {
  status?: string | null;
  workflowCycle?: number | null;
  workflow_cycle?: number | null;
  billingOnly?: boolean | null;
  billing_only?: boolean | null;
  isCapital?: boolean | null;
  is_capital?: boolean | null;
  hasPendingSevenElevenSync?: boolean | null;
  has_pending_seven_eleven_sync?: boolean | null;
  hasPendingContractorAttention?: boolean | null;
  has_pending_contractor_attention?: boolean | null;
  activities?: ActivityLike[] | null;
};

export type CurrentResumeWorkCycle = {
  workflowCycle: number;
  reopenedAt: string;
};

export function normalizeFollowUpCloseReason(reason: string): string {
  return reason.trim();
}

export function validateFollowUpCloseReason(reason: string): string | null {
  const normalized = normalizeFollowUpCloseReason(reason);
  if (normalized.length < FOLLOW_UP_CLOSE_REASON_MIN_LENGTH) {
    return `Enter a reason of at least ${FOLLOW_UP_CLOSE_REASON_MIN_LENGTH} characters.`;
  }
  if (normalized.length > FOLLOW_UP_CLOSE_REASON_MAX_LENGTH) {
    return `Keep the reason to ${FOLLOW_UP_CLOSE_REASON_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

function activityEventData(activity: ActivityLike): Record<string, unknown> {
  const value = activity.eventData ?? activity.event_data;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function activityTime(activity: ActivityLike): string | null {
  const value = activity.createdAt ?? activity.created_at;
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return value;
}

export function currentResumeWorkCycle(
  workOrder: WorkOrderLike | null | undefined,
): CurrentResumeWorkCycle | null {
  const workflowCycle = Number(
    workOrder?.workflowCycle ?? workOrder?.workflow_cycle ?? 0,
  );
  if (!Number.isInteger(workflowCycle) || workflowCycle <= 0) return null;

  const matchingReopens = (workOrder?.activities || []).flatMap(activity => {
    const eventKey = activity.eventKey ?? activity.event_key;
    const activityCycle = Number(
      activity.workflowCycle ?? activity.workflow_cycle ?? 0,
    );
    const reopenedAt = activityTime(activity);
    if (
      eventKey !== "work_order_reopened"
      || Boolean(activity.deletedAt ?? activity.deleted_at)
      || activityCycle !== workflowCycle
      || activityEventData(activity).mode !== "resume_work"
      || !reopenedAt
    ) {
      return [];
    }
    return [{ workflowCycle, reopenedAt }];
  });

  return matchingReopens.sort(
    (left, right) => Date.parse(right.reopenedAt) - Date.parse(left.reopenedAt),
  )[0] || null;
}

export function hasInvoiceCreatedSince(
  invoices: InvoiceLike[],
  boundary: string,
): boolean {
  const boundaryTime = Date.parse(boundary);
  if (Number.isNaN(boundaryTime)) return true;

  return invoices.some(invoice => {
    const deletedAt = invoice.deletedAt ?? invoice.deleted_at;
    if (deletedAt) {
      const deletedTime = Date.parse(deletedAt);
      return Number.isNaN(deletedTime) || deletedTime >= boundaryTime;
    }
    const createdAt = invoice.createdAt ?? invoice.created_at;
    if (!createdAt) return true;
    const createdTime = Date.parse(createdAt);
    return Number.isNaN(createdTime) || createdTime >= boundaryTime;
  });
}

function invoiceCreatedBefore(invoice: InvoiceLike, boundary: string): boolean {
  if (invoice.deletedAt ?? invoice.deleted_at) return false;
  const createdAt = invoice.createdAt ?? invoice.created_at;
  if (!createdAt) return false;
  const createdTime = Date.parse(createdAt);
  const boundaryTime = Date.parse(boundary);
  return !Number.isNaN(createdTime)
    && !Number.isNaN(boundaryTime)
    && createdTime < boundaryTime;
}

export function canCloseReopenedFollowUpWithoutBilling(input: {
  workOrder: WorkOrderLike | null | undefined;
  contractorInvoices?: InvoiceLike[];
  staffInvoices?: InvoiceLike[];
  isOperationalStaff: boolean;
  isInvoiceController: boolean;
  hasCompleteEvidence: boolean;
}): boolean {
  const {
    workOrder,
    contractorInvoices = [],
    staffInvoices = [],
    isOperationalStaff,
    isInvoiceController,
    hasCompleteEvidence,
  } = input;

  if (
    !isOperationalStaff
    || isInvoiceController
    || !hasCompleteEvidence
    || !workOrder
    || !FOLLOW_UP_CLOSE_STATUSES.has(String(workOrder.status || ""))
    || Boolean(workOrder.billingOnly ?? workOrder.billing_only)
    || Boolean(workOrder.isCapital ?? workOrder.is_capital)
    || Boolean(
      workOrder.hasPendingSevenElevenSync
        ?? workOrder.has_pending_seven_eleven_sync,
    )
    || Boolean(
      workOrder.hasPendingContractorAttention
        ?? workOrder.has_pending_contractor_attention,
    )
  ) {
    return false;
  }

  const cycle = currentResumeWorkCycle(workOrder);
  if (!cycle) return false;

  const allInvoices = [...contractorInvoices, ...staffInvoices];
  if (hasInvoiceCreatedSince(allInvoices, cycle.reopenedAt)) return false;

  const priorInvoices = allInvoices.filter(invoice =>
    invoiceCreatedBefore(invoice, cycle.reopenedAt),
  );
  if (
    priorInvoices.length === 0
    || priorInvoices.some(invoice => !["approved", "paid"].includes(
      String(invoice.state || ""),
    ))
  ) {
    return false;
  }

  const priorStaffInvoiceIds = new Set(staffInvoices.flatMap(invoice => (
    invoiceCreatedBefore(invoice, cycle.reopenedAt)
      && ["approved", "paid"].includes(String(invoice.state || ""))
      && String(invoice.documentKind ?? invoice.document_kind ?? "invoice") === "invoice"
      && invoice.id
        ? [invoice.id]
        : []
  )));
  if (priorStaffInvoiceIds.size === 0) return false;

  const priorContractorInvoices = contractorInvoices.filter(invoice =>
    invoiceCreatedBefore(invoice, cycle.reopenedAt)
      && String(invoice.documentKind ?? invoice.document_kind ?? "invoice") === "invoice",
  );
  if (priorContractorInvoices.some(invoice => !invoice.id)) return false;
  const priorContractorInvoiceIds = new Set(priorContractorInvoices.map(invoice => invoice.id!));

  const billedPriorStaffInvoiceIds = new Set<string>();
  const submittedPriorContractorInvoiceIds = new Set<string>();
  for (const activity of workOrder.activities || []) {
    if (activity.deletedAt ?? activity.deleted_at) continue;
    const eventKey = activity.eventKey ?? activity.event_key;
    const eventData = activityEventData(activity);
    const isBilledEvent = eventKey === "staff_billing"
      && eventData.action === "billed_to_7_eleven";
    if (!FOLLOW_UP_BILLING_ACTIVITY_EVENTS.has(String(eventKey))
      && !isBilledEvent) continue;

    const billedAt = activityTime(activity);
    if (!billedAt || Date.parse(billedAt) >= Date.parse(cycle.reopenedAt)) {
      return false;
    }
    const invoiceId = typeof eventData.invoiceId === "string"
      ? eventData.invoiceId
      : "";
    const activityCycle = Number(
      activity.workflowCycle ?? activity.workflow_cycle ?? 0,
    );
    if (eventKey === "invoice_submitted"
      && priorContractorInvoiceIds.has(invoiceId)
      && activityCycle < cycle.workflowCycle) {
      submittedPriorContractorInvoiceIds.add(invoiceId);
    }
    if (isBilledEvent && priorStaffInvoiceIds.has(invoiceId)
      && activityCycle < cycle.workflowCycle
      && Date.parse(billedAt) < Date.parse(cycle.reopenedAt)) {
      billedPriorStaffInvoiceIds.add(invoiceId);
    }
  }

  return billedPriorStaffInvoiceIds.size === priorStaffInvoiceIds.size
    && submittedPriorContractorInvoiceIds.size === priorContractorInvoiceIds.size;
}
