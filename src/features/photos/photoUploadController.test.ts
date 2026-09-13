import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createBrowserPhotoStorageAdapter } from "./browserPhotoStorageAdapter";
import {
  createPhotoUploadController, PhotoUploadError,
  type PhotoUploadItem, type PhotoUploadPorts,
} from "./photoUploadController";
import { PHOTO_ACCEPTED_FORMAT_GUIDANCE, PHOTO_INPUT_ACCEPT } from "../../lib/photoContentPolicy";

const file = (name = "synthetic.jpg") => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], name, { type: "image/jpeg" });
function deferred() {
  let finish: () => void = () => undefined;
  const promise = new Promise<void>(resolvePromise => { finish = resolvePromise; });
  return { promise, finish };
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
  assert.ok(check(), "Synthetic operation did not reach the expected boundary");
}
function harness(overrides: Partial<PhotoUploadPorts<string>> = {}) {
  const calls: string[] = [];
  const snapshots: (readonly PhotoUploadItem[])[] = [];
  const objects = new Set<string>();
  let id = 0;
  const controller = createPhotoUploadController<string>({
    begin: async (_file, operationId, batchId) => {
      calls.push(`begin:${operationId}:${batchId}`);
      return { intent: operationId, status: "upload_required" };
    },
    upload: async intent => { calls.push(`upload:${intent}`); objects.add(intent); },
    finalize: async (intent, _signal, finalizing) => {
      calls.push(`finalize:${intent}`); finalizing();
      return objects.has(intent) ? { status: "confirmed", storagePath: `synthetic/${intent}` } : { status: "upload_required" };
    },
    cancel: async intent => { calls.push(`cancel:${intent}`); objects.delete(intent); },
    ...overrides,
  }, { createId: () => `id-${++id}`, onChange: items => snapshots.push(items) });
  return { controller, calls, snapshots, objects };
}

test("photo controller confirms all eight independently with at most two active files", async () => {
  const gates = Array.from({ length: 8 }, deferred);
  let active = 0, peak = 0, uploads = 0;
  const h = harness({ upload: async intent => {
    const gate = gates[uploads++]; active++; peak = Math.max(peak, active);
    await gate.promise; h.objects.add(intent); active--;
  } });
  const result = h.controller.start(gates.map((_, index) => file(`${index}.jpg`)));
  await until(() => uploads === 2);
  assert.equal(h.controller.snapshot().filter(item => item.status === "queued").length, 6);
  for (let index = 0; index < gates.length; index++) {
    gates[index].finish();
    if (index < 6) await until(() => uploads >= index + 3);
  }
  const items = await result;
  assert.equal(peak, 2);
  assert.equal(items.filter(item => item.status === "confirmed").length, 8);
  assert.equal(new Set(items.map(item => item.batchId)).size, 1);
  assert.equal(new Set(items.map(item => item.operationId)).size, 8);
  for (const status of ["queued", "authorizing", "uploading", "validating", "finalizing", "confirmed"]) {
    assert.ok(h.snapshots.some(items => items.some(item => item.status === status)), status);
  }
  assert.equal(h.controller.busy, false);
});

test("photo controller rejects zero/nine files without authorizing or silently dropping a file", async () => {
  const h = harness();
  await assert.rejects(h.controller.start([]), /between 1 and 8/);
  await assert.rejects(h.controller.start(Array.from({ length: 9 }, () => file())), /between 1 and 8/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.controller.snapshot(), []);
});

test("header screening isolates unsupported files and never trusts their MIME or extension", async () => {
  const h = harness();
  const result = await h.controller.start([
    new File(["BM synthetic not admitted"], "looks-valid.jpg", { type: "image/jpeg" }),
    file("really-jpeg.heic"), new File([], "empty.png", { type: "image/png" }),
  ]);
  assert.deepEqual(result.map(item => item.status), ["failed", "confirmed", "failed"]);
  assert.equal(result[0].retryable, false);
  assert.equal(result[0].message, PHOTO_ACCEPTED_FORMAT_GUIDANCE);
  const before = h.calls.length;
  await h.controller.retry();
  assert.equal(h.calls.length, before);
});

