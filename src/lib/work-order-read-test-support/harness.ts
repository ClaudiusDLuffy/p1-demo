import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

export type ReadCall = {
  name: string;
  args: Record<string, unknown>;
  signal: AbortSignal | undefined;
};
export type RawReadResult = { data: unknown; error: unknown };
export type ReadPlan = (call: ReadCall) => RawReadResult | Promise<RawReadResult>;
const root = process.cwd();
const requireHere = createRequire(join(root, "package.json"));
const allowedRpcs = new Set([
  "list_work_orders_rows_v1", "list_work_orders_table_rows_v2", "get_portal_work_order",
]);

/**
 * Executes the complete production db facade and real boundedReadRpc transport.
 * Only the Supabase request adapter is fake. No copied production function body,
 * mutable global stub, provider fallback, environment access or table query.
 */
export function createWorkOrderReadHarness(plans: readonly ReadPlan[], now = Date.parse("2026-09-12T08:00:00.000Z")) {
  const pending = [...plans];
  const calls: ReadCall[] = [];
  const loaded = new Map<string, { exports: Record<string, unknown> }>();
  class FrozenDate extends Date { static now() { return now; } }
  const client = {
    from() { throw new Error("Read-only page/header test must not issue table queries"); },
    rpc(name: string, args: Record<string, unknown>) {
      assert.ok(allowedRpcs.has(name), `Unexpected query or mutation RPC: ${name}`);
      const call: ReadCall = { name, args: structuredClone(args), signal: undefined };
      calls.push(call);
      const plan = pending.shift();
      assert.ok(plan, "Every query must have an explicit synthetic response plan");
      const query: PromiseLike<RawReadResult> & { abortSignal(signal: AbortSignal): typeof query } = {
        abortSignal(signal) { call.signal = signal; return query; },
        then(onfulfilled, onrejected) {
          return Promise.resolve().then(() => plan(call)).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
  };
  const clientFile = join(root, "src/lib/supabase/client.ts");
  const transportFile = join(root, "src/lib/counts/readRpc.ts");
  const featurePath = join(root, "src/features/work-orders/data/");
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
      if (target === clientFile || target === transportFile || target.startsWith(featurePath)) return load(target);
      return requireHere(target);
    };
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: absolute,
    }).outputText;
    runInNewContext(compiled, {
      exports: ownerModule.exports, module: ownerModule, require: resolveImport, Date: FrozenDate,
      Map, Set, Promise, AbortController, AbortSignal, DOMException, URL,
      crypto: globalThis.crypto,
      fetch: () => { throw new Error("Provider/network access is forbidden in this harness"); },
    }, { filename: absolute });
    return ownerModule.exports;
  };
  const facade = load(join(root, "src/lib/db.ts"));
  const invoke = async (name: string, args: readonly unknown[]) => {
    const method = facade[name];
    assert.equal(typeof method, "function", `Production facade export ${name} must remain callable`);
    if (typeof method !== "function") throw new Error("Unreachable invalid facade export");
    return structuredClone(await Reflect.apply(method, undefined, args));
  };
  return {
    calls,
    loadPage: (params?: Record<string, unknown>, signal?: AbortSignal) => invoke("loadWorkOrdersPage", [params, signal]),
    loadExact: (id: string, signal?: AbortSignal) => invoke("loadWorkOrderById", [id, signal]),
    remainingPlans: () => pending.length,
  };
}

export const respond = (data: unknown): ReadPlan => () => ({ data, error: null });
export const rawPage = (items: readonly unknown[], nextCursor: string | null = null) => ({
  items, hasMore: nextCursor !== null, nextCursor,
});

export function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
