import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import type { ControllerExportContext } from "../../server/controller-exports/controllerExportContext";
import { createStageCommandRepository, type StageCommand } from "../../server/controller-exports/stageCommandRepository";
import { createStageReconciliation } from "../../server/controller-exports/stageReconciliation";
import { createTransitionCommandRepository } from "../../server/controller-exports/transitionCommandRepository";
import { decideCompensation, type ExportCompensationState } from "../../server/controller-exports/compensation";
import { createEligibilityRepository } from "../../server/controller-exports/eligibilityRepository";
import { createExportSnapshot } from "../../server/controller-exports/snapshot";
import { mapControllerExportHistory } from "../../server/controller-exports/historyMapper";
import type { ControllerExportDocumentSession } from "../../server/controller-exports/exportDocumentRepository";
import type { ControllerExportStorageSession } from "../../server/controller-exports/exportStorage";
import { controllerGraphHarness, controllerScopeFake } from "../../server/controller-exports/testing/scopeFake";
import { controllerBoundaryHarness } from "../../server/controller-exports/testing/boundaryHarness";
import { controllerTestIds as ids } from "../../server/controller-exports/testing/authorizationPorts";
import { exportQueryFake, exportInvoiceRow, exportTestId, loadControllerOwner } from "./ownersHarness";

const request = (body: unknown) => new Request("https://synthetic.invalid/api/controller-exports", {
  method: "POST", headers: { Authorization: "Bearer synthetic-controller", "X-Request-ID": ids.request },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const command = (): StageCommand => ({ batchId: ids.batch, actorId: ids.actor,
  objectPath: `2026-09-12/${ids.batch}.zip`, sources: [{ invoiceId: ids.invoice, updatedAt: "2026-09-12T00:00:00.000Z" }],
  archiveSha256: "a".repeat(64), archiveBytes: 1024, archiveFormat: "reference_manifest_v2" });
function commandTransport(respond: (url: URL, method: string, attempt: number) => Response | Promise<Response>) {
  const calls: { url: URL; method: string; body: string | null }[] = [];
  const dataSession = createClient<Database>("https://controller-regression.invalid", "synthetic-test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.hostname, "controller-regression.invalid");
      const method = init?.method ?? "GET"; calls.push({ url, method, body: init?.body ? String(init.body) : null });
      return respond(url, method, calls.length);
    } },
  });
  const context: ControllerExportContext = { actor: { userId: ids.actor, profileId: ids.actor, role: "manager", canHandoff: true },
    requestId: ids.request, signal: null, dataSession };
  return { calls, context };
}
const batchRow = () => ({ id: ids.batch, status: "pending", created_by: ids.actor, invoice_count: 1, total: 120,
  object_path: command().objectPath, archive_sha256: command().archiveSha256, archive_bytes: 1024, archive_format: "reference_manifest_v2" });
const sourceRows = () => [{ batch_id: ids.batch, invoice_id: ids.invoice, source_updated_at: command().sources[0].updatedAt }];
const state = (): ExportCompensationState => ({ archiveBuilt: true, upload: "confirmed", objectOwned: true,
  stage: "unknown", absenceConfirmed: false, cleanup: "not_attempted" });

export async function assertArchiveRpcReconciliation(): Promise<void> {
  for (const responseLost of [false, true]) {
    const h = commandTransport((url, _method, attempt) => {
      if (attempt === 1) {
        if (responseLost) throw new TypeError("Synthetic commit response lost");
        return Response.json({ code: "40001", message: "Synthetic stale selection" }, { status: 409 });
      }
      return Response.json(url.pathname.endsWith("_batches") ? batchRow() : sourceRows());
    });
    const first = await createStageCommandRepository(h.context).execute(command());
    assert.equal(first.status, responseLost ? "outcome_unknown" : "known_rejected");
    const reconciled = await createStageReconciliation(h.context).resolve(command(), first);
    assert.equal(reconciled.status, "replayed");
    assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
    assert.equal(h.calls[0].url.pathname, "/rest/v1/rpc/stage_contractor_bill_handoff");
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls[1].url.searchParams.get("id"), `eq.${ids.batch}`);
    assert.equal(h.calls[1].url.searchParams.get("object_path"), `eq.${command().objectPath}`);
    assert.equal(h.calls[2].url.searchParams.get("limit"), "501");
    assert.deepEqual(decideCompensation({ ...state(), stage: "confirmed" }), { action: "return_success" });
  }
  const mismatch = commandTransport(() => Response.json({ ...batchRow(), archive_sha256: "b".repeat(64) }));
  assert.equal((await createStageReconciliation(mismatch.context).resolve(command(), {
    status: "outcome_unknown", code: "CONTROLLER_EXPORT_OUTCOME_UNKNOWN", cause: new Error("Synthetic response loss"),
  })).status, "outcome_unknown");
  assert.deepEqual(decideCompensation(state()), { action: "retain_unknown" });
}