test("oversize file is rejected before header allocation or authorization", async () => {
  const h = harness();
  const oversized = file();
  Object.defineProperty(oversized, "size", { value: 10 * 1024 * 1024 + 1 });
  assert.equal((await h.controller.start([oversized]))[0].status, "failed");
  assert.deepEqual(h.calls, []);
});

test("lost upload acknowledgement retries the same identity and finalizes without another upload", async () => {
  const h = harness({ upload: async intent => {
    h.calls.push(`upload:${intent}`); h.objects.add(intent); throw new Error("Secret provider path /private/key");
  } });
  const [failed] = await h.controller.start([file()]);
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(failed.message ?? "", /Secret|private/);
  const [confirmed] = await h.controller.retry();
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.operationId, failed.operationId);
  assert.equal(confirmed.batchId, failed.batchId);
  assert.equal(h.calls.filter(call => call.startsWith("upload:")).length, 1);
  assert.equal(new Set(h.calls.filter(call => call.startsWith("begin:"))).size, 1);
});

test("explicit no-object reconciliation permits retrying bytes only at the original identity", async () => {
  let uploads = 0;
  const h = harness({ upload: async intent => {
    h.calls.push(`upload:${intent}`);
    if (++uploads === 1) throw new Error("Request never reached storage");
    h.objects.add(intent);
  } });
  const [failed] = await h.controller.start([file()]);
  assert.equal((await h.controller.retry())[0].status, "confirmed");
  assert.equal(uploads, 2);
  assert.deepEqual(h.calls.filter(call => call.startsWith("upload:")), [`upload:${failed.operationId}`, `upload:${failed.operationId}`]);
  assert.ok(h.calls.indexOf(`finalize:${failed.operationId}`) < h.calls.lastIndexOf(`upload:${failed.operationId}`));
});

test("retry skips confirmed files and does not silently replace an unfinished batch", async () => {
  let failedOnce = false;
  const h = harness({ upload: async intent => {
    h.calls.push(`upload:${intent}`);
    if (intent === "id-3" && !failedOnce) { failedOnce = true; throw new Error("Synthetic outage"); }
    h.objects.add(intent);
  } });
  const result = await h.controller.start([file("first.jpg"), file("second.jpg")]);
  assert.deepEqual(result.map(item => item.status), ["confirmed", "failed"]);
  await assert.rejects(h.controller.start([file("replacement.jpg")]), /unfinished photos/);
  await h.controller.retry();
  assert.equal(h.calls.filter(call => call === "upload:id-2").length, 1);
  assert.equal(h.controller.snapshot()[1].operationId, result[1].operationId);
});

test("lost finalize acknowledgement reconciles existing confirmation without copying bytes", async () => {
  let confirmations = 0;
  const h = harness({ finalize: async intent => {
    if (++confirmations === 1) throw new Error("Confirmation response lost after commit");
    return { status: "confirmed", storagePath: `synthetic/${intent}` };
  } });
  await h.controller.start([file()]);
  assert.equal((await h.controller.retry())[0].status, "confirmed");
  assert.equal(h.calls.filter(call => call.startsWith("upload:")).length, 1);
});

test("double click and retry during an active batch share the running operation", async () => {
  const gate = deferred();
  const h = harness({ upload: async intent => { await gate.promise; h.objects.add(intent); } });
  const first = h.controller.start([file()]);
  assert.equal(h.controller.start([file("second.jpg")]), first);
  assert.equal(h.controller.retry(), first);
  gate.finish(); await first;
  assert.equal(h.controller.snapshot().length, 1);
});

test("cancellation aborts in-flight uploads and never authorizes queued files", async () => {
  let uploading = 0;
  const h = harness({ upload: async (_intent, _file, signal) => {
    uploading++;
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
  } });
  const first = h.controller.start(Array.from({ length: 8 }, () => file()));
  await until(() => uploading === 2);
  const cancellation = h.controller.cancel();
  await first; const result = await cancellation;
  assert.ok(result.every(item => item.status === "cancelled"));
  assert.equal(h.calls.filter(call => call.startsWith("begin:")).length, 2);
  assert.equal(h.calls.filter(call => call.startsWith("cancel:")).length, 2);
});

