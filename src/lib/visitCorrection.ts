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
  ["A single visit cannot exceed 72 hours", ["VISIT_DURATION_LIMIT", "A single visit cannot exceed 72 hours."]],
  ["The corrected times are unchanged", ["VISIT_TIMES_UNCHANGED", "Change at least one actual visit time before saving."]],
  ["You cannot correct this visit", ["VISIT_ACCESS_DENIED", "This visit is not available for correction with your current work-order access."]],
  ["Contractor corrections are limited to 24 hours after check-out", ["VISIT_CORRECTION_WINDOW_CLOSED", "Contractor corrections are limited to 24 hours after check-out. Contact P1 staff to correct this visit."]],
  ["Visit time is locked after the P1 invoice is approved", ["VISIT_LOCKED_BY_INVOICE", "Visit time is locked because the P1 invoice is already approved or paid."]],
  ["The corrected time overlaps another visit for this technician", ["VISIT_TIME_OVERLAP", "These times overlap another visit for this technician. Review both visits before saving."]],
  ["Visit not found", ["VISIT_NOT_FOUND", "This visit is no longer available. Refresh the work order."]],
  ["Work order is unavailable", ["WORK_ORDER_UNAVAILABLE", "This work order is no longer available. Refresh the work-order list."]],
]);

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
    const known = exactServerMessages.get(message);
    if (known) return new VisitCorrectionError(known[0], known[1], cause);
  }

  const providerCode = errorData(cause, "code");
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
