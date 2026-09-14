import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { QueryClient, QueryObserver, type QueryObserverOptions } from "@tanstack/react-query";
import type { DirectoryActor, DirectoryPage } from "./contracts";
import type * as DirectoryQueries from "./queries";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor: DirectoryActor = { id: id(1), role: "manager", active: true };
const requireHere = createRequire(import.meta.url);
type Request = { domain: string; query: string; company: string | null; cursor: string | null;
  signal: AbortSignal; resolve: (page: DirectoryPage) => void };
const result = (n: number, hasMore = false): DirectoryPage => ({ items: [{ id: id(n), name: `Synthetic ${n}` }],
  pageSize: 25, hasMore, nextCursor: hasMore ? `cursor_${n}` : null });

// Synthetic React state/timers around the real hook and real QueryObserver.
// This exercises cancellation and observer/cache changes without claiming E2E.
function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const slots: unknown[] = []; let slot = 0, time = 0, timerId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const effects: (() => void)[] = [];
  let observer: QueryObserver | undefined;
  let unsubscribe: (() => void) | undefined;
  const calls: Request[] = [];
  const exact: { domain: string; id: string; company: string | null; signal: AbortSignal }[] = [];
  const context: { current: DirectoryActor | null } = { current: actor };
  const react = {
    createContext: () => ({}), useContext: () => context.current,
    useState: (initial: unknown) => { const index = slot++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; },
    useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => (() => void) | void, deps: unknown[]) => {
      const index = slot++; const before = slots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
      if (!before || JSON.stringify(before.deps) !== JSON.stringify(deps)) effects.push(() => {
        before?.cleanup?.(); const cleanup = fn(); slots[index] = { deps, cleanup };
      });
    },
  };
  const loaded = new Map<string, unknown>();
  const load = (filename: string): unknown => {
    if (loaded.has(filename)) return loaded.get(filename);
    const exports = {}; loaded.set(filename, exports);
    const code = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    runInNewContext(code, { exports, Promise, Map, Set, Error, JSON,
      setTimeout: (run: () => void, delay: number) => { const key = ++timerId; timers.set(key, { at: time + delay, run }); return key; },
      clearTimeout: (key: number) => timers.delete(key),
      require: (name: string): unknown => {
        if (name === "react") return react;
        if (name === "@tanstack/react-query") return { useQuery: (options: QueryObserverOptions<unknown, Error, unknown, unknown, readonly unknown[]>) => {
          // GC timing is not under test; prevent real minute-long cache timers.
          const observedOptions = { ...options, gcTime: Infinity };
          const currentObserver = observer || new QueryObserver(client, observedOptions);
          if (!observer) { observer = currentObserver; unsubscribe = currentObserver.subscribe(() => undefined); }
          else currentObserver.setOptions(observedOptions);
          return currentObserver.getCurrentResult();
        } };
        if (name === "./api") return {
          loadDirectoryPage: (domain: string, query: string, company: string | null, cursor: string | null, signal: AbortSignal) => {
            return new Promise<DirectoryPage>(done => { calls.push({ domain, query, company, cursor, signal, resolve: done }); });
          },
          loadDirectorySelection: async (domain: string, selectionId: string, company: string | null, signal: AbortSignal) => {
            exact.push({ domain, id: selectionId, company, signal });
            return { id: selectionId, name: "Exact selected" };
          },
          loadDirectoryLabels: async () => [],
        };
        if (name.endsWith("/useCursorPagination")) return load(resolve(filename, "..", `${name}.ts`));
        return name.startsWith(".") ? requireHere(resolve(filename, "..", name)) : requireHere(name);
      },
    }, { filename });
    return exports;
  };
  const hooks = load(resolve("src/features/directory/queries.tsx")) as typeof DirectoryQueries;
  const render = <T,>(fn: () => T) => { slot = 0; const value = fn(); effects.splice(0).forEach(run => run()); return value; };
  const page = (enabled = true, company: string | null = null, scopedActor: DirectoryActor | null = context.current) =>
    render(() => hooks.useDirectoryPage("contacts", enabled, company, scopedActor));
  return { client, calls, exact, context, hooks, page, render,
    advance: (ms: number) => { time += ms; for (const [key, timer] of timers) if (timer.at <= time) { timers.delete(key); timer.run(); } },
    close: () => { unsubscribe?.(); for (const value of slots) (value as { cleanup?: () => void })?.cleanup?.(); client.clear(); },
  };
}
const flush = () => new Promise<void>(done => setImmediate(done));

test("all initial active roles make zero directory page/selection requests before a visible consumer opens", () => {
  const roles: DirectoryActor[] = [actor, { ...actor, role: "dispatcher" }, { ...actor, role: "back_office" },
    { ...actor, role: "back_office", staffPermissions: ["invoice_controller"] },
    { ...actor, role: "contractor", contractorAccountId: id(20), contractorAccessLevel: "admin", canManageTeam: true },
    { ...actor, role: "contractor", contractorAccountId: id(20), contractorAccessLevel: "invoice" },
    { ...actor, role: "contractor", contractorAccountId: id(20), contractorAccessLevel: "report_only" },
    { ...actor, role: "contractor", contractorTier: "direct" }, { ...actor, role: "contractor", contractorTier: "mr_freeze" }];
  for (const role of roles) {
    const h = harness();
    try {
      h.context.current = role; h.page(false);
      h.render(() => h.hooks.useDirectorySelection("profile_labels", null));
      h.render(() => h.hooks.useDirectoryLabels([], false));
      assert.equal(h.calls.length, 0); assert.equal(h.exact.length, 0);
    } finally { h.close(); }
  }
});

