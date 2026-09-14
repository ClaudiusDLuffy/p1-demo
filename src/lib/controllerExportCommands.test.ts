import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "./supabase/database.types";
import type { ControllerExportContext } from "../server/controller-exports/controllerExportContext";
import { createStageCommandRepository, type StageCommand } from "../server/controller-exports/stageCommandRepository";
import { createStageReconciliation } from "../server/controller-exports/stageReconciliation";
import { createTransitionCommandRepository, type TransitionCommand } from "../server/controller-exports/transitionCommandRepository";
import { createTransitionReconciliation } from "../server/controller-exports/transitionReconciliation";
import { decideCompensation, type ExportCompensationState } from "../server/controller-exports/compensation";
import { parseControllerCommandEnvelope } from "../server/controller-exports/commandResultValidation";

const ids = { batch: "91000000-0000-4000-8000-000000000001", actor: "91000000-0000-4000-8000-000000000002",
  invoice: "91000000-0000-4000-8000-000000000003", foreign: "91000000-0000-4000-8000-000000000004" };
const timestamp = "2026-09-12T04:10:20.123456Z";
const command = (): StageCommand => ({ batchId: ids.batch, actorId: ids.actor,
  objectPath: `2026-09-12/${ids.batch}.zip`, sources: [{ invoiceId: ids.invoice, updatedAt: timestamp }],
  archiveSha256: "a".repeat(64), archiveBytes: 1024, archiveFormat: "reference_manifest_v2" });
const stageReceipt = () => ({ batchId: ids.batch, status: "pending", invoiceCount: 1, total: 17.25,
  objectPath: command().objectPath, archiveSha256: command().archiveSha256,
  archiveBytes: 1024, archiveFormat: "reference_manifest_v2" });
const batch = () => ({ id: ids.batch, status: "pending", created_by: ids.actor, invoice_count: 1, total: 17.25,
  object_path: command().objectPath, archive_sha256: command().archiveSha256, archive_bytes: 1024,
  archive_format: "reference_manifest_v2" });
const items = () => [{ batch_id: ids.batch, invoice_id: ids.invoice, source_updated_at: timestamp }];
const confirmed = () => ({ applied: true, batchId: ids.batch, status: "confirmed", invoiceCount: 1, total: 17.25,
  confirmedAt: timestamp, confirmedBy: ids.actor });
const confirmedReplay = () => ({ applied: false, reason: "already_confirmed", batchId: ids.batch,
  status: "confirmed", confirmedAt: timestamp, confirmedBy: ids.actor });
const cancelled = () => ({ applied: true, batchId: ids.batch, status: "cancelled", cancelledAt: timestamp,
  cancelledBy: ids.actor, reason: "Synthetic cancellation" });
type Call = { url: URL; method: string; args: Record<string, unknown> | null; signal: AbortSignal | null | undefined };
function harness(respond: (call: Call, attempt: number) => Response | Promise<Response>, signal: AbortSignal | null = null) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "controller-commands.invalid");
    const call = { url, method: init?.method ?? "GET", args: init?.body
      ? z.record(z.string(), z.unknown()).parse(JSON.parse(String(init.body))) : null, signal: init?.signal };
    calls.push(call);
    return respond(call, calls.length);
  };
  const dataSession = createClient<Database>("https://controller-commands.invalid", "synthetic-test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher },
  });
  const context: ControllerExportContext = { actor: { userId: ids.actor, profileId: ids.actor,
    role: "manager", canHandoff: true }, requestId: "synthetic-request-not-operation", signal, dataSession };
  return { context, calls };
}
const rejection = (code = "40001") => Response.json({ code, message: "synthetic-private-sql-canary", details: "secret" }, { status: 409 });
const unknown = () => ({ status: "outcome_unknown" as const, code: "CONTROLLER_EXPORT_OUTCOME_UNKNOWN" as const,
  cause: new TypeError("Synthetic response loss") });

test("controller stage command invokes the exact seven-argument authoritative function once", async () => {
  const controller = new AbortController();
  const h = harness(() => Response.json({ ...stageReceipt(), private_extra: "not public" }), controller.signal);
  const result = await createStageCommandRepository(h.context).execute(command());
  assert.equal(result.status, "committed");
  if (result.status === "committed") assert.deepEqual(result.receipt, stageReceipt());
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url.pathname, "/rest/v1/rpc/stage_contractor_bill_handoff");
  assert.deepEqual(h.calls[0].args, { p_batch_id: ids.batch, p_actor_id: ids.actor,
    p_object_path: command().objectPath, p_sources: command().sources, p_archive_sha256: command().archiveSha256,
    p_archive_bytes: 1024, p_archive_format: "reference_manifest_v2" });
  assert.equal(h.calls[0].signal, controller.signal);
});

