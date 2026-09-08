import { sendEmail } from "./graphClient";
import { intakeErrorMessage } from "./intakeError";
import { createWorkOrderAssignmentRemovalNotificationPlan } from "./notificationService";
import { createServerClient } from "./supabase/server";

const EMAIL_ASSIGNMENT_REMOVAL_BATCH_SIZE = 10;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AssignmentRemovalClaim = {
  claimStatus: string;
  deliveryId?: string | null;
  workOrderId?: string | null;
  externalWorkOrderId?: string | null;
  outgoingContractorEmail?: string | null;
  transitionType?: string | null;
};

export type EmailAssignmentRemovalDeliveryResult = {
  deliveryId: string;
  delivery:
    | "sent"
    | "already_sent"
    | "not_deliverable"
    | "pending_or_unknown"
    | "delivery_unknown";
};

const parseClaim = (value: unknown): AssignmentRemovalClaim | null => {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as AssignmentRemovalClaim;
};

const normalizedDeliveryId = (deliveryId: string) => {
  const normalized = deliveryId.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error("A valid assignment-removal delivery ID is required");
  }
  return normalized;
};

const requireAccessToken = (accessToken: string) => {
  if (!accessToken.trim()) {
    throw new Error("Graph access token is unavailable");
  }
};

export async function deliverEmailAssignmentRemoval(
  deliveryId: string,
  accessToken: string,
): Promise<EmailAssignmentRemovalDeliveryResult> {
  const id = normalizedDeliveryId(deliveryId);
  // Never claim a durable delivery unless this process can attempt the send.
  // A missing token leaves the row pending for a later intake cycle.
  requireAccessToken(accessToken);

  const sb = createServerClient();
  const { data, error: claimError } = await sb.rpc(
    "claim_email_assignment_removal_delivery",
    { p_delivery_id: id },
  );
  if (claimError) throw claimError;

  const claim = parseClaim(data);
  if (!claim?.claimStatus) {
    throw new Error("Email assignment-removal claim returned an invalid result");
  }

  if (
    claim.claimStatus === "already_sent"
    || claim.claimStatus === "not_deliverable"
    || claim.claimStatus === "pending_or_unknown"
    || claim.claimStatus === "delivery_unknown"
  ) {
    return {
      deliveryId: id,
      delivery: claim.claimStatus,
    };
  }
  if (claim.claimStatus !== "new_claim") {
    throw new Error("Email assignment-removal claim returned an invalid state");
  }

  const claimedDeliveryId = String(claim.deliveryId || "").trim().toLowerCase();
  const workOrderId = String(
    claim.externalWorkOrderId || claim.workOrderId || "",
  ).trim();
  const recipientEmail = String(claim.outgoingContractorEmail || "").trim();
  const transitionType = String(claim.transitionType || "");

  const complete = (status: "sent" | "unknown", errorMessage: string | null) =>
    sb.rpc("complete_contractor_assignment_transition_delivery", {
      p_delivery_id: id,
      p_status: status,
      p_error_message: errorMessage,
    });

  if (
    claimedDeliveryId !== id
    || !workOrderId
    || !recipientEmail
    || transitionType !== "unassigned"
  ) {
    const message = "Email assignment-removal delivery snapshot is incomplete";
    const { error: completionError } = await complete("unknown", message);
    throw new Error(
      completionError
        ? `${message}; audit confirmation also failed: ${completionError.message}`
        : message,
    );
  }

  const plan = createWorkOrderAssignmentRemovalNotificationPlan({
    recipientEmail,
    transitionType: "unassigned",
    workOrder: {
      id: workOrderId,
      externalWorkOrderId: workOrderId,
    },
  });

  try {
    await sendEmail(accessToken, plan.recipients, plan.subject, plan.body);
  } catch (error) {
    const message = intakeErrorMessage(
      error,
      "Email assignment-removal notification outcome is unknown",
    );
    const { error: completionError } = await complete("unknown", message);
    throw new Error(
      completionError
        ? `${message}; delivery outcome and audit confirmation are unknown: ${completionError.message}`
        : `Outgoing contractor email delivery could not be confirmed: ${message}`,
    );
  }

  const { error: completionError } = await complete("sent", null);
  if (completionError) {
    // The message may already have been accepted. Leave the row claimed so a
    // later cycle reports pending_or_unknown instead of sending a duplicate.
    throw new Error(
      `Outgoing contractor email sent, but delivery confirmation failed: ${completionError.message}`,
    );
  }

  return { deliveryId: id, delivery: "sent" };
}

export async function drainEmailAssignmentRemovals(
  accessToken: string,
): Promise<EmailAssignmentRemovalDeliveryResult[]> {
  requireAccessToken(accessToken);
  const sb = createServerClient();
  const { data, error } = await sb
    .from("email_priority_escalation_events")
    .select(`
      id,
      assignment_removal_delivery_id,
      assignment_delivery:contractor_assignment_transition_deliveries!email_priority_escalation_assignment_removal_delivery_fkey!inner(status)
    `)
    .not("assignment_removal_delivery_id", "is", null)
    .eq("assignment_delivery.status", "pending")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(EMAIL_ASSIGNMENT_REMOVAL_BATCH_SIZE);
  if (error) throw error;

  const delivered = await Promise.all((data || []).map(async row => {
    const id = row.assignment_removal_delivery_id;
    if (!id) return null;
    try {
      return await deliverEmailAssignmentRemoval(id, accessToken);
    } catch (deliveryError) {
      console.error(
        `Pending email assignment-removal delivery ${id} failed`,
        deliveryError,
      );
      return null;
    }
  }));

  return delivered.filter(
    (result): result is EmailAssignmentRemovalDeliveryResult => result !== null,
  );
}
