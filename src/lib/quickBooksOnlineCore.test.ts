import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQuickBooksAuthorizationUrl,
  createQuickBooksOAuthState,
  decryptQuickBooksToken,
  encryptQuickBooksToken,
  hashQuickBooksOAuthState,
  isInactiveQuickBooksGrantResponse,
  isQuickBooksRealmId,
  parseQuickBooksTokenResponse,
  resolveQuickBooksConfig,
  resolveQuickBooksEnvironment,
  resolveQuickBooksTokenKeyMaterial,
  type QuickBooksEnvironmentValues,
} from "./server/quickBooksOnlineCore";

const TOKEN_KEY_HEX = "11".repeat(32);

const sandboxValues = (overrides: QuickBooksEnvironmentValues = {}) => ({
  QUICKBOOKS_ENVIRONMENT: "sandbox",
  QUICKBOOKS_SANDBOX_CLIENT_ID: " sandbox-client ",
  QUICKBOOKS_SANDBOX_CLIENT_SECRET: " sandbox-secret ",
  QUICKBOOKS_SANDBOX_REDIRECT_URI: "https://portal.example/api/quickbooks/callback",
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY: TOKEN_KEY_HEX,
  QUICKBOOKS_TOKEN_KEY_VERSION: "2",
  ...overrides,
});

test("QuickBooks configuration keeps sandbox and production endpoints and credentials separate", () => {
  const sandbox = resolveQuickBooksConfig(sandboxValues());
  assert.equal(sandbox.environment, "sandbox");
  assert.equal(sandbox.clientId, "sandbox-client");
  assert.equal(sandbox.clientSecret, "sandbox-secret");
  assert.equal(sandbox.apiBaseUrl, "https://sandbox-quickbooks.api.intuit.com");
  assert.equal(sandbox.redirectUri, "https://portal.example/api/quickbooks/callback");
  assert.equal(sandbox.tokenKey.length, 32);
  assert.equal(sandbox.tokenKeyVersion, 2);
  assert.equal(sandbox.tokenKeyFingerprint, "02d449a31fbb267c8f352e9968a79e3e5fc95c1bbeaa502fd6454ebde5a4bedc");

  const production = resolveQuickBooksConfig({
    ...sandboxValues(),
    QUICKBOOKS_ENVIRONMENT: "production",
    QUICKBOOKS_PRODUCTION_CLIENT_ID: "production-client",
    QUICKBOOKS_PRODUCTION_CLIENT_SECRET: "production-secret",
    QUICKBOOKS_PRODUCTION_REDIRECT_URI: "https://portal.example/api/quickbooks/callback",
  });
  assert.equal(production.environment, "production");
  assert.equal(production.clientId, "production-client");
  assert.equal(production.apiBaseUrl, "https://quickbooks.api.intuit.com");
});

test("QuickBooks configuration fails closed for invalid environments, redirects, keys, and versions", () => {
  assert.equal(resolveQuickBooksEnvironment(undefined), "sandbox");
  assert.throws(
    () => resolveQuickBooksEnvironment("preview"),
    /must be sandbox or production/,
  );
  assert.throws(
    () => resolveQuickBooksConfig(sandboxValues({ QUICKBOOKS_SANDBOX_CLIENT_SECRET: "" })),
    /QUICKBOOKS_SANDBOX_CLIENT_SECRET/,
  );
  assert.throws(
    () => resolveQuickBooksConfig(sandboxValues({
      QUICKBOOKS_SANDBOX_REDIRECT_URI: "http://portal.example/callback",
    })),
    /must use HTTPS outside localhost/,
  );
  assert.doesNotThrow(() => resolveQuickBooksConfig(sandboxValues({
    QUICKBOOKS_SANDBOX_REDIRECT_URI: "http://localhost:3000/api/quickbooks/callback",
  })));
  assert.throws(
    () => resolveQuickBooksConfig(sandboxValues({
      QUICKBOOKS_SANDBOX_REDIRECT_URI: "ftp://localhost/api/quickbooks/callback",
    })),
    /must use HTTPS outside localhost/,
  );
  assert.throws(
    () => resolveQuickBooksConfig(sandboxValues({ QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "short" })),
    /exactly 32 bytes/,
  );
  assert.throws(
    () => resolveQuickBooksConfig(sandboxValues({ QUICKBOOKS_TOKEN_KEY_VERSION: "1.5" })),
    /positive integer/,
  );
});