for (const [label, value] of [
  ["null", null], ["array", []], ["missing batch", { ...stageReceipt(), batchId: undefined }],
  ["invalid UUID", { ...stageReceipt(), batchId: "bad" }], ["foreign batch", { ...stageReceipt(), batchId: ids.foreign }],
  ["unknown state", { ...stageReceipt(), status: "exported" }], ["invalid fingerprint", { ...stageReceipt(), archiveSha256: "bad" }],
  ["wrong bytes", { ...stageReceipt(), archiveBytes: 1025 }], ["negative bytes", { ...stageReceipt(), archiveBytes: -1 }],
  ["string count", { ...stageReceipt(), invoiceCount: "1" }], ["wrong count", { ...stageReceipt(), invoiceCount: 2 }],
  ["foreign object", { ...stageReceipt(), objectPath: "foreign.zip" }], ["wrong format", { ...stageReceipt(), archiveFormat: "legacy" }],
] as const) test(`controller stage result validator rejects ${label} without a success claim`, async () => {
  const h = harness(() => Response.json(value));
  const result = await createStageCommandRepository(h.context).execute(command());
  assert.equal(result.status, "outcome_unknown");
  assert.equal(h.calls.length, 1);
});

for (const value of [null, [], {}, { data: stageReceipt() }, { data: stageReceipt(), error: false },
  { data: stageReceipt(), error: { code: "40001", message: "private" } },
  { data: null, error: { code: 40001, message: "private" } }]) {
  test(`controller command raw envelope rejects ${JSON.stringify(value)}`, () => assert.throws(() => parseControllerCommandEnvelope(value)));
}

