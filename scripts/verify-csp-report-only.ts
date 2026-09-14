import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getCspReportOnlyHeaders } from "../src/lib/config/server/browserSecurity";
import { ConfigurationError, type EnvironmentValues } from "../src/lib/config/shared";
import { PRESERVED_ENFORCED_CSP, readNextHeaders } from "../src/lib/csp-test-support/configuration";

/** Synthetic only. No host environment, .env loader, browser, or transport. */
async function verify() {
  const preview: EnvironmentValues = {
    NODE_ENV: "production", VERCEL_ENV: "preview", P1_APP_ENV: "preview", NEXT_PUBLIC_P1_APP_ENV: "preview",
    P1_ENABLE_CSP_REPORT_ONLY: "true", NEXT_PUBLIC_SUPABASE_URL: "https://syntheticpreview.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
    P1_EXPECTED_SUPABASE_PROJECT_REF: "syntheticpreview", P1_PRODUCTION_SUPABASE_PROJECT_REF: "syntheticproduction",
  };
  const checks: string[] = [];
  const check = (name: string, assertion: () => void) => { assertion(); checks.push(name); };
  const defaultHeaders = await readNextHeaders(() => getCspReportOnlyHeaders({}));
  const previewHeaders = await readNextHeaders(() => getCspReportOnlyHeaders(preview));
  check("default_header_contract", () => assert.equal(defaultHeaders[0].headers.find(header => header.key === "Content-Security-Policy")?.value, PRESERVED_ENFORCED_CSP));
  check("default_has_no_report_header", () => assert.equal(defaultHeaders[0].headers.length, 5));
  check("preview_preserves_every_enforced_header", () => assert.deepEqual(previewHeaders[0].headers.slice(0, 5), defaultHeaders[0].headers));
  const reportOnly = previewHeaders[0].headers.find(header => header.key === "Content-Security-Policy-Report-Only")?.value ?? "";
  check("strict_script_and_style_candidate", () => {
    assert.match(reportOnly, /script-src 'self'; style-src 'self';/);
    assert.doesNotMatch(reportOnly, /unsafe-inline|unsafe-eval/);
  });
  check("exact_supabase_and_websocket_origin", () => {
    assert.match(reportOnly, /connect-src 'self' https:\/\/syntheticpreview\.supabase\.co wss:\/\/syntheticpreview\.supabase\.co;/);
    assert.doesNotMatch(reportOnly, /\*/);
  });
  check("no_violation_payload_collection", () => assert.doesNotMatch(reportOnly, /report-uri|report-to|report-sample/));
  check("production_opt_in_denied", () => assert.throws(() => getCspReportOnlyHeaders({ ...preview,
    VERCEL_ENV: "production", P1_APP_ENV: "production", NEXT_PUBLIC_P1_APP_ENV: "production",
  }), (error: unknown) => error instanceof ConfigurationError && error.code === "ENVIRONMENT_MISMATCH"));
  check("invalid_flag_denied", () => assert.throws(() => getCspReportOnlyHeaders({ P1_ENABLE_CSP_REPORT_ONLY: "yes" }), ConfigurationError));
  check("preview_project_separation", () => assert.throws(() => getCspReportOnlyHeaders({ ...preview,
    P1_PRODUCTION_SUPABASE_PROJECT_REF: "syntheticpreview",
  }), (error: unknown) => error instanceof ConfigurationError && error.code === "ENVIRONMENT_MISMATCH"));
  console.log(JSON.stringify({ result: "passed", evidence: "SYNTHETIC_CONFIGURATION", checks,
    enforcedPolicySha256: createHash("sha256").update(PRESERVED_ENFORCED_CSP).digest("hex"),
    reportOnlyPolicyBytes: Buffer.byteLength(reportOnly), hostedHeadersVerified: false, browserCompatibilityVerified: false,
    productionEnforcementChanged: false, reportCollectorAdded: false,
  }, null, 2));
}

verify().catch(() => {
  console.error(JSON.stringify({ result: "failed", code: "CSP_SYNTHETIC_VERIFICATION_FAILED" }));
  process.exitCode = 1;
});
