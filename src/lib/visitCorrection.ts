import { errorData } from "./errors/errorData";
import { normalizeUnknownError } from "./errors/normalizeUnknown";

const FIVE_MINUTES_MS = 5 * 60 * 1_000;
const MAX_VISIT_DURATION_MS = 72 * 60 * 60 * 1_000;

type VisitCorrectionInput = {
  checkInAt: string;
  checkOutAt: string;
  reason: string;
  originalCheckInAt?: string | null;
  originalCheckOutAt?: string | null;
  nowMs?: number;
};

const STAFF_ROLES = new Set(["manager", "dispatcher", "back_office"]);
const OFFSITE_FIELD_STATUSES = new Set([
  "Awaiting Parts",
  "Completed",
]);

export function canOfferVisitCorrection({
  role,
  workOrderStatus,
  checkOutAt,
}: {
  role?: string | null;
  workOrderStatus?: string | null;
  checkOutAt?: string | null;
}): boolean {
  if (!checkOutAt) return false;
  if (role && STAFF_ROLES.has(role)) return true;
  return role === "contractor" && workOrderStatus !== "closed";
}

export function canOfferMissedVisitCheckout({
  userId,
  role,
  canManageTeam,
  workOrderStatus,
  functionalStatus,
  checkOutAt,
  checkedInBy,
  technicianProfileId,
}: {
  userId?: string | null;
  role?: string | null;
  canManageTeam?: boolean;
  workOrderStatus?: string | null;
  functionalStatus?: string | null;
  checkOutAt?: string | null;
  checkedInBy?: string | null;
  technicianProfileId?: string | null;
}): boolean {
  if (checkOutAt || workOrderStatus === "closed" || !functionalStatus
      || !OFFSITE_FIELD_STATUSES.has(functionalStatus)) return false;
  if (role && STAFF_ROLES.has(role)) return true;
  return role === "contractor" && Boolean(
    canManageTeam
    || (userId && userId === checkedInBy)
    || (userId && userId === technicianProfileId),
  );
}

export class VisitCorrectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "VisitCorrectionError";
  }
}

const exactServerMessages = new Map<string, readonly [string, string]>([
  ["Close the visit before correcting its actual times", ["VISIT_OPEN", "Check out of this visit before correcting its actual times."]],
  ["A correction reason of at least 5 characters is required", ["VISIT_REASON_REQUIRED", "Enter a correction reason of at least 5 characters."]],
  ["Both actual start and stop times are required", ["VISIT_TIMES_REQUIRED", "Enter both the actual check-in and check-out date and time."]],
  ["Actual stop time cannot be before actual start time", ["VISIT_TIME_ORDER", "Actual check-out cannot be before actual check-in."]],
  ["Visit times cannot be in the future", ["VISIT_TIME_FUTURE", "Actual visit times cannot be in the future."]],
  ["range lower bound must be less than or equal to range upper bound", ["VISIT_POLICY_REJECTED", "A legacy visit contains an invalid time interval. Refresh after the portal update, then try the correction again."]],
  ["A single visit cannot exceed 72 hours", ["VISIT_DURATION_LIMIT", "A single visit cannot exceed 72 hours."]],
  ["The corrected times are unchanged", ["VISIT_TIMES_UNCHANGED", "Change at least one actual visit time before saving."]],
  ["You cannot correct this visit", ["VISIT_ACCESS_DENIED", "This visit is not available for correction with your current work-order access."]],
  ["Visit time is locked after the P1 invoice is approved", ["VISIT_LOCKED_BY_INVOICE", "Visit time is locked because the P1 invoice is already approved or paid."]],
  ["The corrected time overlaps another visit for this technician", ["VISIT_TIME_OVERLAP", "These times overlap another visit for this technician. Review both visits before saving."]],
  ["The checkout time overlaps another visit for this technician", ["VISIT_TIME_OVERLAP", "This checkout overlaps another visit for this technician. Review both visits before saving."]],
  ["This visit is already checked out", ["VISIT_CHANGED", "This visit was already checked out. Refresh the work order."]],
  ["Missed checkout is available only after field work has moved off site", ["VISIT_CHANGED", "This work order is no longer eligible for missed-checkout recovery. Refresh it before trying again."]],
  ["Only the visit technician, acting lead, or company admin can record this checkout", ["VISIT_ACCESS_DENIED", "Only the visit technician, their team lead, company administrator, or P1 operations staff can record this checkout."]],
  ["Checkout time cannot be before active visit check-in", ["VISIT_TIME_ORDER", "Actual check-out cannot be before this visit's check-in."]],
  ["Checkout time cannot be in the future", ["VISIT_TIME_FUTURE", "Actual check-out cannot be more than 5 minutes in the future."]],
  ["Visit not found", ["VISIT_NOT_FOUND", "This visit is no longer available. Refresh the work order."]],
  ["Work order is unavailable", ["WORK_ORDER_UNAVAILABLE", "This work order is no longer available. Refresh the work-order list."]],
]);

