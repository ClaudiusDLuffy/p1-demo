import { NextRequest, NextResponse } from "next/server";

import { requireStaffRequest } from "../../../../lib/server/staffAuthorization";

const ACCESS_LEVELS = new Set(["invoice", "report_only"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (value: unknown) => String(value ?? "").trim();

function redirectUrl(request: NextRequest) {
  const configured = clean(process.env.NEXT_PUBLIC_APP_URL).replace(/\/$/, "");
  return configured || request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  const auth = await requireStaffRequest(request);
  if ("error" in auth) return auth.error;

  try {
    const body = await request.json();
    const contractorId = clean(body.contractorId);
    const name = clean(body.name);
    const email = clean(body.email).toLowerCase();
    const phone = clean(body.phone);
    const accessLevel = clean(body.accessLevel);

    if (!contractorId || !name || !email) {
      return NextResponse.json(
        { error: "Contractor, technician name, and email are required" },
        { status: 400 },
      );
    }
    if (!EMAIL_PATTERN.test(email)) {
      return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
    }
    if (!ACCESS_LEVELS.has(accessLevel)) {
      return NextResponse.json(
        { error: "Access must be invoice or report only" },
        { status: 400 },
      );
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
      return NextResponse.json({ error: "Active contractor company not found" }, { status: 404 });
    }

    if (existingProfile) {
      if (existingProfile.role !== "contractor") {
        return NextResponse.json(
          { error: "That email belongs to a P1 staff account" },
          { status: 409 },
        );
      }
      if (existingProfile.contractor_access_level === "company_admin") {
        return NextResponse.json(
          { error: "A contractor company administrator cannot be converted to a technician" },
          { status: 409 },
        );
      }
      if (
        existingProfile.contractor_organization_id
        && contractor.contractor_organization_id
        && existingProfile.contractor_organization_id !== contractor.contractor_organization_id
      ) {
        return NextResponse.json(
          { error: "That account already belongs to another contractor company" },
          { status: 409 },
        );
      }
      if (
        existingProfile.active === true
        && existingProfile.is_assignable !== false
        && existingProfile.id !== contractorId
      ) {
        return NextResponse.json(
          { error: "That email is an assignable contractor account and cannot be converted to a technician" },
          { status: 409 },
        );
      }
    }

    let profileId = existingProfile?.id || "";
    let createdAuthUser = false;
    let emailDelivery: "invitation" | "recovery" | "none" = "none";

    if (!profileId) {
      const { data, error } = await auth.sb.auth.admin.inviteUserByEmail(email, {
        data: { name, role: "contractor" },
        redirectTo: redirectUrl(request),
      });
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 409 });
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
        redirectTo: redirectUrl(request),
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

    return NextResponse.json({ technician: result, emailDelivery });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not configure technician" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireStaffRequest(request);
  if ("error" in auth) return auth.error;

  try {
    const body = await request.json();
    const profileId = clean(body.profileId);
    if (!profileId) {
      return NextResponse.json({ error: "Technician profile is required" }, { status: 400 });
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

    return NextResponse.json({
      technician: result,
      authDisabled: !banError,
      warning: banError
        ? "Portal access is blocked by the profile wall, but Supabase Auth could not be banned automatically."
        : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not deactivate technician" },
      { status: 500 },
    );
  }
}