test("controller stage confirmed receipt wins over cancellation after provider response", async () => {
  const controller = new AbortController();
  const h = harness(() => { controller.abort(); return Response.json(stageReceipt()); }, controller.signal);
  const result = await createStageCommandRepository(h.context).execute(command());
  assert.equal(result.status, "committed");
  assert.equal(h.calls.length, 1);
});
test("controller stage cancellation before dispatch makes zero RPC calls", async () => {
  const controller = new AbortController(); controller.abort();
  const h = harness(() => Response.json(stageReceipt()), controller.signal);
  assert.equal((await createStageCommandRepository(h.context).execute(command())).status, "not_dispatched");
  assert.equal(h.calls.length, 0);
});
test("controller stage actor graft is rejected before dispatch", async () => {
  const h = harness(() => Response.json(stageReceipt()));
  assert.equal((await createStageCommandRepository(h.context).execute({ ...command(), actorId: ids.foreign })).status, "known_rejected");
  assert.equal(h.calls.length, 0);
});
for (const objectPath of [`2026-09-12/${ids.foreign}.zip`, `2026-02-30/${ids.batch}.zip`,
  `2026-09-12/nested/${ids.batch}.zip`, `../${ids.batch}.zip`, `2026-09-12/${ids.batch}.pdf`,
  `/2026-09-12/${ids.batch}.zip`, `2026-09-12/${ids.batch}.zip?download=1`]) {
  test(`controller stage command rejects a noncanonical batch object before RPC: ${objectPath}`, async () => {
    const h = harness(() => Response.json({ ...stageReceipt(), objectPath }));
    const result = await createStageCommandRepository(h.context).execute({ ...command(), objectPath });
    assert.equal(result.status, "not_dispatched");
    assert.equal(h.calls.length, 0);
  });
  test(`controller stage reconciliation rejects a noncanonical batch object before reading: ${objectPath}`, async () => {
    const h = harness(call => Response.json(call.url.pathname.endsWith("_batches") ? { ...batch(), object_path: objectPath } : items()));
    const result = await createStageReconciliation(h.context).resolve({ ...command(), objectPath }, unknown());
    assert.equal(result.status, "outcome_unknown");
    assert.equal(h.calls.length, 0);
  });
}
test("controller stage reconciliation cannot replace the authorized actor binding", async () => {
  const h = harness(call => Response.json(call.url.pathname.endsWith("_batches") ? { ...batch(), created_by: ids.foreign } : items()));
  const result = await createStageReconciliation(h.context).resolve({ ...command(), actorId: ids.foreign }, unknown());
  assert.equal(result.status, "outcome_unknown");
  assert.equal(h.calls.length, 0);
});
test("controller stage known rejection rechecks exact immutable snapshot before cleanup", async () => {
  const h = harness((call, attempt) => attempt === 1 ? rejection()
    : Response.json(call.url.pathname.endsWith("_batches") ? batch() : items()));
  const first = await createStageCommandRepository(h.context).execute(command());
  const result = await createStageReconciliation(h.context).resolve(command(), first);
  assert.equal(result.status, "replayed");
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[1].url.searchParams.get("id"), `eq.${ids.batch}`);
  assert.equal(h.calls[1].url.searchParams.get("object_path"), `eq.${command().objectPath}`);
  assert.equal(h.calls[2].url.searchParams.get("limit"), "501");
});
test("controller stage commit then response loss recovers exact immutable batch without a second stage", async () => {
  const h = harness((call, attempt) => {
    if (attempt === 1) throw new TypeError("Synthetic response loss");
    return Response.json(call.url.pathname.endsWith("_batches") ? batch() : items());
  });
  const first = await createStageCommandRepository(h.context).execute(command());
  assert.equal(first.status, "outcome_unknown");
  const result = await createStageReconciliation(h.context).resolve(command(), first);
  assert.equal(result.status, "replayed");
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
});
for (const mismatch of [{ archive_sha256: "b".repeat(64) }, { created_by: ids.foreign },
  { status: "confirmed" }, { status: "cancelled" }, { invoice_count: 2 }, { id: ids.foreign }, { archive_bytes: "1024" }]) {
  test(`controller stage mismatched recovery evidence stays unknown ${JSON.stringify(mismatch)}`, async () => {
    const h = harness(() => Response.json({ ...batch(), ...mismatch }));
    assert.equal((await createStageReconciliation(h.context).resolve(command(), unknown())).status, "outcome_unknown");
    assert.equal(h.calls.length, 1);
  });
}
for (const changed of [[], [...items(), ...items()], [{ ...items()[0], invoice_id: ids.foreign }],
  [{ ...items()[0], batch_id: ids.foreign }], [{ ...items()[0], source_updated_at: "2026-09-12T04:10:20.123457Z" }]]) {
  test(`controller stage changed immutable source binding stays unknown ${JSON.stringify(changed)}`, async () => {
    const h = harness(call => Response.json(call.url.pathname.endsWith("_batches") ? batch() : changed));
    assert.equal((await createStageReconciliation(h.context).resolve(command(), unknown())).status, "outcome_unknown");
  });
}
test("controller stage equivalent timestamp offsets preserve all revision microseconds", async () => {
  const h = harness(call => Response.json(call.url.pathname.endsWith("_batches") ? batch()
    : [{ ...items()[0], source_updated_at: "2026-09-12T12:10:20.123456+08:00" }]));
  assert.equal((await createStageReconciliation(h.context).resolve(command(), unknown())).status, "replayed");
});
for (const known of [true, false]) test(`controller stage absent lookup only proves safe rejection when database outcome is known=${known}`, async () => {
  const h = harness(() => Response.json(null));
  const result = await createStageReconciliation(h.context).resolve(command(), known
    ? { status: "known_rejected", code: "40001", cause: new Error("Synthetic stale selection") } : unknown());
  assert.equal(result.status, known ? "known_rejected" : "outcome_unknown");
  if (result.status === "known_rejected") assert.equal(result.absenceConfirmed, true);
});
test("controller stage unavailable reconciliation retains unknown without another command", async () => {
  const h = harness(() => { throw new TypeError("Synthetic unavailable read"); });
  assert.equal((await createStageReconciliation(h.context).resolve(command(), unknown())).status, "outcome_unknown");
  assert.equal(h.calls.length, 1);
});
test("controller stage cancellation between reconciliation reads prevents immutable-item work", async () => {
  const controller = new AbortController();
  const h = harness(() => { controller.abort(); return Response.json(batch()); }, controller.signal);
  assert.equal((await createStageReconciliation(h.context).resolve(command(), unknown())).status, "outcome_unknown");
  assert.equal(h.calls.length, 1);
});
test("controller stage exact committed reconciliation evidence wins a late abort", async () => {
  const controller = new AbortController();
  const h = harness((_call, attempt) => {
    if (attempt === 1) return Response.json(batch());
    controller.abort(); return Response.json(items());
  }, controller.signal);
  assert.equal((await createStageReconciliation(h.context).resolve(command(), unknown())).status, "replayed");
  assert.equal(h.calls.length, 2);
});
test("controller stage reconciliation deadline aborts actual query transport without SDK retries", async () => {
  const keepAlive = setTimeout(() => undefined, 6000);
  const started = performance.now();
  const h = harness(call => new Promise((_resolve, reject) => {
    assert.ok(call.signal);
    call.signal.addEventListener("abort", () => reject(call.signal?.reason), { once: true });
  }));
  try {
    assert.equal((await createStageReconciliation(h.context).resolve(command(), unknown())).status, "outcome_unknown");
    assert.equal(h.calls.length, 1);
    assert.ok(h.calls[0].signal?.aborted);
    assert.ok(performance.now() - started < 5900);
  } finally { clearTimeout(keepAlive); }
});
for (const code of ["22023", "42501", "P0002", "40001", "55000", "23505", "P0001"]) {
  test(`controller stage known SQL rejection ${code} remains explicit and unretried`, async () => {
    const h = harness(() => rejection(code));
    const result = await createStageCommandRepository(h.context).execute(command());
    assert.equal(result.status, "known_rejected");
    if (result.status === "known_rejected") assert.equal(result.code, code);
    assert.equal(h.calls.length, 1);
  });
}
test("controller stage unknown provider code is not proof of database rollback", async () => {
  const h = harness(() => rejection("NETWORK_TIMEOUT"));
  assert.equal((await createStageCommandRepository(h.context).execute(command())).status, "outcome_unknown");
});

