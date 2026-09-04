import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const migration = read("supabase/migrations/0116_private_quickbooks_sandbox_connection.sql");
const audit = read("supabase/audits/0116_private_quickbooks_sandbox_connection_verification.sql");
const oauth = read("src/lib/server/quickBooksOnline.ts");
const oauthCore = read("src/lib/server/quickBooksOnlineCore.ts");
const connectRoute = read("src/app/api/quickbooks/connect/route.ts");
const callbackRoute = read("src/app/api/quickbooks/callback/route.ts");
const connectionRoute = read("src/app/api/quickbooks/connection/route.ts");
const connectionUi = read("src/features/invoices/QuickBooksSandboxConnection.tsx");

test("legacy plaintext tokens and new OAuth tables are closed to browser roles", () => {
  assert.match(migration, /drop policy if exists qbo_staff/);
  assert.match(migration, /revoke all on public\.qbo_tokens from public, anon, authenticated, service_role/);
  for (const table of [
    "quickbooks_oauth_states",
    "quickbooks_connections",
    "quickbooks_connection_events",
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`revoke all on public\\.${table}[\\s\\S]*?public, anon, authenticated`));
  }
  assert.match(audit, /credential_tables_have_no_client_policies/);
  assert.match(audit, /browser_roles_blocked/);
  assert.match(audit, /legacy_plaintext_token_count = 0/);
  assert.match(migration, /grant select, update on public\.quickbooks_oauth_states to service_role/);
  assert.doesNotMatch(migration, /grant select, insert, update, delete on public\.quickbooks_oauth_states/);
  assert.match(migration, /grant select on public\.quickbooks_connections to service_role/);
  assert.doesNotMatch(migration, /grant select, insert, update, delete on public\.quickbooks_connections/);
});

