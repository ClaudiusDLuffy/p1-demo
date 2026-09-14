import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getCspReportOnlyHeaders } from "./config/server/browserSecurity";
import { ConfigurationError, type EnvironmentValues } from "./config/shared";
import { PRESERVED_ENFORCED_CSP, readNextHeaders } from "./csp-test-support/configuration";

const development: EnvironmentValues = {
  NODE_ENV: "development", P1_ENABLE_CSP_REPORT_ONLY: "true",
  NEXT_PUBLIC_SUPABASE_URL: "https://syntheticpreview.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
};
const preview: EnvironmentValues = {
  ...development, NODE_ENV: "production", VERCEL_ENV: "preview",
  P1_APP_ENV: "preview", NEXT_PUBLIC_P1_APP_ENV: "preview",
  P1_EXPECTED_SUPABASE_PROJECT_REF: "syntheticpreview",
  P1_PRODUCTION_SUPABASE_PROJECT_REF: "syntheticproduction",
};
const errorCode = (code: string) => (error: unknown) => error instanceof ConfigurationError && error.code === code;

test("report-only is opt-in and does not read missing core configuration or unrelated secrets when disabled", () => {
  for (const flag of [undefined, "", "false"]) {
    const values = Object.defineProperty({ P1_ENABLE_CSP_REPORT_ONLY: flag }, "NEXT_PUBLIC_SUPABASE_URL", {
      get() { throw new Error("Disabled CSP read core configuration"); },
    });
    assert.deepEqual(getCspReportOnlyHeaders(values), []);
  }
  const values = Object.defineProperty({ ...preview }, "SUPABASE_SECRET_KEY", {
    get() { throw new Error("CSP read service credentials"); },
  });
  Object.defineProperty(values, "TWILIO_AUTH_TOKEN", { get() { throw new Error("CSP read provider credentials"); } });
  assert.equal(getCspReportOnlyHeaders(values).length, 1);
});