test("closed directories never fetch; search debounces300ms and aborts old observer requests", async () => {
  const h = harness();
  try {
    h.page(false); assert.equal(h.calls.length, 0);
    let view = h.page(true); assert.equal(h.calls.length, 1);
    view.setSearch(" Alpha "); view = h.page(true);
    assert.equal(h.calls[0].signal.aborted, true); assert.equal(view.items.length, 0);
    h.advance(299); h.page(); assert.equal(h.calls.length, 1);
    h.advance(1); view = h.page(); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].query, "alpha");
    view.setSearch("Beta"); h.page(); assert.equal(h.calls[1].signal.aborted, true);
    h.calls[1].resolve(result(7)); await flush();
    h.advance(300); h.page(); assert.equal(h.calls[2].query, "beta");
    h.calls[2].resolve(result(8)); await flush(); view = h.page();
    assert.equal(view.items[0].id, id(8)); assert.ok(!view.items.some(item => item.id === id(7)));
    h.page(false); assert.equal(h.calls.length, 3);
  } finally { h.close(); }
});
test("continuation is explicit, never accumulated; search and company changes reset cursor", async () => {
  const h = harness();
  try {
    h.page(); h.calls[0].resolve(result(2, true)); await flush();
    let view = h.page(); assert.equal(h.calls.length, 1); assert.equal(view.items[0].id, id(2));
    view.next(); view = h.page(); assert.equal(view.position.page, 2); assert.equal(h.calls[1].cursor, "cursor_2");
    h.calls[1].resolve(result(3)); await flush(); view = h.page();
    assert.deepEqual(view.items.map(item => item.id), [id(3)]);
    view.previous(); view = h.page(); assert.equal(view.position.page, 1); assert.equal(view.items[0].id, id(2));
    view.next(); h.page(); view = h.page(true, id(20));
    assert.equal(view.position.page, 1); assert.equal(h.calls.at(-1)?.company, id(20));
    view.setSearch("new"); h.page(true, id(20)); h.advance(300); view = h.page(true, id(20));
    assert.equal(view.position.page, 1); assert.equal(h.calls.at(-1)?.cursor, null);
  } finally { h.close(); }
});
test("actor/role/company/access transitions hide old results and abort in-flight directory reads", async () => {
  const h = harness();
  try {
    h.page(); h.calls[0].resolve(result(5)); await flush(); assert.equal(h.page().items.length, 1);
    const another = { ...actor, id: id(9) };
    let view = h.page(true, null, another); assert.equal(view.items.length, 0);
    const old = h.calls.at(-1)!;
    view = h.page(true, null, { ...another, role: "contractor", contractorAccountId: id(10), contractorAccessLevel: "admin", canManageTeam: true });
    assert.equal(old.signal.aborted, true); assert.equal(view.items.length, 0);
    const count = h.calls.length; h.page(true, null, { ...another, active: false }); assert.equal(h.calls.length, count);
    h.page(true, null, null); assert.equal(h.calls.length, count);
    const keys = h.client.getQueryCache().getAll().map(query => query.queryKey);
    assert.ok(keys.every(key => key.includes(25)));
  } finally { h.close(); }
});
test("invalid input, closed state, and debounce cannot manually refetch an empty or stale search", async () => {
  const h = harness();
  try {
    let view = h.page(false); await view.refetch(); assert.equal(h.calls.length, 0);
    view = h.page(); const count = h.calls.length;
    view.setSearch("x".repeat(201)); view = h.page();
    assert.equal(view.isError, true); await view.refetch(); assert.equal(h.calls.length, count);
    view.setSearch("next"); view = h.page(); await view.refetch(); assert.equal(h.calls.length, count);
    h.advance(300); view = h.page(); assert.equal(h.calls.at(-1)?.query, "next");
  } finally { h.close(); }
});
test("restart clears an invalid continuation and reissues only the first current-search page", async () => {
  const h = harness();
  try {
    h.page(); h.calls[0].resolve(result(2, true)); await flush(); let view = h.page();
    view.next(); view = h.page(); assert.equal(view.position.page, 2);
    view.reset(); view = h.page(); assert.equal(view.position.page, 1);
    assert.equal(h.calls.at(-1)?.cursor, null); assert.equal(h.calls[1].signal.aborted, true);
  } finally { h.close(); }
});
test("selected hydration uses exact requested identity and obeys role-scoped cancellation", async () => {
  const h = harness();
  try {
    const selection = () => h.render(() => h.hooks.useDirectorySelection("technician_profile", id(99), id(30)));
    selection(); await flush(); const view = selection();
    assert.equal(view.data?.id, id(99)); assert.equal(h.calls.length, 0);
    assert.equal(h.exact[0].domain, "technician_profile"); assert.equal(h.exact[0].company, id(30));
    h.context.current = null; const disabled = selection(); assert.equal(disabled.data, undefined);
    await disabled.refetch(); assert.equal(h.exact.length, 1);
  } finally { h.close(); }
});
