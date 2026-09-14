import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

function run(args: string[]) {
  // No inherited environment and no .env loader: these are entirely synthetic
  // read-only configuration/boundary checks, not credential certification.
  return spawnSync(process.execPath, args, { cwd: process.cwd(), env: { NODE_ENV: "production" }, encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 });
}
test("configuration preflight reports missing core configuration without values", () => {
  const result = run(["--import", "tsx", "scripts/verify-runtime-configuration.ts"]);
  assert.equal(result.status, 1); const output: unknown = JSON.parse(result.stdout);
  assert.ok(output && typeof output === "object" && "checks" in output && Array.isArray(output.checks));
  const hasState = (feature: string, status: string) => (item: unknown) => !!item && typeof item === "object"
    && "feature" in item && item.feature === feature && "status" in item && item.status === status;
  assert.ok(output.checks.some(hasState("app_environment", "incomplete")));
  assert.ok(output.checks.some(hasState("graph", "disabled")));
  assert.doesNotMatch(result.stdout, /sb_secret_|Bearer |https:\/\//);
});
test("synthetic preflight succeeds without inheriting host secrets or reading environment files", () => {
  const result = run(["--import", "tsx", "scripts/verify-runtime-configuration.ts", "--synthetic"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /synthetic-secret|synthetic-token|synthetic@example|AC0000|https:\/\//);
});
test("client configuration boundary verifies static, lazy, reexport and erased type behavior", () => {
  const result = run(["scripts/verify-configuration-boundaries.mjs", "--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  const output: unknown = JSON.parse(result.stdout);
  assert.ok(output && typeof output === "object" && "clientRoots" in output && typeof output.clientRoots === "number" && output.clientRoots > 0);
  assert.ok("result" in output && output.result === "passed");
});
