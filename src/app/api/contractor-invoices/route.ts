import { createApiMethodBoundary } from "../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/contractor-invoices", ["DELETE"]);
export const GET = apiMethodBoundary.methodNotAllowed;
export const POST = apiMethodBoundary.methodNotAllowed;
export const PUT = apiMethodBoundary.methodNotAllowed;
export const PATCH = apiMethodBoundary.methodNotAllowed;
export const HEAD = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { legacyErrorResponse } from "../../../lib/errors/legacyResponse";
import { runRequestOperation } from "../../../lib/server/requestOperation";
import { createRequestContext } from "../../../lib/observability/requestContext";
import { errorResponse, finalizeApiResponse } from "../../../lib/errors/httpBoundary";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "../../../lib/supabase/server";
import {
  isInvoiceControllerProfile,
  loadStaffPermissions,
  STAFF_ROLES,
} from "../../../lib/server/staffAuthorization";
import { FinancialDeleteSchema, FinancialInvoiceIdSchema } from "../../../lib/staffInvoiceContracts";
import { FinancialRequestError, financialErrorResponse, parseFinancialRequest } from "../../../lib/financialHttpBoundary";
import { deleteFinancialCommand } from "../../../lib/staffFinancialCommands";
import type { Database } from "../../../lib/supabase/database.types";
import { getServerPublicSupabaseConfig } from "../../../lib/config/server/supabase";
import { ConfigurationError } from "../../../lib/config/shared";

const jsonError = legacyErrorResponse;

const bearerToken = (request: NextRequest) =>
  request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] || "";

const authClient = () => {
  const configuration = getServerPublicSupabaseConfig();
  return createClient<Database>(
  configuration.url,
  configuration.publishableKey,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
};

async function requireInvoiceStaff(request: NextRequest) {
  const token = bearerToken(request);
  if (!token) return { error: jsonError("Unauthorized", 401) };

  const auth = authClient();
  const { data, error } = await auth.auth.getUser(token);
  if (error || !data.user) return { error: jsonError("Unauthorized", 401) };
  const sb = createServerClient();
  const { data: profile, error: profileError } = await sb
    .from("profiles")
    .select("id, role, name, active")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) return { error: jsonError("Staff access could not be verified", 500) };
  if (!profile?.active || !STAFF_ROLES.has(profile.role || "")) {
    return { error: jsonError("Forbidden", 403) };
  }
  let staffPermissions: string[];
  try {
    staffPermissions = await loadStaffPermissions(sb, profile.id);
  } catch {
    return { error: jsonError("Staff permissions could not be verified", 500) };
  }
  const authorizedProfile = { ...profile, staffPermissions };
  if (isInvoiceControllerProfile(authorizedProfile)) {
    return { error: jsonError("The controller cannot delete contractor invoices", 403) };
  }
  return { sb, user: data.user, profile: authorizedProfile };
}

export async function DELETE(request: NextRequest) {
  const context = createRequestContext(request, "/api/contractor-invoices");
  try {
    return await runRequestOperation(context, async () => {
  try {
    const id = FinancialInvoiceIdSchema.safeParse(request.nextUrl.searchParams.get("id"));
    if (!id.success) throw new FinancialRequestError("FINANCIAL_VALIDATION_FAILED", "A valid invoice id is required", 422);
    const command = await parseFinancialRequest(request, FinancialDeleteSchema);
    const auth = await requireInvoiceStaff(request);
    if ("error" in auth) return await finalizeApiResponse(await auth.error, context);
    const result = await deleteFinancialCommand(auth.sb, auth.user.id, id.data, "contractor", command);
    return await finalizeApiResponse(await NextResponse.json({ invoice: {
      id: result.invoiceId, num: result.invoiceNum, work_order_id: result.workOrderId, deleted_at: result.deletedAt,
    }, command: result }), context);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return await finalizeApiResponse(await financialErrorResponse(error), context);
  }

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}
