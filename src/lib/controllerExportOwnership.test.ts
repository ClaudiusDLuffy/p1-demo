import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The production checker parses syntax, not compatibility comments or file lengths.
const checkerPromise = import("../../scripts/verify-controller-export-true-ownership.mjs");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = join(directory, entry.name);
    return entry.isDirectory() ? files(name) : name.endsWith(".ts") ? [name] : [];
  });
}
const source = new Map([...files("src/server/controller-exports"), "src/app/api/controller-exports/route.ts"]
  .map(name => [name, readFileSync(name, "utf8")]));
test("controller ownership checker accepts the actual focused production graph", async () => {
  const checker = await checkerPromise;
  assert.ok(checker.verifyControllerExportOwnership(source).controllerOwners > 0);
});
for (const [name, mutation, expected] of [
  ["src/server/controller-exports/applicationService.ts", '\nimport legacy from "./legacyRouteImplementation";', /legacy fallback/],
  ["src/server/controller-exports/applicationService.ts", '\nexport * from "./legacyRouteImplementation";', /legacy fallback/],
  ["src/server/controller-exports/stageControllerExport.ts", '\nconst fallback = () => import("./legacyRouteImplementation");', /dynamic legacy/],
  ["src/server/controller-exports/applicationService.ts", '\nfunction unsafe(db) { return db.rpc("stage_contractor_bill_handoff"); }', /side effects/],
  ["src/server/controller-exports/stageControllerExport.ts", '\nfunction unsafe(db) { return db.from("invoices"); }', /raw I\/O/],
  ["src/server/controller-exports/stageControllerExport.ts", '\nasync function unsafe(storage,attempt) { await storage.cleanup(attempt); }', /cleanup lacks/],
  ["src/server/controller-exports/stageControllerExport.ts", '\nasync function unsafe(storage,attempt,state) { if (decideCompensation(state).action !== "cleanup_exact_object") await storage.cleanup(attempt); }', /cleanup lacks/],
  ["src/server/controller-exports/stageControllerExport.ts", '\nasync function unsafe(storage,attempt,state) { if (decideCompensation(state).action === "cleanup_exact_object") return; else await storage.cleanup(attempt); }', /cleanup lacks/],
  ["src/server/controller-exports/snapshot.ts", '\nimport { createServerClient } from "../../lib/supabase/server";', /pure mapper/],
  ["src/server/controller-exports/stageResultMapper.ts", '\nconsole.log("private");', /impure policy/],
  ["src/server/controller-exports/transitionCommandRepository.ts", '\nfunction unsafe(db) { return db.update({state:"paid"}); }', /direct table write/],
  ["src/server/controller-exports/exportStorage.ts", '\nfunction unsafe(db) { return db.rpc("stage_contractor_bill_handoff"); }', /Storage adapter/],
  ["src/server/controller-exports/archiveBuilder.ts", '\nfunction unsafe(storage) { return storage.upload("foreign"); }', /Archive builder/],
  ["src/server/controller-exports/stageReconciliation.ts", '\nfunction unsafe(){return randomUUID();}', /new operation identity/],
  ["src/server/controller-exports/stageReconciliation.ts", '\nfunction unsafe(db){return db.rpc("stage_contractor_bill_handoff");}', /non-idempotent stage retry/],
  ["src/server/controller-exports/stageControllerExport.ts", '\nconst unsafe={batchId:context.requestId};', /correlation used/],
] as const) test(`controller ownership negative probe: ${expected.source}`, async () => {
  const checker = await checkerPromise;
  const changed = new Map(source);
  changed.set(name, changed.get(name) + mutation);
  assert.throws(() => checker.verifyControllerExportOwnership(changed), expected);
});

const financialChecker = () => import("../../scripts/verify-financial-route-boundaries.mjs");
const financialSources = new Map([...source, ["src/app/api/billing-invoices/route.ts",
  readFileSync("src/app/api/billing-invoices/route.ts", "utf8")]]);
test("financial boundary guard recognizes the actual typed controller HTTP boundary", async () => {
  assert.equal((await financialChecker()).verifyFinancialRouteBoundaries(financialSources).boundaries, 3);
});
for (const injected of ['db["from"]("invoices");', 'db.rpc("unsafe");', 'storage.createSignedUrl("foreign");',
  'generateInvoicePdf({});', 'import("./legacyRouteImplementation");']) {
  test(`financial boundary guard rejects executable route I/O: ${injected}`, async () => {
    const checker = await financialChecker();
    const changed = new Map(financialSources);
    changed.set("src/app/api/controller-exports/route.ts", changed.get("src/app/api/controller-exports/route.ts") + injected);
    assert.throws(() => checker.verifyFinancialRouteBoundaries(changed));
  });
}
