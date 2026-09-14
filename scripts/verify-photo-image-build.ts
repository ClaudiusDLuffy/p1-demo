import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { syntheticBmp } from "../src/lib/photo-test-support/syntheticFormats";
import { syntheticHeic } from "../src/lib/photo-test-support/syntheticHeic";

// Run in a fresh process after a production webpack build. No environment file
// is read; every Auth, profile, RPC and Storage request is replaced locally.
// This exercises packaged runtime assets, not real JWT/RLS/Storage gateways.
const root = fileURLToPath(new URL("../", import.meta.url));
const routeFile = ".next/server/app/api/private-objects/finalize/route.js";
const workerFile = "src/lib/server/photoImageInspectionWorker.mjs";
const ids = {
  actor: "11111111-1111-4111-8111-111111111111",
  intent: "22222222-2222-4222-8222-222222222222",
  operation: "33333333-3333-4333-8333-333333333333",
  batch: "44444444-4444-4444-8444-444444444444",
  claim: "55555555-5555-4555-8555-555555555555",
  binding: "66666666-6666-4666-8666-666666666666",
  photo: "77777777-7777-4777-8777-777777777777",
};
const token = ["e30", Buffer.from(JSON.stringify({ sub: ids.actor })).toString("base64url"), "synthetic"].join(".");
const secret = "synthetic-service-key";
const objectPath = `wo/WOT-SYNTHETIC/${ids.intent}`;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function tracedFiles(): Promise<string[]> {
  const trace: unknown = JSON.parse(await readFile(path.join(root, `${routeFile}.nft.json`), "utf8"));
  assert.ok(record(trace) && Array.isArray(trace.files), "Build route trace is missing or invalid");
  const paths: unknown[] = trace.files;
  assert.ok(paths.every((entry): entry is string => typeof entry === "string"), "Invalid trace path");
  const files = [...new Set([routeFile, ...paths.map(file => {
    const relative = path.relative(root, path.resolve(root, path.dirname(routeFile), file));
    assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative), "Trace escapes repository");
    assert.ok(relative.startsWith(".next/") || relative.startsWith("node_modules/")
      || relative === "package.json" || relative === workerFile, "Trace contains a non-runtime file");
    assert.ok(!path.basename(relative).startsWith(".env"), "Trace contains environment configuration");
    return relative;
  })])];
  assert.ok(files.includes(workerFile), "Image inspection worker is not traced");
  assert.ok(files.includes("node_modules/sharp/package.json"), "Sharp package is not traced");
  for (const dependency of ["detect-libc", "semver", "@img/colour"]) {
    assert.ok(files.some(file => file.endsWith(`node_modules/${dependency}/package.json`)), `Sharp runtime dependency ${dependency} is not traced`);
  }
  assert.ok(files.some(file => /node_modules\/@img\/sharp-[^/]+\/.*\.node$/.test(file)), "Sharp native runtime is not traced");
  assert.ok(files.some(file => /node_modules\/@img\/sharp-libvips-[^/]+\/lib\//.test(file)), "libvips runtime is not traced");
  return files;
}

function request(authenticated = true): Request {
  return new Request("https://synthetic.invalid/api/private-objects/finalize", {
    method: "POST", headers: {
      "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    }, body: JSON.stringify({ intentId: ids.intent }),
  });
}

async function verify(): Promise<void> {
  const files = await tracedFiles();
  const packageRoot = await mkdtemp(path.join(tmpdir(), "p1-photo-image-build-"));
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const environment = {
    NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable-key",
    SUPABASE_SECRET_KEY: secret,
  };
  const originalEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  let bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#0044cc" } }).jpeg().toBuffer();
  let finalizations = 0;
  let authentications = 0;
  let downloads = 0;
  let failures: string[] = [];
  const intent = (status: string) => ({
    intentId: ids.intent, operationId: ids.operation, batchId: ids.batch, purpose: "photo",
    workOrderId: "WOT-SYNTHETIC", parentId: null, bucket: "photos", objectPath, status,
    expiresAt: "2099-09-09T00:00:00Z", claimId: status === "validating" ? ids.claim : null,
    bindingId: status === "finalized" ? ids.binding : null, photoId: status === "finalized" ? ids.photo : null,
    attachmentId: null,
    file: { name: "disguised.jpg", mimeType: "image/jpeg", sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") },
  });
  const json = (value: unknown) => Response.json(value);
  try {
    for (const file of files) {
      const destination = path.join(packageRoot, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(root, file), destination);
    }
    assert.deepEqual(await readFile(path.join(packageRoot, workerFile)), await readFile(path.join(root, workerFile)));
    Object.assign(process.env, environment);
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const actorAuthorization = `Bearer ${token}`;
      if (url.pathname === "/auth/v1/user") {
        assert.equal(method, "GET");
        assert.equal(headers.get("authorization"), actorAuthorization);
        authentications += 1;
        return json({ id: ids.actor, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} });
      }
      if (url.pathname === "/rest/v1/profiles") {
        assert.equal(method, "GET");
        assert.equal(url.searchParams.get("id"), `eq.${ids.actor}`);
        assert.equal(headers.get("authorization"), `Bearer ${secret}`);
        return json({ id: ids.actor, active: true });
      }
      if (url.pathname === `/storage/v1/object/photos/${objectPath}`) {
        assert.equal(method, "GET");
        assert.equal(headers.get("authorization"), `Bearer ${secret}`);
        downloads += 1;
        return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/jpeg" } });
      }
      assert.ok(url.pathname.startsWith("/rest/v1/rpc/"), "Unexpected request blocked");
      assert.equal(method, "POST");
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body)
        : input instanceof Request ? await input.clone().json() : null;
      assert.ok(record(body) && body.p_intent_id === ids.intent, "Unexpected RPC target");
      const routine = url.pathname.slice("/rest/v1/rpc/".length);
      if (["get_private_object_upload_v1", "claim_private_object_upload_v1"].includes(routine)) {
        assert.equal(headers.get("authorization"), actorAuthorization);
        assert.deepEqual(body, { p_intent_id: ids.intent });
        return json(intent(routine.startsWith("claim_") ? "validating" : "pending"));
      }
      assert.equal(headers.get("authorization"), `Bearer ${secret}`);
      assert.equal(body.p_claim_id, ids.claim);
      if (routine === "finalize_private_object_upload_v1") {
        assert.deepEqual(body.p_inspection, {
          format: "jpeg", mimeType: "image/jpeg", extension: "jpg", sizeBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"), width: 64, height: 48, frames: 1,
        });
        finalizations += 1;
        return json(intent("finalized"));
      }
      assert.equal(routine, "fail_private_object_upload_v1", "Unexpected RPC blocked");
      assert.equal(typeof body.p_code, "string");
      if (typeof body.p_code !== "string") throw new Error("Invalid failure receipt");
      failures.push(body.p_code);
      return json(intent(body.p_code === "UNSUPPORTED_IMAGE_FORMAT" ? "cleanup_required" : "pending"));
    };
    process.chdir(packageRoot);
    const requireBuilt = createRequire(path.join(packageRoot, routeFile));
    const built: unknown = requireBuilt(path.join(packageRoot, routeFile));
    assert.ok(record(built) && record(built.routeModule) && record(built.routeModule.userland));
    const post = built.routeModule.userland.POST;
    assert.equal(typeof post, "function", "Built route has no POST handler");
    if (typeof post !== "function") throw new Error("Built route has no POST handler");
    const call = async (input: Request): Promise<Response> => {
      const result: unknown = await post(input);
      assert.ok(result instanceof Response, "Built route returned an invalid response");
      return result;
    };
    const valid = await call(request());
    const validBody: unknown = await valid.json();
    const code = record(validBody) && typeof validBody.code === "string" ? validBody.code : "no error code";
    assert.equal(valid.status, 200, `Packaged route did not finalize a validated JPEG (${code}; ${failures.join(",")})`);
    assert.deepEqual(validBody, { status: "confirmed", intent: intent("finalized") });
    assert.equal(finalizations, 1);
    assert.equal(downloads, 1);
    assert.deepEqual(failures, []);

    for (const unsupported of [syntheticHeic(), syntheticBmp()]) {
      bytes = unsupported;
      const response = await call(request());
      assert.equal(response.status, 200, "Unsupported upload should return its cleanup receipt");
      const result: unknown = await response.json();
      assert.ok(record(result) && result.status === "cleanup_required");
      assert.equal(result.code, "UNSUPPORTED_IMAGE_FORMAT");
      assert.equal(result.intentId, ids.intent);
      assert.equal(finalizations, 1, "Unsupported bytes reached financial/photo finalization");
    }
    assert.deepEqual(failures, ["UNSUPPORTED_IMAGE_FORMAT", "UNSUPPORTED_IMAGE_FORMAT"]);
    const beforeAuth = authentications;
    const beforeDownloads = downloads;
    const unauthorized = await call(request(false));
    assert.equal(unauthorized.status, 401);
    const unauthorizedBody: unknown = await unauthorized.json();
    assert.ok(record(unauthorizedBody));
    assert.equal(unauthorizedBody.correlationId, unauthorized.headers.get("X-Request-ID"));
    assert.match(String(unauthorizedBody.correlationId), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.deepEqual(unauthorizedBody, { code: "UNAUTHORIZED", message: "Please sign in again.",
      error: "Please sign in again.", correlationId: unauthorizedBody.correlationId });
    assert.equal(authentications, beforeAuth, "Unauthenticated input must not request identity data");
    assert.equal(downloads, beforeDownloads);

    // Removing only the synthetic copied worker proves success used this
    // package's checked worker, not a repository/global-module fallback.
    bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#0044cc" } }).jpeg().toBuffer();
    await rename(path.join(packageRoot, workerFile), path.join(packageRoot, `${workerFile}.withheld`));
    failures = [];
    const missingWorker = await call(request());
    assert.equal(missingWorker.status, 409);
    const missingWorkerBody: unknown = await missingWorker.json();
    assert.ok(record(missingWorkerBody));
    assert.equal(missingWorkerBody.correlationId, missingWorker.headers.get("X-Request-ID"));
    assert.match(String(missingWorkerBody.correlationId), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.deepEqual(missingWorkerBody, {
      code: "IMAGE_INSPECTION_FAILED", message: "This file could not be accepted. Check its format and size.",
      error: "This file could not be accepted. Check its format and size.", correlationId: missingWorkerBody.correlationId,
    });
    assert.deepEqual(failures, ["IMAGE_INSPECTION_FAILED"]);
    assert.equal(finalizations, 1, "Missing packaged worker must never finalize metadata");
    console.log(`Photo image build verification passed: ${files.length} traced files; JPEG confirmed, HEIC/BMP cleanup-only, unauthenticated 401, missing worker safely rejected; every external request stubbed.`);
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    for (const key of Object.keys(environment)) {
      if (originalEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnvironment[key];
    }
    // Only this invocation's newly created synthetic runtime copy is removed.
    await rm(packageRoot, { recursive: true, force: true });
  }
}

void verify().catch(error => {
  const message = error instanceof assert.AssertionError ? error.message : "Photo build verification failed; check the compiled route and trace.";
  console.error(message);
  process.exitCode = 1;
});
