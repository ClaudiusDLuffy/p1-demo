import assert from "node:assert/strict";
import { configurationFixture } from "./config-test-support/runtimeConfig";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { beginObjectRequestSchema, intentRequestSchema, deleteRequestSchema, uploadIntentSchema,
  PrivateObjectError, type UploadIntent, type ObjectDeletion } from "./privateObjectContracts";
import type { PhotoImageMetadata } from "./photoContentPolicy";
import type { PrivateObjectWorkflowPorts } from "./server/privateObjectWorkflow";
import type { PrivateObjectStorage, RemovalOutcome } from "./server/privateObjectStorage";

const requireHere = createRequire(import.meta.url);
const cache = new Map<string, Record<string, unknown>>();
function serverModule(name: string): Record<string, unknown> {
  const filename = resolve("src/lib/server", `${name}.ts`);
  const previous = cache.get(filename); if (previous) return previous;
  const exports: Record<string, unknown> = {}; cache.set(filename, exports);
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, Buffer, process, AbortSignal, Uint8Array, TextDecoder, Response, Request,
    Promise, setTimeout, clearTimeout, fetch,
    require: (dependency: string): unknown => {
      if (dependency === "server-only") return {};
      if (dependency === "../supabase/server") return { createServerClient: () => { throw new Error("Shared database access is forbidden in this test"); } };
      if (dependency.startsWith("./")) return serverModule(dependency.slice(2));
      return dependency.startsWith(".") ? requireHere(resolve(filename, "..", dependency)) : requireHere(dependency);
    },
  }, { filename });
  return exports;
}
const workflowExports = serverModule("privateObjectWorkflow") as Partial<typeof import("./server/privateObjectWorkflow")>;
const inspectionExports = serverModule("photoImageInspection") as Partial<typeof import("./server/photoImageInspection")>;
const authorizationExports = serverModule("privateObjectAuthorization") as Partial<typeof import("./server/privateObjectAuthorization")>;
// Transpiled installed source owns these exports; check before invoking them.
assert.ok(workflowExports.createPrivateObjectWorkflow && inspectionExports.inspectPhotoImage && inspectionExports.PhotoContentError
  && authorizationExports.parseObjectRequest && authorizationExports.privateObjectFailure);
const { createPrivateObjectWorkflow } = workflowExports;
const { inspectPhotoImage, PhotoContentError } = inspectionExports;
const { parseObjectRequest, privateObjectFailure } = authorizationExports;
const id = "00000000-0000-4000-8000-000000000001", claimId = "00000000-0000-4000-8000-000000000002";
const batchId = "00000000-0000-4000-8000-000000000003", bindingId = "00000000-0000-4000-8000-000000000004";
const metadata: PhotoImageMetadata = { format: "jpeg", mimeType: "image/jpeg", extension: "jpg", sizeBytes: 4,
  sha256: "a".repeat(64), width: 1, height: 1, frames: 1 };
const pending = (): UploadIntent => ({ intentId: id, operationId: id, batchId, purpose: "photo", workOrderId: "SYNTHETIC",
  parentId: null, bucket: "photos", objectPath: `wo/SYNTHETIC/${id}`, status: "pending", expiresAt: "2099-01-01T00:00:00Z",
  claimId: null, bindingId: null, storageObjectId: null, photoId: null, attachmentId: null,
  file: { name: "synthetic.jpg", mimeType: "image/jpeg", sizeBytes: 4, sha256: metadata.sha256 } });
const deletion = (): ObjectDeletion => ({ deletionId: id, operationId: id, bindingId, purpose: "photo", bucket: "photos",
  objectPath: `wo/SYNTHETIC/${id}`, status: "pending", claimId: null, photoId: bindingId });

