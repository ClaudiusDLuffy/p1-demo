import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { zipArchiveByteLength, zipArchiveHasEntry } from "./zipArchive";
import type { ControllerExportStorageSession } from "../server/controller-exports/exportStorage";
import { exportTestId, loadControllerOwner } from "./controller-export-test-support/ownersHarness";

const archiveOwner = loadControllerOwner<typeof import("../server/controller-exports/archiveBuilder")>("src/server/controller-exports/archiveBuilder.ts");
const storageOwner = loadControllerOwner<typeof import("../server/controller-exports/exportStorage")>("src/server/controller-exports/exportStorage.ts");
const attempt = { batchId: exportTestId(800), objectPath: `2026-09-12/${exportTestId(800)}.zip` };
const filename = "Contractor-Bills-2026-09-12-95100000-000.zip";
const bytes = new TextEncoder().encode("SYNTHETIC-ARCHIVE-CONTENT");
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const uploadReceipt = () => ({ data: { id: exportTestId(801), path: attempt.objectPath, fullPath: `controller-exports/${attempt.objectPath}` }, error: null });
const signedUrl = `https://synthetic.invalid/storage/v1/object/sign/controller-exports/${attempt.objectPath}?token=synthetic-token`;
type StorageAction = "upload" | "download" | "remove" | "sign";
const fakeStorage = (outcomes: Partial<Record<StorageAction, unknown | (() => unknown)>> = {}) => {
  const calls: { action: StorageAction; bucket: string; args: readonly unknown[] }[] = [];
  const run = async (action: StorageAction, bucket: string, args: readonly unknown[], fallback: unknown): Promise<unknown> => {
    calls.push({ action, bucket, args });
    const outcome = Object.hasOwn(outcomes, action) ? outcomes[action] : fallback;
    return typeof outcome === "function" ? outcome() : outcome;
  };
  const session: ControllerExportStorageSession = { storage: Object.assign({ from: (bucket: "controller-exports") => ({
    upload: (path: string, body: Uint8Array, options: { contentType: "application/zip"; upsert: false }) => run("upload", bucket, [path, body, options], uploadReceipt()),
    download: (path: string, options: Record<string, never>, parameters?: { signal: AbortSignal }) => ({ asStream: () => run("download", bucket, [path, options, parameters], { data: new Blob([bytes]).stream(), error: null }) }),
    remove: (paths: string[]) => run("remove", bucket, [paths], { data: [{ name: attempt.objectPath }], error: null }),
    createSignedUrl: (path: string, seconds: number, options: { download: string }) => run("sign", bucket, [path, seconds, options], { data: { signedUrl }, error: null }),
  }) }, { url: "https://synthetic.invalid/storage/v1" }) };
  return { session, calls };
};
const archiveEntries = () => [{ name: "Contractor-bills-reference-manifest.csv", data: new TextEncoder().encode("\uFEFFReference Only\r\nSynthetic") },
  { name: "Contractor-Bill-PDFs/Invoice-Synthetic.pdf", data: new TextEncoder().encode("%PDF-synthetic") }];

