import { createApiMethodBoundary } from "../../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/notifications/assignment-removal", ["POST"]);
export const GET = apiMethodBoundary.methodNotAllowed;
export const PUT = apiMethodBoundary.methodNotAllowed;
export const PATCH = apiMethodBoundary.methodNotAllowed;
export const DELETE = apiMethodBoundary.methodNotAllowed;
export const HEAD = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { legacyErrorResponse } from "../../../../lib/errors/legacyResponse";
import { AppError } from "../../../../lib/errors/AppError";
import { runRequestOperation } from "../../../../lib/server/requestOperation";
import { createRequestContext } from "../../../../lib/observability/requestContext";
import { errorResponse, finalizeApiResponse } from "../../../../lib/errors/httpBoundary";
import { NextRequest, NextResponse } from "next/server";

import { sendWorkOrderAssignmentRemovalNotification } from "../../../../lib/notificationService";
import { requireStaffRequest } from "../../../../lib/server/staffAuthorization";
import { requireLegacyGraphDeliveryConfiguration } from "../../../../lib/config/server/graph";

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

const jsonError = legacyErrorResponse;

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
  const context = createRequestContext(request, "/api/notifications/assignment-removal");
  try {
    return await runRequestOperation(context, async () => {
  const auth = await requireStaffRequest(request);
  if ("error" in auth) return await finalizeApiResponse(await auth.error, context);

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return await finalizeApiResponse(await jsonError("Invalid JSON body", 400), context);
  }

  const deliveryId = String(body.deliveryId || "").trim();
  if (!UUID_PATTERN.test(deliveryId)) {
    return await finalizeApiResponse(await jsonError("A valid deliveryId is required", 400), context);
  }

  const existingDelivery = await auth.sb.from("contractor_assignment_transition_deliveries")
    .select("status").eq("id", deliveryId).maybeSingle();
  if (existingDelivery.error) throw existingDelivery.error;
  requireLegacyGraphDeliveryConfiguration(existingDelivery.data?.status);

  const { data, error: claimError } = await auth.sb.rpc(
    "claim_contractor_assignment_transition_delivery",
    {
      p_delivery_id: deliveryId,
      p_actor_id: auth.profile.id,
    },
  );
  if (claimError) return await finalizeApiResponse(await jsonError(claimError, 409), context);

  const claim = parseClaim(data);
  if (!claim?.claimStatus) {
    return await finalizeApiResponse(await jsonError("Assignment-removal notification claim returned an invalid result", 500), context);
  }
  if (claim.claimStatus === "already_sent") {
    return await finalizeApiResponse(await NextResponse.json({ success: true, delivery: "already_sent" }), context);
  }
  if (claim.claimStatus === "not_deliverable") {
    return await finalizeApiResponse(await NextResponse.json({ success: true, delivery: "not_deliverable" }), context);
  }
  if (
    claim.claimStatus === "pending_or_unknown"
    || claim.claimStatus === "delivery_unknown"
  ) {
    return await finalizeApiResponse(await NextResponse.json(
      { success: false, delivery: claim.claimStatus },
      { status: 202 },
    ), context);
  }
  if (claim.claimStatus !== "new_claim") {
    return await finalizeApiResponse(await jsonError("Assignment-removal notification claim returned an invalid state", 500), context);
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
    return errorResponse(new AppError("RESULT_UNCONFIRMED", { cause: completionError, status: 500 }), context);
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
    await complete("unknown", "DELIVERY_UNKNOWN");
    return errorResponse(new AppError("DELIVERY_UNKNOWN", { cause: error, status: 502 }), context);
  }

  const { error: completionError } = await complete("sent", null);
  if (completionError) {
    return errorResponse(new AppError("DELIVERY_UNKNOWN", { cause: completionError, status: 500 }), context);
  }

  return await finalizeApiResponse(await NextResponse.json({ success: true, delivery: "sent" }), context);

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}