export async function assertAmbiguousStageRetention(): Promise<void> {
  for (const phase of ["upload", "stage"] as const) {
    const fake = controllerScopeFake();
    if (phase === "upload") fake.scope.stage.storage.upload = async () => { fake.calls.push("storage:upload"); return { status: "unknown", ownership: "unverified" }; };
    else fake.scope.stage.commands.execute = async value => { fake.calls.push("command:stage"); fake.commands.push(value); return { status: "outcome_unknown", code: "CONTROLLER_EXPORT_OUTCOME_UNKNOWN", cause: new Error("Synthetic lost stage response") }; };
    const h = controllerGraphHarness({ scope: fake }); const response = await h.route("POST", request({}));
    assert.equal(response.status, 500); assert.equal(h.calls.includes("storage:cleanup"), false);
    assert.equal(h.commands.length, phase === "upload" ? 0 : 1);
    assert.equal(h.calls.filter(call => call === "attempt:create").length, 1);
    assert.equal(h.calls.filter(call => call === "storage:upload").length, 1);
  }
  assert.deepEqual(decideCompensation({ ...state(), upload: "unknown", stage: "not_dispatched", objectOwned: false }), { action: "retain_unknown" });
  assert.deepEqual(decideCompensation({ ...state(), stage: "known_rejected", absenceConfirmed: true }), { action: "cleanup_exact_object" });
  for (const cleanup of ["unknown", "known_failed"] as const) assert.deepEqual(decideCompensation({ ...state(), stage: "known_rejected", absenceConfirmed: true, cleanup }), { action: "retain_unknown" });
  assert.deepEqual(decideCompensation({ ...state(), stage: "known_rejected", absenceConfirmed: true, cleanup: "confirmed" }), { action: "return_failure" });
}

export async function assertExclusionChunking(): Promise<void> {
  const invoices = Array.from({ length: 500 }, (_, index) => exportInvoiceRow(index + 1, { contractor_id: exportTestId(1000 + index),
    work_order_id: `WOT${900000 + index}`, pdf_storage_path: `synthetic-${index}.pdf` }));
  const fake = exportQueryFake({ invoices: [...invoices].reverse() });
  const selected = await createEligibilityRepository(fake.session, null).loadSelected(invoices.map(row => row.id).reverse());
  assert.deepEqual(selected.map(row => row.id), invoices.map(row => row.id));
  assert.equal(fake.dispatchCount(), 15); // Three query families × ceil(500 / 100).
  const documentOwner = loadControllerOwner<typeof import("../../server/controller-exports/exportDocumentRepository")>("src/server/controller-exports/exportDocumentRepository.ts");
  const session: ControllerExportDocumentSession = { ...fake.session, rpc: () => { throw new Error("No document bytes requested"); },
    storage: { from: () => ({ download: () => { throw new Error("No Storage requested"); } }) } };
  const inputs = [];
  for await (const input of documentOwner.createExportDocumentRepository(session, null).iterateInputs(selected)) inputs.push(input);
  assert.equal(inputs.length, 500); assert.equal(fake.dispatchCount(), 35);
  for (const table of ["invoices", "contractor_invoice_payment_holds", "controller_invoice_export_items", "invoice_lines", "activities", "profiles", "work_orders"]) {
    assert.equal(fake.queries.filter(query => query.table === table).length, 5, table);
  }
  assert.ok(fake.queries.every(query => query.fields !== "*" && query.filters.every(filter => filter.operator !== "in" || Array.isArray(filter.value) && filter.value.length <= 100)));
  const middle = exportQueryFake({}, (_query, count) => count === 3 ? { data: null, error: { message: "Synthetic private failure" } } : undefined);
  await assert.rejects(createEligibilityRepository(middle.session, null).loadSelected(invoices.map(row => row.id)));
  assert.equal(middle.dispatchCount(), 4); // Only already-dispatched pair can complete.
  const abort = new AbortController();
  const cancelled = exportQueryFake({}, (query, count) => { assert.equal(query.signal, abort.signal); if (count === 2) abort.abort(); });
  await assert.rejects(createEligibilityRepository(cancelled.session, abort.signal).loadSelected(invoices.map(row => row.id)), { name: "AbortError" });
  assert.equal(cancelled.dispatchCount(), 2);
}