test("cancel after an uncertain begin recovers that operation before requesting cleanup", async () => {
  let begins = 0;
  const h = harness({ begin: async (_file, operationId, batchId) => {
    h.calls.push(`begin:${operationId}:${batchId}`);
    if (++begins === 1) throw new Error("Intent response lost");
    return { intent: operationId, status: "upload_required" };
  } });
  await h.controller.start([file()]);
  const result = await h.controller.cancel();
  assert.equal(result[0].status, "cancelled");
  assert.equal(new Set(h.calls.filter(call => call.startsWith("begin:"))).size, 1);
  assert.equal(h.calls.filter(call => call.startsWith("cancel:")).length, 1);
});

test("failed cleanup remains visible and retry checks the same cancellation identity", async () => {
  let cancellations = 0;
  const h = harness({ upload: async () => { throw new Error("Synthetic unknown upload"); }, cancel: async intent => {
    h.calls.push(`cancel:${intent}`);
    if (++cancellations === 1) throw new Error("Cleanup outage");
  } });
  await h.controller.start([file()]);
  const [pending] = await h.controller.cancel();
  assert.equal(pending.status, "cleanup_required");
  assert.equal((await h.controller.retry())[0].status, "cancelled");
  assert.deepEqual(h.calls.filter(call => call.startsWith("cancel:")), [`cancel:${pending.operationId}`, `cancel:${pending.operationId}`]);
});

test("completion winning a cancellation race remains confirmed, never falsely cancelled", async () => {
  const gate = deferred(); let finalizing = false;
  const h = harness({ finalize: async intent => {
    finalizing = true; await gate.promise;
    return { status: "confirmed", storagePath: `synthetic/${intent}` };
  } });
  const start = h.controller.start([file()]);
  await until(() => finalizing);
  const cancel = h.controller.cancel(); gate.finish(); await start;
  assert.equal((await cancel)[0].status, "confirmed");
  assert.equal(h.calls.filter(call => call.startsWith("cancel:")).length, 0);
});

test("concurrent cancellation/retry clicks share one cleanup request", async () => {
  const gate = deferred(); let cancellations = 0;
  const h = harness({ upload: async () => { throw new Error("Synthetic failed transport"); }, cancel: async () => {
    cancellations++; await gate.promise;
  } });
  await h.controller.start([file()]);
  const first = h.controller.cancel();
  assert.equal(h.controller.cancel(), first);
  assert.equal(h.controller.retry(), first);
  assert.equal(h.controller.start([file("another.jpg")]), first);
  assert.equal(h.controller.busy, true);
  gate.finish(); await first;
  assert.equal(cancellations, 1);
  assert.equal(h.controller.busy, false);
});

test("a second per-file Cancel click joins pending cleanup instead of being dropped", async () => {
  const gate = deferred();
  const h = harness({ upload: async () => { throw new Error("Synthetic failed transport"); }, cancel: async intent => {
    h.calls.push(`cancel:${intent}`); await gate.promise;
  } });
  const items = await h.controller.start([file(), file()]);
  const first = h.controller.cancel([items[0].operationId]);
  assert.equal(h.controller.cancel([items[1].operationId]), first);
  gate.finish();
  assert.ok((await first).every(item => item.status === "cancelled"));
  assert.deepEqual(h.calls.filter(call => call.startsWith("cancel:")), items.map(item => `cancel:${item.operationId}`));
});

test("server-requested cleanup is retried as cleanup, not another upload", async () => {
  const h = harness({ finalize: async () => ({ status: "cleanup_required", message: "The image is truncated. Choose a complete copy after cleanup." }) });
  const [pending] = await h.controller.start([file()]);
  assert.equal(pending.status, "cleanup_required");
  assert.equal(pending.message, "The image is truncated. Choose a complete copy after cleanup.");
  assert.equal((await h.controller.retry())[0].status, "cancelled");
  assert.equal(h.calls.filter(call => call.startsWith("upload:")).length, 1);
  assert.equal(h.calls.filter(call => call.startsWith("cancel:")).length, 1);
});

test("typed safe rejection controls retry guidance without exposing internal errors", async () => {
  const h = harness({ begin: async () => { throw new PhotoUploadError("This assignment changed. Refresh the work order.", false); } });
  const [result] = await h.controller.start([file()]);
  assert.equal(result.retryable, false);
  assert.equal(result.message, "This assignment changed. Refresh the work order.");
});

