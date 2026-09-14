import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

export type ReadCall = { name: string; args: Record<string, unknown>; signal: AbortSignal | undefined };
export type RawReadResult = { data: unknown; error: unknown };
export type ReadPlan = (call: ReadCall) => RawReadResult | Promise<RawReadResult>;
const root = process.cwd();
const requireHere = createRequire(join(root, "package.json"));
const pageRpcs = ["list_work_order_activities_rows_v1", "list_work_order_visits_rows_v1"];

/** Complete real db facade and transport; only the two allowed Supabase requests are injected. */
function createHarness(plans: readonly ReadPlan[], allowedNames: readonly string[]) {
  const allowedRpcs = new Set(allowedNames);
  const pending = [...plans];
  const calls: ReadCall[] = [];
  const loaded = new Map<string, { exports: Record<string, unknown> }>();
  const client = {
    from() { throw new Error("Activity/visit read tests must not issue table queries"); },
    rpc(name: string, args: Record<string, unknown>) {
      assert.ok(allowedRpcs.has(name), `Unexpected query or mutation RPC: ${name}`);
      const call: ReadCall = { name, args: structuredClone(args), signal: undefined };
      calls.push(call);
      const plan = pending.shift();
      assert.ok(plan, "Every query requires an explicit synthetic response plan");
      const query: PromiseLike<RawReadResult> & { abortSignal(signal: AbortSignal): typeof query } = {
        abortSignal(signal) { call.signal = signal; return query; },
        then(onfulfilled, onrejected) { return Promise.resolve().then(() => plan(call)).then(onfulfilled, onrejected); },
      };
      return query;
    },
  };
  const clientFile = join(root, "src/lib/supabase/client.ts");
  const transportFile = join(root, "src/lib/counts/readRpc.ts");
  const featurePath = join(root, "src/features/work-orders/data/");
  const photoFeaturePath = join(root, "src/features/photos/data/");
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
      if (target === clientFile || target === transportFile || target.startsWith(featurePath)
        || target.startsWith(photoFeaturePath)) return load(target);
      return requireHere(target);
    };
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: absolute,
    }).outputText;
    runInNewContext(compiled, { exports: ownerModule.exports, module: ownerModule, require: resolveImport,
      Date, Map, Set, Promise, AbortController, AbortSignal, DOMException, URL, crypto: globalThis.crypto,
      fetch: () => { throw new Error("Provider/network access forbidden in this harness"); },
    }, { filename: absolute });
    return ownerModule.exports;
  };
  const facade = load(join(root, "src/lib/db.ts"));
  const invoke = async (name: string, args: readonly unknown[]): Promise<unknown> => {
    const method = facade[name];
    assert.equal(typeof method, "function", `Production facade ${name} must remain callable`);
    if (typeof method !== "function") throw new Error("Invalid facade export");
    const result: unknown = await Reflect.apply(method, undefined, args);
    return structuredClone(result);
  };
  return {
    calls,
    loadActivities: (workOrder: unknown, cursor?: string | null, limit?: number, signal?: AbortSignal) =>
      invoke("loadWorkOrderActivitiesPage", [workOrder, cursor, limit, signal]),
    loadVisits: (id: string, cursor?: string | null, limit?: number, signal?: AbortSignal) =>
      invoke("loadWorkOrderVisitsPage", [id, cursor, limit, signal]),
    loadDetails: (workOrder: unknown, signal?: AbortSignal) => invoke("loadWorkOrderDetails", [workOrder, signal]),
    remainingPlans: () => pending.length,
  };
}
export function createActivityVisitReadHarness(plans: readonly ReadPlan[]) {
  const { loadDetails: _loadDetails, ...harness } = createHarness(plans, pageRpcs);
  void _loadDetails;
  return harness;
}
/** Composite-detail tests still execute all four real owners; no broad query allowance. */
export function createWorkOrderDetailReadHarness(plans: readonly ReadPlan[]) {
  return createHarness(plans, [...pageRpcs, "list_work_order_photos_rows_v1", "get_portal_work_order"]);
}
export const respond = (data: unknown): ReadPlan => () => ({ data, error: null });
export const rawPage = (items: readonly unknown[], nextCursor: string | null = null) => ({
  items, hasMore: nextCursor !== null, nextCursor,
});
export function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