for (const action of ["confirm", "cancel"] as const) {
  const transition: TransitionCommand = action === "confirm" ? { action, batchId: ids.batch }
    : { action, batchId: ids.batch, reason: "Synthetic cancellation" };
  test(`controller ${action} preserves exact receipt, RPC, actor and signal`, async () => {
    const controller = new AbortController();
    const receipt = action === "confirm" ? confirmed() : cancelled();
    const h = harness(() => { controller.abort(); return Response.json(receipt); }, controller.signal);
    const result = await createTransitionCommandRepository(h.context).execute(transition);
    assert.equal(result.status, "committed");
    if (result.status === "committed") assert.deepEqual(result.receipt, receipt);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].signal, controller.signal);
    assert.equal(h.calls[0].url.pathname, `/rest/v1/rpc/${action}_controller_invoice_export`);
    assert.deepEqual(h.calls[0].args, action === "confirm" ? { p_batch_id: ids.batch, p_actor_id: ids.actor }
      : { p_batch_id: ids.batch, p_actor_id: ids.actor, p_reason: "Synthetic cancellation" });
  });
  test(`controller ${action} aborted before dispatch never calls the command`, async () => {
    const controller = new AbortController(); controller.abort();
    const h = harness(() => Response.json({}), controller.signal);
    assert.equal((await createTransitionCommandRepository(h.context).execute(transition)).status, "not_dispatched");
    assert.equal(h.calls.length, 0);
  });
  for (const malformed of [null, [], {}, { ...(action === "confirm" ? confirmed() : cancelled()), applied: "true" },
    { ...(action === "confirm" ? confirmed() : cancelled()), batchId: ids.foreign }]) {
    test(`controller ${action} malformed receipt cannot report success ${JSON.stringify(malformed)}`, async () => {
      const h = harness(() => Response.json(malformed));
      assert.equal((await createTransitionCommandRepository(h.context).execute(transition)).status, "outcome_unknown");
    });
  }
}
test("controller confirmed replay retains SQL's asymmetric original actor receipt", async () => {
  const receipt = { ...confirmedReplay(), confirmedBy: ids.foreign };
  const h = harness(() => Response.json(receipt));
  const result = await createTransitionCommandRepository(h.context).execute({ action: "confirm", batchId: ids.batch });
  assert.equal(result.status, "replayed");
  if (result.status === "replayed") assert.deepEqual(result.receipt, receipt);
});
test("controller confirm response loss replays the identical natural batch command once", async () => {
  const h = harness((_call, attempt) => { if (attempt === 1) throw new TypeError("Synthetic response loss"); return Response.json(confirmedReplay()); });
  const command: TransitionCommand = { action: "confirm", batchId: ids.batch };
  const first = await createTransitionCommandRepository(h.context).execute(command);
  assert.equal((await createTransitionReconciliation(h.context).resolve(command, first)).status, "replayed");
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].args, h.calls[0].args);
});
test("controller confirm reconciliation preserves the original authorized actor despite later context mutation", async () => {
  const h = harness((_call, attempt) => {
    if (attempt === 1) { h.context.actor.profileId = ids.foreign; throw new TypeError("Synthetic response loss"); }
    return Response.json(confirmedReplay());
  });
  const executor = createTransitionCommandRepository(h.context);
  const reconciliation = createTransitionReconciliation(h.context);
  const command: TransitionCommand = { action: "confirm", batchId: ids.batch };
  const first = await executor.execute(command);
  assert.equal((await reconciliation.resolve(command, first)).status, "replayed");
  assert.deepEqual(h.calls[1].args, h.calls[0].args);
  assert.equal(h.calls[1].args?.p_actor_id, ids.actor);
});
test("controller confirm rejection after ambiguous first response remains unknown", async () => {
  const h = harness(() => rejection("55000"));
  assert.equal((await createTransitionReconciliation(h.context).resolve({ action: "confirm", batchId: ids.batch }, unknown())).status, "outcome_unknown");
  assert.equal(h.calls.length, 1);
});
test("controller cancel response loss is reconciled by same actor and exact reason without replay RPC", async () => {
  const h = harness((_call, attempt) => { if (attempt === 1) throw new TypeError("Synthetic response loss");
    return Response.json({ id: ids.batch, status: "cancelled", cancelled_at: timestamp, cancelled_by: ids.actor,
      cancellation_reason: "Synthetic cancellation", confirmed_at: null, confirmed_by: null }); });
  const command: TransitionCommand = { action: "cancel", batchId: ids.batch, reason: "Synthetic cancellation" };
  const first = await createTransitionCommandRepository(h.context).execute(command);
  const result = await createTransitionReconciliation(h.context).resolve(command, first);
  assert.equal(result.status, "replayed");
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
  if (result.status === "replayed") assert.deepEqual(result.receipt, cancelled());
});
for (const change of [{ cancelled_by: ids.foreign }, { cancellation_reason: "Other reason" },
  { status: "confirmed" }, { confirmed_at: timestamp }, { id: ids.foreign }]) {
  test(`controller cancel mismatch cannot confirm an ambiguous transition ${JSON.stringify(change)}`, async () => {
    const h = harness(() => Response.json({ id: ids.batch, status: "cancelled", cancelled_at: timestamp,
      cancelled_by: ids.actor, cancellation_reason: "Synthetic cancellation", confirmed_at: null, confirmed_by: null, ...change }));
    assert.equal((await createTransitionReconciliation(h.context).resolve({ action: "cancel", batchId: ids.batch,
      reason: "Synthetic cancellation" }, unknown())).status, "outcome_unknown");
  });
}
test("controller repeated cancel remains the existing known wrong-state rejection, never fabricated replay", async () => {
  const h = harness(() => rejection("55000"));
  const command: TransitionCommand = { action: "cancel", batchId: ids.batch, reason: "Synthetic cancellation" };
  const first = await createTransitionCommandRepository(h.context).execute(command);
  assert.equal(first.status, "known_rejected");
  assert.deepEqual(await createTransitionReconciliation(h.context).resolve(command, first), first);
  assert.equal(h.calls.length, 1);
});

