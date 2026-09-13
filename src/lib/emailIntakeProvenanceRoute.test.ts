import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { configurationFixture } from "./config-test-support/runtimeConfig";

type RouteHandler = (request: NextRequest) => Promise<Response>;
function routeFixture(results: unknown[] = [], failure?: unknown) {
  let calls = 0;
  const exports: { GET?: RouteHandler; POST?: RouteHandler } = {};
  const filename = resolve("src/app/api/email-intake/route.ts"); const requireHere = createRequire(import.meta.url);
  const environment = { CRON_SECRET: "synthetic-cron", EMAIL_INTAKE_ENABLED: "true" };
  runInNewContext(ts.transpileModule(readFileSync(resolve("src/app/api/email-intake/route.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, process: { env: { CRON_SECRET: "synthetic-cron", EMAIL_INTAKE_ENABLED: "true" } },
    require(name: string): unknown {
      if (name.endsWith("emailIntakeProcessor")) return { runIntakeCycle: async () => { calls++; if (failure) throw failure; return results; } };
      return configurationFixture(name, environment) ?? requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
    },
  });
  assert.ok(exports.GET && exports.POST);
  return { GET: exports.GET, POST: exports.POST, calls: () => calls };
}
const request = (authorization?: string) => new NextRequest("https://portal.example.invalid/api/email-intake", {
  headers: authorization ? { authorization } : {},
});

test("intake GET/POST retain cron authentication and successful compatibility fields", async () => {
  for (const method of ["GET", "POST"] as const) {
    const h = routeFixture([{ action: "created", logStatus: "recorded" }]);
    assert.equal((await h[method](request())).status, 401);
    assert.equal(h.calls(), 0);
    const response = await h[method](request("Bearer synthetic-cron"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, processed: 1, results: [{ action: "created", logStatus: "recorded" }] });
  }
});

test("an unconfirmed trusted receipt produces a visible safe 503 without hiding accepted work", async () => {
  const h = routeFixture([{ action: "created", logStatus: "unconfirmed", logError: "INTAKE_LOG_UNCONFIRMED" }]);
  const response = await h.POST(request("Bearer synthetic-cron"));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.success, false); assert.equal(body.processed, 1); assert.equal(body.code, "INTAKE_LOG_UNCONFIRMED");
  assert.deepEqual(body.results, [{ action: "created", logStatus: "unconfirmed", logError: "INTAKE_LOG_UNCONFIRMED" }]);
  assert.equal(body.correlationId, response.headers.get("X-Request-ID"));
});

test("outer intake provider errors are not returned as SQL, token or filesystem details", async () => {
  const h = routeFixture([], new Error("Bearer synthetic-secret /private/customer-email SQL stack"));
  const response = await h.GET(request("Bearer synthetic-cron"));
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /synthetic-secret|customer-email|SQL stack/);
});
