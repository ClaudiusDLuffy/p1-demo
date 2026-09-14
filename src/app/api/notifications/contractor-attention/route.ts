import { createApiMethodBoundary } from "../../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/notifications/contractor-attention", ["POST"]);
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
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { sendContractorPortalPing } from "../../../../lib/notificationService";
import { createServerClient } from "../../../../lib/supabase/server";
import type { Database } from "../../../../lib/supabase/database.types";
import { getServerPublicSupabaseConfig } from "../../../../lib/config/server/supabase";
import { requireLegacyGraphDeliveryConfiguration } from "../../../../lib/config/server/graph";

const STAFF_ROLES = new Set(["manager", "dispatcher", "back_office"]);

const jsonError = legacyErrorResponse;

const anonClient = () => {
  const configuration = getServerPublicSupabaseConfig();
  return createClient<Database>(
    configuration.url,
    configuration.publishableKey,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
};

const getBearerToken = (req: NextRequest) => {
  const match = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
};

async function requireStaff(req: NextRequest) {
  const token = getBearerToken(req);
  if (!token) return { error: jsonError("Unauthorized", 401) };

  const auth = anonClient();
  const { data, error } = await auth.auth.getUser(token);
  if (error || !data.user) return { error: jsonError("Unauthorized", 401) };

  const sb = createServerClient();
  const { data: profile, error: profileError } = await sb
    .from("profiles")
    .select("id,role,active")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profileError) return { error: jsonError(profileError, 500) };
  if (!profile?.active || !STAFF_ROLES.has(profile.role || "")) {
    return { error: jsonError("Forbidden", 403) };
  }

  return { sb, profile };
}

export async function POST(req: NextRequest) {
  const context = createRequestContext(req, "/api/notifications/contractor-attention");
  try {
    return await runRequestOperation(context, async () => {
  const auth = await requireStaff(req);
  if ("error" in auth) return await finalizeApiResponse(await auth.error, context);

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return await finalizeApiResponse(await jsonError("Invalid JSON body", 400), context);
  }

  const workOrderId = String(body.workOrderId || "").trim();
  const activityId = String(body.activityId || "").trim();
  if (!workOrderId || !activityId) {
    return await finalizeApiResponse(await jsonError("workOrderId and activityId are required", 400), context);
  }

  const { data: activity, error: activityError } = await auth.sb
    .from("activities")
    .select("id,work_order_id,requires_contractor_attention,contractor_assignment_version,created_at,deleted_at")
    .eq("id", activityId)
    .eq("work_order_id", workOrderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (activityError) return await finalizeApiResponse(await jsonError(activityError, 500), context);
  if (!activity?.requires_contractor_attention) {
    return await finalizeApiResponse(await jsonError("Contractor attention request not found", 404), context);
  }

  const { data: workOrder, error: workOrderError } = await auth.sb
    .from("work_orders")
    .select("contractor_id,contractor_assignment_version,contractor_assignment_started_at")
    .eq("id", workOrderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (workOrderError) return await finalizeApiResponse(await jsonError(workOrderError, 500), context);
  if (!workOrder?.contractor_id) {
    return await finalizeApiResponse(await jsonError("Work order is not assigned to a contractor", 400), context);
  }

  const activityCreatedAt = Date.parse(activity.created_at || "");
  const assignmentStartedAt = Date.parse(
    workOrder.contractor_assignment_started_at || "",
  );
  if (
    activity.contractor_assignment_version !== workOrder.contractor_assignment_version
    || !Number.isFinite(activityCreatedAt)
    || !Number.isFinite(assignmentStartedAt)
    || activityCreatedAt < assignmentStartedAt
  ) {
    return await finalizeApiResponse(await jsonError(
      "Contractor assignment changed before the notification could be sent",
      409,
    ), context);
  }

  const { data: contractor, error: contractorError } = await auth.sb
    .from("profiles")
    .select("email,role,active")
    .eq("id", workOrder.contractor_id)
    .maybeSingle();

  if (contractorError) return await finalizeApiResponse(await jsonError(contractorError, 500), context);
  if (contractor?.role !== "contractor" || !contractor.active) {
    return await finalizeApiResponse(await jsonError("Assigned contractor account is inactive or invalid", 409), context);
  }
  if (!contractor?.email) return await finalizeApiResponse(await jsonError("Contractor email not found", 400), context);

  // A bounded state read avoids consuming a first claim on local configuration
  // failure. Existing terminal/claimed replay still goes through the original
  // command's current actor, activity and assignment authorization below.
  const existingDelivery = await auth.sb.from("contractor_activity_alert_deliveries")
    .select("status").eq("activity_id", activityId).maybeSingle();
  if (existingDelivery.error) throw existingDelivery.error;
  requireLegacyGraphDeliveryConfiguration(existingDelivery.data?.status);

  const { data: deliveryClaim, error: claimError } = await auth.sb.rpc(
    "claim_contractor_activity_alert_delivery",
    {
      p_activity_id: activityId,
      p_work_order_id: workOrderId,
      p_actor_id: auth.profile.id,
    },
  );
  if (claimError) return await finalizeApiResponse(await jsonError(claimError, 409), context);
  if (deliveryClaim === "already_sent") {
    return await finalizeApiResponse(await NextResponse.json({
      success: true,
      delivery: "already_sent",
    }), context);
  }
  if (deliveryClaim === "pending_or_unknown") {
    return await finalizeApiResponse(await NextResponse.json(
      { success: false, delivery: "pending_or_unknown" },
      { status: 202 },
    ), context);
  }
  if (deliveryClaim === "delivery_unknown") {
    return await finalizeApiResponse(await NextResponse.json(
      { success: false, delivery: "delivery_unknown" },
      { status: 202 },
    ), context);
  }
  if (deliveryClaim !== "new_claim") {
    return await finalizeApiResponse(await jsonError("Contractor notification claim returned an invalid state", 500), context);
  }

  try {
    await sendContractorPortalPing(contractor.email);
  } catch (error) {
    await auth.sb.rpc(
      "complete_contractor_activity_alert_delivery",
      {
        p_activity_id: activityId,
        p_status: "unknown",
        p_error_message: "DELIVERY_UNKNOWN",
      },
    );
    return errorResponse(new AppError("DELIVERY_UNKNOWN", { cause: error, status: 502 }), context);
  }

  const { error: completionError } = await auth.sb.rpc(
    "complete_contractor_activity_alert_delivery",
    {
      p_activity_id: activityId,
      p_status: "sent",
      p_error_message: null,
    },
  );
  if (completionError) {
    return errorResponse(new AppError("DELIVERY_UNKNOWN", { cause: completionError, status: 500 }), context);
  }

  return await finalizeApiResponse(await NextResponse.json({ success: true, delivery: "sent" }), context);

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}
