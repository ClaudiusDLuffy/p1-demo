import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import {
  decryptQuickBooksToken,
  getQuickBooksConfig,
  getQuickBooksConfigurationStatus,
  revokeQuickBooksToken,
  type QuickBooksEnvironment,
} from "../../../../lib/server/quickBooksOnline";
import {
  canHandoffQuickBooksProfile,
  requireStaffRequest,
} from "../../../../lib/server/staffAuthorization";

export const runtime = "nodejs";

const jsonError = (message: string, status: number) =>
  NextResponse.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

const authorize = async (request: NextRequest) => {
  const auth = await requireStaffRequest(request, { allowInvoiceController: true });
  if ("error" in auth) return auth;
  if (!canHandoffQuickBooksProfile(auth.profile)) {
    return { error: jsonError("QuickBooks handoff permission required", 403) };
  }
  return auth;
};

const sandboxConfiguration = () => {
  const configuration = getQuickBooksConfigurationStatus();
  if (configuration.environment !== "sandbox") {
    return {
      configuration,
      error: jsonError(
        "Production QuickBooks connections are locked during sandbox validation",
        409,
      ),
    };
  }
  return { configuration, error: null };
};

export async function GET(request: NextRequest) {
  const auth = await authorize(request);
  if ("error" in auth) return auth.error;

  const { configuration, error: environmentError } = sandboxConfiguration();
  if (environmentError) return environmentError;

  const { data: connection, error } = await auth.sb
    .from("quickbooks_connections")
    .select("id,environment,company_name,status,connected_at,last_verified_at,access_token_expires_at,refresh_token_expires_at,updated_at,token_key_version,token_key_fingerprint")
    .eq("environment", "sandbox")
    .in("status", ["active", "disconnecting"])
    .maybeSingle();
  if (error) return jsonError("QuickBooks connection status could not be loaded", 500);

  const refreshExpiry = connection?.refresh_token_expires_at
    ? new Date(connection.refresh_token_expires_at).getTime()
    : null;
  let keyConfigurationMismatch = false;
  if (connection && configuration.configured) {
    try {
      const currentConfig = getQuickBooksConfig("sandbox");
      keyConfigurationMismatch =
        connection.token_key_version !== currentConfig.tokenKeyVersion
        || connection.token_key_fingerprint !== currentConfig.tokenKeyFingerprint;
    } catch {
      keyConfigurationMismatch = true;
    }
  }

  return NextResponse.json({
    environment: "sandbox",
    configured: configuration.configured,
    configurationError: configuration.error,
    connected: Boolean(connection),
    disconnecting: connection?.status === "disconnecting",
    companyName: connection?.company_name || null,
    connectedAt: connection?.connected_at || null,
    lastVerifiedAt: connection?.last_verified_at || null,
    accessTokenExpiresAt: connection?.access_token_expires_at || null,
    refreshTokenExpiresAt: connection?.refresh_token_expires_at || null,
    requiresReconnect: Boolean(connection) && (
      !configuration.configured
      || keyConfigurationMismatch
      || refreshExpiry === null
      || refreshExpiry <= Date.now()
    ),
    billWritesEnabled: false,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}

type DisconnectClaim = {
  connectionId?: string;
  environment?: QuickBooksEnvironment;
  realmId?: string;
  refreshTokenCiphertext?: string;
  refreshTokenExpiresAt?: string | null;
  tokenKeyVersion?: number;
  tokenKeyFingerprint?: string;
  claimId?: string;
  alreadyDisconnected?: boolean;
  inProgress?: boolean;
  retryAfterSeconds?: number;
};

export async function DELETE(request: NextRequest) {
  const auth = await authorize(request);
  if ("error" in auth) return auth.error;

  const { configuration, error: environmentError } = sandboxConfiguration();
  if (environmentError) return environmentError;

  const { data: connection, error } = await auth.sb
    .from("quickbooks_connections")
    .select("id,updated_at")
    .eq("environment", "sandbox")
    .in("status", ["active", "disconnecting"])
    .maybeSingle();
  if (error) return jsonError("QuickBooks connection could not be loaded", 500);
  // DELETE is idempotent. This also recovers cleanly when Intuit revocation and
  // the final database transaction succeeded but the HTTP response was lost.
  if (!connection) {
    return NextResponse.json({ disconnected: true }, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const requestedClaimId = randomUUID();
  const { data: claimData, error: claimError } = await auth.sb.rpc(
    "claim_quickbooks_connection_disconnect",
    {
      p_connection_id: connection.id,
      p_actor_id: auth.profile.id,
      p_expected_updated_at: connection.updated_at,
      p_claim_id: requestedClaimId,
    },
  );
  if (claimError) {
    return jsonError(
      claimError.code === "PT409"
        ? "QuickBooks connection changed; refresh before disconnecting"
        : "QuickBooks disconnect could not be claimed safely",
      claimError.code === "PT409" ? 409 : 500,
    );
  }

  const claim = (claimData || {}) as DisconnectClaim;
  if (claim.alreadyDisconnected) {
    return NextResponse.json({ disconnected: true }, {
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (claim.inProgress) {
    const retryAfter = Number.isSafeInteger(claim.retryAfterSeconds)
      ? Math.max(1, claim.retryAfterSeconds!)
      : 60;
    return NextResponse.json({
      error: "QuickBooks disconnect is already in progress; retry shortly",
    }, {
      status: 409,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfter),
      },
    });
  }
  if (
    claim.connectionId !== connection.id
    || claim.environment !== "sandbox"
    || !claim.realmId
    || !claim.refreshTokenCiphertext
    || !Number.isSafeInteger(claim.tokenKeyVersion)
    || !claim.tokenKeyFingerprint
    || !claim.claimId
  ) {
    return jsonError("QuickBooks disconnect claim was incomplete", 500);
  }

  const releasePreflightClaim = async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const released = await auth.sb.rpc(
          "release_quickbooks_connection_disconnect",
          {
            p_connection_id: connection.id,
            p_actor_id: auth.profile.id,
            p_claim_id: claim.claimId!,
            p_reason_code: "credential_preflight_failed",
          },
        );
        if (!released.error) return true;
      } catch {
        // The retry handles a transport-ambiguous idempotent release.
      }
    }
    return false;
  };

  let revocationOutcome: "confirmed" | "already_inactive" | "expired";
  const refreshTokenExpiry = claim.refreshTokenExpiresAt
    ? new Date(claim.refreshTokenExpiresAt).getTime()
    : null;
  const refreshTokenIsExpired = refreshTokenExpiry !== null
    && Number.isFinite(refreshTokenExpiry)
    && refreshTokenExpiry <= Date.now();

  if (refreshTokenIsExpired) {
    // An expired grant is already unusable. No secret or Intuit client
    // credential is needed to erase its encrypted local remnants.
    revocationOutcome = "expired";
  } else {
    if (!configuration.configured) {
      const released = await releasePreflightClaim();
      return jsonError(
        released
          ? "QuickBooks configuration must be restored before authorization can be revoked safely"
          : "QuickBooks disconnect is locked for safe recovery; restore the server configuration and retry",
        409,
      );
    }

    let config;
    let refreshToken: string;
    try {
      config = getQuickBooksConfig("sandbox", claim.tokenKeyVersion);
      if (config.tokenKeyFingerprint !== claim.tokenKeyFingerprint) {
        throw new Error("Stored QuickBooks encryption key fingerprint does not match");
      }
      refreshToken = decryptQuickBooksToken(
        config,
        claim.realmId,
        "refresh",
        claim.refreshTokenCiphertext,
      );
    } catch {
      const released = await releasePreflightClaim();
      return jsonError(
        released
          ? "The stored QuickBooks encryption key is unavailable or does not match"
          : "QuickBooks disconnect is locked for safe recovery; restore the stored encryption key and retry",
        409,
      );
    }

    try {
      revocationOutcome = await revokeQuickBooksToken(config, refreshToken);
    } catch {
      // Do not release the claim after an external request: a network failure can
      // mean Intuit processed the revocation but the response was lost. Keeping
      // the claim blocks reconnects and makes a later DELETE safely resume it.
      return jsonError(
        "QuickBooks revocation could not be confirmed. The connection is locked safely; retry disconnect.",
        502,
      );
    }
  }

  let finalized = false;
  for (let attempt = 0; attempt < 2 && !finalized; attempt += 1) {
    try {
      const result = await auth.sb.rpc(
        "finalize_quickbooks_connection_disconnect",
        {
          p_connection_id: connection.id,
          p_actor_id: auth.profile.id,
          p_claim_id: claim.claimId,
          p_revocation_outcome: revocationOutcome,
        },
      );
      finalized = !result.error;
    } catch {
      // A transport failure is ambiguous; retry the idempotent finalizer once.
    }
  }
  if (!finalized) {
    return jsonError(
      "Intuit access was revoked, but local cleanup is pending. Retry disconnect to finish safely.",
      502,
    );
  }

  return NextResponse.json({ disconnected: true }, {
    headers: { "Cache-Control": "no-store" },
  });
}
