import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

import {
  canHandoffQuickBooks,
  canExportQuickBooks,
  isInvoiceController,
} from "../staffPermissions";
import { createServerClient } from "../supabase/server";
import type { Database } from "../supabase/database.types";
import { getServerPublicSupabaseConfig } from "../config/server/supabase";

export const STAFF_ROLES = new Set(["manager", "dispatcher", "back_office"]);

export async function loadStaffPermissions(
  supabase: SupabaseClient<Database>,
  profileId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  const query = supabase
    .from("staff_permission_grants")
    .select("permission")
    .eq("profile_id", profileId);
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  signal?.throwIfAborted();
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error("Staff permission result could not be verified");
  return data.map(grant => {
    if (!grant || typeof grant.permission !== "string" || grant.permission.length > 100) {
      throw new Error("Staff permission result could not be verified");
    }
    return grant.permission;
  });
}

export function isInvoiceControllerProfile(profile: {
  staffPermissions?: string[] | null;
} | null | undefined): boolean {
  return isInvoiceController(profile);
}

export function canExportQuickBooksProfile(profile: {
  staffPermissions?: string[] | null;
} | null | undefined): boolean {
  return canExportQuickBooks(profile);
}

export function canHandoffQuickBooksProfile(profile: {
  staffPermissions?: string[] | null;
} | null | undefined): boolean {
  return canHandoffQuickBooks(profile);
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

  const configuration = getServerPublicSupabaseConfig();
  const auth = createClient<Database>(
    configuration.url,
    configuration.publishableKey,
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
