import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import type { PhotoUploadItem, PhotoUploadPorts } from "./photoUploadController";
import { directoryActorScope, workOrderDetailsKey, workOrderByIdKey, workOrderChildCountKey } from "../../lib/counts/queryKeys";

type Hook = {
  doAddPhotos: (workOrderId: string, files: FileList | null) => Promise<unknown>;
  retryPhotoUploads: (workOrderId: string, operationIds?: readonly string[]) => Promise<unknown>;
  cancelPhotoUploads: (workOrderId: string, operationIds?: readonly string[]) => Promise<unknown>;
  doRemovePhoto: (workOrderId: string, path: string) => Promise<unknown>;
  retryPhotoDeletion: (workOrderId: string) => Promise<unknown>;
};
const filename = resolve("src/features/work-orders/useWorkOrders.ts");
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const requireHere = createRequire(import.meta.url);
const woId = "WOT-SYNTHETIC-PHOTOS";
const currentUser = { id: "synthetic-contractor", role: "contractor", name: "Synthetic" };
const detailCacheKey = workOrderDetailsKey(woId, directoryActorScope(currentUser)).join(":");
const files = (count = 1): FileList => {
  const values = Array.from({ length: count }, (_, index) => new File([new Uint8Array([0xff, 0xd8, 0xff])], `${index}.jpg`, { type: "image/jpeg" }));
  return Object.assign(values, { item: (index: number) => values[index] ?? null });
};
function harness(options: { failUploadOnce?: boolean; pendingDeleteOnce?: boolean; versionsMissing?: boolean; uploadGate?: Promise<void> } = {}) {
  const workOrder = { id: woId, contractorAssignmentVersion: options.versionsMissing ? null : 3,
    workflowCycle: 2, photos: ["legacy/photo.png"], activities: [{ id: "legacy-note", text: "Original note" }] };
  const cache = new Map<string, unknown>([["work-orders", [workOrder]], [detailCacheKey, { ...workOrder }]]);
  const mutations: string[] = [], messages: string[] = [], invalidations: string[][] = [];
  const begins: { operationId: string; batchId: string; name: string }[] = [];
  const factoryCalls: unknown[][] = [], deletedPaths: string[] = [];
  const stateChanges: unknown[] = [];
  const effects: (() => void | (() => void))[] = [];
  const objects = new Set<string>();
  let uploaded = 0, deletes = 0;
  const ports: PhotoUploadPorts<string> = {
    begin: async (file, operationId, batchId) => { begins.push({ operationId, batchId, name: file.name }); return { intent: operationId, status: "upload_required" }; },
    upload: async intent => {
      mutations.push(`upload:${intent}`);
      await options.uploadGate;
      if (++uploaded === 2 && options.failUploadOnce) throw new Error("Synthetic lost response");
      objects.add(intent);
    },
    finalize: async (intent, _signal, finalizing) => { finalizing(); return objects.has(intent)
      ? { status: "confirmed", storagePath: `confirmed/${intent}` } : { status: "upload_required" }; },
    cancel: async intent => { mutations.push(`cancel:${intent}`); objects.delete(intent); },
  };
  const queryClient = {
    getQueryData: (key: readonly string[]) => cache.get(key.join(":")),
    setQueryData: (key: readonly string[], value: unknown) => {
      const next = typeof value === "function" ? value(cache.get(key.join(":"))) : value;
      cache.set(key.join(":"), next);
    },
    invalidateQueries: ({ queryKey }: { queryKey: string[] }) => { invalidations.push(queryKey); return Promise.resolve(); },
  };
  const exports: { default?: (props: Record<string, unknown>) => Hook } = {};
  runInNewContext(compiled, { exports, Date, Promise, Map, Set, crypto: globalThis.crypto,
    require: (name: string): unknown => {
      if (name === "react") return { useEffect: (effect: () => void | (() => void)) => { effects.push(effect); }, useRef: (current: unknown) => ({ current }),
        useState: (initial: unknown) => { let value = initial; return [value, (next: unknown) => {
          value = typeof next === "function" ? next(value) : next; stateChanges.push(value);
        }]; } };
      if (name === "@tanstack/react-query") return { useQueryClient: () => queryClient };
      if (name === "../../lib/privateObjectClient") return { createWorkOrderPhotoPorts: (...args: unknown[]) => { factoryCalls.push(args); return ports; } };
      if (name.endsWith("/queries")) return {
        WORK_ORDERS_KEY: ["work-orders"], WORK_ORDER_DETAILS_KEY: ["work-order-details"], WORK_ORDER_BY_ID_KEY: ["work-order-by-id"],
        workOrderDetailsKey, workOrderByIdKey,
      };
      if (name.endsWith("/db")) return new Proxy({ removePhoto: async (_id: string, path: string) => {
        deletedPaths.push(path); return { success: !(options.pendingDeleteOnce && ++deletes === 1) };
      } }, { get: (target, key) => key === "removePhoto" ? target.removePhoto : () => { throw new Error(`Unexpected raw persistence: ${String(key)}`); } });
      return requireHere(resolve(filename, "..", name));
    },
  }, { filename });
  assert.ok(exports.default);
  const hook = exports.default({ currentUser,
    workOrdersData: [workOrder], invoices: [], fire: (message: string) => messages.push(message) });
  const items = (): readonly PhotoUploadItem[] => {
    for (const value of [...stateChanges].reverse()) {
      if (typeof value === "object" && value !== null && woId in value && Array.isArray(value[woId])) return value[woId];
    }
    return [];
  };
  return { hook, workOrder, cache, messages, invalidations, factoryCalls, deletedPaths, begins, mutations, stateChanges, items, effects };
}

