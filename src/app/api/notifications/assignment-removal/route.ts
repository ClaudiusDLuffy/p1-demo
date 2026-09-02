import { NextRequest, NextResponse } from "next/server";

import { sendWorkOrderAssignmentRemovalNotification } from "../../../../lib/notificationService";
import { requireStaffRequest } from "../../../../lib/server/staffAuthorization";

export const runtime = "nodejs";

type AssignmentTransitionType =
  | "reassigned"
  | "unassigned"
  | "duplicated_for_reassignment";

type AssignmentDeliveryClaim = {
  claimStatus: string;
  deliveryId?: string | null;
  workOrderId?: string | null;
  externalWorkOrderId?: string | null;
  outgoingContractorEmail?: string | null;
  transitionType?: string | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TRANSITION_TYPES = new Set<AssignmentTransitionType>([
  "reassigned",
  "unassigned",
  "duplicated_for_reassignment",
]);

const jsonError = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

const parseClaim = (value: unknown): AssignmentDeliveryClaim | null => {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as AssignmentDeliveryClaim;
};

export async function POST(request: NextRequest) {
  const auth = await requireStaffRequest(request);
  if ("error" in auth) return auth.error;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const deliveryId = String(body.deliveryId || "").trim();
  if (!UUID_PATTERN.test(deliveryId)) {
    return jsonError("A valid deliveryId is required", 400);
  }

  const { data, error: claimError } = await auth.sb.rpc(
    "claim_contractor_assignment_transition_delivery",
    {
      p_delivery_id: deliveryId,
      p_actor_id: auth.profile.id,
    },
  );
  if (claimError) return jsonError(claimError.message, 409);

  const claim = parseClaim(data);
  if (!claim?.claimStatus) {
    return jsonError("Assignment-removal notification claim returned an invalid result", 500);
  }
  if (claim.claimStatus === "already_sent") {
    return NextResponse.json({ success: true, delivery: "already_sent" });
  }
  if (claim.claimStatus === "not_deliverable") {
    return NextResponse.json({ success: true, delivery: "not_deliverable" });
  }
  if (
    claim.claimStatus === "pending_or_unknown"
    || claim.claimStatus === "delivery_unknown"
  ) {
    return NextResponse.json(
      { success: false, delivery: claim.claimStatus },
      { status: 202 },
    );
  }
  if (claim.claimStatus !== "new_claim") {
    return jsonError("Assignment-removal notification claim returned an invalid state", 500);
  }

  const claimedDeliveryId = String(claim.deliveryId || "").trim();
  const workOrderId = String(
    claim.externalWorkOrderId || claim.workOrderId || "",
  ).trim();
  const recipientEmail = String(claim.outgoingContractorEmail || "").trim();
  const transitionType = String(claim.transitionType || "") as AssignmentTransitionType;

  const complete = (status: "sent" | "unknown", errorMessage: string | null) =>
    auth.sb.rpc("complete_contractor_assignment_transition_delivery", {
      p_delivery_id: deliveryId,
      p_status: status,
      p_error_message: errorMessage,
    });

  if (
    claimedDeliveryId !== deliveryId
    || !workOrderId
    || !recipientEmail
    || !TRANSITION_TYPES.has(transitionType)
  ) {
    const message = "Assignment-removal delivery snapshot is incomplete";
    const { error: completionError } = await complete("unknown", message);
    return jsonError(
      completionError
        ? `${message}; audit confirmation also failed: ${completionError.message}`
        : message,
      500,
    );
  }

  try {
    await sendWorkOrderAssignmentRemovalNotification({
      recipientEmail,
      transitionType,
      workOrder: {
        id: workOrderId,
        externalWorkOrderId: workOrderId,
      },
    });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Assignment-removal notification send failed";
    const { error: completionError } = await complete("unknown", message);
    return jsonError(
      completionError
        ? `${message}; delivery outcome and audit confirmation are unknown: ${completionError.message}`
        : `Outgoing contractor email delivery could not be confirmed: ${message}`,
      502,
    );
  }

  const { error: completionError } = await complete("sent", null);
  if (completionError) {
    return jsonError(
      `Outgoing contractor email sent, but delivery confirmation failed: ${completionError.message}`,
      500,
    );
  }

  return NextResponse.json({ success: true, delivery: "sent" });
}
