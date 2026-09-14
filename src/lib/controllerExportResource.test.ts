import assert from "node:assert/strict";
import test from "node:test";
import { readControllerExportBody, CONTROLLER_EXPORT_BODY_BYTES } from "../server/controller-exports/contracts";
import type { ControllerExportDocumentRepository, ControllerExportDocumentInput } from "../server/controller-exports/exportDocumentRepository";
import type { ControllerExportArchiveBuilder } from "../server/controller-exports/archiveBuilder";
import type { ZipArchiveEntry } from "./zipArchive";
import { createExportSnapshot, CONTROLLER_EXPORT_MANIFEST_NAME } from "../server/controller-exports/snapshot";
import { loadControllerOwner, exportInvoiceRow } from "./controller-export-test-support/ownersHarness";
import { createEligibilityRepository } from "../server/controller-exports/eligibilityRepository";
import { exportQueryFake } from "./controller-export-test-support/ownersHarness";

test("controller body limit returns promptly even when stream cancellation never acknowledges", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(CONTROLLER_EXPORT_BODY_BYTES + 1)); },
    cancel() { cancelled = true; return new Promise<void>(() => undefined); } });
  const request = new Request("https://synthetic.invalid/api/controller-exports", { method: "POST", body, duplex: "half" } as RequestInit);
  const result = await Promise.race([readControllerExportBody(request).then(() => "unexpected success", (error: unknown) => error instanceof Error && "code" in error ? error.code : "unexpected rejection"),
    new Promise(resolve => setTimeout(() => resolve("stalled cleanup"), 100))]);
  assert.equal(result, "PAYLOAD_TOO_LARGE");
  assert.equal(cancelled, true);
});

async function fixture(count: number) {
  const rows = Array.from({ length: count }, (_, index) => exportInvoiceRow(index + 1));
  const query = exportQueryFake({ invoices: rows });
  const facts = await createEligibilityRepository(query.session, null).loadSelected(rows.map(row => row.id));
  const inputs: ControllerExportDocumentInput[] = facts.map(invoice => ({ invoice, contractor: null, workOrder: null,
    useStoredOriginal: false, lines: [{ id: invoice.id, invoiceId: invoice.id, position: 0, type: "Labor",
      description: "Synthetic line only", qty: 1, rate: 17.25, amount: 17.25 }] }));
  return { facts, inputs };
}
test("controller package assembly consumes streamed invoices without the complete-line collector and preserves archive order", async () => {
  const { facts, inputs } = await fixture(3);
  const owner = loadControllerOwner<typeof import("../server/controller-exports/buildExportArchive")>("src/server/controller-exports/buildExportArchive.ts");
  const calls: string[] = [];
  const documents: ControllerExportDocumentRepository = {
    async loadInputs() { throw new Error("Full selection line collector must not run"); },
    async *iterateInputs() { for (const input of [...inputs].reverse()) { calls.push(`input:${input.invoice.id}`); yield input; } },
    async loadBytes(input) { calls.push(`pdf:${input.invoice.id}`); return new Uint8Array([Number(input.invoice.id.slice(-2))]); },
  };
  let entries: readonly ZipArchiveEntry[] = [];
  const archive: ControllerExportArchiveBuilder = { async build(value) { entries = value; return { bytes: new Uint8Array([80, 75]), byteLength: 2, sha256: "a".repeat(64) }; } };
  const builder = owner.createExportPackageBuilder(documents, archive, null);
  const prepared = await builder.prepare(facts);
  assert.equal(calls.length, 0);
  await builder.build(prepared);
  assert.equal(entries[0].name, CONTROLLER_EXPORT_MANIFEST_NAME);
  assert.deepEqual(Array.from(entries, entry => entry.name), [CONTROLLER_EXPORT_MANIFEST_NAME, ...createExportSnapshot(inputs).pdfEntries.map(entry => entry.name)]);
  assert.equal(new TextDecoder().decode(entries[0].data), new TextDecoder().decode(createExportSnapshot(inputs).manifest));
  assert.deepEqual(calls, [...inputs].reverse().flatMap(input => [`input:${input.invoice.id}`, `pdf:${input.invoice.id}`]));
  assert.equal(inputs.every(input => input.lines.length === 1), true);
});
test("controller package assembly stops the input iterator before later work after a document crosses the ZIP bound", async () => {
  const { facts, inputs } = await fixture(3);
  const owner = loadControllerOwner<typeof import("../server/controller-exports/buildExportArchive")>("src/server/controller-exports/buildExportArchive.ts");
  let yielded = 0; let closed = false; let archiveCalls = 0;
  const documents: ControllerExportDocumentRepository = {
    async loadInputs() { throw new Error("Not a collector"); },
    async *iterateInputs() { try { for (const input of inputs) { yielded++; yield input; } } finally { closed = true; } },
    async loadBytes(_input, remaining) { assert.ok(remaining < 95 * 1024 * 1024); throw new Error("Synthetic over-limit document rejected by bounded reader"); },
  };
  const builder = owner.createExportPackageBuilder(documents, { async build() { archiveCalls++; throw new Error("Must not build"); } }, null);
  await assert.rejects(builder.build(await builder.prepare(facts)));
  assert.equal(yielded, 1); assert.equal(closed, true); assert.equal(archiveCalls, 0);
});
test("controller package canonical source identities are captured before document I/O", async () => {
  const { facts } = await fixture(1);
  const owner = loadControllerOwner<typeof import("../server/controller-exports/buildExportArchive")>("src/server/controller-exports/buildExportArchive.ts");
  const documents: ControllerExportDocumentRepository = { async loadInputs() { throw new Error("Not used"); },
    async *iterateInputs() { throw new Error("Not used"); }, async loadBytes() { throw new Error("Not used"); } };
  const prepared = await owner.createExportPackageBuilder(documents, { async build() { throw new Error("Not used"); } }, null).prepare(facts);
  const originalId = facts[0].id;
  facts[0].id = "82000000-0000-4000-8000-000000000999";
  assert.equal(prepared.sources[0].invoiceId, originalId);
  assert.equal(prepared.invoices[0].id, originalId);
});
