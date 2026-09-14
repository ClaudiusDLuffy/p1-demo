import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import type * as Client from "./privateObjectClient";
import { beginObjectRequestSchema, uploadIntentSchema, type UploadIntent } from "./privateObjectContracts";
import { configurationFixture } from "./config-test-support/runtimeConfig";
import { PHOTO_ACCEPTED_FORMAT_GUIDANCE } from "./photoContentPolicy";

const ids = { intent: "10000000-0000-4000-8000-000000000001", operation: "10000000-0000-4000-8000-000000000002", batch: "10000000-0000-4000-8000-000000000003", photo: "10000000-0000-4000-8000-000000000004" };
const image = () => new File([new Uint8Array([255, 216, 255, 0, 255, 217])], "camera.heic", { type: "application/octet-stream" });
function harness(options: { loseUploadResponse?: boolean; rejectFormat?: boolean } = {}) {
  const filename = resolve("src/lib/privateObjectClient.ts");
  const requireHere = createRequire(import.meta.url);
  const exports: Partial<typeof Client> = {};
  const calls: { path: string; body: unknown; contentType: string | null }[] = [];
  let intent: UploadIntent | null = null;
  let uploaded = false;
  let uploads = 0;
  let confirmations = 0;
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, Blob, File, Error, crypto: webcrypto, AbortSignal,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-public-key" } },
    require: (name: string) => name === "./supabase/client" ? {
      supabase: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "synthetic-user-session" } }, error: null }) } }),
    } : configurationFixture(name) ?? requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name),
    fetch: async (target: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), "Bearer synthetic-user-session");
      if (target.startsWith("https://")) {
        assert.ok(intent);
        assert.equal(target, `https://synthetic.invalid/storage/v1/object/${intent.bucket}/${intent.objectPath}`);
        assert.equal(headers.get("x-upsert"), "false");
        assert.equal(headers.get("content-type"), "image/jpeg");
        uploads++; uploaded = true;
        if (options.loseUploadResponse) throw new Error("transport lost after accepting object");
        return new Response("{}");
      }
      assert.equal(typeof init.body, "string");
      const body: unknown = JSON.parse(String(init.body));
      calls.push({ path: target, body, contentType: headers.get("content-type") });
      if (target.endsWith("intents")) {
        const request = beginObjectRequestSchema.parse(body);
        assert.equal(request.kind, "photo");
        if (request.kind !== "photo") throw new Error("Unexpected attachment");
        intent ??= uploadIntentSchema.parse({ intentId: ids.intent, operationId: request.operationId, batchId: request.batchId,
          purpose: "photo", workOrderId: request.workOrderId, parentId: null, bucket: "photos", objectPath: `wo/${request.workOrderId}/${ids.intent}`,
          status: "pending", expiresAt: "2026-09-10T00:00:00Z", claimId: null, bindingId: null, storageObjectId: null,
          photoId: null, attachmentId: null, file: request.file });
        return Response.json(intent);
      }
      assert.ok(intent);
      if (target.endsWith("finalize")) {
        if (!uploaded) return Response.json({ status: "upload_required", intent });
        if (options.rejectFormat) return Response.json({ status: "cleanup_required", intentId: intent.intentId,
          code: "UNSUPPORTED_IMAGE_FORMAT", message: "Convert this photo. Existing uploaded photos are not affected." });
        if (intent.status !== "finalized") confirmations++;
        intent = { ...intent, status: "finalized", storageObjectId: ids.photo, photoId: ids.photo, bindingId: ids.photo };
        return Response.json({ status: "confirmed", intent });
      }
      if (target.endsWith("cancel")) return Response.json({ ...intent, status: "cleaned" });
      throw new Error("Unexpected IO");
    },
  });
  assert.equal(typeof exports.createWorkOrderPhotoPorts, "function");
  assert.ok(exports.createWorkOrderPhotoPorts);
  return { ports: exports.createWorkOrderPhotoPorts("WOT-SYNTHETIC", 3, 2), calls,
    counts: () => ({ uploads, confirmations }) };
}

test("client reserves a parent/version-bound photo and uploads actual-signature MIME, not filename/MIME claims", async () => {
  const h = harness(); const file = image(); const signal = new AbortController().signal;
  const authorization = await h.ports.begin(file, ids.operation, ids.batch, signal);
  assert.equal(authorization.status, "upload_required");
  await h.ports.upload(authorization.intent, file, signal);
  const result = await h.ports.finalize(authorization.intent, signal, () => undefined);
  assert.equal(result.status, "confirmed");
  const request = beginObjectRequestSchema.parse(h.calls[0].body);
  assert.equal(request.file.name, "camera.heic");
  assert.equal(request.file.mimeType, "application/octet-stream");
  assert.equal(request.file.sha256.length, 64);
  assert.deepEqual(h.counts(), { uploads: 1, confirmations: 1 });
});

test("accepted upload with a lost response finalizes the same intent without another object", async () => {
  const h = harness({ loseUploadResponse: true }); const file = image(); const signal = new AbortController().signal;
  const first = await h.ports.begin(file, ids.operation, ids.batch, signal);
  await assert.rejects(h.ports.upload(first.intent, file, signal));
  const replay = await h.ports.begin(file, ids.operation, ids.batch, signal);
  assert.equal(replay.intent.objectPath, first.intent.objectPath);
  assert.equal((await h.ports.finalize(replay.intent, signal, () => undefined)).status, "confirmed");
  assert.equal((await h.ports.finalize(replay.intent, signal, () => undefined)).status, "confirmed");
  assert.deepEqual(h.counts(), { uploads: 1, confirmations: 1 });
});

test("trusted rejection exposes compatible conversion guidance and no client confirmation", async () => {
  const h = harness({ rejectFormat: true }); const file = image(); const signal = new AbortController().signal;
  const first = await h.ports.begin(file, ids.operation, ids.batch, signal);
  await h.ports.upload(first.intent, file, signal);
  const result = await h.ports.finalize(first.intent, signal, () => undefined);
  assert.equal(result.status, "cleanup_required");
  if (result.status === "cleanup_required") assert.equal(result.message, PHOTO_ACCEPTED_FORMAT_GUIDANCE);
  assert.equal(h.counts().confirmations, 0);
});

test("same bytes selected twice in one batch cannot reserve another object", async () => {
  const h = harness(); const signal = new AbortController().signal;
  await h.ports.begin(image(), ids.operation, ids.batch, signal);
  await assert.rejects(h.ports.begin(image(), ids.photo, ids.batch, signal), /already included in this batch/);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.counts(), { uploads: 0, confirmations: 0 });
});