test("definite duplicate or unsupported begin rejection cancels locally without another request", async () => {
  for (const message of ["This image is already included in this batch.", "This file is not supported."]) {
    let begins = 0;
    const h = harness({ begin: async () => { begins++; throw new PhotoUploadError(message, false); } });
    const [failed] = await h.controller.start([file()]);
    assert.equal(failed.status, "failed");
    assert.equal(failed.retryable, false);
    assert.equal((await h.controller.cancel())[0].status, "cancelled");
    assert.equal(begins, 1);
    assert.deepEqual(h.calls, []);
  }
});

test("a later definite rejection does not forget an earlier uncertain reservation", async () => {
  let begins = 0;
  const h = harness({ begin: async () => {
    if (++begins === 1) throw new Error("Reservation may have committed before the response was lost");
    throw new PhotoUploadError("This file is no longer permitted.", false);
  } });
  await h.controller.start([file()]);
  assert.equal((await h.controller.retry())[0].status, "failed");
  assert.equal((await h.controller.cancel())[0].status, "cleanup_required");
  assert.equal(begins, 3);
});

test("disposal during unknown-begin recovery aborts it and does not start cancellation under another session", async () => {
  let begins = 0;
  let recoverySignal: AbortSignal | undefined;
  const gate = deferred();
  const h = harness({ begin: async (_file, operationId, _batchId, signal) => {
    if (++begins === 1) throw new Error("Unknown reservation outcome");
    recoverySignal = signal;
    await gate.promise;
    return { intent: operationId, status: "upload_required" };
  } });
  await h.controller.start([file()]);
  const cancellation = h.controller.cancel();
  await until(() => recoverySignal !== undefined);
  h.controller.dispose();
  assert.equal(recoverySignal?.aborted, true);
  const count = h.snapshots.length;
  gate.finish(); await cancellation;
  assert.equal(h.snapshots.length, count);
  assert.equal(h.calls.filter(call => call.startsWith("cancel:")).length, 0);
});

test("disposal aborts local uploads without deleting durable intents or applying late callbacks", async () => {
  const gate = deferred(); let signal: AbortSignal | undefined;
  const h = harness({ upload: async (intent, _file, uploadSignal) => {
    signal = uploadSignal; await gate.promise; h.objects.add(intent);
  } });
  const running = h.controller.start([file(), file(), file()]);
  await until(() => !!signal);
  const callbacks = h.snapshots.length;
  h.controller.dispose();
  assert.equal(signal?.aborted, true);
  gate.finish(); await running;
  assert.equal(h.snapshots.length, callbacks);
  assert.equal(h.calls.filter(call => call.startsWith("cancel:") || call.startsWith("finalize:")).length, 0);
  assert.equal(h.controller.snapshot().filter(item => item.status === "cancelled").length, 1);
  await h.controller.cancel(); await h.controller.retry();
  await assert.rejects(h.controller.start([file()]), /session has ended/);
  assert.equal(h.calls.filter(call => call.startsWith("cancel:")).length, 0);
});

test("disposing a completed controller preserves confirmed photos without a cleanup request", async () => {
  const h = harness(); await h.controller.start([file()]);
  const before = h.calls.length;
  h.controller.dispose(); await h.controller.cancel();
  assert.equal(h.controller.snapshot()[0].status, "confirmed");
  assert.equal(h.calls.length, before);
});

