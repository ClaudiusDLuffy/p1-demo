import { z } from "zod";
import { PRIORITY } from "./constants";
import { computeSlaBreaches, type Priority } from "./slaConfig";
import type { GraphEmail } from "./graphClient";

export type WorkOrderPriority = Priority;

export const workOrderPriorityLabel = (priority: WorkOrderPriority) =>
  PRIORITY[priority].label;

export const workOrderPrioritySchema = z.enum(["p1", "p2", "p3", "p4", "p5"]);

export const isWorkOrderPriority = (value: string): value is WorkOrderPriority =>
  workOrderPrioritySchema.safeParse(value).success;

export const emailPriorityUpdateResultSchema = z.object({
  applied: z.boolean(),
  replayed: z.boolean(),
  outcome: z.enum([
    "escalated",
    "unchanged",
    "not_escalation",
    "stale",
    "non_operational",
  ]),
  eventId: z.string().uuid(),
  workOrderId: z.string().min(1),
  externalWorkOrderId: z.string().min(1),
  previousPriority: workOrderPrioritySchema,
  reportedPriority: workOrderPrioritySchema,
  currentPriority: workOrderPrioritySchema,
  deliveryStatus: z.enum([
    "not_required",
    "pending",
    "claimed",
    "sent",
    "unknown",
    "failed",
  ]),
});

export const emailPriorityDeliveryClaimSchema = z.object({
  claimStatus: z.enum([
    "new_claim",
    "already_sent",
    "delivery_unknown",
    "delivery_failed",
    "not_required",
    "pending_or_unknown",
  ]),
  eventId: z.string().uuid(),
  workOrderId: z.string().min(1),
  externalWorkOrderId: z.string().min(1),
  previousPriority: workOrderPrioritySchema,
  reportedPriority: workOrderPrioritySchema,
  incidentId: z.string().nullable(),
  storeNumber: z.string().nullable(),
  storeState: z.string().nullable(),
  city: z.string().nullable(),
  address: z.string().nullable(),
  summary: z.string().nullable(),
  contractorName: z.string().nullable(),
  sourceReceivedAt: z.string().min(1),
});

export const emailPriorityDeliveryRetrySchema = z.object({
  eventId: z.string().uuid(),
  deliveryStatus: z.enum(["pending", "failed"]),
  attemptCount: z.number().int().min(1).max(3),
  nextAttemptAt: z.string().nullable(),
});

export type EmailPriorityUpdateResult = z.infer<
  typeof emailPriorityUpdateResultSchema
>;
export type EmailPriorityDeliveryClaim = z.infer<
  typeof emailPriorityDeliveryClaimSchema
>;

export type PriorityIntakeCutoverDecision =
  | { action: "process" }
  | { action: "skip"; reason: string }
  | { action: "hold"; reason: string };

const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function priorityIntakeCutoverDecision(
  receivedAt: string,
  configuredStartAt: string | undefined,
): PriorityIntakeCutoverDecision {
  const rawStartAt = String(configuredStartAt || "").trim();
  if (!rawStartAt) {
    return {
      action: "hold",
      reason: "EMAIL_PRIORITY_INTAKE_START_AT is required before priority updates can run; mailbox left unchanged",
    };
  }

  const startAt = new Date(rawStartAt);
  if (
    !ISO_INSTANT_PATTERN.test(rawStartAt)
    || !Number.isFinite(startAt.getTime())
  ) {
    return {
      action: "hold",
      reason: "EMAIL_PRIORITY_INTAKE_START_AT is invalid; mailbox left unchanged",
    };
  }

  const received = new Date(receivedAt);
  if (!Number.isFinite(received.getTime())) {
    return {
      action: "hold",
      reason: "priority update email has an invalid received time; mailbox left unchanged",
    };
  }

  if (received.getTime() < startAt.getTime()) {
    return {
      action: "skip",
      reason: "priority notice predates the configured priority-intake cutover",
    };
  }

  return { action: "process" };
}

export function emailPrioritySourceMessageId(
  email: Pick<GraphEmail, "id" | "internetMessageId">,
): string {
  const sourceMessageId = String(email.internetMessageId || email.id).trim();
  if (!sourceMessageId) {
    throw new Error("Priority update email is missing a stable message ID");
  }
  if (sourceMessageId.length > 2048) {
    throw new Error("Priority update email message ID is too long");
  }
  return sourceMessageId;
}

export function priorityEscalationSlaFields(
  priority: Priority,
  slaStartedAt: string | null,
) {
  if (!slaStartedAt) {
    return {
      expectedSlaStartedAt: null,
      responseBreachAt: null,
      resolutionBreachAt: null,
    };
  }

  const startedAt = new Date(slaStartedAt);
  if (!Number.isFinite(startedAt.getTime())) {
    throw new Error("Work-order SLA start time is invalid");
  }

  const deadlines = computeSlaBreaches(priority, startedAt);
  return {
    expectedSlaStartedAt: slaStartedAt,
    responseBreachAt: deadlines.responseBreachAt?.toISOString() ?? null,
    resolutionBreachAt: deadlines.resolutionBreachAt?.toISOString() ?? null,
  };
}