function harness(options: {
  inspect?: typeof inspectPhotoImage; bytes?: Uint8Array | null;
  finalizeFailure?: "rollback" | "lost_response"; failUnavailable?: boolean;
  busy?: boolean; initialStatus?: UploadIntent["status"]; removeOutcome?: RemovalOutcome; objectPresent?: boolean;
} = {}) {
  let intent: UploadIntent = { ...pending(), status: options.initialStatus ?? "pending" };
  let deleted = deletion();
  const calls: string[] = [], failures: string[] = [], inspections: unknown[] = [];
  const durable = { metadata: 0, bindings: 0, activities: 0 };
  let finalizeFailures = 0;
  const ports: PrivateObjectWorkflowPorts = {
    get: async () => { calls.push("get"); return { ...intent }; },
    claim: async () => {
      calls.push("claim");
      if (["finalized", "cleanup_required", "cancelled", "expired", "cleaned"].includes(intent.status)) return { ...intent };
      intent = { ...intent, status: "validating", claimId: options.busy ? null : claimId,
        storageObjectId: options.objectPresent === false ? null : id }; return { ...intent };
    },
    finalize: async (_id, claim, inspection) => {
      calls.push("finalize"); assert.equal(claim, claimId); inspections.push(inspection);
      const before = { ...durable };
      durable.bindings++; durable.metadata++;
      if (options.finalizeFailure === "rollback" && finalizeFailures++ === 0) {
        Object.assign(durable, before); throw new Error("Synthetic transaction failure after binding; SQL fixture separately proves rollback");
      }
      durable.activities++;
      intent = { ...intent, status: "finalized", claimId: null, bindingId, photoId: bindingId };
      if (options.finalizeFailure === "lost_response" && finalizeFailures++ === 0) throw new Error("Synthetic lost acknowledgement after committed binding");
      return { ...intent };
    },
    fail: async (_id, claim, code) => {
      calls.push("fail"); assert.equal(claim, claimId); failures.push(code);
      if (options.failUnavailable) throw new Error("Synthetic fail-marker transport outage");
      if (intent.status === "finalized") return { ...intent };
      const retry = ["OBJECT_MISSING", "IMAGE_INSPECTION_BUSY", "IMAGE_INSPECTION_TIMEOUT", "IMAGE_INSPECTION_ABORTED",
        "IMAGE_INSPECTION_FAILED", "OBJECT_DOWNLOAD_FAILED", "FINALIZATION_FAILED"].includes(code);
      intent = { ...intent, status: retry ? "pending" : "cleanup_required", claimId: null }; return { ...intent };
    },
    cancel: async () => { calls.push("cancel"); if (intent.status !== "finalized") intent = { ...intent, status: "cancelled" }; return { ...intent }; },
    claimCleanup: async () => { calls.push("claimCleanup"); if (intent.status !== "cleaned") intent = { ...intent, claimId }; return { ...intent }; },
    completeCleanup: async (_id, claim, outcome) => { calls.push(`completeCleanup:${outcome}`); assert.equal(claim, claimId);
      intent = { ...intent, status: ["deleted", "absent"].includes(outcome) ? "cleaned" : "cleanup_required", claimId: null }; return { ...intent }; },
    claimDeletion: async () => { calls.push("claimDeletion"); if (deleted.status !== "deleted") deleted = { ...deleted, claimId }; return { ...deleted }; },
    completeDeletion: async (_id, claim, outcome) => { calls.push(`completeDeletion:${outcome}`); assert.equal(claim, claimId);
      deleted = { ...deleted, status: ["deleted", "absent"].includes(outcome) ? "deleted" : outcome === "failed" ? "failed" : "unknown", claimId: null }; return { ...deleted }; },
  };
  const storage: PrivateObjectStorage = {
    download: async (object, maximum) => { calls.push("download"); assert.equal(object.objectPath, pending().objectPath);
      assert.equal(maximum, 10 * 1024 * 1024); return options.bytes === undefined ? new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) : options.bytes; },
    remove: async object => { calls.push("remove"); assert.equal(object.objectPath, pending().objectPath); return options.removeOutcome ?? "deleted"; },
  };
  return { workflow: createPrivateObjectWorkflow(ports, storage, options.inspect ?? (async () => metadata)),
    calls, failures, inspections, durable, state: () => intent, ports, storage };
}