export async function assertMalformedBatchRequests(): Promise<void> {
  for (const body of ["{", "null", "[]", { invoiceIds: "bad" }, { invoiceIds: [null] }, { invoiceIds: [ids.invoice, 1] }]) {
    const h = controllerBoundaryHarness(); const response = await h.route("POST", request(body));
    assert.equal(response.status, 400); assert.equal(h.service.calls.length, 0); assert.equal(h.service.constructed.length, 0);
    assert.deepEqual(await response.json(), { error: "The request is invalid. Check the details and try again.", code: "INVALID_REQUEST", correlationId: ids.request });
  }
  for (const raw of [null, [], {}, { batchId: ids.batch, status: "exported" }]) {
    const h = commandTransport(() => Response.json(raw));
    assert.equal((await createStageCommandRepository(h.context).execute(command())).status, "outcome_unknown");
    assert.equal(h.calls.length, 1);
  }
}

export async function assertLargePrivateZipResponse(): Promise<void> {
  const owner = loadControllerOwner<typeof import("../../server/controller-exports/archiveBuilder")>("src/server/controller-exports/archiveBuilder.ts");
  const archive = await owner.createArchiveBuilder(null, { now: () => new Date("2026-09-12T00:00:00Z") }).build([
    { name: "Reference.csv", data: new TextEncoder().encode("Synthetic manifest") },
    { name: "Synthetic.pdf", data: new Uint8Array(8 * 1024 * 1024).fill(163) },
  ]);
  assert.ok(archive.byteLength > 8 * 1024 * 1024); assert.ok(archive.byteLength < 95 * 1024 * 1024);
  assert.equal(archive.bytes[0], 80); assert.equal(archive.bytes[1], 75);
  const calls: { name: string; path: string; bytes?: Uint8Array; ttl?: number }[] = [];
  const storageSession: ControllerExportStorageSession = { storage: { from(bucket) {
    assert.equal(bucket, "controller-exports"); return {
      async upload(path, bytes, options) { calls.push({ name: "upload", path, bytes });
        assert.deepEqual(options, { contentType: "application/zip", upsert: false });
        return { data: { id: ids.otherActor, path, fullPath: `controller-exports/${path}` }, error: null }; },
      async createSignedUrl(path, ttl) { calls.push({ name: "sign", path, ttl });
        return { data: { signedUrl: `https://synthetic.invalid/storage/v1/object/sign/controller-exports/${path}?token=synthetic` }, error: null }; },
      download: () => { throw new Error("No upload reconciliation expected"); },
      remove: () => { throw new Error("Committed archive must never be cleaned"); },
    };
  } } };
  const storageOwner = loadControllerOwner<typeof import("../../server/controller-exports/exportStorage")>("src/server/controller-exports/exportStorage.ts");
  const fake = controllerScopeFake(); fake.scope.stage.storage = storageOwner.createExportStorage(storageSession, null, { expectedOrigin: "https://synthetic.invalid" });
  fake.scope.stage.packages.build = async () => archive;
  const h = controllerGraphHarness({ scope: fake }); const response = await h.route("POST", request({}));
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/json");
  const text = await response.text(); assert.ok(Buffer.byteLength(text) < 1024);
  assert.equal(JSON.parse(text).archiveBytes, archive.byteLength); assert.equal(JSON.parse(text).archiveSha256, archive.sha256);
  assert.equal(calls.length, 2); assert.equal(calls[0].bytes, archive.bytes); assert.equal(calls[1].ttl, 120);
  assert.equal(h.commands.length, 1); assert.equal(h.commands[0].archiveBytes, archive.byteLength);
}

export async function assertCanonicalControllerIdentity(): Promise<void> {
  const row = exportInvoiceRow(1, { num: "INV-700001" });
  const fake = exportQueryFake({ invoices: [row], invoice_lines: [{ id: exportTestId(500), invoice_id: row.id, position: 0, type: "Labor", description: "Synthetic repair", qty: 1, rate: 123.45, amount: 123.45 }],
    work_orders: [{ id: "WOT900001-2", duplicate_root_work_order_id: "WOT900001", summary: "Store 42 HVAC Repair", description: null,
      line_of_service: "HVAC", business_service: null, category: null, sub_category: null }] });
  const selected = await createEligibilityRepository(fake.session, null).loadSelected([row.id]);
  const documents = loadControllerOwner<typeof import("../../server/controller-exports/exportDocumentRepository")>("src/server/controller-exports/exportDocumentRepository.ts");
  const session: ControllerExportDocumentSession = { ...fake.session, rpc: () => { throw new Error("No document download"); }, storage: { from: () => ({ download: () => { throw new Error("No document download"); } }) } };
  const inputs = await documents.createExportDocumentRepository(session, null).loadInputs(selected);
  const snapshot = createExportSnapshot(inputs); const csv = new TextDecoder().decode(snapshot.manifest);
  assert.equal(selected[0].workOrderId, "WOT900001-2"); assert.equal(inputs[0].workOrder?.duplicate_root_work_order_id, "WOT900001");
  assert.match(csv, /,WOT900001,WOT900001-2,42,/);
  assert.equal(snapshot.pdfEntries[0].name, `Contractor-Bill-PDFs/Invoice-INV-700001-WOT900001-${row.id}.pdf`);
  assert.doesNotMatch(snapshot.pdfEntries[0].name, /Store 42|WOT900001-2/);
  assert.deepEqual(snapshot.sources, [{ invoiceId: row.id, updatedAt: row.updated_at }]);
  const history = mapControllerExportHistory({ batches: [{ id: ids.batch, status: "pending", createdBy: ids.actor, createdAt: "2026-09-12T00:00:00Z",
    confirmedAt: null, confirmedBy: null, cancelledAt: null, cancelledBy: null, cancellationReason: null, invoiceCount: 1, total: 130 }],
    items: [{ batchId: ids.batch, invoiceId: row.id, invoiceNumber: "INV-700001", workOrderId: "WOT900001-2", contractorId: null, total: 130 }], profiles: [] });
  assert.equal(history.history[0].items[0].workOrderId, "WOT900001-2");
  assert.equal(history.history[0].items[0].invoiceNumber, "INV-700001");
}

