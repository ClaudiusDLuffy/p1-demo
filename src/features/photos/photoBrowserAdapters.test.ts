import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createBrowserPhotoStorageAdapter, type BrowserPhotoStorageDependencies } from "./browserPhotoStorageAdapter";
import { readPhotoBytes, digestPhotoBytes, photoContentType, validatePhotoFile, requirePhotoBlob,
  createPhotoObjectUrl, revokePhotoObjectUrl, createPhotoArchiveObjectUrl } from "./browserPhotoFileAdapter";
import { PhotoUploadError } from "./photoUploadError";
import { PhotoUploadError as CompatiblePhotoUploadError } from "./photoUploadController";
import { PHOTO_CONTENT_LIMITS } from "../../lib/photoContentPolicy";
import { uploadIntentSchema } from "../../lib/privateObjectContracts";

const jpeg = () => new File([new Uint8Array([255,216,255,0,255,217])], "synthetic.heic", { type: "application/octet-stream" });
const intent = () => uploadIntentSchema.parse({
  intentId: "a8400000-0000-4000-8000-000000000001", operationId: "a8400000-0000-4000-8000-000000000002",
  batchId: "a8400000-0000-4000-8000-000000000003", purpose: "photo", workOrderId: "SYNTHETIC-PHOTO",
  parentId: null, bucket: "photos", objectPath: "wo/SYNTHETIC-PHOTO/a8400000-0000-4000-8000-000000000001",
  status: "pending", expiresAt: "2026-09-14T12:00:00Z", claimId: null, bindingId: null, storageObjectId: null,
  photoId: null, attachmentId: null,
  file: { name: "synthetic.heic", mimeType: "application/octet-stream", sizeBytes: 6, sha256: "a".repeat(64) },
});
function adapter(overrides: Partial<BrowserPhotoStorageDependencies> = {}) {
  const requests: { target: string; init?: RequestInit }[] = [], downloads: string[] = [];
  const dependencies: BrowserPhotoStorageDependencies = {
    session: async () => ({ data: { session: { access_token: "synthetic-user-token" } }, error: null }),
    configuration: () => ({ url: "https://synthetic.invalid", publishableKey: "synthetic-public-key" }),
    download: async path => { downloads.push(path); return { data: jpeg(), error: null }; },
    fetch: async (target, init) => { requests.push({ target, init }); return new Response(jpeg()); }, ...overrides,
  };
  return { ...createBrowserPhotoStorageAdapter(dependencies), requests, downloads };
}