test("controller focused archive preserves stored ZIP32, deterministic clock, bytes and SHA without mutating input", async () => {
  const input = archiveEntries(); const before = structuredClone(input);
  const builder = archiveOwner.createArchiveBuilder(null, { now: () => new Date("2026-09-12T00:00:00Z") });
  const first = await builder.build(input); const second = await builder.build(input);
  assert.deepEqual(first, second); assert.deepEqual(input, before);
  assert.ok(first.bytes instanceof Uint8Array); assert.equal(first.byteLength, zipArchiveByteLength(input));
  assert.equal(first.sha256, digest(first.bytes));
  assert.ok(zipArchiveHasEntry(first.bytes, input[0].name)); assert.ok(zipArchiveHasEntry(first.bytes, input[1].name));
  const view = new DataView(first.bytes.buffer); assert.equal(view.getUint16(8, true), 0); assert.equal(view.getUint16(6, true), 0x0800);
});
test("controller archive Buffer inputs preserve exactly the Uint8Array binary representation", async () => {
  const builder = archiveOwner.createArchiveBuilder(null, { now: () => new Date("2026-09-12T00:00:00Z") });
  const source = archiveEntries();
  const normal = await builder.build(source);
  const buffers = await builder.build(source.map(entry => ({ ...entry, data: Buffer.from(entry.data) })));
  assert.deepEqual(buffers.bytes, normal.bytes);
});
test("controller archive500 invoices plus manifest preserve501 unique ordered entries", async () => {
  const entries = [archiveEntries()[0], ...Array.from({ length: 500 }, (_, index) => ({ name: `Contractor-Bill-PDFs/Invoice-${exportTestId(index)}.pdf`, data: new Uint8Array([index % 256]) }))];
  const result = await archiveOwner.createArchiveBuilder(null).build(entries);
  assert.equal(result.byteLength, zipArchiveByteLength(entries));
  const view = new DataView(result.bytes.buffer); assert.equal(view.getUint16(result.byteLength - 12, true), 501);
  assert.ok(zipArchiveHasEntry(result.bytes, entries[500].name));
  await assert.rejects(archiveOwner.createArchiveBuilder(null).build([...entries, { name: "one-too-many.pdf", data: bytes }]));
});
for (const name of ["../outside.pdf", "/absolute.pdf", "nested\\escape.pdf", "folder//double.pdf"]) test(`controller archive refuses unsafe entry ${name}`, async () => {
  await assert.rejects(archiveOwner.createArchiveBuilder(null).build([archiveEntries()[0], { name, data: bytes }]));
});
test("controller archive refuses duplicate entries and cancellation before building", async () => {
  await assert.rejects(archiveOwner.createArchiveBuilder(null).build([archiveEntries()[0], archiveEntries()[0]]));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(archiveOwner.createArchiveBuilder(controller.signal).build(archiveEntries()), { name: "AbortError" });
});
test("controller95MiB archive bound includes metadata; exact limit works and one byte over fails", async t => {
  const input = [{ name: "Contractor-bills-reference-manifest.csv", data: new Uint8Array() }, { name: "Contractor-Bill-PDFs/Large.pdf", data: new Uint8Array() }];
  const overhead = zipArchiveByteLength(input);
  input[1].data = new Uint8Array(archiveOwner.MAX_CONTROLLER_ARCHIVE_BYTES - overhead);
  // Deliberately nonuniform synthetic bytes; stored ZIP does not compress them.
  for (let index = 0; index < input[1].data.length; index += 1) input[1].data[index] = (index * 31 + (index >>> 8)) & 255;
  const rssBefore = process.memoryUsage().rss; const started = performance.now();
  const archive = await archiveOwner.createArchiveBuilder(null).build(input);
  const elapsedMs = performance.now() - started; const rssAfter = process.memoryUsage().rss;
  assert.equal(archive.byteLength, 95 * 1024 * 1024);
  assert.ok(zipArchiveHasEntry(archive.bytes, input[1].name));
  await assert.rejects(archiveOwner.createArchiveBuilder(null).build([{ ...input[0], data: new Uint8Array(1) }, input[1]]), { code: "CONFLICT" });
  t.diagnostic(JSON.stringify({ fixture: "synthetic_near_cap_stored_zip32", inputBytes: input[1].data.byteLength, archiveBytes: archive.byteLength,
    overheadBytes: overhead, elapsedMs, rssBefore, rssAfter, maxRssKiB: process.resourceUsage().maxRSS,
    limitations: "Local sampled process RSS and cumulative process maxRSS only; not hosted peak memory or browser certification." }));
});