const state = (): ExportCompensationState => ({ archiveBuilt: true, upload: "confirmed", objectOwned: true,
  stage: "not_dispatched", absenceConfirmed: false, cleanup: "not_attempted" });
for (const [label, changes, action] of [
  ["archive failure", { archiveBuilt: false, upload: "not_dispatched", objectOwned: false }, "return_failure"],
  ["known upload rejection", { upload: "known_failed", objectOwned: false }, "return_failure"],
  ["upload ambiguity", { upload: "unknown", objectOwned: false }, "retain_unknown"],
  ["signed URL failed before stage", {}, "cleanup_exact_object"],
  ["stage ambiguity", { stage: "unknown" }, "retain_unknown"],
  ["stage committed", { stage: "confirmed" }, "return_success"],
  ["known rejection without absent proof", { stage: "known_rejected" }, "retain_unknown"],
  ["known rejection and absent proof", { stage: "known_rejected", absenceConfirmed: true }, "cleanup_exact_object"],
  ["unverified object", { objectOwned: false }, "retain_unknown"],
  ["cleanup confirmed", { cleanup: "confirmed" }, "return_failure"],
  ["cleanup not found", { cleanup: "not_found" }, "return_failure"],
  ["cleanup failed", { cleanup: "known_failed" }, "retain_unknown"],
  ["cleanup response unknown", { cleanup: "unknown" }, "retain_unknown"],
] satisfies [string, Partial<ExportCompensationState>, string][]) {
  test(`controller compensation decision: ${label}`, () => assert.equal(decideCompensation({ ...state(), ...changes }).action, action));
}
test("controller compensation retains every transport-ambiguous stage", () => {
  for (const cleanup of ["not_attempted", "confirmed", "not_found", "known_failed", "unknown"] as const) {
    assert.equal(decideCompensation({ ...state(), stage: "unknown", cleanup }).action, "retain_unknown");
    assert.equal(decideCompensation({ ...state(), stage: "confirmed", cleanup }).action, "return_success");
  }
});
