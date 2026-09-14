import type { SupabaseClient } from "@supabase/supabase-js";
import { MobileContractError } from "@p1/mobile-contracts";

export type RecoveryTokens = { accessToken: string; refreshToken: string };
export function parseRecoveryLink(url: string): RecoveryTokens | null {
  try {
    const normalized = url.replace("#", "?");
    const parsed = new URL(normalized);
    if (parsed.protocol !== "p1pros:" || parsed.hostname !== "reset-password") return null;
    const type = parsed.searchParams.get("type");
    const accessToken = parsed.searchParams.get("access_token");
    const refreshToken = parsed.searchParams.get("refresh_token");
    return type === "recovery" && accessToken && refreshToken ? { accessToken, refreshToken } : null;
  } catch { return null; }
}
export async function applyRecoveryLink(client: SupabaseClient, url: string): Promise<void> {
  const tokens = parseRecoveryLink(url);
  if (!tokens) throw new MobileContractError("auth_required", "This password-reset link is invalid or expired.");
  const { error } = await client.auth.setSession({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken });
  if (error) throw new MobileContractError("auth_required", "This password-reset link is invalid or expired.");
}