test("safe upload error retains its compatible class identity", () => assert.equal(PhotoUploadError, CompatiblePhotoUploadError));
for (const [name, bytes, mime] of [
  ["jpeg", [255,216,255], "image/jpeg"], ["png", [137,80,78,71,13,10,26,10], "image/png"],
  ["gif", [...Buffer.from("GIF89a")], "image/gif"], ["webp", [...Buffer.from("RIFF0000WEBP")], "image/webp"],
  ["tiff", [73,73,42,0], "image/tiff"],
] as const) test(`browser signature accepts ${name} independently of extension and MIME`, async () => {
  assert.equal(await photoContentType(new File([new Uint8Array(bytes)], "synthetic.bmp", { type: "text/plain" })), mime);
});
for (const [name, bytes] of [["bmp", "BMsynthetic"], ["heic", "0000ftypheic0000"], ["heif", "0000ftypmif10000"], ["unknown", "synthetic plain text"]]) {
  test(`browser signature rejects disguised ${name} without an upload`, async () => {
    await assert.rejects(validatePhotoFile(new File([bytes], "synthetic.jpg", { type: "image/jpeg" })), PhotoUploadError);
  });
}
test("browser byte and digest mechanics preserve all actual bytes", async () => {
  const file = jpeg(), bytes = await readPhotoBytes(file);
  assert.equal(await digestPhotoBytes(file), createHash("sha256").update(new Uint8Array(bytes)).digest("hex"));
});
test("photo size gate accepts exactly 10 MiB and rejects empty and one byte over", async () => {
  const bytes = new Uint8Array(PHOTO_CONTENT_LIMITS.maxBytes); bytes.set([255,216,255]);
  await validatePhotoFile(new Blob([bytes]));
  await assert.rejects(validatePhotoFile(new Blob([])), PhotoUploadError);
  await assert.rejects(validatePhotoFile(new Blob([bytes, new Uint8Array(1)])), PhotoUploadError);
  assert.deepEqual([PHOTO_CONTENT_LIMITS.maxWidth, PHOTO_CONTENT_LIMITS.maxHeight, PHOTO_CONTENT_LIMITS.maxTotalPixels,
    PHOTO_CONTENT_LIMITS.maxFrames, PHOTO_CONTENT_LIMITS.timeoutMs], [12000,12000,40000000,100,10000]);
});
test("file cancellation prevents byte dispatch and rejects late bytes with the same reason", async () => {
  const c = new AbortController(), reason = new DOMException("Synthetic cancellation", "AbortError"); c.abort(reason);
  let reads = 0;
  class ObservedBlob extends Blob { async arrayBuffer() { reads++; return super.arrayBuffer(); } }
  await assert.rejects(readPhotoBytes(new ObservedBlob(["synthetic"]), c.signal), e => e === reason); assert.equal(reads, 0);
  const late = new AbortController();
  class LateBlob extends Blob { async arrayBuffer() { late.abort(reason); return super.arrayBuffer(); } }
  await assert.rejects(readPhotoBytes(new LateBlob(["synthetic"]), late.signal), e => e === reason);
});
test("preview and archive object URLs preserve bytes and can be revoked without external IO", async () => {
  const blob = jpeg(), url = createPhotoObjectUrl(blob);
  try { assert.deepEqual(new Uint8Array(await (await fetch(url)).arrayBuffer()), new Uint8Array(await blob.arrayBuffer())); }
  finally { revokePhotoObjectUrl(url); }
  await assert.rejects(fetch(url));
  const bytes = new Uint8Array([80,75,3,4]), archive = createPhotoArchiveObjectUrl(bytes); bytes[0] = 0;
  try { const response = await fetch(archive); assert.equal((await response.arrayBuffer()).byteLength, 4); assert.equal(response.headers.get("content-type"), "application/zip"); }
  finally { revokePhotoObjectUrl(archive); }
});
test("raw blob boundary rejects non-Blob results", () => {
  for (const value of [null, undefined, {}, "synthetic", { arrayBuffer: () => new ArrayBuffer(0) }]) assert.throws(() => requirePhotoBlob(value));
});
test("photo upload uses only exact reserved path, actual MIME, user session and INSERT protocol", async () => {
  const h = adapter(), file = jpeg(), reservation = intent();
  await h.uploadReservedPhoto(reservation, file, new AbortController().signal);
  assert.equal(h.requests.length, 1);
  const call = h.requests[0], headers = new Headers(call.init?.headers);
  assert.equal(call.target, "https://synthetic.invalid/storage/v1/object/" + reservation.bucket + "/" + reservation.objectPath);
  assert.equal(call.init?.body, file); assert.equal(call.init?.method, "POST");
  assert.equal(headers.get("x-upsert"), "false"); assert.equal(headers.get("content-type"), "image/jpeg");
  assert.equal(headers.get("authorization"), "Bearer synthetic-user-token");
  assert.equal(h.downloads.length, 0);
});
for (const [name, patch] of [
  ["bucket", { bucket: "invoice-pdfs" }], ["path", { objectPath: "wo/OTHER/object" }],
  ["parent", { workOrderId: "OTHER" }], ["traversal", { objectPath: "../object" }],
] as const) test(`invalid reservation ${name} is rejected before dispatch`, async () => {
  const h = adapter(); await assert.rejects(h.uploadReservedPhoto({ ...intent(), ...patch }, jpeg()), PhotoUploadError);
  assert.equal(h.requests.length, 0);
});
test("aborted-before-dispatch upload does not read auth or send bytes", async () => {
  let auth = 0; const h = adapter({ session: async () => { auth++; return null; } });
  const c = new AbortController(); c.abort();
  await assert.rejects(h.uploadReservedPhoto(intent(), jpeg(), c.signal), { name: "AbortError" });
  assert.equal(auth, 0); assert.equal(h.requests.length, 0);
});
test("known rejection and unknown upload outcomes never retry, remove, or claim metadata confirmation", async () => {
  for (const fail of [false, true]) {
    let calls = 0; const h = adapter({ fetch: async () => { calls++; if (fail) throw new Error("Synthetic response lost"); return new Response("{}", { status: 403 }); } });
    await assert.rejects(h.uploadReservedPhoto(intent(), jpeg()));
    assert.equal(calls, 1); assert.equal(h.downloads.length, 0); assert.equal("remove" in h, false);
  }
});
test("late cancellation after acknowledged upload is left to authoritative workflow reconciliation", async () => {
  const c = new AbortController(); let calls = 0;
  const h = adapter({ fetch: async () => { calls++; c.abort(); return new Response("{}"); } });
  await h.uploadReservedPhoto(intent(), jpeg(), c.signal);
  assert.equal(calls, 1); assert.equal(h.downloads.length, 0);
});
test("malformed session stops upload and private download validates the raw result", async () => {
  const h = adapter({ session: async () => ({ data: { session: {} } }), download: async () => ({ data: "not a Blob", error: null }) });
  await assert.rejects(h.uploadReservedPhoto(intent(), jpeg()), PhotoUploadError); assert.equal(h.requests.length, 0);
  await assert.rejects(h.loadPhotoBlob(intent().objectPath), /Empty photo response/);
});
test("exact private download and preview do not create a public/signed URL or enumerate objects", async () => {
  const h = adapter(), path = intent().objectPath;
  assert.ok((await h.loadPhotoBlob(path)) instanceof Blob);
  const url = await h.getPhotoUrl(path); assert.ok(url?.startsWith("blob:")); if (url) revokePhotoObjectUrl(url);
  assert.deepEqual(h.downloads, [path, path]); assert.equal(h.requests.length, 0);
  assert.equal(await h.getPhotoUrl(""), null); await assert.rejects(h.loadPhotoBlob(""), /A photo path is required/);
});
test("legacy download bytes and URL passthrough remain compatible without rebinding", async () => {
  const h = adapter();
  for (const path of ["data:image/jpeg;base64,synthetic", "https://example.invalid/synthetic.jpg"]) {
    assert.equal(await h.getPhotoUrl(path), path); assert.ok((await h.loadPhotoBlob(path)) instanceof Blob);
  }
  assert.equal(h.downloads.length, 0); assert.equal(h.requests.length, 2);
});
