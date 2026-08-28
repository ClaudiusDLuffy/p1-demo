import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { sendContractorPortalPing } from "../../../../lib/notificationService";
import { createServerClient } from "../../../../lib/supabase/server";
import type { Database } from "../../../../lib/supabase/database.types";

const STAFF_ROLES = new Set(["manager", "dispatcher", "back_office"]);

const jsonError = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

const anonClient = () =>
  createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

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

  if (profileError) return { error: jsonError(profileError.message, 500) };
  if (!profile?.active || !STAFF_ROLES.has(profile.role || "")) {
    return { error: jsonError("Forbidden", 403) };
  }

  return { sb };
}

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if ("error" in auth) return auth.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const workOrderId = String(body.workOrderId || "").trim();
  const activityId = String(body.activityId || "").trim();
  if (!workOrderId || !activityId) {
    return jsonError("workOrderId and activityId are required", 400);
  }

  const { data: activity, error: activityError } = await auth.sb
    .from("activities")
    .select("id,work_order_id,requires_contractor_attention,deleted_at")
    .eq("id", activityId)
    .eq("work_order_id", workOrderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (activityError) return jsonError(activityError.message, 500);
  if (!activity?.requires_contractor_attention) {
    return jsonError("Contractor attention request not found", 404);
  }

  const { data: workOrder, error: workOrderError } = await auth.sb
    .from("work_orders")
    .select("contractor_id")
    .eq("id", workOrderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (workOrderError) return jsonError(workOrderError.message, 500);
  if (!workOrder?.contractor_id) {
    return jsonError("Work order is not assigned to a contractor", 400);
  }

  const { data: contractor, error: contractorError } = await auth.sb
    .from("profiles")
    .select("email")
    .eq("id", workOrder.contractor_id)
    .maybeSingle();

  if (contractorError) return jsonError(contractorError.message, 500);
  if (!contractor?.email) return jsonError("Contractor email not found", 400);

  try {
    await sendContractorPortalPing(contractor.email);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Notification send failed",
      500,
    );
  }

  return NextResponse.json({ success: true });
}