test("OAuth state is high entropy, short lived, staff bound, and consumed once", () => {
  assert.match(oauthCore, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(connectRoute, /actor_id: auth\.profile\.id/);
  assert.match(connectRoute, /begin_quickbooks_oauth_authorization/);
  assert.match(migration, /v_expires_at timestamptz := now\(\) \+ interval '10 minutes'/);
  assert.match(migration, /Disconnect the current QuickBooks company before starting another authorization/);
  assert.match(migration, /update public\.quickbooks_oauth_states oauth_state[\s\S]*oauth_state\.used_at is null/);
  assert.match(callbackRoute, /\.is\("used_at", null\)/);
  assert.match(callbackRoute, /\.gt\("expires_at", usedAt\)/);
  assert.match(callbackRoute, /\.eq\("permission", "quickbooks_handoff"\)/);
});

test("sandbox authorization uses the minimum accounting scope and production stays locked", () => {
  assert.match(oauthCore, /com\.intuit\.quickbooks\.accounting/);
  assert.doesNotMatch(oauthCore, /openid|profile|email|app-foundations/);
  assert.match(connectRoute, /config\.environment !== "sandbox"/);
  assert.match(connectRoute, /Production QuickBooks authorization is locked/);
  assert.match(callbackRoute, /oauthState\.environment !== "sandbox"/);
  assert.match(connectionRoute, /configuration\.environment !== "sandbox"/);
});

test("the callback verifies the realm before encrypting and atomically saving credentials", () => {
  assert.match(callbackRoute, /fetchQuickBooksCompanyInfo/);
  assert.match(callbackRoute, /encryptQuickBooksToken/);
  assert.match(callbackRoute, /save_quickbooks_connection/);
  assert.match(callbackRoute, /authorizationAttemptHash/);
  assert.match(callbackRoute, /quickbooks_connection_events/);
  assert.match(oauthCore, /aes-256-gcm/);
  assert.match(oauthCore, /cipher\.setAAD/);
  assert.match(oauthCore, /tokenKeyFingerprint/);
  assert.match(oauthCore, /:v\$\{tokenKeyVersion\}:/);
  assert.doesNotMatch(
    connectionUi,
    /access_token_ciphertext|refresh_token_ciphertext|decryptQuickBooksToken|encryptQuickBooksToken/,
  );
});

test("ambiguous callback saves preserve every potentially current same-realm grant", () => {
  assert.match(
    callbackRoute,
    /type SaveOutcome = "not_attempted" \| "saved" \| "rejected" \| "ambiguous"/,
  );
  assert.match(callbackRoute, /saveWasAttempted = true/);
  assert.match(callbackRoute, /sawAmbiguousSaveAttempt/);
  assert.match(
    callbackRoute,
    /quickbooks_connection_events[\s\S]*authorization_attempt_hash[\s\S]*quickbooks_connections[\s\S]*\.eq\("environment", oauthState\.environment\)[\s\S]*\.eq\("realm_id", realmId\)[\s\S]*\.in\("status", \["active", "disconnecting"\]\)/,
  );
  assert.match(
    callbackRoute,
    /persistedConnectionIsCurrent[\s\S]*persistedAttempt\.error[\s\S]*sameRealmConnection\.error[\s\S]*sameRealmConnection\.data[\s\S]*!persistedAttempt\.data && saveOutcome !== "rejected"/,
  );
  assert.match(
    callbackRoute,
    /refreshTokenForCleanup && candidateRevocationIsSafe/,
  );
  assert.match(callbackRoute, /"pending", "persistence_pending"/);
  assert.match(connectionUi, /authorization is pending verification/);
});

test("disconnect is claimed before revocation and finalized idempotently afterward", () => {
  const claimPosition = connectionRoute.indexOf('"claim_quickbooks_connection_disconnect"');
  const revokePosition = connectionRoute.indexOf("await revokeQuickBooksToken");
  const finalizePosition = connectionRoute.indexOf('"finalize_quickbooks_connection_disconnect"');
  assert.ok(claimPosition > -1 && revokePosition > claimPosition);
  assert.ok(finalizePosition > revokePosition);
  assert.match(connectionRoute, /release_quickbooks_connection_disconnect/);
  assert.match(connectionRoute, /refreshTokenExpiry[\s\S]*"expired"/);
  assert.match(connectionRoute, /p_revocation_outcome: revocationOutcome/);
  assert.match(connectionRoute, /claim\.inProgress/);
  assert.match(connectionRoute, /Retry-After/);
  assert.match(oauthCore, /invalid_grant/);
  assert.match(connectionRoute, /Keeping[\s\S]*claim blocks reconnects/);
  assert.match(migration, /p_expected_updated_at/);
  assert.match(migration, /status = 'disconnecting'/);
  assert.match(migration, /authorization_attempt_hash/);
  assert.match(migration, /access_token_ciphertext = null/);
  assert.match(migration, /refresh_token_ciphertext = null/);
  assert.doesNotMatch(connectionRoute, /"disconnect_quickbooks_connection"/);
  assert.match(audit, /unsafe_legacy_disconnect_functions_removed/);
});

test("disconnect is a generation barrier against stale OAuth callbacks", () => {
  assert.match(
    migration,
    /p_authorization_attempt_created_at <= v_connection\.disconnected_at/,
  );
  assert.match(migration, /This QuickBooks authorization predates the completed disconnect/);
  assert.match(
    migration,
    /claim_quickbooks_connection_disconnect[\s\S]*update public\.quickbooks_oauth_states oauth_state/,
  );
  assert.match(audit, /pre_disconnect_authorization_reactivation_count/);
  assert.match(audit, /usable_oauth_state_during_live_connection_count/);
});

test("the disconnect watermark rejects delayed callbacks across different realms", () => {
  assert.match(
    migration,
    /disconnect_event\.environment = p_environment[\s\S]*disconnect_event\.created_at >= p_authorization_attempt_created_at/,
  );
  assert.match(migration, /This QuickBooks authorization predates the environment disconnect/);
  assert.match(migration, /quickbooks_connection_events_disconnect_watermark_idx/);
  assert.match(
    migration,
    /last_authorization_attempt_hash[\s\S]*= p_authorization_attempt_hash[\s\S]*'idempotent', true/,
  );
  assert.match(
    callbackRoute,
    /persistedAttempt\.data\.connection_id === sameRealmConnection\.data\.id[\s\S]*sameRealmConnection\.data\.status === "active"[\s\S]*last_authorization_attempt_hash/,
  );
  assert.match(
    audit,
    /disconnect_event\.environment = authorization_event\.environment/,
  );
  assert.match(audit, /disconnect_watermark_indexed/);
});

test("disconnect leases prevent concurrent callers from revoking the same token", () => {
  assert.match(
    migration,
    /disconnect_claimed_at > now\(\) - interval '1 minute'[\s\S]*'inProgress', true/,
  );
  assert.match(migration, /disconnect_claimed_at \+ interval '1 minute'/);
  assert.match(migration, /refreshTokenExpiresAt/);
  assert.match(audit, /disconnect_claim_leased_and_returns_locked_credential/);
});

test("callback redirects cannot leak or cache the one-time OAuth callback URL", () => {
  assert.match(callbackRoute, /Cache-Control", "no-store"/);
  assert.match(callbackRoute, /Referrer-Policy", "no-referrer"/);
});

test("this phase performs company verification but cannot create accounting transactions", () => {
  assert.match(oauth, /companyinfo/);
  assert.match(connectionRoute, /billWritesEnabled: false/);
  assert.match(connectionUi, /Automatic Bill creation[\s\S]*remain locked/);
  assert.doesNotMatch(oauth, /\/bill\b/i);
  assert.doesNotMatch(callbackRoute, /\/bill\b/i);
  assert.doesNotMatch(connectionRoute, /\/bill\b/i);
});

test("connection controls expose pending disconnects, reconnect recovery, and loading states", () => {
  assert.match(connectionUi, /disconnecting: boolean/);
  assert.match(connectionUi, /useState\(true\)/);
  assert.match(connectionUi, /Connection status is unavailable/);
  assert.match(connectionUi, /Check status again/);
  assert.match(connectionUi, /Retry disconnect/);
  assert.match(connectionUi, /Disconnect to reconnect/);
  assert.match(connectionUi, /role="alert"[\s\S]*?previous disconnect has not finished/);
  assert.match(connectionUi, /role="alert"[\s\S]*?current authorization or encryption configuration/);
});
