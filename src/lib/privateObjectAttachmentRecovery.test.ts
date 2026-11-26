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

const parent = "71000000-0000-4000-8000-000000000001";
function harness(cancellation: "cleaned" | "cleanup_required" | "finalized" | "lost" | "mismatched" = "cleaned") {
  const filename = resolve("src/lib/privateObjectClient.ts"), requireHere = createRequire(import.meta.url);
  const exports: Partial<typeof Client> = {};
  const intents: UploadIntent[] = [], uploaded = new Set<string>();
  let uploads = 0;
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, Blob, File, Error, crypto: webcrypto, AbortSignal,
    require: (name: string) => name === "./supabase/client" ? {
      supabase: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "synthetic-session" } }, error: null }) } }),
    } : configurationFixture(name) ?? requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name),
    fetch: async (target: string, init: RequestInit) => {
      if (target.startsWith("https://")) {
        const intent = intents.find(value => target.endsWith(value.objectPath));
        assert.ok(intent); assert.equal(new Headers(init.headers).get("x-upsert"), "false");
        assert.equal(new Headers(init.headers).get("content-type"), "application/pdf");
        uploads++; uploaded.add(intent.intentId); return new Response("{}");
      }
      const body = JSON.parse(String(init.body));
      if (target.endsWith("intents")) {
        const request = beginObjectRequestSchema.parse(body);
        assert.equal(request.kind, "attachment"); if (request.kind !== "attachment") throw Error("Unexpected photo");
        const intentId = webcrypto.randomUUID();
        const intent = uploadIntentSchema.parse({ intentId, operationId: request.operationId, batchId: null,
          purpose: request.purpose, workOrderId: "WOT-SYNTHETIC", parentId: request.parentId, bucket: "invoice-pdfs",
          objectPath: `${request.parentId}/${intentId}.pdf`, status: "pending", expiresAt: "2026-12-01T00:00:00Z",
          claimId: null, bindingId: null, storageObjectId: null, photoId: null, attachmentId: null, file: request.file });
        intents.push(intent); return Response.json(intent);
      }
      const index = intents.findIndex(value => value.intentId === body.intentId), intent = intents[index];
      assert.ok(intent);
      if (target.endsWith("cancel")) {
        if (cancellation === "lost") throw Error("Synthetic lost cleanup response");
        const status = cancellation === "mismatched" ? "cleaned" : cancellation;
        const result = { ...intent, status, operationId: cancellation === "mismatched" ? webcrypto.randomUUID() : intent.operationId };
        if (cancellation !== "mismatched") intents[index] = result;
        return Response.json(result);
      }
      assert.ok(target.endsWith("finalize"));
      if (intent.status === "cleaned" || intent.status === "cleanup_required") {
        return Response.json({ status: "cleanup_required", intentId: intent.intentId, code: "UPLOAD_CLEANED", message: "Synthetic cleanup completed" });
      }
      if (!uploaded.has(intent.intentId)) return Response.json({ status: "upload_required", intent });
      const finalized: UploadIntent = { ...intent, status: "finalized", storageObjectId: intent.intentId, bindingId: intent.intentId, attachmentId: intent.intentId };
      intents[index] = finalized; return Response.json({ status: "confirmed", intent: finalized });
    },
  });
  assert.ok(exports.uploadBoundAttachment); assert.ok(exports.cancelUnattachedUpload);
  return { upload: exports.uploadBoundAttachment, cancel: exports.cancelUnattachedUpload, intents, uploads: () => uploads };
}

for (const purpose of ["invoice_original", "invoice_generated"] as const) {
  test(`${purpose}: verified cleanup allows same-file retry without reusing the deleted reservation`, async () => {
    const h = harness(), file = new Blob(["synthetic PDF"], { type: "application/pdf" });
    const original = await h.upload(parent, purpose, file, "synthetic.pdf");
    assert.equal((await h.cancel(original)).status, "cleaned");
    const [retry, concurrent] = await Promise.all([h.upload(parent, purpose, file, "synthetic.pdf"), h.upload(parent, purpose, file, "synthetic.pdf")]);
    assert.notEqual(retry.operationId, original.operationId); assert.notEqual(retry.objectPath, original.objectPath);
    assert.equal(retry.intentId, concurrent.intentId); assert.equal(retry.parentId, parent); assert.equal(retry.purpose, purpose);
    assert.equal(h.intents.length, 2); assert.equal(h.uploads(), 2);
    assert.equal((await h.upload(parent, purpose, file, "synthetic.pdf")).intentId, retry.intentId);
    assert.equal(h.intents.length, 2); assert.equal(h.uploads(), 2);
  });
}

for (const outcome of ["finalized", "cleanup_required", "lost", "mismatched"] as const) {
  test(`attachment ${outcome} cleanup outcome never creates a fresh reservation`, async () => {
    const h = harness(outcome), file = new Blob(["synthetic PDF"], { type: "application/pdf" });
    const original = await h.upload(parent, "invoice_original", file, "synthetic.pdf");
    if (outcome === "lost" || outcome === "mismatched") await assert.rejects(h.cancel(original));
    else await h.cancel(original);
    if (outcome === "cleanup_required") await assert.rejects(h.upload(parent, "invoice_original", file, "synthetic.pdf"));
    else assert.equal((await h.upload(parent, "invoice_original", file, "synthetic.pdf")).intentId, original.intentId);
    assert.equal(h.intents.length, 1); assert.equal(h.uploads(), 1);
  });
}
