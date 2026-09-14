import { MobileContractError, parseMobileProfile, type MobileProfile } from "@p1/mobile-contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ProfileBoundary = {
  readProfile(userId: string): Promise<{ data: unknown; error: unknown }>;
  readScope(): Promise<{ data: unknown; error: unknown }>;
};
export function createProfileBoundary(client: SupabaseClient): ProfileBoundary {
  return {
    async readProfile(userId) {
      const result = await client.from("profiles").select("id,role,active,name,email").eq("id", userId).maybeSingle();
      return { data: result.data, error: result.error };
    },
    async readScope() {
      const result = await client.rpc("get_my_contractor_scope");
      return { data: result.data, error: result.error };
    },
  };
}
export async function loadMobileProfile(boundary: ProfileBoundary, userId: string): Promise<MobileProfile> {
  const profile = await boundary.readProfile(userId);
  if (profile.error) throw profile.error;
  if (!profile.data) throw new MobileContractError("profile_missing", "No active profile is assigned to this account.");
  const record = profile.data as Record<string, unknown>;
  if (record.id !== userId) throw new MobileContractError("profile_invalid", "Your profile identity could not be verified.");
  if (record.active === false) return parseMobileProfile(record, {}, userId);
  const scope = await boundary.readScope();
  if (scope.error && record.role === "contractor") throw scope.error;
  return parseMobileProfile(record, scope.data ?? {}, userId);
}
