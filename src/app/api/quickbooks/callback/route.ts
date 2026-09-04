import { NextRequest, NextResponse } from "next/server";

import {
  encryptQuickBooksToken,
  exchangeQuickBooksAuthorizationCode,
  fetchQuickBooksCompanyInfo,
  getQuickBooksConfig,
  hashQuickBooksOAuthState,
  isQuickBooksRealmId,
  revokeQuickBooksToken,
  type QuickBooksEnvironment,
} from "../../../../lib/server/quickBooksOnline";
import { STAFF_ROLES } from "../../../../lib/server/staffAuthorization";
import { createServerClient } from "../../../../lib/supabase/server";

export const runtime = "nodejs";

const STATE_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;

const portalRedirect = (
  request: NextRequest,
  status: "connected" | "cancelled" | "pending" | "error",
  reason?: string,
) => {
  const configuredBase = String(
    process.env.NEXT_PUBLIC_APP_URL || process.env.PORTAL_URL || "",
  ).trim();
  let url: URL;
  try {
    url = configuredBase ? new URL(configuredBase) : new URL(request.nextUrl.origin);
  } catch {
    url = new URL(request.nextUrl.origin);
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.searchParams.set("quickbooks", status);
  if (reason) url.searchParams.set("reason", reason);
  const response = NextResponse.redirect(url, { status: 303 });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
};

type OAuthStateRow = {
  actor_id: string;
  environment: QuickBooksEnvironment;
  redirect_uri: string;
  created_at: string;
};

type SaveOutcome = "not_attempted" | "saved" | "rejected" | "ambiguous";

const isDefinitiveDatabaseRejection = (error: unknown) => {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return typeof error.code === "string" && error.code.length > 0;
};

export async function GET(request: NextRequest) {
  const rawState = String(request.nextUrl.searchParams.get("state") || "").trim();
  if (!STATE_PATTERN.test(rawState)) {
    return portalRedirect(request, "error", "invalid_state");
  }

  const sb = createServerClient();
  const realmId = String(request.nextUrl.searchParams.get("realmId") || "").trim();
  const usedAt = new Date().toISOString();
  const stateUpdate: { used_at: string; used_realm_id?: string } = { used_at: usedAt };
  if (isQuickBooksRealmId(realmId)) stateUpdate.used_realm_id = realmId;
  const { data: consumedState, error: stateError } = await sb
    .from("quickbooks_oauth_states")
    .update(stateUpdate)
    .eq("state_hash", hashQuickBooksOAuthState(rawState))
    .is("used_at", null)
    .gt("expires_at", usedAt)
    .select("actor_id,environment,redirect_uri,created_at")
    .maybeSingle();
  if (stateError || !consumedState) {
    return portalRedirect(request, "error", "expired_state");
  }
  const oauthState = consumedState as OAuthStateRow;

  if (oauthState.environment !== "sandbox") {
    return portalRedirect(request, "error", "production_locked");
  }

  if (request.nextUrl.searchParams.has("error")) {
    return portalRedirect(request, "cancelled");
  }

  const code = String(request.nextUrl.searchParams.get("code") || "").trim();
  if (!code || code.length > 4_096 || !isQuickBooksRealmId(realmId)) {
    return portalRedirect(request, "error", "invalid_callback");
  }

  const [profileResult, permissionResult] = await Promise.all([
    sb
      .from("profiles")
      .select("id,role,active")
      .eq("id", oauthState.actor_id)
      .maybeSingle(),
    sb
      .from("staff_permission_grants")
      .select("profile_id")
      .eq("profile_id", oauthState.actor_id)
      .eq("permission", "quickbooks_handoff")
      .maybeSingle(),
  ]);
  if (
    profileResult.error
    || permissionResult.error
    || !profileResult.data?.active
    || !STAFF_ROLES.has(profileResult.data.role || "")
    || !permissionResult.data
  ) {
    return portalRedirect(request, "error", "authorization_changed");
  }

  let refreshTokenForCleanup = "";
  let saveWasAttempted = false;
  let saveOutcome: SaveOutcome = "not_attempted";
  let candidateRevocationIsSafe = false;
  let persistenceNeedsVerification = false;
  try {
    const config = getQuickBooksConfig(oauthState.environment);
    if (config.redirectUri !== oauthState.redirect_uri) {
      return portalRedirect(request, "error", "configuration_changed");
    }

    const tokens = await exchangeQuickBooksAuthorizationCode(
      config,
      code,
      oauthState.redirect_uri,
    );
    refreshTokenForCleanup = tokens.refreshToken;
    const company = await fetchQuickBooksCompanyInfo(config, tokens.accessToken, realmId);
    const authorizationAttemptHash = hashQuickBooksOAuthState(rawState);
    const accessTokenCiphertext = encryptQuickBooksToken(
      config,
      realmId,
      "access",
      tokens.accessToken,
    );
    const refreshTokenCiphertext = encryptQuickBooksToken(
      config,
      realmId,
      "refresh",
      tokens.refreshToken,
    );
    const saveArgs = {
      p_actor_id: oauthState.actor_id,
      p_environment: config.environment,
      p_realm_id: realmId,
      p_company_name: company.companyName || "",
      p_scope: tokens.scope,
      p_access_token_ciphertext: accessTokenCiphertext,
      p_refresh_token_ciphertext: refreshTokenCiphertext,
      p_access_token_expires_at: tokens.accessTokenExpiresAt,
      p_refresh_token_expires_at: tokens.refreshTokenExpiresAt,
      p_token_key_version: config.tokenKeyVersion,
      p_token_key_fingerprint: config.tokenKeyFingerprint,
      p_authorization_attempt_hash: authorizationAttemptHash,
      p_authorization_attempt_created_at: oauthState.created_at,
    };

    // The consumed state hash is the database idempotency key. A transport
    // failure is not proof that the RPC rolled back, so keep that outcome
    // distinct from a database rejection before considering token cleanup.
    let saveError: unknown = null;
    let sawAmbiguousSaveAttempt = false;
    for (let attempt = 0; attempt < 2 && saveOutcome !== "saved"; attempt += 1) {
      saveOutcome = "ambiguous";
      try {
        saveWasAttempted = true;
        const result = await sb.rpc("save_quickbooks_connection", saveArgs);
        saveError = result.error;
        if (!result.error) {
          saveOutcome = "saved";
          break;
        }
        if (isDefinitiveDatabaseRejection(result.error)) {
          if (!sawAmbiguousSaveAttempt) saveOutcome = "rejected";
          break;
        }
        sawAmbiguousSaveAttempt = true;
      } catch (error) {
        saveError = error;
        sawAmbiguousSaveAttempt = true;
      }
    }

    if (saveOutcome !== "saved") {
      const [persistedAttempt, sameRealmConnection] = await Promise.all([
        sb
          .from("quickbooks_connection_events")
          .select("connection_id")
          .eq("authorization_attempt_hash", authorizationAttemptHash)
          .maybeSingle(),
        sb
          .from("quickbooks_connections")
          .select("id,status,last_authorization_attempt_hash")
          .eq("environment", oauthState.environment)
          .eq("realm_id", realmId)
          .in("status", ["active", "disconnecting"])
          .maybeSingle(),
      ]);

      const persistedConnectionIsCurrent = Boolean(
        persistedAttempt.data
        && sameRealmConnection.data
        && persistedAttempt.data.connection_id === sameRealmConnection.data.id
        && sameRealmConnection.data.status === "active"
        && sameRealmConnection.data.last_authorization_attempt_hash
          === authorizationAttemptHash,
      );

      if (persistedConnectionIsCurrent) {
        saveOutcome = "saved";
      } else if (
        persistedAttempt.error
        || sameRealmConnection.error
        || sameRealmConnection.data
        || (!persistedAttempt.data && saveOutcome !== "rejected")
      ) {
        // A failed safety lookup, a transport-ambiguous RPC, or any protected
        // same-realm connection means revocation could invalidate credentials
        // that are already current. Preserve the candidate for reconciliation.
        saveOutcome = "ambiguous";
        persistenceNeedsVerification = true;
      } else {
        // Every save attempt received a definite database rejection, the
        // idempotency event is absent, and no protected same-realm connection
        // exists. Only this fully confirmed case permits candidate cleanup.
        candidateRevocationIsSafe = true;
      }
    }

    if (saveOutcome !== "saved") {
      throw saveError || new Error("QuickBooks connection could not be saved");
    }
    refreshTokenForCleanup = "";

    return portalRedirect(request, "connected");
  } catch {
    if (refreshTokenForCleanup && !saveWasAttempted) {
      const sameRealmConnection = await sb
        .from("quickbooks_connections")
        .select("id")
        .eq("environment", oauthState.environment)
        .eq("realm_id", realmId)
        .in("status", ["active", "disconnecting"])
        .maybeSingle();
      candidateRevocationIsSafe = !sameRealmConnection.error
        && !sameRealmConnection.data;
    }

    if (refreshTokenForCleanup && candidateRevocationIsSafe) {
      try {
        const config = getQuickBooksConfig(oauthState.environment);
        await revokeQuickBooksToken(config, refreshTokenForCleanup);
      } catch {
        // The callback never exposes or logs credentials, even if cleanup fails.
      }
    }
    if (persistenceNeedsVerification) {
      return portalRedirect(request, "pending", "persistence_pending");
    }
    return portalRedirect(request, "error", "connection_failed");
  }
}