test("upload receipt schema preserves the database-owned Storage object identity", () => {
  const receipt = uploadIntentSchema.parse({ ...pending(), storageObjectId: id });
  assert.equal(receipt.storageObjectId, id);
});

test("trusted photo workflow inspects first and commits binding/metadata/evidence only through finalization", async () => {
  const h = harness(); const result = await h.workflow.finalize(id);
  assert.equal(result.status, "confirmed");
  assert.deepEqual(h.calls, ["claim", "download", "finalize"]);
  assert.deepEqual(h.inspections, [metadata]);
  assert.deepEqual(h.durable, { metadata: 1, bindings: 1, activities: 1 });
  assert.equal((await h.workflow.finalize(id)).status, "confirmed");
  assert.equal(h.calls.filter(call => call === "download").length, 1);
});

test("actual early inspector rejects HEIC/HEIF/BMP bytes without any finalized metadata or activity", async () => {
  for (const bytes of [new Uint8Array(Buffer.from("BM synthetic BMP")),
    new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic")])),
    new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmif1")]))]) {
    const h = harness({ inspect: inspectPhotoImage, bytes });
    const result = await h.workflow.finalize(id);
    assert.equal(result.status, "cleanup_required");
    assert.deepEqual(h.failures, ["UNSUPPORTED_IMAGE_FORMAT"]);
    assert.equal(h.calls.includes("finalize"), false);
    assert.deepEqual(h.durable, { metadata: 0, bindings: 0, activities: 0 });
    assert.equal((await h.workflow.cleanup(id)).status, "cleaned");
    assert.equal(h.calls.filter(call => call === "remove").length, 1);
  }
});

test("trusted inspection rejection is preserved as safe cleanup guidance, never a success response", async () => {
  for (const code of ["INVALID_IMAGE_CONTENT", "IMAGE_RESOURCE_LIMIT", "IMAGE_TOO_LARGE"] as const) {
    const h = harness({ inspect: async () => { throw new PhotoContentError(code); } });
    const result = await h.workflow.finalize(id);
    assert.equal(result.status, "cleanup_required");
    if (result.status !== "cleanup_required") continue;
    assert.equal(result.code, code); assert.ok(result.message.length > 10);
    assert.equal(h.calls.includes("finalize"), false);
  }
});

test("database-confirmed missing object retains the reservation without contacting Storage", async () => {
  const h = harness({ objectPresent: false });
  const result = await h.workflow.finalize(id);
  assert.equal(result.status, "upload_required");
  assert.deepEqual(h.failures, ["OBJECT_MISSING"]);
  assert.equal(h.calls.includes("download"), false);
  assert.equal(h.state().objectPath, pending().objectPath);
  assert.equal(h.state().operationId, id);
  assert.deepEqual(h.durable, { metadata: 0, bindings: 0, activities: 0 });
});

test("inspection busy is retryable at the same intent and never causes cleanup or duplicate metadata", async () => {
  let inspections = 0;
  const h = harness({ inspect: async () => { if (++inspections === 1) throw new PhotoContentError("IMAGE_INSPECTION_BUSY"); return metadata; } });
  await assert.rejects(h.workflow.finalize(id), error => error instanceof PrivateObjectError && error.code === "IMAGE_INSPECTION_BUSY");
  assert.equal(h.state().status, "pending");
  assert.equal(h.calls.includes("remove"), false);
  assert.equal((await h.workflow.finalize(id)).status, "confirmed");
  assert.equal(h.durable.activities, 1);
});

test("another validation lease denies duplicate work before download or inspection", async () => {
  const h = harness({ busy: true });
  await assert.rejects(h.workflow.finalize(id), error => error instanceof PrivateObjectError && error.code === "VALIDATION_PENDING");
  assert.deepEqual(h.calls, ["claim"]);
});

test("digest or size mismatch fails before binding and requests cleanup of only the known object", async () => {
  for (const inspection of [{ ...metadata, sha256: "b".repeat(64) }, { ...metadata, sizeBytes: 5 }]) {
    const h = harness({ inspect: async () => inspection });
    const result = await h.workflow.finalize(id);
    assert.equal(result.status, "cleanup_required");
    assert.deepEqual(h.failures, ["OBJECT_CHANGED"]);
    assert.equal(h.calls.includes("finalize"), false);
  }
});

test("modelled DB rollback after binding cannot be reported as confirmed by the service", async () => {
  const h = harness({ finalizeFailure: "rollback" });
  await assert.rejects(h.workflow.finalize(id), error => error instanceof PrivateObjectError && error.code === "FINALIZATION_FAILED");
  assert.deepEqual(h.durable, { metadata: 0, bindings: 0, activities: 0 });
  assert.equal(h.state().status, "pending");
  assert.equal((await h.workflow.finalize(id)).status, "confirmed");
  assert.deepEqual(h.durable, { metadata: 1, bindings: 1, activities: 1 });
  // Real transaction atomicity belongs to the separate isolated SQL harness.
});

test("lost post-commit response discovers the durable receipt instead of demoting or duplicating it", async () => {
  const h = harness({ finalizeFailure: "lost_response" });
  assert.equal((await h.workflow.finalize(id)).status, "confirmed");
  assert.equal((await h.workflow.finalize(id)).status, "confirmed");
  assert.deepEqual(h.durable, { metadata: 1, bindings: 1, activities: 1 });
  assert.equal(h.calls.filter(call => call === "finalize").length, 1);
});

test("lost commit and fail-marker acknowledgements remain uncertain until same-intent replay", async () => {
  const h = harness({ finalizeFailure: "lost_response", failUnavailable: true });
  await assert.rejects(h.workflow.finalize(id), error => error instanceof PrivateObjectError && error.code === "FINALIZATION_FAILED");
  assert.equal((await h.workflow.finalize(id)).status, "confirmed");
  assert.equal(h.durable.activities, 1);
});

test("finalization returns terminal stale-parent cleanup without touching Storage", async () => {
  const h = harness({ initialStatus: "cleanup_required" });
  assert.equal((await h.workflow.finalize(id)).status, "cleanup_required");
  assert.deepEqual(h.calls, ["claim"]);
});

test("cancellation preserves completed races and cancelled uploads finish exact-object cleanup", async () => {
  const completed = harness(); await completed.workflow.finalize(id);
  assert.equal((await completed.workflow.cancel(id)).status, "finalized");
  assert.equal(completed.calls.includes("remove"), false);
  const pending = harness();
  assert.equal((await pending.workflow.cancel(id)).status, "cleaned");
  assert.deepEqual(pending.calls, ["cancel", "claimCleanup", "remove", "completeCleanup:deleted"]);
  assert.equal((await pending.workflow.cleanup(id)).status, "cleaned");
  assert.equal(pending.calls.filter(call => call === "remove").length, 1);
});

test("cleanup failure remains recoverable rather than deleting the durable reservation", async () => {
  for (const removeOutcome of ["unknown", "failed"] as const) {
    const h = harness({ removeOutcome });
    assert.equal((await h.workflow.cancel(id)).status, "cleanup_required");
    assert.equal(h.state().objectPath, pending().objectPath);
  }
});

test("deletion treats absence as completed but unknown/failure as pending durable recovery", async () => {
  for (const removeOutcome of ["deleted", "absent", "unknown", "failed"] as const) {
    const h = harness({ removeOutcome });
    const result = await h.workflow.delete(id);
    assert.equal(result.status, ["deleted", "absent"].includes(removeOutcome) ? "deleted" : removeOutcome);
    assert.equal(result.objectPath, pending().objectPath);
    if (result.status === "deleted") {
      assert.equal((await h.workflow.delete(id)).status, "deleted");
      assert.equal(h.calls.filter(call => call === "remove").length, 1);
    }
  }
});

const request = (body: unknown, contentType = "application/json") => new Request("https://portal.invalid/api/private-objects/intents", {
  method: "POST", headers: { "Content-Type": contentType }, body: JSON.stringify(body),
});
const photoRequest = { kind: "photo", workOrderId: "SYNTHETIC", operationId: id, batchId,
  expectedAssignmentVersion: 3, expectedWorkflowCycle: 2, file: pending().file };

test("private-object request boundary accepts typed reservation fields but rejects arbitrary paths and authority", async () => {
  assert.deepEqual(await parseObjectRequest(request(photoRequest), beginObjectRequestSchema), photoRequest);
  for (const patch of [{ objectPath: "another/company.jpg" }, { bucket: "profiles" }, { role: "manager" },
    { userId: id }, { expectedAssignmentVersion: "3" }, { expectedWorkflowCycle: -1 }, { operationId: "bad-id" },
    { file: { ...pending().file, sizeBytes: "4" } }, { file: { ...pending().file, sizeBytes: 16 * 1024 * 1024 } },
    { file: { ...pending().file, sha256: "not-a-digest" } }]) {
    await assert.rejects(parseObjectRequest(request({ ...photoRequest, ...patch }), beginObjectRequestSchema), error => error instanceof PrivateObjectError && error.code === "INVALID_REQUEST");
  }
});

test("finalization and deletion accept only server-resolved intent/metadata identities", async () => {
  assert.deepEqual(await parseObjectRequest(request({ intentId: id }), intentRequestSchema), { intentId: id });
  assert.deepEqual(await parseObjectRequest(request({ purpose: "photo", metadataId: bindingId, operationId: id }), deleteRequestSchema),
    { purpose: "photo", metadataId: bindingId, operationId: id });
  for (const extra of [{ objectPath: "wo/OTHER/file" }, { bucket: "photos" }, { claimId }, { bindingId }]) {
    await assert.rejects(parseObjectRequest(request({ intentId: id, ...extra }), intentRequestSchema));
    await assert.rejects(parseObjectRequest(request({ purpose: "photo", metadataId: bindingId, operationId: id, ...extra }), deleteRequestSchema));
  }
});

test("request JSON must be correctly typed, valid UTF-8 and bounded before parsing", async () => {
  for (const contentType of ["text/plain", "text/application/json", "application/not-json"]) {
    await assert.rejects(parseObjectRequest(request({ intentId: id }, contentType), intentRequestSchema));
  }
  for (const body of ["{broken", " ".repeat(16 * 1024 + 1), new Uint8Array([0xff, 0xfe])]) {
    const invalid = new Request("https://portal.invalid", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    await assert.rejects(parseObjectRequest(invalid, intentRequestSchema), error => error instanceof PrivateObjectError && error.httpStatus === 422);
  }
});

test("reservation receipts reject mismatched purpose/bucket/parent paths before use", () => {
  assert.equal(uploadIntentSchema.safeParse(pending()).success, true);
  for (const patch of [{ bucket: "invoice-pdfs" }, { objectPath: `wo/OTHER/${id}` }, { objectPath: "wo/%2e%2e/forged" },
    { purpose: "invoice_original" }, { workOrderId: "OTHER" }]) {
    assert.equal(uploadIntentSchema.safeParse({ ...pending(), ...patch }).success, false);
  }
});

test("unknown provider/native/SQL failures return a generic non-cached API envelope", async () => {
  const response = privateObjectFailure(new Error("Private SQL path /var/private key=secret"));
  assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.doesNotMatch(body, /SQL|\/var|key=|stack/);
  assert.match(body, /FILE_OPERATION_UNAVAILABLE/);
});

function actorHarness(options: { identityError?: boolean; active?: boolean; missing?: boolean; profileError?: boolean } = {}) {
  const filename = resolve("src/lib/server/privateObjectAuthorization.ts");
  const exports: Partial<typeof import("./server/privateObjectAuthorization")> = {};
  const calls: { name: string; value: unknown }[] = [];
  const actor = { auth: { getUser: async (token: string) => {
    calls.push({ name: "getUser", value: token });
    return { error: options.identityError ? new Error("Synthetic invalid token") : null,
      data: { user: options.identityError ? null : { id: bindingId } } };
  } } };
  const query = { select: (value: string) => { calls.push({ name: "select", value }); return query; },
    eq: (key: string, value: string) => { calls.push({ name: key, value }); return query; },
    maybeSingle: async () => ({ error: options.profileError ? new Error("Synthetic profile read outage") : null,
      data: options.missing ? null : { id: bindingId, active: options.active ?? true } }),
  };
  const service = { from: (table: string) => { calls.push({ name: "from", value: table }); return query; } };
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, Response, TextDecoder, AbortSignal,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-public-key" } },
    require: (name: string): unknown => {
      const configuration = configurationFixture(name); if (configuration) return configuration;
      if (name === "server-only") return {};
      if (name === "@supabase/supabase-js") return { createClient: (_url: string, _key: string, options: unknown) => {
        calls.push({ name: "actorOptions", value: options }); return actor;
      } };
      if (name === "../supabase/server") return { createServerClient: () => service };
      if (name === "./privateObjectStorage") return serverModule("privateObjectStorage");
      return name.startsWith(".") ? requireHere(resolve(filename, "..", name)) : requireHere(name);
    },
  }, { filename });
  assert.ok(exports.requirePrivateObjectActor);
  return { authorize: exports.requirePrivateObjectActor, calls, actor, service };
}