export async function assertHeldControllerExclusion(): Promise<void> {
  const query = exportQueryFake({ invoices: [exportInvoiceRow(1)], contractor_invoice_payment_holds: [{ invoice_id: exportTestId(1) }] });
  const fake = controllerScopeFake({ stage: { eligibility: createEligibilityRepository(query.session, null) } });
  const h = controllerGraphHarness({ scope: fake }); const response = await h.route("POST", request({ invoiceIds: [exportTestId(1)] }));
  assert.equal(response.status, 409); assert.deepEqual(h.calls, []); assert.equal(h.commands.length, 0);
  assert.ok(!query.queries.some(item => item.table === "invoices"));
  // Authoritative hold race is a database rejection, never a client eligibility override.
  const race = controllerScopeFake();
  race.scope.stage.commands.execute = async value => { race.calls.push("command:held-race"); race.commands.push(value); return { status: "known_rejected", code: "40001", cause: new Error("Synthetic hold appeared after pre-read") }; };
  race.scope.stage.reconciliation.resolve = async (_value, result) => { assert.equal(result.status, "known_rejected"); return { status: "known_rejected", code: "40001", absenceConfirmed: true, cause: new Error("Synthetic absent batch") }; };
  const raceRoute = controllerGraphHarness({ scope: race }); const denied = await raceRoute.route("POST", request({ invoiceIds: [ids.invoice] }));
  assert.equal(denied.status, 409); assert.equal(race.commands.length, 1); assert.equal(race.calls.filter(call => call === "storage:cleanup").length, 1);
  const signed = loadControllerOwner<typeof import("../../server/controller-exports/signedDownloadService")>("src/server/controller-exports/signedDownloadService.ts");
  let signedCalls = 0;
  const cancelled = controllerScopeFake();
  cancelled.scope.list.history.loadDownload = async batchId => ({ batchId, objectPath: `2026-09-12/${batchId}.zip`, status: "cancelled",
    createdAt: "2026-09-12T00:00:00Z", format: "reference_manifest_v2" });
  cancelled.scope.stage.storage.sign = async () => { signedCalls++; return { status: "failed" }; };
  await assert.rejects(signed.createSignedDownloadService(cancelled.scope.list.history, cancelled.scope.stage.storage).load(ids.batch), { code: "CONFLICT" });
  assert.equal(signedCalls, 0);
}

export async function assertControllerTransitions(): Promise<void> {
  for (const action of ["confirm", "cancel"] as const) {
    const receipt = action === "confirm"
      ? { applied: true, batchId: ids.batch, status: "confirmed", invoiceCount: 1, total: 120, confirmedAt: "2026-09-12T00:00:00Z", confirmedBy: ids.actor }
      : { applied: true, batchId: ids.batch, status: "cancelled", cancelledAt: "2026-09-12T00:00:00Z", cancelledBy: ids.actor, reason: "Synthetic cancellation" };
    const h = commandTransport(() => Response.json(receipt));
    const result = await createTransitionCommandRepository(h.context).execute(action === "confirm"
      ? { action, batchId: ids.batch } : { action, batchId: ids.batch, reason: "Synthetic cancellation" });
    assert.equal(result.status, "committed");
    if (result.status === "committed") assert.deepEqual(result.receipt, receipt);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url.pathname, `/rest/v1/rpc/${action}_controller_invoice_export`);
    assert.deepEqual(JSON.parse(h.calls[0].body ?? "null"), { p_actor_id: ids.actor, p_batch_id: ids.batch, ...(action === "cancel" ? { p_reason: "Synthetic cancellation" } : {}) });
  }
}
