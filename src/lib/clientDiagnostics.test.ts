import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { resolveClientDiagnosticCode, sanitizeDiagnosticDetails, type ClientDiagnosticValue } from "./clientDiagnostics";
import { handleClientDiagnostic } from "./server/diagnostics/handler";
import type { ClientDiagnosticReport } from "./observability/clientReportContracts";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

test("client diagnostics preserve an already-normalized safe error category", () => {
  assert.equal(resolveClientDiagnosticCode({ code: "TIMEOUT", message: "SYNTHETIC_PRIVATE_PROVIDER_TEXT" }), "TIMEOUT");
  assert.equal(resolveClientDiagnosticCode({ message: "RESULT_UNCONFIRMED" }), "RESULT_UNCONFIRMED");
  assert.equal(resolveClientDiagnosticCode({ message: "SYNTHETIC_PRIVATE_PROVIDER_TEXT" }), "INTERNAL_ERROR");
});

test("diagnostic details retain only closed, bounded primitive fields", () => {
  assert.deepEqual(sanitizeDiagnosticDetails({
    itemCount: 4,
    hasMore: false,
    scope: "active",
    page: 1,
    totalCount: 12,
    contractorScopeResolved: true,
    "bad key": "discarded",
    infinite: Number.POSITIVE_INFINITY,
  }), {
    itemCount: 4,
    hasMore: false,
    scope: "active",
    page: 1,
    totalCount: 12,
    contractorScopeResolved: true,
  });
  const invalid: Record<string, ClientDiagnosticValue>[] = [{ scope: "x".repeat(250) }, { page: Number.POSITIVE_INFINITY }, { hasMore: "false" }, { itemCount: -1 }];
  for (const details of invalid) {
    assert.deepEqual(sanitizeDiagnosticDetails(details), {});
  }
});

test("the diagnostic route revalidates levels and structured details before safe logging", async () => {
  const route = read("src/app/api/client-errors/route.ts");
  assert.match(route, /handleClientDiagnostic\(request/);
  assert.match(route, /safeLog\("client_diagnostic", context, \{ code: report\.code/);
  assert.doesNotMatch(route, /console\.(info|warn|error)|report\.(message|stack)/);
  const recorded: Pick<ClientDiagnosticReport, "level" | "source" | "portalView" | "details">[] = [];
  const dependencies = { authorize: async () => "81000000-0000-4000-8000-000000000001",
    admit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    log: (report: ClientDiagnosticReport) => { recorded.push({ level: report.level, source: report.source,
      portalView: report.portalView, details: report.details }); return true; } };
  const send = (body: unknown) => handleClientDiagnostic(new Request("https://synthetic.invalid/api/client-errors", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), dependencies);
  const valid = { version: 1, code: "INTERNAL_ERROR", source: "synthetic_fixture", portalView: "billing",
    message: "Synthetic failure", details: { itemCount: 2, hasMore: false } };
  for (const level of ["error", "warning", "info"] as const) {
    const response = await send({ ...valid, level });
    assert.equal(response.status, 202);
    assert.deepEqual(recorded.at(-1), { level, source: "synthetic_fixture", portalView: "billing",
      details: { itemCount: 2, hasMore: false } });
  }
  for (const body of [{ ...valid, level: "debug" }, { ...valid, level: 1 }, { ...valid, level: "info", details: { itemCount: -1 } },
    { ...valid, level: "info", details: { itemCount: 1_000_001 } }, { ...valid, level: "info", details: { providerPayload: "SYNTHETIC_PRIVATE" } }]) {
    const before = recorded.length;
    const response = await send(body);
    assert.equal(response.status, 422);
    assert.equal(recorded.length, before);
    assert.doesNotMatch(await response.text(), /SYNTHETIC_PRIVATE|providerPayload/);
  }
});
