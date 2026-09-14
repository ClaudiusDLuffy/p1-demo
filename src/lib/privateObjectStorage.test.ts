import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PrivateObjectError } from "./privateObjectContracts";

const filename = resolve("src/lib/server/privateObjectStorage.ts");
const requireHere = createRequire(import.meta.url);
const ts = requireHere("typescript") as typeof import("typescript"); // Installed compiler is the existing test harness dependency.
const exports: Partial<typeof import("./server/privateObjectStorage")> = {};
runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText, { exports, AbortSignal, Uint8Array, Response, fetch,
  require: (name: string): unknown => name === "server-only" ? {} : requireHere(resolve(filename, "..", name)),
}, { filename });
assert.ok(exports.createPrivateObjectStorage && exports.readBoundedBytes);
const { createPrivateObjectStorage, readBoundedBytes } = exports;
const object = { bucket: "photos", objectPath: "wo/SYNTHETIC/00000000-0000-4000-8000-000000000001" };
const safeFailure = (error: unknown, code: string) => error instanceof PrivateObjectError && error.code === code;
function storage(responder: (url: string, init: RequestInit) => Promise<Response>, timeoutMs = 10) {
  return createPrivateObjectStorage({ url: "https://storage.invalid", secret: "synthetic-service-secret", timeoutMs,
    fetch: async (input, init = {}) => responder(String(input), init) });
}

test("bounded Storage stream enforces actual bytes even with misleading Content-Length", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3])); controller.enqueue(new Uint8Array([4, 5, 6]));
  }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedBytes(new Response(stream, { headers: { "Content-Length": "1" } }), 5), error => safeFailure(error, "FILE_TOO_LARGE"));
  assert.equal(cancelled, true); assert.equal(stream.locked, false);
});

test("oversized advertised Storage body is cancelled before reading", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(readBoundedBytes(new Response(stream, { headers: { "Content-Length": "11" } }), 10), error => safeFailure(error, "FILE_TOO_LARGE"));
  assert.equal(cancelled, true);
});

test("bounded stream preserves the exact bytes at its ceiling and releases the reader", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); controller.close();
  } });
  assert.deepEqual(await readBoundedBytes(new Response(stream), 4), new Uint8Array([1, 2, 3, 4]));
  assert.equal(stream.locked, false);
});

test("Storage 404 means absent while 403/5xx remain errors, never false absence", async () => {
  assert.equal(await storage(async () => new Response(null, { status: 404 })).download(object, 10), null);
  for (const status of [403, 500, 503]) {
    await assert.rejects(storage(async () => new Response("provider details", { status })).download(object, 10), error => safeFailure(error, "OBJECT_DOWNLOAD_FAILED"));
  }
});

test("Storage fetch timeout and caller abort fail safely without exposing provider details", async () => {
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    const adapter = storage(async (_url, { signal }) => new Promise<Response>((_resolve, reject) => {
      assert.ok(signal);
      if (signal.aborted) reject(new Error("private provider path"));
      else signal.addEventListener("abort", () => reject(new Error("private provider path")), { once: true });
    }));
    await assert.rejects(adapter.download(object, 10), error => safeFailure(error, "OBJECT_DOWNLOAD_FAILED"));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(adapter.download(object, 10, controller.signal), error => safeFailure(error, "OBJECT_DOWNLOAD_FAILED"));
  } finally { clearTimeout(keepAlive); }
});

test("Storage streaming failure cancels the reader and returns a safe transport error", async () => {
  const adapter = storage(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("private SQL/provider path")); } })));
  await assert.rejects(adapter.download(object, 10), error => safeFailure(error, "OBJECT_DOWNLOAD_FAILED")
    && error instanceof Error && !error.message.includes("private"));
});

test("unknown HEAD outcome never sends DELETE, and exact missing object needs no DELETE", async () => {
  for (const [status, expected] of [[403, "unknown"], [503, "unknown"], [404, "absent"]] as const) {
    const methods: string[] = [];
    const result = await storage(async (_url, init) => { methods.push(init.method ?? "GET"); return new Response(null, { status }); }).remove(object);
    assert.equal(result, expected); assert.deepEqual(methods, ["HEAD"]);
  }
});

