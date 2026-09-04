import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Pure Node.js helpers for the server-only QuickBooks facade.
 *
 * This module never reads ambient environment variables and never owns a
 * credential. Client code must import neither this module nor the server-only
 * facade; the Node crypto dependency also keeps it outside browser bundles.
 */

export type QuickBooksEnvironment = "sandbox" | "production";

export type QuickBooksConfig = {
  environment: QuickBooksEnvironment;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiBaseUrl: string;
  tokenKey: Buffer;
  tokenKeyVersion: number;
  tokenKeyFingerprint: string;
};

export type QuickBooksTokenResponse = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string | null;
  scope: string;
};

export type QuickBooksRevocationOutcome = "confirmed" | "already_inactive";

export type QuickBooksEnvironmentValues = Readonly<Record<string, string | undefined>>;

export const QUICKBOOKS_ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";
export const QUICKBOOKS_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";

const environmentPrefix = (environment: QuickBooksEnvironment) =>
  environment === "sandbox" ? "QUICKBOOKS_SANDBOX" : "QUICKBOOKS_PRODUCTION";

export function resolveQuickBooksEnvironment(
  rawValue: unknown,
): QuickBooksEnvironment {
  const value = String(rawValue || "sandbox").trim().toLowerCase();
  if (value !== "sandbox" && value !== "production") {
    throw new Error("QUICKBOOKS_ENVIRONMENT must be sandbox or production");
  }
  return value;
}

export function parseQuickBooksTokenKey(rawValue: string): Buffer {
  const raw = rawValue.trim();
  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("QUICKBOOKS_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

const parseTokenKeyVersion = (rawValue: string | undefined): number => {
  const keyVersion = Number(rawValue || "1");
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new Error("QUICKBOOKS_TOKEN_KEY_VERSION must be a positive integer");
  }
  return keyVersion;
};

export type QuickBooksTokenKeyMaterial = {
  tokenKey: Buffer;
  tokenKeyVersion: number;
  tokenKeyFingerprint: string;
};

/**
 * Resolves the current key or an explicitly versioned retired key. Keeping an
 * old key under QUICKBOOKS_TOKEN_ENCRYPTION_KEY_V<n> lets the server revoke and
 * erase a connection encrypted before rotation without silently trying the
 * wrong key.
 */
export function resolveQuickBooksTokenKeyMaterial(
  values: QuickBooksEnvironmentValues,
  requestedVersion?: number,
): QuickBooksTokenKeyMaterial {
  const currentVersion = parseTokenKeyVersion(values.QUICKBOOKS_TOKEN_KEY_VERSION);
  const version = requestedVersion ?? currentVersion;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("QuickBooks token key version must be a positive integer");
  }
  const variableName = version === currentVersion
    ? "QUICKBOOKS_TOKEN_ENCRYPTION_KEY"
    : `QUICKBOOKS_TOKEN_ENCRYPTION_KEY_V${version}`;
  const rawKey = String(values[variableName] || "").trim();
  if (!rawKey) {
    throw new Error(`QuickBooks token encryption key version ${version} is not configured`);
  }
  const tokenKey = parseQuickBooksTokenKey(rawKey);
  return {
    tokenKey,
    tokenKeyVersion: version,
    tokenKeyFingerprint: createHash("sha256").update(tokenKey).digest("hex"),
  };
}

export function resolveQuickBooksConfig(
  values: QuickBooksEnvironmentValues,
  requestedEnvironment?: QuickBooksEnvironment,
): QuickBooksConfig {
  const environment = requestedEnvironment
    || resolveQuickBooksEnvironment(values.QUICKBOOKS_ENVIRONMENT);
  const prefix = environmentPrefix(environment);
  const clientId = String(values[`${prefix}_CLIENT_ID`] || "").trim();
  const clientSecret = String(values[`${prefix}_CLIENT_SECRET`] || "").trim();
  const redirectUri = String(values[`${prefix}_REDIRECT_URI`] || "").trim();
  const encryptionKey = String(values.QUICKBOOKS_TOKEN_ENCRYPTION_KEY || "").trim();
  const missing = [
    !clientId && `${prefix}_CLIENT_ID`,
    !clientSecret && `${prefix}_CLIENT_SECRET`,
    !redirectUri && `${prefix}_REDIRECT_URI`,
    !encryptionKey && "QUICKBOOKS_TOKEN_ENCRYPTION_KEY",
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0) {
    throw new Error(`QuickBooks configuration is incomplete: ${missing.join(", ")}`);
  }

  let parsedRedirect: URL;
  try {
    parsedRedirect = new URL(redirectUri);
  } catch {
    throw new Error(`${prefix}_REDIRECT_URI must be an absolute URL`);
  }
  const localHttp = parsedRedirect.protocol === "http:"
    && parsedRedirect.hostname === "localhost";
  if (parsedRedirect.protocol !== "https:" && !localHttp) {
    throw new Error(`${prefix}_REDIRECT_URI must use HTTPS outside localhost`);
  }

  const keyMaterial = resolveQuickBooksTokenKeyMaterial(values);

  return {
    environment,
    clientId,
    clientSecret,
    redirectUri: parsedRedirect.toString(),
    apiBaseUrl: environment === "sandbox"
      ? "https://sandbox-quickbooks.api.intuit.com"
      : "https://quickbooks.api.intuit.com",
    ...keyMaterial,
  };
}

