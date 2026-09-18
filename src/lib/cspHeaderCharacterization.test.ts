import assert from "node:assert/strict";
import test from "node:test";
import { PRESERVED_ENFORCED_CSP, readNextHeaders } from "./csp-test-support/configuration";

test("CSP characterization: default global headers preserve the complete enforced contract", async () => {
  const result = await readNextHeaders();
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "/:path*");
  assert.deepEqual(result[0].headers, [
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    { key: "Content-Security-Policy", value: PRESERVED_ENFORCED_CSP },
  ]);
});

test("CSP characterization: permissive inline/eval and remote image/font sources are existing compatibility debt", async () => {
  const headers = (await readNextHeaders())[0].headers;
  const policy = headers.find(header => header.key === "Content-Security-Policy")?.value;
  assert.match(policy ?? "", /script-src 'self' 'unsafe-inline' 'unsafe-eval'/);
  assert.match(policy ?? "", /style-src 'self' 'unsafe-inline'/);
  assert.match(policy ?? "", /img-src 'self' data: blob: https:/);
  assert.match(policy ?? "", /font-src 'self' data: https:/);
  assert.match(policy ?? "", /connect-src 'self' blob: https:\/\/\*\.supabase\.co/);
  assert.equal(headers.some(header => /Report-Only|Reporting-Endpoints/.test(header.key)), false);
});

test("the browser harness can add only its exact loopback Supabase origin in development", async () => {
  const result = await readNextHeaders(() => [], {
    NODE_ENV: "development",
    P1_E2E_ALLOW_LOCAL_CSP: "true",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  });
  const policy = result[0].headers.find(header => header.key === "Content-Security-Policy")?.value ?? "";
  assert.match(policy, /connect-src 'self' blob: https:\/\/\*\.supabase\.co wss:\/\/\*\.supabase\.co http:\/\/127\.0\.0\.1:54321 ws:\/\/127\.0\.0\.1:54321/);

  for (const environment of [
    { NODE_ENV: "production", P1_E2E_ALLOW_LOCAL_CSP: "true", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" },
    { NODE_ENV: "development", P1_E2E_ALLOW_LOCAL_CSP: "true", NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid" },
  ]) {
    await assert.rejects(readNextHeaders(() => [], environment), /Local E2E/);
  }
});
