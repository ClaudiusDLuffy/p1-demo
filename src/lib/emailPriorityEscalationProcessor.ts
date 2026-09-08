import {
  isGraphHttpError,
  type GraphEmail,
} from "./graphClient";
import type { ParsedWorkOrder } from "./emailParser";
import {
  emailPriorityDeliveryClaimSchema,
  emailPriorityDeliveryRetrySchema,
  emailPrioritySourceMessageId,
  emailPriorityUpdateResultSchema,
  priorityEscalationSlaFields,
  type EmailPriorityUpdateResult,
} from "./emailPriorityEscalation";
import { intakeErrorMessage } from "./intakeError";
import { sendWorkOrderPriorityEscalationNotification } from "./notificationService";
import { createServerClient } from "./supabase/server";
import type { Json } from "./supabase/database.types";

const PRIORITY_DELIVERY_BATCH_SIZE = 10;

type PriorityNotificationStatus =
  | "not_required"
  | "queued"
  | "pending_or_unknown"
  | "retry_scheduled"
  | "sent"
  | "unknown"
  | "failed";

export type PriorityEscalationProcessingResult = EmailPriorityUpdateResult & {
  notificationStatus: PriorityNotificationStatus;
};

const priorityDeliveryStatus = (
  status: EmailPriorityUpdateResult["deliveryStatus"],
): PriorityNotificationStatus => {
  if (status === "sent") return "sent";
  if (status === "unknown") return "unknown";
  if (status === "failed") return "failed";
  if (status === "claimed") return "pending_or_unknown";
  if (status === "pending") return "queued";
  return "not_required";
};

const deliverPriorityEscalationNotification = async (
  eventId: string,
  accessToken: string,
): Promise<PriorityNotificationStatus> => {
  const sb = createServerClient();
  const { data: claimData, error: claimError } = await sb.rpc(
    "claim_email_priority_escalation_delivery",
    { p_event_id: eventId },
  );
  if (claimError) throw claimError;

  const claim = emailPriorityDeliveryClaimSchema.parse(claimData);
  if (claim.claimStatus !== "new_claim") {
    if (claim.claimStatus === "already_sent") return "sent";
    if (claim.claimStatus === "delivery_unknown") return "unknown";
    if (claim.claimStatus === "delivery_failed") return "failed";
    if (claim.claimStatus === "not_required") return "not_required";
    return "pending_or_unknown";
  }

  try {
    await sendWorkOrderPriorityEscalationNotification(
      {
        workOrder: {
          id: claim.workOrderId,
          externalWorkOrderId: claim.externalWorkOrderId,
          incidentId: claim.incidentId,
          storeNumber: claim.storeNumber,
          city: claim.city,
          state: claim.storeState,
          address: claim.address,
          summary: claim.summary,
        },
        previousPriority: claim.previousPriority,
        newPriority: claim.reportedPriority,
        contractorName: claim.contractorName,
        sourceReceivedAt: claim.sourceReceivedAt,
      },
      accessToken,
    );
  } catch (notificationError) {
    const message = intakeErrorMessage(
      notificationError,
      "Priority escalation notification outcome is unknown",
    );

    if (isGraphHttpError(notificationError)) {
      if (notificationError.retryable) {
        const { data: retryData, error: retryError } = await sb.rpc(
          "retry_email_priority_escalation_delivery",
          {
            p_event_id: eventId,
            p_error_message: message,
            p_retry_after_seconds: notificationError.retryAfterSeconds ?? 30,
          },
        );
        if (retryError) throw retryError;
        const retry = emailPriorityDeliveryRetrySchema.parse(retryData);
        return retry.deliveryStatus === "pending"
          ? "retry_scheduled"
          : "failed";
      }

      if (notificationError.deliveryOutcomeUnknown) {
        const { error: completeError } = await sb.rpc(
          "complete_email_priority_escalation_delivery",
          {
            p_event_id: eventId,
            p_status: "unknown",
            p_error_message: message,
          },
        );
        if (completeError) throw completeError;
        return "unknown";
      }

      const { error: completeError } = await sb.rpc(
        "complete_email_priority_escalation_delivery",
        {
          p_event_id: eventId,
          p_status: "failed",
          p_error_message: message,
        },
      );
      if (completeError) throw completeError;
      return "failed";
    }

    const { error: completeError } = await sb.rpc(
      "complete_email_priority_escalation_delivery",
      {
        p_event_id: eventId,
        p_status: "unknown",
        p_error_message: message,
      },
    );
    if (completeError) throw completeError;
    return "unknown";
  }

  const { error: completeError } = await sb.rpc(
    "complete_email_priority_escalation_delivery",
    {
      p_event_id: eventId,
      p_status: "sent",
      p_error_message: null,
    },
  );
  if (completeError) throw completeError;
  return "sent";
};

export const applyEmailPriorityEscalation = async (
  workOrderId: string,
  parsed: ParsedWorkOrder,
  email: GraphEmail,
  intakePatch?: Json,
): Promise<PriorityEscalationProcessingResult | null> => {
  if (!parsed.priority) return null;

  const receivedAt = new Date(email.receivedDateTime);
  if (!Number.isFinite(receivedAt.getTime())) {
    throw new Error("Priority update email has an invalid received time");
  }

  const sb = createServerClient();
  const { data: workOrder, error: workOrderError } = await sb
    .from("work_orders")
    .select("sla_started_at")
    .eq("id", workOrderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (workOrderError) throw workOrderError;
  if (!workOrder) throw new Error("Active work order not found for priority update");

  const sla = priorityEscalationSlaFields(
    parsed.priority,
    workOrder.sla_started_at,
  );
  const args = {
    p_work_order_id: workOrderId,
    p_reported_priority: parsed.priority,
    p_source_message_id: emailPrioritySourceMessageId(email),
    p_source_received_at: receivedAt.toISOString(),
    p_source_subject: email.subject || "",
    p_expected_sla_started_at: sla.expectedSlaStartedAt,
    p_response_breach_at: sla.responseBreachAt,
    p_resolution_breach_at: sla.resolutionBreachAt,
  };
  const { data, error } = intakePatch === undefined
    ? await sb.rpc("apply_email_work_order_priority_escalation", args)
    : await sb.rpc("refresh_email_work_order_dispatch", {
        ...args,
        p_intake_patch: intakePatch,
        p_afm_email: parsed.afmEmail,
      });
  if (error) throw error;

  const update = emailPriorityUpdateResultSchema.parse(data);
  return {
    ...update,
    notificationStatus: priorityDeliveryStatus(update.deliveryStatus),
  };
};

export const drainPendingPriorityEscalationNotifications = async (
  accessToken: string,
) => {
  const sb = createServerClient();
  const { data, error } = await sb
    .from("email_priority_escalation_events")
    .select("id")
    .eq("delivery_status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(PRIORITY_DELIVERY_BATCH_SIZE);
  if (error) throw error;

  await Promise.all((data || []).map(async event => {
    try {
      await deliverPriorityEscalationNotification(event.id, accessToken);
    } catch (deliveryError) {
      console.error("Pending priority escalation delivery failed", deliveryError);
    }
  }));
};
