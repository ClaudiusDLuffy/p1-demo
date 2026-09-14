import { createApiMethodBoundary } from "../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/parts-order-settings", ["GET", "PATCH"]);
export const POST = apiMethodBoundary.methodNotAllowed;
export const PUT = apiMethodBoundary.methodNotAllowed;
export const DELETE = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { runRequestOperation } from "../../../lib/server/requestOperation";
import { createRequestContext } from "../../../lib/observability/requestContext";
import { errorResponse, finalizeApiResponse } from "../../../lib/errors/httpBoundary";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireStaffRequest } from "../../../lib/server/staffAuthorization";
import type { Database } from "../../../lib/supabase/database.types";
import { partsSettingsCommandSchema } from "../../../features/parts-sms/settingsContract";

export const runtime = "nodejs";

const jsonError = (message: string, status: number, code = "SETTINGS_UNAVAILABLE") =>
  NextResponse.json({ error: message, code }, { status });

const authFailure = (status: number) => status === 401
  ? jsonError("Sign in again to manage parts alerts.", 401, "AUTH_REQUIRED")
  : status === 403 ? jsonError("Operational staff access is required.", 403, "FORBIDDEN")
    : jsonError("Could not verify your account. Try again.", 503);

async function loadConfiguration(sb: SupabaseClient<Database>) {
  const [settingsResult, recipientsResult] = await Promise.all([
    sb
      .from("p1_parts_alert_settings")
      .select("enabled,timezone,cutoff_time,updated_at")
      .eq("singleton", true)
      .maybeSingle(),
    sb
      .from("p1_parts_alert_recipients")
      .select("id,profile_id,phone_e164,active,profiles!p1_parts_alert_recipients_profile_id_fkey(name,email)")
      .eq("active", true)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(26),
  ]);
  if (settingsResult.error) throw settingsResult.error;
  if (recipientsResult.error) throw recipientsResult.error;
  if ((recipientsResult.data || []).length > 25) throw new Error("Parts settings capacity needs review");

  return {
    enabled: Boolean(settingsResult.data?.enabled),
    timezone: settingsResult.data?.timezone || "America/New_York",
    cutoffTime: settingsResult.data?.cutoff_time
      ? String(settingsResult.data.cutoff_time).slice(0, 5)
      : null,
    updatedAt: settingsResult.data?.updated_at || null,
    recipients: (recipientsResult.data || []).map(recipient => ({
      id: recipient.id,
      profileId: recipient.profile_id,
      phoneE164: recipient.phone_e164,
      active: recipient.active,
      name: recipient.profiles?.name || "Staff member",
      email: recipient.profiles?.email || null,
    })),
  };
}

export async function GET(request: NextRequest) {
  const context = createRequestContext(request, "/api/parts-order-settings");
  try {
    return await runRequestOperation(context, async () => {
  try {
    const auth = await requireStaffRequest(request);
    if ("error" in auth) return await finalizeApiResponse(await authFailure(auth.error?.status || 503), context);
    return await finalizeApiResponse(await NextResponse.json(await loadConfiguration(auth.sb)), context);
  } catch {
    return await finalizeApiResponse(await jsonError("Could not load parts alert settings. Try again.", 503), context);
  }

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}

export async function PATCH(request: NextRequest) {
  const context = createRequestContext(request, "/api/parts-order-settings");
  try {
    return await runRequestOperation(context, async () => {
  try {
    const auth = await requireStaffRequest(request);
    if ("error" in auth) return await finalizeApiResponse(await authFailure(auth.error?.status || 503), context);
    const parsed = partsSettingsCommandSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return await finalizeApiResponse(await jsonError("Check enabled, recipients, timezone and cutoff. Use actual booleans, up to 25 unique staff profiles, E.164 numbers and HH:MM time.", 400, "VALIDATION_FAILED"), context);
    const { enabled, timezone, cutoffTime, recipients } = parsed.data;

    const { error } = await auth.sb.rpc("configure_p1_parts_alerts", {
      p_actor_id: auth.profile.id,
      p_enabled: enabled,
      p_timezone: timezone,
      p_cutoff_time: cutoffTime,
      p_recipients: recipients,
    });
    if (error) return await finalizeApiResponse(await error.code === "42501"
      ? authFailure(403) : error.code === "22023" || error.code === "23514"
        ? jsonError("The configuration is no longer valid. Check the active staff recipients and try again.", 400, "VALIDATION_FAILED")
        : jsonError("Could not save settings. Refresh before trying again.", 503), context);

    return await finalizeApiResponse(await NextResponse.json(await loadConfiguration(auth.sb)), context);
  } catch {
    return await finalizeApiResponse(await jsonError("Could not confirm the saved settings. Refresh before trying again.", 503), context);
  }

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}
