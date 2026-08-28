import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { sendDispatchNotification } from "../../../../lib/notificationService";
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
  const auth = req.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
};

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

  if (profileError) return { error: jsonError(profileError.message, 500) };
  if (!profile?.active || !STAFF_ROLES.has(profile.role || "")) {
    return { error: jsonError("Forbidden", 403) };
  }

  return { sb, user, profile };
}

const mapWorkOrder = (wo: any) => ({
  id: wo.id,
  incidentId: wo.incident_id,
  storeNumber: wo.store_number,
  city: wo.city,
  state: wo.store_state,
  address: wo.address,
  priority: wo.priority,
  summary: wo.summary,
  description: wo.description,
});

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if ("error" in auth) return auth.error;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const workOrderId = String(body.workOrderId || "").trim();
  const overrideContractorId = body.contractorId ? String(body.contractorId).trim() : "";
  if (!workOrderId) return jsonError("workOrderId is required", 400);

  const { sb } = auth;
  const { data: wo, error: woError } = await (sb as any)
    .from("work_orders")
    .select("id,incident_id,store_number,city,store_state,address,priority,summary,description,contractor_id,deleted_at")
    .eq("id", workOrderId)
    .is("deleted_at", null)
    .maybeSingle();

  if (woError) return jsonError(woError.message, 500);
  if (!wo) return jsonError("Work order not found", 404);

  const contractorId = overrideContractorId || wo.contractor_id;
  if (!contractorId) return jsonError("Work order is not assigned to a contractor", 400);

  const { data: contractor, error: contractorError } = await sb
    .from("profiles")
    .select("id,email,name,company")
    .eq("id", contractorId)
    .maybeSingle();

  if (contractorError) return jsonError(contractorError.message, 500);
  if (!contractor?.email) return jsonError("Contractor email not found", 400);

  try {
    await sendDispatchNotification({
      workOrder: mapWorkOrder(wo),
      contractorAssigned: true,
      contractorEmail: contractor.email,
      contractorName: contractor.company || contractor.name || "Contractor",
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Notification send failed", 500);
  }

  return NextResponse.json({ success: true });
}