export function buildQuickBooksAuthorizationUrl(
  config: Pick<QuickBooksConfig, "clientId" | "redirectUri">,
  state: string,
): string {
  const url = new URL(QUICKBOOKS_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QUICKBOOKS_ACCOUNTING_SCOPE);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export const createQuickBooksOAuthState = () =>
  randomBytes(32).toString("base64url");

export const hashQuickBooksOAuthState = (state: string) =>
  createHash("sha256").update(state, "utf8").digest("hex");

export function parseQuickBooksTokenResponse(
  payload: Readonly<Record<string, unknown>>,
  now = Date.now(),
): QuickBooksTokenResponse {
  const accessToken = String(payload.access_token || "").trim();
  const refreshToken = String(payload.refresh_token || "").trim();
  const expiresIn = Number(payload.expires_in);
  const refreshExpiresIn = Number(payload.x_refresh_token_expires_in);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("QuickBooks authorization returned incomplete token metadata");
  }
  const scope = String(payload.scope || QUICKBOOKS_ACCOUNTING_SCOPE).trim()
    || QUICKBOOKS_ACCOUNTING_SCOPE;
  if (!scope.split(/\s+/).includes(QUICKBOOKS_ACCOUNTING_SCOPE)) {
    throw new Error("QuickBooks authorization did not grant the accounting scope");
  }
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: new Date(now + expiresIn * 1_000).toISOString(),
    refreshTokenExpiresAt: Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0
      ? new Date(now + refreshExpiresIn * 1_000).toISOString()
      : null,
    scope,
  };
}

const cipherContext = (
  environment: QuickBooksEnvironment,
  tokenKeyVersion: number,
  realmId: string,
  tokenType: "access" | "refresh",
) => `p1:qbo:${environment}:v${tokenKeyVersion}:${realmId}:${tokenType}`;

export function encryptQuickBooksToken(
  config: Pick<QuickBooksConfig, "environment" | "tokenKey" | "tokenKeyVersion">,
  realmId: string,
  tokenType: "access" | "refresh",
  plaintext: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.tokenKey, iv);
  cipher.setAAD(Buffer.from(cipherContext(
    config.environment,
    config.tokenKeyVersion,
    realmId,
    tokenType,
  ), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function decryptQuickBooksToken(
  config: Pick<QuickBooksConfig, "environment" | "tokenKey" | "tokenKeyVersion">,
  realmId: string,
  tokenType: "access" | "refresh",
  encrypted: string,
): string {
  const parts = encrypted.split(".");
  if (parts.length !== 3) throw new Error("Stored QuickBooks credential is invalid");
  const [ivValue, ciphertextValue, authTagValue] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    config.tokenKey,
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAAD(Buffer.from(cipherContext(
    config.environment,
    config.tokenKeyVersion,
    realmId,
    tokenType,
  ), "utf8"));
  decipher.setAuthTag(Buffer.from(authTagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export const isQuickBooksRealmId = (value: string) => /^[0-9]{1,32}$/.test(value);

/**
 * Intuit reports an expired, invalid, or previously revoked OAuth grant as
 * `invalid_grant`. In every one of those cases there is no usable grant left to
 * revoke, so local credential erasure may safely finish. Other errors remain
 * fail-closed (especially invalid_client, rate limits, and server failures).
 */
export function isInactiveQuickBooksGrantResponse(
  status: number,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  return status === 400 && String(payload.error || "").trim() === "invalid_grant";
}