test("preview candidate is strict and exact-origin while enforced Next headers remain byte-identical", async () => {
  const headers = (await readNextHeaders(() => getCspReportOnlyHeaders(preview)))[0].headers;
  assert.equal(headers.length, 6);
  assert.equal(headers.find(header => header.key === "Content-Security-Policy")?.value, PRESERVED_ENFORCED_CSP);
  const value = headers.find(header => header.key === "Content-Security-Policy-Report-Only")?.value ?? "";
  const directives = new Map(value.split("; ").map(directive => {
    const [name, ...sources] = directive.split(" ");
    return [name, sources] as const;
  }));
  assert.equal(directives.size, 13);
  assert.deepEqual(directives.get("script-src"), ["'self'"]);
  assert.deepEqual(directives.get("style-src"), ["'self'"]);
  assert.deepEqual(directives.get("connect-src"), ["'self'", "https://syntheticpreview.supabase.co", "wss://syntheticpreview.supabase.co"]);
  assert.deepEqual(directives.get("img-src"), ["'self'", "data:", "blob:", "https://syntheticpreview.supabase.co"]);
  assert.deepEqual(directives.get("font-src"), ["'self'", "data:"]);
  assert.deepEqual(directives.get("worker-src"), ["'self'", "blob:"]);
  assert.deepEqual(directives.get("frame-src"), ["'self'", "blob:"]);
  assert.deepEqual(directives.get("object-src"), ["'none'"]);
  assert.deepEqual(directives.get("base-uri"), ["'self'"]);
  assert.deepEqual(directives.get("form-action"), ["'self'"]);
  assert.deepEqual(directives.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(directives.get("manifest-src"), ["'self'"]);
  assert.doesNotMatch(value, /unsafe-inline|unsafe-eval|report-uri|report-to|report-sample|\*|syntheticproduction|graph|twilio|intuit/i);
  assert.equal(headers.some(header => header.key === "Reporting-Endpoints"), false);
});

test("default and explicit false leave every actual Next header unchanged", async () => {
  const baseline = await readNextHeaders();
  for (const values of [{}, { ...preview, P1_ENABLE_CSP_REPORT_ONLY: "false" }]) {
    assert.deepEqual(await readNextHeaders(() => getCspReportOnlyHeaders(values)), baseline);
  }
});

test("development exact loopback origins are supported without silently allowing inline scripts, eval or every websocket", () => {
  for (const url of ["http://localhost:54321", "http://127.0.0.1:54321", "http://[::1]:54321"]) {
    const [header] = getCspReportOnlyHeaders({ ...development, NEXT_PUBLIC_SUPABASE_URL: url });
    assert.ok(header.value.includes(`connect-src 'self' ${url} ${url.replace(/^http:/, "ws:")}`));
    assert.doesNotMatch(header.value, /unsafe-inline|unsafe-eval|ws:\s|https:\s|\*/);
  }
});

test("production and test environments cannot opt into report-only, including forged preview declarations", async () => {
  const production = { ...preview, VERCEL_ENV: "production", P1_APP_ENV: "production", NEXT_PUBLIC_P1_APP_ENV: "production" };
  for (const values of [production, { ...preview, VERCEL_ENV: "production" }, { ...development, NODE_ENV: "test" }]) {
    assert.throws(() => getCspReportOnlyHeaders(values), errorCode("ENVIRONMENT_MISMATCH"));
    await assert.rejects(readNextHeaders(() => getCspReportOnlyHeaders(values)), errorCode("ENVIRONMENT_MISMATCH"));
  }
  assert.deepEqual(getCspReportOnlyHeaders({ ...production, P1_ENABLE_CSP_REPORT_ONLY: "false" }), []);
});

test("flag syntax uses the existing strict configuration contract", () => {
  for (const flag of ["yes", "1", "TRUE", "false; script-src *", "true\nfalse"]) {
    assert.throws(() => getCspReportOnlyHeaders({ ...preview, P1_ENABLE_CSP_REPORT_ONLY: flag }), errorCode("CONFIG_INVALID"));
  }
  assert.equal(getCspReportOnlyHeaders({ ...preview, P1_ENABLE_CSP_REPORT_ONLY: " true " }).length, 1);
});

test("preview requires core configuration, environment alignment, and a distinct declared project", () => {
  for (const key of ["P1_APP_ENV", "NEXT_PUBLIC_P1_APP_ENV", "P1_EXPECTED_SUPABASE_PROJECT_REF", "P1_PRODUCTION_SUPABASE_PROJECT_REF", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]) {
    assert.throws(() => getCspReportOnlyHeaders({ ...preview, [key]: undefined }), errorCode("CONFIG_INCOMPLETE"));
  }
  for (const change of [
    { P1_APP_ENV: "production" }, { P1_EXPECTED_SUPABASE_PROJECT_REF: "other" },
    { P1_PRODUCTION_SUPABASE_PROJECT_REF: "syntheticpreview" }, { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" },
    { VERCEL_ENV: undefined },
  ]) assert.throws(() => getCspReportOnlyHeaders({ ...preview, ...change }), errorCode("ENVIRONMENT_MISMATCH"));
});

test("malformed origins cannot inject directives, credentials, wildcard hosts, or unsafe protocols", () => {
  for (const url of [
    "javascript:alert(1)", "data:text/plain,synthetic", "wss://synthetic.invalid", "http://remote.invalid",
    "https://user:synthetic-private-value@synthetic.invalid", "https://synthetic.invalid/path",
    "https://synthetic.invalid/?credential=synthetic-private-value", "https://synthetic.invalid/#synthetic",
    "https://synthetic.invalid\r\nreport-uri:https://other.invalid", "https://syn\tthetic.invalid",
    "https://*.synthetic.invalid", "https://synthetic.invalid;object-src",
  ]) {
    assert.throws(() => getCspReportOnlyHeaders({ ...development, NEXT_PUBLIC_SUPABASE_URL: url }), error => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.code, "CONFIG_INVALID");
      assert.doesNotMatch(JSON.stringify(error), /synthetic-private-value|https:\/\/|credential=/);
      return true;
    });
  }
});

test("CSP preparation adds no report collector, browser payload listener, or modification of parser/build boundaries", () => {
  const source = readFileSync("src/lib/config/server/browserSecurity.ts", "utf8");
  assert.match(source, /import process from "node:process"/);
  assert.doesNotMatch(source, /fetch\(|console\.|addEventListener|sendBeacon|SUPABASE_SECRET_KEY/);
  const config = readFileSync("next.config.ts", "utf8");
  assert.match(config, /serverExternalPackages: \["@napi-rs\/canvas", "pdfjs-dist"\]/);
  assert.match(config, /buildInvoicePdfRuntime\(\)/);
  assert.match(config, /photoImageInspectionWorker\.mjs/);
  assert.equal(config.match(/\.\.\.getCspReportOnlyHeaders\(\)/g)?.length, 1);
});
