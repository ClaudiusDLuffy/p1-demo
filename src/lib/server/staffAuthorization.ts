import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

import { STAFF_PERMISSION } from "../staffPermissions";
import { createServerClient } from "../supabase/server";
import type { Database } from "../supabase/database.types";

export const STAFF_ROLES = new Set(["manager", "dispatcher", "back_office"]);

export async function loadStaffPermissions(
  supabase: SupabaseClient<Database>,
  profileId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("staff_permission_grants")
    .select("permission")
    .eq("profile_id", profileId);
  if (error) throw error;
  return (data || []).map(grant => String(grant.permission));
}

export function isInvoiceControllerProfile(profile: {
  staffPermissions?: string[] | null;
} | null | undefined): boolean {
  return Array.isArray(profile?.staffPermissions)
    && profile.staffPermissions.includes(STAFF_PERMISSION.invoiceController);
}

export async function requireStaffRequest(
  request: NextRequest,
  options: { allowInvoiceController?: boolean } = {},
) {
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const auth = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data, error: authError } = await auth.auth.getUser(token);
  if (authError || !data.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const sb = createServerClient();
  const { data: profile, error: profileError } = await sb
    .from("profiles")
    .select("id,name,email,role,active")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) {
    return { error: NextResponse.json({ error: profileError.message }, { status: 500 }) };
  }
  if (!profile?.active || !STAFF_ROLES.has(profile.role || "")) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  try {
    const staffPermissions = await loadStaffPermissions(sb, profile.id);
    if (
      !options.allowInvoiceController
      && isInvoiceControllerProfile({ staffPermissions })
    ) {
      return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return {
      sb,
      user: data.user,
      profile: { ...profile, staffPermissions },
    };
  } catch (permissionError) {
    return {
      error: NextResponse.json(
        { error: permissionError instanceof Error ? permissionError.message : "Permission lookup failed" },
        { status: 500 },
      ),
    };
  }
}
