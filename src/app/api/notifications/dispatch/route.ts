import { createApiMethodBoundary } from "../../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/notifications/dispatch", ["POST"]);
export const GET = apiMethodBoundary.methodNotAllowed;
export const PUT = apiMethodBoundary.methodNotAllowed;
export const PATCH = apiMethodBoundary.methodNotAllowed;
export const DELETE = apiMethodBoundary.methodNotAllowed;
export const HEAD = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { legacyErrorResponse } from "../../../../lib/errors/legacyResponse";
import { runRequestOperation } from "../../../../lib/server/requestOperation";
import { createRequestContext } from "../../../../lib/observability/requestContext";
import { errorResponse, finalizeApiResponse } from "../../../../lib/errors/httpBoundary";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "../../../../lib/supabase/server";
import type { Database } from "../../../../lib/supabase/database.types";
import { z } from "zod";
import { currentSchema } from "../../../../features/receiving-dispatch/contracts";
import { getServerPublicSupabaseConfig } from "../../../../lib/config/server/supabase";

const STAFF_ROLES = new Set(["manager", "dispatcher", "back_office"]);

const jsonError = legacyErrorResponse;

const anonClient = (token?: string) => {
  const configuration = getServerPublicSupabaseConfig();
  return createClient<Database>(
    configuration.url,
    configuration.publishableKey,
    { auth: { autoRefreshToken: false, persistSession: false },
      ...(token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : {}) },
  );
};

const getBearerToken = (req: NextRequest) => {
  const auth = req.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
};

// Kept as a compatibility mapping for existing route characterization tests;
// the queue-aware route no longer passes this payload to a direct sender.
const mapWorkOrder = (wo: Pick<Database["public"]["Tables"]["work_orders"]["Row"], "id" | "duplicate_root_work_order_id">) => ({
  id: wo.id,
  externalWorkOrderId: wo.duplicate_root_work_order_id || wo.id,
});
void mapWorkOrder;

async function requireStaff(req: NextRequest) {
  const token = getBearerToken(req);
  if (!token) return { error: jsonError("Unauthorized", 401) };

  const auth = anonClient();
  const { data: authData, error: authError } = await auth.auth.getUser(token);
  const user = authData.user;
  if (authError || !user) return { error: jsonError("Unauthorized", 401) };

  const sb = createServerClient();
  const { data: profile, error: profileError } = await sb
    .from("profiles")
    .select("id, role, active")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) return { error: jsonError("Dispatch status is unavailable", 503) };
  if (!profile?.active || !STAFF_ROLES.has(profile.role || "")) {
    return { error: jsonError("Forbidden", 403) };
  }

  const permissions = await sb.from("staff_permission_grants").select("permission").eq("profile_id", profile.id);
  if (permissions.error) return { error: jsonError("Dispatch status is unavailable", 503) };
  if (permissions.data.some(grant => grant.permission === "invoice_controller")) {
    return { error: jsonError("Forbidden", 403) };
  }
  return { sb, user, profile, caller: anonClient(token) };
}

export async function POST(req: NextRequest) {
  const context = createRequestContext(req, "/api/notifications/dispatch");
  try {
    return await runRequestOperation(context, async () => {
  const auth = await requireStaff(req);
  if ("error" in auth) return await finalizeApiResponse(await auth.error, context);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return await finalizeApiResponse(await jsonError("Invalid JSON body", 400), context);
  }

  const input = z.strictObject({ workOrderId: z.string().trim().min(1).max(128), contractorId: z.uuid().nullish() }).safeParse(body);
  if (!input.success) return await finalizeApiResponse(await jsonError("Invalid dispatch status request", 400), context);
  const { workOrderId, contractorId: overrideContractorId } = input.data;

  const { sb } = auth;
  const { data: wo, error: woError } = await sb
    .from("work_orders")
    .select("id,contractor_id,contractor_assignment_version,duplicate_root_work_order_id,deleted_at")
    .eq("id", workOrderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (woError) return await finalizeApiResponse(await jsonError("Dispatch status is unavailable", 503), context);
  if (!wo) return await finalizeApiResponse(await jsonError("Work order not found", 404), context);

  if (
    overrideContractorId
    && overrideContractorId !== wo.contractor_id
  ) {
    return await finalizeApiResponse(await jsonError(
      "Contractor no longer matches the work order assignment",
      409,
    ), context);
  }

  const contractorId = wo.contractor_id;
  if (!contractorId) return await finalizeApiResponse(await jsonError("Work order is not assigned to a contractor", 400), context);

  // Assignment commands create the receiving-dispatch outbox row in the same
  // transaction. This compatibility endpoint only acknowledges that durable
  // intent; it never sends an untracked Graph message or accepts a recipient.
  const { data, error } = await auth.caller.rpc("get_receiving_dispatch_current_v1", {
    p_work_order_id: workOrderId, p_assignment_version: wo.contractor_assignment_version,
  }).abortSignal(AbortSignal.timeout(5_000));
  if (error) return await finalizeApiResponse(await jsonError("Dispatch status could not be confirmed. Refresh the work order.", 409), context);
  const parsed = currentSchema.safeParse(data);
  if (!parsed.success || !parsed.data.delivery) {
    return await finalizeApiResponse(await jsonError("No tracked receiving-dispatch record is available for this assignment.", 409), context);
  }
  const delivery = parsed.data.delivery;
  if (delivery.state === "pending") return await finalizeApiResponse(await NextResponse.json({ success: true, status: "queued", deliveryId: delivery.id }), context);
  return await finalizeApiResponse(await NextResponse.json({ success: true, status: delivery.state, deliveryId: delivery.id }), context);

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}
