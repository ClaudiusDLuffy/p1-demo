import { createApiMethodBoundary } from "../../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/contractor-technicians/manage", ["POST", "DELETE"]);
export const GET = apiMethodBoundary.methodNotAllowed;
export const PUT = apiMethodBoundary.methodNotAllowed;
export const PATCH = apiMethodBoundary.methodNotAllowed;
export const HEAD = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { safeErrorMessage } from "../../../../lib/errors/normalizeUnknown";
import { runRequestOperation } from "../../../../lib/server/requestOperation";
import { createRequestContext } from "../../../../lib/observability/requestContext";
import { errorResponse, finalizeApiResponse } from "../../../../lib/errors/httpBoundary";
import { NextRequest, NextResponse } from "next/server";

import { requireStaffRequest } from "../../../../lib/server/staffAuthorization";
import { getPortalOrigin } from "../../../../lib/config/server/appEnvironment";
import { ConfigurationError } from "../../../../lib/config/shared";

const ACCESS_LEVELS = new Set(["invoice", "report_only"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (value: unknown) => String(value ?? "").trim();

const redirectUrl = getPortalOrigin;

export async function POST(request: NextRequest) {
  const context = createRequestContext(request, "/api/contractor-technicians/manage");
  try {
    return await runRequestOperation(context, async () => {
  const auth = await requireStaffRequest(request);
  if ("error" in auth) return await finalizeApiResponse(await auth.error, context);
  // Validate links before the invitation can be accepted by Auth.
  const invitationOrigin = redirectUrl();

  try {
    const body = await request.json();
    const contractorId = clean(body.contractorId);
    const name = clean(body.name);
    const email = clean(body.email).toLowerCase();
    const phone = clean(body.phone);
    const accessLevel = clean(body.accessLevel);

    if (!contractorId || !name || !email) {
      return await finalizeApiResponse(await NextResponse.json(
        { error: "Contractor, technician name, and email are required" },
        { status: 400 },
      ), context);
    }
    if (!EMAIL_PATTERN.test(email)) {
      return await finalizeApiResponse(await NextResponse.json({ error: "Enter a valid email address" }, { status: 400 }), context);
    }
    if (!ACCESS_LEVELS.has(accessLevel)) {
      return await finalizeApiResponse(await NextResponse.json(
        { error: "Access must be invoice or report only" },
        { status: 400 },
      ), context);
    }

    const [{ data: contractor, error: contractorError }, { data: existingProfile, error: profileError }] = await Promise.all([
      auth.sb
        .from("profiles")
        .select("id,role,active,contractor_organization_id")
        .eq("id", contractorId)
        .maybeSingle(),
      auth.sb
        .from("profiles")
        .select("id,email,role,active,is_assignable,contractor_organization_id,contractor_access_level")
        .ilike("email", email)
        .maybeSingle(),
    ]);
    if (contractorError) throw contractorError;
    if (profileError) throw profileError;
    if (!contractor || contractor.role !== "contractor" || contractor.active !== true) {
      return await finalizeApiResponse(await NextResponse.json({ error: "Active contractor company not found" }, { status: 404 }), context);
    }

    if (existingProfile) {
      if (existingProfile.role !== "contractor") {
        return await finalizeApiResponse(await NextResponse.json(
          { error: "That email belongs to a P1 staff account" },
          { status: 409 },
        ), context);
      }
      if (existingProfile.contractor_access_level === "company_admin") {
        return await finalizeApiResponse(await NextResponse.json(
          { error: "A contractor company administrator cannot be converted to a technician" },
          { status: 409 },
        ), context);
      }
      if (
        existingProfile.contractor_organization_id
        && contractor.contractor_organization_id
        && existingProfile.contractor_organization_id !== contractor.contractor_organization_id
      ) {
        return await finalizeApiResponse(await NextResponse.json(
          { error: "That account already belongs to another contractor company" },
          { status: 409 },
        ), context);
      }
      if (
        existingProfile.active === true
        && existingProfile.is_assignable !== false
        && existingProfile.id !== contractorId
      ) {
        return await finalizeApiResponse(await NextResponse.json(
          { error: "That email is an assignable contractor account and cannot be converted to a technician" },
          { status: 409 },
        ), context);
      }
    }

    let profileId = existingProfile?.id || "";
    let createdAuthUser = false;
    let emailDelivery: "invitation" | "recovery" | "none" = "none";

    if (!profileId) {
      const { data, error } = await auth.sb.auth.admin.inviteUserByEmail(email, {
        data: { name, role: "contractor" },
        redirectTo: invitationOrigin,
      });
      if (error) {
        return await finalizeApiResponse(await NextResponse.json({ error: error.message }, { status: 409 }), context);
      }
      if (!data.user?.id) throw new Error("Supabase did not return the invited user");
      profileId = data.user.id;
      createdAuthUser = true;
      emailDelivery = "invitation";
    } else if (existingProfile?.active !== true) {
      const { error: updateError } = await auth.sb.auth.admin.updateUserById(profileId, {
        ban_duration: "none",
        user_metadata: { name, role: "contractor" },
      });
      if (updateError) throw updateError;
      const { error: recoveryError } = await auth.sb.auth.resetPasswordForEmail(email, {
        redirectTo: invitationOrigin,
      });
      if (recoveryError) throw recoveryError;
      emailDelivery = "recovery";
    }

    const { data: result, error: configureError } = await auth.sb.rpc(
      "configure_contractor_technician",
      {
        p_actor_id: auth.user.id,
        p_contractor_id: contractorId,
        p_profile_id: profileId,
        p_name: name,
        p_phone: phone || null,
        p_access_level: accessLevel,
      },
    );

    if (configureError) {
      if (createdAuthUser) {
        await auth.sb.auth.admin.deleteUser(profileId).catch(() => undefined);
      }
      throw configureError;
    }

    return await finalizeApiResponse(await NextResponse.json({ technician: result, emailDelivery }), context);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return await finalizeApiResponse(await NextResponse.json(
      { error: safeErrorMessage(error) },
      { status: 500 },
    ), context);
  }

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}

export async function DELETE(request: NextRequest) {
  const context = createRequestContext(request, "/api/contractor-technicians/manage");
  try {
    return await runRequestOperation(context, async () => {
  const auth = await requireStaffRequest(request);
  if ("error" in auth) return await finalizeApiResponse(await auth.error, context);

  try {
    const body = await request.json();
    const profileId = clean(body.profileId);
    if (!profileId) {
      return await finalizeApiResponse(await NextResponse.json({ error: "Technician profile is required" }, { status: 400 }), context);
    }

    const { data: result, error } = await auth.sb.rpc(
      "deactivate_contractor_technician",
      {
        p_actor_id: auth.user.id,
        p_profile_id: profileId,
      },
    );
    if (error) throw error;

    const { error: banError } = await auth.sb.auth.admin.updateUserById(profileId, {
      ban_duration: "876000h",
    });

    return await finalizeApiResponse(await NextResponse.json({
      technician: result,
      authDisabled: !banError,
      warning: banError
        ? "Portal access is blocked by the profile wall, but Supabase Auth could not be banned automatically."
        : null,
    }), context);
  } catch (error) {
    return await finalizeApiResponse(await NextResponse.json(
      { error: safeErrorMessage(error) },
      { status: 500 },
    ), context);
  }

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}