test("lost DELETE acknowledgement reconciles exact absence and reports deletion", async () => {
  const requests: { url: string; method: string; body?: BodyInit | null }[] = [];
  let removed = false;
  const adapter = storage(async (url, init) => {
    requests.push({ url, method: init.method ?? "GET", body: init.body });
    if (init.method === "DELETE") { removed = true; throw new Error("Connection lost after accepted removal"); }
    return new Response(null, { status: removed ? 404 : 200 });
  });
  assert.equal(await adapter.remove(object), "deleted");
  assert.deepEqual(requests.map(request => request.method), ["HEAD", "DELETE", "HEAD"]);
  const request = requests[1]; assert.equal(request.url, "https://storage.invalid/storage/v1/object/photos");
  assert.equal(typeof request.body, "string");
  assert.deepEqual(JSON.parse(String(request.body)), { prefixes: [object.objectPath] });
  assert.equal(requests[0].url, requests[2].url);
});

test("DELETE acceptance alone is not proof of removal; ambiguous HEAD stays pending", async () => {
  for (const [deleteStatus, afterStatus, expected] of [[200, 200, "unknown"], [200, 503, "unknown"], [403, 200, "failed"], [403, 503, "unknown"]] as const) {
    let heads = 0;
    const adapter = storage(async (_url, init) => new Response(null, {
      status: init.method === "DELETE" ? deleteStatus : ++heads === 1 ? 200 : afterStatus,
    }));
    assert.equal(await adapter.remove(object), expected);
  }
});

test("Storage adapter rejects traversal, encoded paths and arbitrary buckets before network access", async () => {
  let calls = 0;
  const adapter = storage(async () => { calls++; return new Response(null); });
  for (const target of [
    { ...object, bucket: "profiles" }, { ...object, objectPath: "" },
    ...["../another", "/absolute", "wo//file", "wo/./file", "wo/%2e%2e/file", "wo/file?token=forged", "wo/file#fragment", "wo\\file", "wo/\u0000file"]
      .map(objectPath => ({ ...object, objectPath })),
  ]) {
    await assert.rejects(adapter.download(target, 10), error => safeFailure(error, "INVALID_OBJECT_BINDING"));
    await assert.rejects(adapter.remove(target), error => safeFailure(error, "INVALID_OBJECT_BINDING"));
  }
  assert.equal(calls, 0);
});

test("Storage requests use server credentials and no-store only within the supplied bound object", async () => {
  const adapter = storage(async (url, init) => {
    assert.equal(url, `https://storage.invalid/storage/v1/object/photos/${object.objectPath}`);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer synthetic-service-secret");
    assert.equal(headers.get("apikey"), "synthetic-service-secret");
    assert.equal(init.cache, "no-store"); assert.ok(init.signal);
    return new Response(new Uint8Array([1]));
  });
  assert.deepEqual(await adapter.download(object, 10), new Uint8Array([1]));
});

test("stalled bounded reader is cancelled by its deadline rather than waiting for another chunk", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const controller = new AbortController();
  const reading = readBoundedBytes(new Response(stream), 10, controller.signal);
  controller.abort();
  await assert.rejects(reading, error => safeFailure(error, "OBJECT_DOWNLOAD_FAILED"));
  assert.equal(cancelled, true); assert.equal(stream.locked, false);
});

test("Storage download deadline also cancels a body that stalls after successful response headers", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const adapter = storage(async () => new Response(stream));
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    await assert.rejects(adapter.download(object, 10), error => safeFailure(error, "OBJECT_DOWNLOAD_FAILED"));
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  } finally { clearTimeout(keepAlive); }
});

test("missing/error download responses discard their bodies before returning safe outcomes", async () => {
  for (const status of [404, 403, 503]) {
    let cancelled = false;
    const adapter = storage(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status }));
    if (status === 404) assert.equal(await adapter.download(object, 10), null);
    else await assert.rejects(adapter.download(object, 10), error => safeFailure(error, "OBJECT_DOWNLOAD_FAILED"));
    assert.equal(cancelled, true);
  }
});