test("versioned key lookup preserves revocation access after an intentional key rotation", () => {
  const rotatedValues = sandboxValues({
    QUICKBOOKS_TOKEN_KEY_VERSION: "2",
    QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "22".repeat(32),
    QUICKBOOKS_TOKEN_ENCRYPTION_KEY_V1: TOKEN_KEY_HEX,
  });
  const current = resolveQuickBooksTokenKeyMaterial(rotatedValues);
  const retired = resolveQuickBooksTokenKeyMaterial(rotatedValues, 1);
  assert.equal(current.tokenKeyVersion, 2);
  assert.equal(current.tokenKey.toString("hex"), "22".repeat(32));
  assert.equal(retired.tokenKeyVersion, 1);
  assert.equal(retired.tokenKey.toString("hex"), TOKEN_KEY_HEX);
  assert.notEqual(current.tokenKeyFingerprint, retired.tokenKeyFingerprint);
  assert.throws(
    () => resolveQuickBooksTokenKeyMaterial(rotatedValues, 3),
    /key version 3 is not configured/,
  );
});

test("OAuth authorization URL requests only accounting and binds the exact redirect and state", () => {
  const config = resolveQuickBooksConfig(sandboxValues());
  const state = createQuickBooksOAuthState();
  const secondState = createQuickBooksOAuthState();
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(state, secondState);
  assert.match(hashQuickBooksOAuthState(state), /^[0-9a-f]{64}$/);

  const url = new URL(buildQuickBooksAuthorizationUrl(config, state));
  assert.equal(url.origin + url.pathname, "https://appcenter.intuit.com/connect/oauth2");
  assert.equal(url.searchParams.get("client_id"), "sandbox-client");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "com.intuit.quickbooks.accounting");
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  assert.equal(url.searchParams.get("state"), state);
  assert.equal([...url.searchParams.keys()].sort().join(","), "client_id,redirect_uri,response_type,scope,state");
});

test("OAuth token metadata validates scope and computes both expirations deterministically", () => {
  const now = Date.parse("2026-09-04T00:00:00.000Z");
  const parsed = parseQuickBooksTokenResponse({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_in: 3_600,
    x_refresh_token_expires_in: 8_726_400,
    scope: "com.intuit.quickbooks.accounting",
  }, now);
  assert.equal(parsed.accessTokenExpiresAt, "2026-09-04T01:00:00.000Z");
  assert.equal(parsed.refreshTokenExpiresAt, "2026-12-14T00:00:00.000Z");
  assert.throws(
    () => parseQuickBooksTokenResponse({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3_600,
      scope: "openid",
    }, now),
    /did not grant the accounting scope/,
  );
  assert.throws(
    () => parseQuickBooksTokenResponse({ access_token: "", expires_in: 3_600 }, now),
    /incomplete token metadata/,
  );
});

test("AES-GCM tokens round-trip while realm, environment, type, key, and tag remain bound", () => {
  const config = resolveQuickBooksConfig(sandboxValues());
  const encrypted = encryptQuickBooksToken(config, "123456789", "refresh", "secret-token");
  const second = encryptQuickBooksToken(config, "123456789", "refresh", "secret-token");
  assert.notEqual(encrypted, second, "a fresh IV must produce distinct ciphertext");
  assert.equal(
    decryptQuickBooksToken(config, "123456789", "refresh", encrypted),
    "secret-token",
  );
  assert.throws(() => decryptQuickBooksToken(config, "987654321", "refresh", encrypted));
  assert.throws(() => decryptQuickBooksToken(config, "123456789", "access", encrypted));
  assert.throws(() => decryptQuickBooksToken(
    { ...config, environment: "production" },
    "123456789",
    "refresh",
    encrypted,
  ));
  assert.throws(() => decryptQuickBooksToken(
    { ...config, tokenKey: Buffer.alloc(32, 9) },
    "123456789",
    "refresh",
    encrypted,
  ));
  assert.throws(() => decryptQuickBooksToken(
    { ...config, tokenKeyVersion: config.tokenKeyVersion + 1 },
    "123456789",
    "refresh",
    encrypted,
  ));

  const [iv, body, tag] = encrypted.split(".");
  const tamperedTag = `${tag.startsWith("A") ? "B" : "A"}${tag.slice(1)}`;
  assert.throws(() => decryptQuickBooksToken(
    config,
    "123456789",
    "refresh",
    [iv, body, tamperedTag].join("."),
  ));
  assert.throws(() => decryptQuickBooksToken(config, "123456789", "refresh", "broken"));
});

test("QuickBooks realm IDs accept only bounded numeric company IDs", () => {
  assert.equal(isQuickBooksRealmId("12345678901234567890123456789012"), true);
  assert.equal(isQuickBooksRealmId(""), false);
  assert.equal(isQuickBooksRealmId("123-456"), false);
  assert.equal(isQuickBooksRealmId("1".repeat(33)), false);
});

test("only Intuit's definitive inactive-grant response permits local revocation recovery", () => {
  assert.equal(isInactiveQuickBooksGrantResponse(400, {
    error: "invalid_grant",
    error_description: "Token invalid",
  }), true);
  assert.equal(isInactiveQuickBooksGrantResponse(401, {
    error: "invalid_grant",
  }), false);
  assert.equal(isInactiveQuickBooksGrantResponse(400, {
    error: "invalid_client",
  }), false);
  assert.equal(isInactiveQuickBooksGrantResponse(500, {}), false);
});