test("photo hook captures assignment/cycle, patches confirmed paths only and refreshes the scoped detail", async () => {
  const h = harness();
  await h.hook.doAddPhotos(woId, files(2));
  assert.deepEqual(h.factoryCalls, [[woId, 3, 2]]);
  const saved = h.cache.get(detailCacheKey);
  assert.ok(typeof saved === "object" && saved !== null && "photos" in saved && Array.isArray(saved.photos));
  assert.equal(saved.photos.length, 3);
  assert.equal(saved.photos[0], "legacy/photo.png");
  assert.deepEqual(JSON.parse(JSON.stringify("activities" in saved ? saved.activities : null)), h.workOrder.activities);
  assert.ok(h.items().every(item => item.status === "confirmed"));
  assert.ok(h.messages.includes("2 photos uploaded"));
  assert.deepEqual(JSON.parse(JSON.stringify(h.invalidations)), [workOrderDetailsKey(woId), workOrderByIdKey(woId),
    workOrderChildCountKey(directoryActorScope(currentUser), woId, "photos")]);
});

test("photo hook preserves partial success and retries only the same failed file identity", async () => {
  const h = harness({ failUploadOnce: true });
  await h.hook.doAddPhotos(woId, files(2));
  assert.deepEqual(Array.from(h.items(), item => item.status), ["confirmed", "failed"]);
  const first = h.begins[0], second = h.begins[1];
  assert.ok(h.messages.some(message => message.includes("1 need attention")));
  await h.hook.retryPhotoUploads(woId);
  assert.ok(h.items().every(item => item.status === "confirmed"));
  assert.equal(h.begins.filter(call => call.operationId === first.operationId).length, 1);
  assert.deepEqual(h.begins[2], second);
  assert.equal(h.factoryCalls.length, 1);
  assert.ok(!h.mutations.some(call => call.includes("activity")));
});

test("photo hook suppresses double click without allocating another batch", async () => {
  const h = harness();
  const first = h.hook.doAddPhotos(woId, files());
  await h.hook.doAddPhotos(woId, files()); await first;
  assert.equal(h.begins.length, 1);
  assert.equal(h.factoryCalls.length, 1);
});

test("new completed batches use the latest versions, while unknown outcomes keep old bound identity", async () => {
  const h = harness();
  await h.hook.doAddPhotos(woId, files());
  await h.hook.doAddPhotos(woId, files());
  assert.equal(h.factoryCalls.length, 1, "Unchanged versions may retain the bounded controller");
  h.workOrder.contractorAssignmentVersion = 4;
  h.workOrder.workflowCycle = 3;
  await h.hook.doAddPhotos(woId, files());
  assert.deepEqual(h.factoryCalls[1], [woId, 4, 3]);
  assert.equal(new Set(h.begins.map(call => call.operationId)).size, 3);
});

test("missing parent versions fail safely before authorization, rather than coercing null to zero", async () => {
  const h = harness({ versionsMissing: true });
  await h.hook.doAddPhotos(woId, files());
  assert.equal(h.factoryCalls.length, 0);
  assert.equal(h.begins.length, 0);
  assert.match(h.messages[0], /Refresh the work order/);
});

test("pending deletion keeps a retry target even when refresh no longer returns the photo row", async () => {
  const h = harness({ pendingDeleteOnce: true });
  await h.hook.doRemovePhoto(woId, "legacy/photo.png");
  assert.match(h.messages[0], /not confirmed/);
  assert.ok(h.stateChanges.some(value => typeof value === "object" && value !== null && woId in value
    && typeof value[woId] === "string" && value[woId].includes("Retry")));
  h.workOrder.photos = [];
  h.cache.set(detailCacheKey, { photos: [] });
  await h.hook.retryPhotoDeletion(woId);
  assert.deepEqual(h.deletedPaths, ["legacy/photo.png", "legacy/photo.png"]);
  assert.equal(h.messages.at(-1), "Photo removed");
  await h.hook.retryPhotoDeletion(woId);
  assert.equal(h.deletedPaths.length, 2, "Confirmed deletion clears the local recovery target");
});

test("photo session cleanup prevents late upload state or cache writes after actor change/unmount", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolvePromise => { release = resolvePromise; });
  const h = harness({ uploadGate: gate });
  const cleanup = h.effects[0](); assert.equal(typeof cleanup, "function");
  const running = h.hook.doAddPhotos(woId, files());
  for (let attempt = 0; attempt < 100 && !h.mutations.length; attempt++) await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
  assert.ok(h.mutations.length);
  if (typeof cleanup !== "function") return;
  cleanup();
  const stateCount = h.stateChanges.length, messageCount = h.messages.length;
  release(); await running;
  assert.equal(h.stateChanges.length, stateCount);
  assert.equal(h.messages.length, messageCount);
  assert.equal(h.invalidations.length, 0);
  assert.equal(h.mutations.filter(call => call.startsWith("cancel:")).length, 0);
  assert.deepEqual(h.cache.get(detailCacheKey), h.workOrder);
  await h.hook.retryPhotoUploads(woId);
  assert.equal(h.begins.length, 1);
});
