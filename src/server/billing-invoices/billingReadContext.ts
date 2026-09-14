import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { NextRequest } from "next/server";
import type { Database } from "../../lib/supabase/database.types";
import { createServerClient } from "../../lib/supabase/server";
import { getServerPublicSupabaseConfig } from "../../lib/config/server/supabase";
import { legacyErrorResponse } from "../../lib/errors/legacyResponse";
import { isInvoiceControllerProfile, loadStaffPermissions, STAFF_ROLES } from "../../lib/server/staffAuthorization";

export type BillingReadAuthorization = {
  sb: ReturnType<typeof createServerClient>;
  user: { id: string };
  profile: { id: string; role: string | null; name: string | null; active: boolean | null; staffPermissions: string[] };
  isController: boolean;
};

const anonClient = () => {
  const configuration = getServerPublicSupabaseConfig();
  return createClient<Database>(configuration.url, configuration.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
};

const getBearerToken = (request: NextRequest) =>
  (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
const profileSchema = z.object({ id: z.string().uuid(), role: z.string().nullable(),
  name: z.string().nullable().optional(), active: z.boolean().nullable() });

/** Preserves the existing active-user/staff authorization contract. */
export async function authorizeBillingRead(request: NextRequest): Promise<BillingReadAuthorization | { error: Response }> {
  request.signal.throwIfAborted();
  const token = getBearerToken(request);
  if (!token) return { error: legacyErrorResponse("Unauthorized", 401) };
  const auth = anonClient();
  const { data: authData, error: authError } = await auth.auth.getUser(token);
  const user = authData.user;
  if (authError || !user) return { error: legacyErrorResponse("Unauthorized", 401) };
  const sb = createServerClient();
  const { data: rawProfile, error: profileError } = await sb.from("profiles")
    .select("id, role, name, active").eq("id", user.id).abortSignal(request.signal).maybeSingle();
  request.signal.throwIfAborted();
  if (profileError) return { error: legacyErrorResponse("Staff access could not be verified", 500) };
  if (rawProfile === null) return { error: legacyErrorResponse("Forbidden", 403) };
  const parsedProfile = profileSchema.safeParse(rawProfile);
  if (!parsedProfile.success || parsedProfile.data.id !== user.id) return { error: legacyErrorResponse("Staff access could not be verified", 500) };
  const profile = { ...parsedProfile.data, name: parsedProfile.data.name ?? null,
    role: parsedProfile.data.role ?? null, active: parsedProfile.data.active ?? null };
  if (!profile.active || !STAFF_ROLES.has(profile.role || "")) return { error: legacyErrorResponse("Forbidden", 403) };
  try {
    const staffPermissions = await loadStaffPermissions(sb, profile.id, request.signal);
    return { sb, user, profile: { ...profile, staffPermissions }, isController: isInvoiceControllerProfile({ ...profile, staffPermissions }) };
  } catch {
    request.signal.throwIfAborted();
    return { error: legacyErrorResponse("Staff permissions could not be verified", 500) };
  }
}