const SAFE_WORK_ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function reviewedOverlapMessage(cause: unknown): string | null {
  const rawDetails = errorData(cause, "details");
  if (typeof rawDetails !== "string" || rawDetails.length > 8_192) return null;

  try {
    const details: unknown = JSON.parse(rawDetails);
    if (errorData(details, "code") !== "VISIT_TIME_OVERLAP") return null;
    const rawIds = errorData(details, "conflictingWorkOrderIds");
    if (!Array.isArray(rawIds)) return null;
    const workOrderIds = [...new Set(rawIds
      .filter((value): value is string => typeof value === "string" && SAFE_WORK_ORDER_ID.test(value)))]
      .slice(0, 3);
    if (workOrderIds.length === 0) return null;

    const rawCount = errorData(details, "conflictCount");
    const conflictCount = typeof rawCount === "number" && Number.isSafeInteger(rawCount) && rawCount > 0
      ? rawCount
      : workOrderIds.length;
    const additional = Math.max(0, conflictCount - workOrderIds.length);
    const listed = workOrderIds.join(", ");
    return `These times overlap another visit on ${listed}${additional > 0 ? ` and ${additional} more` : ""}. Review the conflicting visit before saving.`;
  } catch {
    return null;
  }
}

export function validateVisitCorrection(input: VisitCorrectionInput): void {
  if (input.reason.trim().length < 5) {
    throw new VisitCorrectionError(
      "VISIT_REASON_REQUIRED",
      "Enter a correction reason of at least 5 characters.",
    );
  }

  const checkInMs = Date.parse(input.checkInAt);
  const checkOutMs = Date.parse(input.checkOutAt);
  if (!Number.isFinite(checkInMs) || !Number.isFinite(checkOutMs)) {
    throw new VisitCorrectionError(
      "VISIT_TIMES_REQUIRED",
      "Enter both the actual check-in and check-out date and time.",
    );
  }
  if (checkOutMs < checkInMs) {
    throw new VisitCorrectionError(
      "VISIT_TIME_ORDER",
      "Actual check-out cannot be before actual check-in.",
    );
  }

  const nowMs = input.nowMs ?? Date.now();
  if (checkInMs > nowMs + FIVE_MINUTES_MS || checkOutMs > nowMs + FIVE_MINUTES_MS) {
    throw new VisitCorrectionError(
      "VISIT_TIME_FUTURE",
      "Actual visit times cannot be in the future.",
    );
  }
  if (checkOutMs - checkInMs > MAX_VISIT_DURATION_MS) {
    throw new VisitCorrectionError(
      "VISIT_DURATION_LIMIT",
      "A single visit cannot exceed 72 hours.",
    );
  }

  const originalCheckInMs = input.originalCheckInAt
    ? Date.parse(input.originalCheckInAt)
    : Number.NaN;
  const originalCheckOutMs = input.originalCheckOutAt
    ? Date.parse(input.originalCheckOutAt)
    : Number.NaN;
  if (
    checkInMs === originalCheckInMs
    && checkOutMs === originalCheckOutMs
  ) {
    throw new VisitCorrectionError(
      "VISIT_TIMES_UNCHANGED",
      "Change at least one actual visit time before saving.",
    );
  }
}

export function safeVisitCorrectionError(cause: unknown): VisitCorrectionError {
  if (cause instanceof VisitCorrectionError) return cause;

  const message = errorData(cause, "message");
  if (typeof message === "string") {
    if (message === "The corrected time overlaps another visit for this technician") {
      const reviewed = reviewedOverlapMessage(cause);
      if (reviewed) return new VisitCorrectionError("VISIT_TIME_OVERLAP", reviewed, cause);
    }
    const known = exactServerMessages.get(message);
    if (known) return new VisitCorrectionError(known[0], known[1], cause);
  }

  const providerCode = errorData(cause, "code");
  if (providerCode === "P0001") {
    return new VisitCorrectionError(
      "VISIT_POLICY_REJECTED",
      "The visit correction was rejected by a field-time policy. Refresh the work order, verify the technician and times, then try again.",
      cause,
    );
  }
  if (providerCode === "42501" || providerCode === "PT403") {
    return new VisitCorrectionError(
      "VISIT_ACCESS_DENIED",
      "This visit is not available for correction with your current access or work-order state. Refresh the work order.",
      cause,
    );
  }
  if (providerCode === "22023" || providerCode === "PT422") {
    return new VisitCorrectionError(
      "VISIT_INPUT_INVALID",
      "Check the actual visit dates, times, and correction reason, then try again.",
      cause,
    );
  }
  if (providerCode === "40001" || providerCode === "PT409") {
    return new VisitCorrectionError(
      "VISIT_CHANGED",
      "This visit changed in another session. Refresh the work order before correcting it.",
      cause,
    );
  }
  if (providerCode === "P0002" || providerCode === "PT404") {
    return new VisitCorrectionError(
      "VISIT_NOT_FOUND",
      "This visit is no longer available. Refresh the work order.",
      cause,
    );
  }

  const normalized = normalizeUnknownError(cause);
  return new VisitCorrectionError(
    "VISIT_CORRECTION_UNCONFIRMED",
    normalized.message,
    cause,
  );
}