test("controller upload sends one exact private batch object and validates its receipt", async () => {
  const fake = fakeStorage();
  const result = await storageOwner.createExportStorage(fake.session, null).upload(attempt, bytes);
  assert.deepEqual(result, { status: "confirmed", ownership: "exact_attempt_object" });
  assert.deepEqual(fake.calls, [{ action: "upload", bucket: "controller-exports", args: [attempt.objectPath, bytes, { contentType: "application/zip", upsert: false }] }]);
});
for (const [name, receipt] of [
  ["null", null], ["missing envelope", {}], ["empty success", { data: null, error: null }],
  ["foreign object", { data: { id: exportTestId(801), path: "other.zip", fullPath: "controller-exports/other.zip" }, error: null }],
  ["invalid UUID", { data: { id: "bad", path: attempt.objectPath, fullPath: `controller-exports/${attempt.objectPath}` }, error: null }],
] as const) test(`controller malformed upload ${name} is unknown, never success or automatic cleanup`, async () => {
  const fake = fakeStorage({ upload: receipt });
  const result = await storageOwner.createExportStorage(fake.session, null).upload(attempt, bytes);
  assert.equal(result.status, "unknown"); assert.equal(result.ownership, "unverified"); assert.equal(fake.calls.length, 1);
});
for (const status of [400, 401, 403, 409, 413, 415, 422]) test(`controller known Storage rejection ${status} does not authorize cleanup`, async () => {
  const fake = fakeStorage({ upload: { data: null, error: { statusCode: String(status), message: "PRIVATE PROVIDER CANARY" } } });
  const result = await storageOwner.createExportStorage(fake.session, null).upload(attempt, bytes);
  assert.equal(result.status, "known_failed"); assert.equal(result.ownership, "unverified"); assert.equal(fake.calls.length, 1);
});
test("controller ambiguous upload and abort after dispatch retain unknown without a blind retry", async () => {
  const controller = new AbortController();
  const fake = fakeStorage({ upload: () => { controller.abort(); throw new DOMException("Synthetic timeout", "AbortError"); } });
  const result = await storageOwner.createExportStorage(fake.session, controller.signal).upload(attempt, bytes);
  assert.equal(result.status, "unknown"); assert.equal(fake.calls.length, 1);
});
test("controller validated upload success survives late cancellation; early abort sends nothing", async () => {
  const controller = new AbortController();
  const fake = fakeStorage({ upload: () => { controller.abort(); return uploadReceipt(); } });
  const port = storageOwner.createExportStorage(fake.session, controller.signal);
  assert.equal((await port.upload(attempt, bytes)).status, "confirmed");
  assert.equal((await port.upload(attempt, bytes)).status, "not_dispatched"); assert.equal(fake.calls.length, 1);
});
test("controller exact upload reconciliation requires matching full hash and size at same path", async () => {
  const controller = new AbortController(); const fake = fakeStorage();
  const port = storageOwner.createExportStorage(fake.session, controller.signal);
  assert.deepEqual(await port.reconcileUpload(attempt, digest(bytes), bytes.byteLength), { status: "confirmed", ownership: "exact_attempt_object" });
  assert.deepEqual(fake.calls, [{ action: "download", bucket: "controller-exports", args: [attempt.objectPath, {}, { signal: controller.signal }] }]);
});
for (const outcome of [{ data: new Blob([new Uint8Array(bytes.length)]).stream(), error: null }, { data: new Blob().stream(), error: null },
  { data: null, error: { statusCode: "404" } }, { data: "invalid", error: null }, null]) test("controller unknown or changed upload proof remains unknown without cleanup", async () => {
  const fake = fakeStorage({ download: outcome });
  const result = await storageOwner.createExportStorage(fake.session, null).reconcileUpload(attempt, digest(bytes), bytes.byteLength);
  assert.equal(result.status, "unknown"); assert.equal(result.ownership, "unverified"); assert.equal(fake.calls.length, 1);
});
for (const [name, raw, expected] of [
  ["confirmed", { data: [{ name: attempt.objectPath }], error: null }, "confirmed"],
  ["already absent", { data: [], error: null }, "not_found"],
  ["provider absent", { data: null, error: { status: 404 } }, "not_found"],
  ["known rejection", { data: null, error: { status: 403 } }, "known_failed"],
  ["provider timeout", { data: null, error: { status: 504 } }, "unknown"],
  ["malformed", { data: null, error: null }, "unknown"],
  ["foreign object", { data: [{ name: "other.zip" }], error: null }, "unknown"],
] as const) test(`controller cleanup ${name} retains exact evidence without false clean claims`, async () => {
  const fake = fakeStorage({ remove: raw }); const result = await storageOwner.createExportStorage(fake.session, null).cleanup(attempt);
  assert.equal(result.status, expected); assert.deepEqual(fake.calls[0].args, [[attempt.objectPath]]);
});
test("controller cleanup response loss and cancellation remain unknown or not attempted", async () => {
  const fake = fakeStorage({ remove: () => { throw new Error("Synthetic response loss"); } });
  assert.equal((await storageOwner.createExportStorage(fake.session, null).cleanup(attempt)).status, "unknown");
  const controller = new AbortController(); controller.abort();
  assert.equal((await storageOwner.createExportStorage(fake.session, controller.signal).cleanup(attempt)).status, "not_attempted");
  assert.equal(fake.calls.length, 1);
});
test("controller signed URL uses exact120-second lifetime and private batch path", async () => {
  const fake = fakeStorage(); const result = await storageOwner.createExportStorage(fake.session, null).sign(attempt, filename);
  assert.deepEqual(result, { status: "confirmed", url: signedUrl });
  assert.deepEqual(fake.calls, [{ action: "sign", bucket: "controller-exports", args: [attempt.objectPath, 120, { download: filename }] }]);
});
for (const url of ["javascript:alert(1)", "https://synthetic.invalid/wrong/path?token=x", signedUrl.replace("synthetic.invalid", "foreign.invalid"), signedUrl.replace("token=synthetic-token", "no-token=x")]) test("controller malformed or foreign signed URLs fail without leaking raw provider fields", async () => {
  const fake = fakeStorage({ sign: { data: { signedUrl: url, detail: "PRIVATE CANARY" }, error: null } });
  assert.equal((await storageOwner.createExportStorage(fake.session, null).sign(attempt, filename)).status, "failed");
});
test("controller foreign batch paths are rejected before any Storage dispatch", async () => {
  const fake = fakeStorage(); const port = storageOwner.createExportStorage(fake.session, null);
  for (const objectPath of ["../foreign.zip", `2026-09-12/${exportTestId(801)}.zip`, "2026-02-30/invalid.zip"]) {
    await assert.rejects(port.upload({ ...attempt, objectPath }, bytes));
    await assert.rejects(port.cleanup({ ...attempt, objectPath }));
    await assert.rejects(port.sign({ ...attempt, objectPath }, filename));
  }
  assert.equal(fake.calls.length, 0);
});
test("controller installed Storage SDK preserves Uint8Array upload and download abort signal without network", async () => {
  const controller = new AbortController(); const calls: { method: string; body: unknown; signal: unknown; contentType: string | null }[] = [];
  const client = createClient("https://synthetic.invalid", "synthetic-publishable", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
    const url = String(input); const method = init?.method ?? "GET";
    calls.push({ method, body: init?.body, signal: init?.signal, contentType: new Headers(init?.headers).get("content-type") });
    if (url.includes("/object/sign/")) return new Response(JSON.stringify({ signedURL: `/object/sign/controller-exports/${attempt.objectPath}?token=synthetic-token` }), { headers: { "content-type": "application/json" } });
    if (method === "POST") return new Response(JSON.stringify({ Id: exportTestId(801), Key: `controller-exports/${attempt.objectPath}` }), { headers: { "content-type": "application/json" } });
    return new Response(bytes, { headers: { "content-type": "application/zip" } });
  } } });
  const port = storageOwner.createExportStorage(client, controller.signal);
  assert.equal((await port.upload(attempt, bytes)).status, "confirmed");
  assert.equal((await port.reconcileUpload(attempt, digest(bytes), bytes.byteLength)).status, "confirmed");
  assert.equal((await port.sign(attempt, filename)).status, "confirmed");
  assert.ok(calls[0].body instanceof Uint8Array); assert.equal(calls[0].contentType, "application/zip");
  assert.equal(calls[1].signal, controller.signal);
});