test("private-object auth rejects absent/malformed bearer tokens before creating any clients", async () => {
  for (const authorization of [null, "Basic synthetic", "Bearer two tokens"]) {
    const h = actorHarness();
    await assert.rejects(h.authorize(new Request("https://portal.invalid", { headers: authorization ? { authorization } : {} })),
      error => error instanceof PrivateObjectError && error.httpStatus === 401);
    assert.deepEqual(h.calls, []);
  }
});

test("private-object auth verifies the session with Auth and rechecks active profile in the database", async () => {
  for (const [options, status] of [[{ identityError: true }, 401], [{ active: false }, 403],
    [{ missing: true }, 403], [{ profileError: true }, 503]] as const) {
    const h = actorHarness(options);
    await assert.rejects(h.authorize(new Request("https://portal.invalid", { headers: { authorization: "Bearer synthetic-token" } })),
      error => error instanceof PrivateObjectError && error.httpStatus === status);
    assert.equal(h.calls.filter(call => call.name === "getUser").length, 1);
    if ("identityError" in options) assert.equal(h.calls.some(call => call.name === "from"), false);
  }
});

test("claimed JWT role/user does not replace the identity returned by Auth or the active profile lookup", async () => {
  const forgedClaims = `synthetic.${Buffer.from(JSON.stringify({ sub: id, role: "service_role", active: true })).toString("base64url")}.not-a-real-signature`;
  const h = actorHarness();
  const result = await h.authorize(new Request("https://portal.invalid", { headers: { authorization: `Bearer ${forgedClaims}` } }));
  assert.equal(result.actor, h.actor); assert.equal(result.service, h.service);
  assert.deepEqual(h.calls.find(call => call.name === "id"), { name: "id", value: bindingId });
  assert.equal(h.calls.find(call => call.name === "getUser")?.value, forgedClaims);
  assert.ok(JSON.stringify(h.calls.find(call => call.name === "actorOptions")?.value).includes(`Bearer ${forgedClaims}`));
  // Auth cryptographic JWT verification itself is mocked, never claimed as a
  // real gateway test. This executes the app's independent identity/profile boundary.
});
