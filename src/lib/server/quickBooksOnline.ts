import "server-only";

import {
  buildQuickBooksAuthorizationUrl,
  createQuickBooksOAuthState,
  decryptQuickBooksToken,
  encryptQuickBooksToken,
  hashQuickBooksOAuthState,
  isInactiveQuickBooksGrantResponse,
  isQuickBooksRealmId,
  parseQuickBooksTokenResponse,
  QUICKBOOKS_ACCOUNTING_SCOPE,
  resolveQuickBooksConfig,
  resolveQuickBooksEnvironment,
  resolveQuickBooksTokenKeyMaterial,
  type QuickBooksConfig,
  type QuickBooksEnvironment,
  type QuickBooksRevocationOutcome,
  type QuickBooksTokenResponse,
} from "./quickBooksOnlineCore";

export {
  buildQuickBooksAuthorizationUrl,
  createQuickBooksOAuthState,
  decryptQuickBooksToken,
  encryptQuickBooksToken,
  hashQuickBooksOAuthState,
  isInactiveQuickBooksGrantResponse,
  isQuickBooksRealmId,
  QUICKBOOKS_ACCOUNTING_SCOPE,
};
export type {
  QuickBooksConfig,
  QuickBooksEnvironment,
  QuickBooksRevocationOutcome,
  QuickBooksTokenResponse,
};

export type QuickBooksCompanyInfo = {
  companyName: string | null;
};

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

export const getQuickBooksConfig = (
  requestedEnvironment?: QuickBooksEnvironment,
  requestedTokenKeyVersion?: number,
): QuickBooksConfig => {
  const currentConfig = resolveQuickBooksConfig(
    process.env,
    requestedEnvironment,
  );
  if (
    requestedTokenKeyVersion === undefined
    || requestedTokenKeyVersion === currentConfig.tokenKeyVersion
  ) {
    return currentConfig;
  }
  return {
    ...currentConfig,
    ...resolveQuickBooksTokenKeyMaterial(
      process.env,
      requestedTokenKeyVersion,
    ),
  };
};

export const getQuickBooksConfigurationStatus = () => {
  let environment: QuickBooksEnvironment = "sandbox";
  try {
    environment = resolveQuickBooksEnvironment(
      process.env.QUICKBOOKS_ENVIRONMENT,
    );
  } catch (error) {
    return {
      environment,
      configured: false,
      error: error instanceof Error
        ? error.message
        : "QuickBooks configuration is invalid",
    };
  }

  try {
    getQuickBooksConfig(environment);
    return { environment, configured: true, error: null };
  } catch (error) {
    return {
      environment,
      configured: false,
      error: error instanceof Error
        ? error.message
        : "QuickBooks configuration is incomplete",
    };
  }
};

const safeOAuthError = (operation: string, response: Response) =>
  new Error(`QuickBooks ${operation} failed with HTTP ${response.status}`);

export const exchangeQuickBooksAuthorizationCode = async (
  config: QuickBooksConfig,
  code: string,
  redirectUri: string,
): Promise<QuickBooksTokenResponse> => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw safeOAuthError("authorization", response);
  return parseQuickBooksTokenResponse(
    await response.json() as Record<string, unknown>,
  );
};

export const fetchQuickBooksCompanyInfo = async (
  config: QuickBooksConfig,
  accessToken: string,
  realmId: string,
): Promise<QuickBooksCompanyInfo> => {
  const url = new URL(
    `/v3/company/${encodeURIComponent(realmId)}/companyinfo/${encodeURIComponent(realmId)}`,
    config.apiBaseUrl,
  );
  url.searchParams.set("minorversion", "75");
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) throw safeOAuthError("company verification", response);
  const payload = await response.json() as {
    CompanyInfo?: { CompanyName?: unknown; LegalName?: unknown };
  };
  const companyName = String(
    payload.CompanyInfo?.CompanyName || payload.CompanyInfo?.LegalName || "",
  ).trim();
  return { companyName: companyName || null };
};

export const revokeQuickBooksToken = async (
  config: QuickBooksConfig,
  token: string,
): Promise<QuickBooksRevocationOutcome> => {
  const response = await fetch(REVOKE_URL, {
    method: "POST",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) return "confirmed";

  let payload: Record<string, unknown> = {};
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    // A non-JSON failure is never interpreted as a successful revocation.
  }
  if (isInactiveQuickBooksGrantResponse(response.status, payload)) {
    return "already_inactive";
  }
  throw safeOAuthError("disconnect", response);
};