type Element = { type: unknown; props: Record<string, unknown> };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (typeof value !== "object" || value === null || !("type" in value) || !("props" in value)) return [];
  const element = value as Element; // This test's JSX runtime owns the exact element shape.
  return [element, ...elements(element.props.children)];
}
function gallery(props: Record<string, unknown>, mime = "image/png") {
  const filename = resolve("src/features/photos/PhotoGallery.tsx");
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const requireHere = createRequire(import.meta.url);
  const exports: { default?: (props: Record<string, unknown>) => unknown } = {};
  const downloads: string[] = [], messages: string[] = [];
  let state = 0;
  runInNewContext(compiled, { exports, console, File, Blob, Set, Promise,
    fetch: async () => new Response(new Blob(["synthetic"], { type: mime })),
    URL: { createObjectURL: () => "blob:synthetic", revokeObjectURL: () => undefined },
    document: { body: { appendChild: () => undefined }, createElement: () => {
      const anchor = { href: "", download: "", target: "", rel: "", remove: () => undefined,
        click: () => downloads.push(anchor.download) };
      return anchor;
    } },
    require: (name: string): unknown => {
      if (name === "react/jsx-runtime") return { jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
        jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }) };
      if (name === "react") return { useEffect: () => undefined, useRef: (current: unknown) => ({ current }),
        useState: (initial: unknown) => { const index = state++; return [index === 0 ? { "opaque-storage-key": "blob:photo" }
          : index === 1 ? true : initial, () => undefined]; } };
      if (name.endsWith("/db")) return {};
      if (name === "./browserPhotoStorageAdapter") return createBrowserPhotoStorageAdapter({
        session: async () => { throw new Error("Unexpected preview authentication"); },
        configuration: () => { throw new Error("Unexpected preview upload"); },
        download: async () => { throw new Error("Unexpected preview Storage query"); },
        fetch: async () => new Response(new Blob(["synthetic"], { type: mime })),
      });
      if (name.includes("/components/")) return new Proxy({}, { get: (_target, key) => key });
      if (name === "./PhotoUploadProgress") return { PhotoUploadProgress: "UploadProgress" };
      return requireHere(resolve(filename, "..", name));
    },
  }, { filename });
  assert.ok(exports.default);
  const nodes = elements(exports.default({ woId: "SYNTHETIC", photos: ["opaque-storage-key"], setImageErrors: () => undefined,
    setLightbox: () => undefined, fire: (message: string) => messages.push(message), ...props }));
  return { nodes, downloads, messages };
}

test("gallery preserves camera capture, supported-format guidance and exact FileList callback", async () => {
  const calls: unknown[][] = [], gate = deferred();
  const h = gallery({ doAddPhotos: async (...args: unknown[]) => { calls.push(args); await gate.promise; } });
  const inputs = h.nodes.filter(node => node.type === "input" && node.props.type === "file");
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].props.capture, "environment");
  assert.ok(inputs.every(input => input.props.accept === PHOTO_INPUT_ACCEPT));
  const change = inputs[0].props.onChange;
  assert.equal(typeof change, "function");
  const files = { 0: file(), length: 1 }, target = { files, value: "selected" };
  if (typeof change !== "function") return;
  change({ target }); change({ target });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "SYNTHETIC"); assert.equal(calls[0][1], files);
  gate.finish(); await until(() => target.value === "");
});

test("gallery rejects oversized batches visibly and forwards typed per-file recovery props", () => {
  let calls = 0;
  const uploadItems = [{ operationId: "synthetic", status: "failed" }];
  const retryUploads = () => undefined, cancelUploads = () => undefined;
  const h = gallery({ doAddPhotos: () => calls++, uploadItems, retryUploads, cancelUploads });
  const input = h.nodes.find(node => node.type === "input" && node.props.type === "file");
  assert.ok(input && typeof input.props.onChange === "function");
  input.props.onChange({ target: { files: { length: 9 }, value: "selected" } });
  assert.equal(calls, 0); assert.match(h.messages[0], /up to 8/);
  const progress = h.nodes.find(node => node.type === "UploadProgress");
  assert.equal(progress?.props.items, uploadItems);
  assert.equal(progress?.props.retryUploads, retryUploads);
  assert.equal(progress?.props.cancelUploads, cancelUploads);
});

test("gallery extensionless PNG download uses downloaded MIME instead of a guessed JPEG extension", async () => {
  const h = gallery({});
  const download = h.nodes.find(node => node.props["aria-label"] === "Download photo 1");
  assert.ok(download && typeof download.props.onClick === "function");
  download.props.onClick({ stopPropagation: () => undefined });
  await until(() => h.downloads.length === 1);
  assert.equal(h.downloads[0], "SYNTHETIC-photo-1.png");
});

test("read-only gallery does not expose upload, deletion or retry/cancel actions", () => {
  const h = gallery({ readOnly: true, doAddPhotos: () => undefined, doRemovePhoto: () => undefined,
    uploadItems: [], retryUploads: () => undefined, cancelUploads: () => undefined });
  assert.equal(h.nodes.filter(node => node.type === "input" && node.props.type === "file").length, 0);
  const progress = h.nodes.find(node => node.type === "UploadProgress");
  assert.equal(progress?.props.retryUploads, undefined);
  assert.equal(progress?.props.cancelUploads, undefined);
});
