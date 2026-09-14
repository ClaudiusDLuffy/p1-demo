import assert from "node:assert/strict";
import test from "node:test";
import { controllerGraphHarness, controllerScopeFake } from "../server/controller-exports/testing/scopeFake";
import { controllerTestIds as ids } from "../server/controller-exports/testing/authorizationPorts";
import { transitionControllerExport } from "../server/controller-exports/transitionControllerExport";
import type { ControllerExportContext } from "../server/controller-exports/controllerExportContext";
import type { TransitionCommand } from "../server/controller-exports/transitionCommandRepository";
import type { PreparedControllerExportArchive } from "../server/controller-exports/buildExportArchive";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./supabase/database.types";

function request(method: string, body: unknown) {
  return new Request("https://synthetic.invalid/api/controller-exports", { method,
    headers: { Authorization: "Bearer synthetic-controller", "X-Request-ID": ids.request }, body: JSON.stringify(body) });
}
for (const method of ["POST", "confirm", "cancel"] as const) {
  test(`controller ${method} committed result structurally skips an optional failing reconciler`, async () => {
    const fake = controllerScopeFake();
    let reconciliations = 0;
    const failing = async (): Promise<never> => { reconciliations++; throw new Error("Synthetic optional reconciliation outage"); };
    fake.scope.stage.reconciliation.resolve = failing;
    fake.scope.transition.reconciliation.resolve = failing;
    const h = controllerGraphHarness({ scope: fake });
    const response = await h.route(method === "POST" ? "POST" : "PATCH", request(method === "POST" ? "POST" : "PATCH",
      method === "POST" ? { invoiceIds: [ids.invoice] } : { action: method, batchId: ids.batch, reason: "Synthetic cancellation" }));
    assert.equal(response.status, 200);
    assert.equal(reconciliations, 0);
    assert.equal(fake.calls.includes("storage:cleanup"), false);
    assert.equal(h.logs.length, 0);
  });
}
test("controller stage immutable source command does not change when loaded source facts change after dispatch", async () => {
  const fake = controllerScopeFake();
  const prepare = fake.scope.stage.packages.prepare;
  let prepared: PreparedControllerExportArchive | undefined;
  fake.scope.stage.packages.prepare = async invoices => { prepared = await prepare(invoices); return prepared; };
  fake.scope.stage.commands.execute = async () => {
    assert.ok(prepared);
    prepared.sources[0].invoiceId = ids.otherActor;
    prepared.sources[0].updatedAt = "2026-09-13T00:00:00.000Z";
    return { status: "outcome_unknown", code: "CONTROLLER_EXPORT_OUTCOME_UNKNOWN", cause: new TypeError("Synthetic response loss") };
  };
  let seenInvoice = ""; let seenRevision = "";
  fake.scope.stage.reconciliation.resolve = async (command, result) => {
    seenInvoice = command.sources[0].invoiceId; seenRevision = command.sources[0].updatedAt; return result;
  };
  const h = controllerGraphHarness({ scope: fake });
  const response = await h.route("POST", request("POST", { invoiceIds: [ids.invoice] }));
  assert.equal(response.status, 500);
  assert.equal(seenInvoice, ids.invoice);
  assert.equal(seenRevision, "2026-09-12T00:00:00.000Z");
  assert.equal(fake.calls.includes("storage:cleanup"), false);
});
test("controller transition captures its exact command before dispatch and reconciliation", async () => {
  const command: TransitionCommand = { action: "cancel", batchId: ids.batch, reason: "Original synthetic reason" };
  const client = createClient<Database>("https://unused-controller.invalid", "synthetic-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async () => { throw new Error("No transport is allowed in this use-case fixture"); } },
  });
  const context: ControllerExportContext = { actor: { userId: ids.actor, profileId: ids.actor, role: "back_office", canHandoff: true },
    requestId: ids.request, signal: null, dataSession: client };
  let seen: TransitionCommand | undefined;
  const result = await transitionControllerExport(command, context, {
    commands: { async execute() { command.batchId = ids.otherActor; command.reason = "Changed synthetic reason";
      return { status: "outcome_unknown", code: "CONTROLLER_EXPORT_OUTCOME_UNKNOWN", cause: new TypeError("Synthetic response loss") }; } },
    reconciliation: { async resolve(captured, response) { seen = { ...captured }; return response; } },
  });
  assert.equal(result.kind, "failed");
  assert.deepEqual(seen, { action: "cancel", batchId: ids.batch, reason: "Original synthetic reason" });
});
