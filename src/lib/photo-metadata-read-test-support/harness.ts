import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

export type PhotoReadCall = { name: string; args: Record<string, unknown>; signal: AbortSignal | undefined };
export type PhotoRawResult = { data: unknown; error: unknown };
export type PhotoReadPlan = (call: PhotoReadCall) => PhotoRawResult | Promise<PhotoRawResult>;
const root = process.cwd();
const requireHere = createRequire(join(root, "package.json"));
const allowedRpc = "list_work_order_photos_rows_v1";

/** Full real facade/transport/repository/validator/mapper; only the single Supabase RPC transport is injected. */
export function createPhotoMetadataReadHarness(plans: readonly PhotoReadPlan[]) {
  const pending = [...plans];
  const calls: PhotoReadCall[] = [];
  const loaded = new Map<string, { exports: Record<string, unknown> }>();
  const client = {
    from() { throw new Error("Photo metadata harness must not issue table queries"); },
    get storage() { throw new Error("Photo metadata harness must not access Storage"); },
    rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, allowedRpc, "No unrelated RPC, count, mutation or metadata collection");
      const call: PhotoReadCall = { name, args: structuredClone(args), signal: undefined };
      calls.push(call);
      const plan = pending.shift();
      assert.ok(plan, "Every query requires an explicit synthetic response plan");
      const query: PromiseLike<PhotoRawResult> & { abortSignal(signal: AbortSignal): typeof query } = {
        abortSignal(signal) { call.signal = signal; return query; },
        then(onfulfilled, onrejected) { return Promise.resolve().then(() => plan(call)).then(onfulfilled, onrejected); },
      };
      return query;
    },
  };
  const clientFile = join(root, "src/lib/supabase/client.ts");
  const transportFile = join(root, "src/lib/counts/readRpc.ts");
  const featurePaths = [join(root, "src/features/work-orders/data/"), join(root, "src/features/photos/data/")];
  const load = (filename: string): Record<string, unknown> => {
    const absolute = resolve(filename);
    if (absolute === clientFile) return { supabase: () => client };
    const previous = loaded.get(absolute);
    if (previous) return previous.exports;
    const ownerModule = { exports: {} };
    loaded.set(absolute, ownerModule);
    const resolveImport = (name: string): unknown => {
      if (!name.startsWith(".") && !name.startsWith("@/")) return requireHere(name);
      const base = name.startsWith("@/") ? join(root, "src", name.slice(2)) : resolve(dirname(absolute), name);
      const target = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]
        .find(candidate => existsSync(candidate) && statSync(candidate).isFile());
      assert.ok(target, `Unresolved production dependency: ${name}`);
      if (target === clientFile || target === transportFile || featurePaths.some(feature => target.startsWith(feature))) return load(target);
      return requireHere(target);
    };
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: absolute,
    }).outputText;
    runInNewContext(compiled, { exports: ownerModule.exports, module: ownerModule, require: resolveImport,
      Date, Map, Set, Promise, AbortController, AbortSignal, DOMException, URL, crypto: globalThis.crypto,
      fetch: () => { throw new Error("Provider/network access forbidden in photo metadata harness"); },
    }, { filename: absolute });
    return ownerModule.exports;
  };
  const facade = load(join(root, "src/lib/db.ts"));
  return {
    calls,
    async loadPage(workOrderId: string, cursor?: string | null, limit?: number, signal?: AbortSignal): Promise<unknown> {
      const method = facade.loadWorkOrderPhotosPage;
      assert.equal(typeof method, "function", "The production compatibility facade must remain callable");
      if (typeof method !== "function") throw new Error("Invalid photo metadata facade export");
      const result: unknown = await Reflect.apply(method, undefined, [workOrderId, cursor, limit, signal]);
      return structuredClone(result);
    },
    remainingPlans: () => pending.length,
  };
}

export const photoRespond = (data: unknown): PhotoReadPlan => () => ({ data, error: null });
export function photoPage(items: readonly unknown[], nextCursor: string | null = null) {
  return { items, nextCursor, hasMore: nextCursor !== null };
}
export function photoRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
