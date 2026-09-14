import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { QueryClient, QueryObserver, type QueryObserverOptions } from "@tanstack/react-query";
import { AppError } from "./errors/AppError";
import { directoryActorScope, workOrderByIdKey } from "./counts/queryKeys";
import { invoicePartHintIds, invoicePartHintsKey, parseInvoicePartHints, readInvoicePartHints } from "../features/work-orders/invoicePartHints";
import type { DirectoryActor } from "../features/directory/contracts";
import type { useInvoicePartHints } from "../features/work-orders/useInvoicePartHints";

const id = (n: number) => `76200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const parts = [{ id: id(2) }, { id: id(1) }];
const actor: DirectoryActor = { id: id(3), active: true, role: "manager" };
const tick = () => new Promise<void>(done => setImmediate(done));

test("part billing hint input is deduplicated, deterministic, bounded and ID-only", () => {
  assert.deepEqual(invoicePartHintIds([...parts, parts[0]]), [id(1), id(2)]);
  assert.throws(() => invoicePartHintIds([{ id: "private description" }]), AppError);
  assert.equal(invoicePartHintIds(Array.from({ length: 1_000 }, (_, n) => ({ id: id(n) }))).length, 1_000);
  assert.throws(() => invoicePartHintIds(Array.from({ length: 1_001 }, (_, n) => ({ id: id(n) }))), AppError);
});
test("part hints reject duplicate, unrequested or malformed IDs and discard unrelated fields", () => {
  assert.deepEqual(parseInvoicePartHints({ billedPartIds: [id(1)], lines: ["must not be retained"] }, [id(1)]), [id(1)]);
  for (const bad of [null, [], {}, { billedPartIds: [id(2)] }, { billedPartIds: [id(1), id(1)] }, { billedPartIds: [1] }]) {
    assert.throws(() => parseInvoicePartHints(bad, [id(1)]), AppError);
  }
});
test("one bounded hint RPC replaces complete invoice hydration without per-part queries", async () => {
  const calls: unknown[] = [];
  const controller = new AbortController();
  const result = await readInvoicePartHints("WOT-SYNTHETIC", parts, controller.signal, async (name, args, signal) => {
    calls.push({ name, args }); assert.equal(signal, controller.signal); return { billedPartIds: [id(1)] };
  });
  assert.deepEqual(result, [id(1)]);
  assert.deepEqual(calls, [{ name: "get_work_order_invoice_part_hints_v1", args: { p_work_order_id: "WOT-SYNTHETIC", p_part_ids: [id(1), id(2)] } }]);
  await readInvoicePartHints("WOT-SYNTHETIC", [], undefined, async () => { assert.fail("Empty parts need no query"); });
});
test("part hints preserve safe errors and reject results delivered after cancellation", async () => {
  const error = new AppError("FORBIDDEN");
  await assert.rejects(readInvoicePartHints("WOT-SYNTHETIC", parts, undefined, async () => { throw error; }), value => value === error);
  const controller = new AbortController();
  await assert.rejects(readInvoicePartHints("WOT-SYNTHETIC", parts, controller.signal, async () => {
    controller.abort(); return { billedPartIds: [id(1)] };
  }), { name: "AbortError" });
});
test("hint query keys follow exact work-order Realtime scope and isolate account/company/part changes", () => {
  const scope = directoryActorScope(actor);
  assert.deepEqual(invoicePartHintsKey("WOT-A", scope, [id(1)]).slice(0, 3), workOrderByIdKey("WOT-A", scope));
  for (const other of [{ ...actor, id: id(4) }, { ...actor, contractorAccountId: id(5) }, { ...actor, active: false }]) {
    assert.notDeepEqual(invoicePartHintsKey("WOT-A", scope, [id(1)]), invoicePartHintsKey("WOT-A", directoryActorScope(other), [id(1)]));
  }
  assert.notDeepEqual(invoicePartHintsKey("WOT-A", scope, [id(1)]), invoicePartHintsKey("WOT-A", scope, [id(2)]));
});

function hookHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const context: { visible: boolean; actor: DirectoryActor } = { visible: true, actor };
  const calls: { signal: AbortSignal; resolve(value: readonly string[]): void }[] = [];
  let observer: QueryObserver<unknown> | undefined;
  let unsubscribe: (() => void) | undefined;
  const file = resolve("src/features/work-orders/useInvoicePartHints.ts");
  const localRequire = createRequire(file);
  const exported: { useInvoicePartHints?: typeof useInvoicePartHints } = {};
  runInNewContext(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports: exported, require: (name: string): unknown => {
    if (name === "@tanstack/react-query") return { useQuery: (options: QueryObserverOptions<unknown>) => {
      if (!observer) { observer = new QueryObserver(client, options); unsubscribe = observer.subscribe(() => undefined); }
      else observer.setOptions(options);
      return observer.getCurrentResult();
    } };
    if (name.endsWith("/directory/queries")) return { useDirectoryActor: () => context.actor };
    if (name.endsWith("/countQueryPolicy")) return { countReadPolicy: { staleTime: 30_000, refetchOnWindowFocus: false, refetchOnReconnect: false }, useCountQueryVisibility: (enabled: boolean) => enabled && context.visible };
    if (name === "./invoicePartHints") return { invoicePartHintsKey, readInvoicePartHints: (_id: string, _parts: unknown, signal: AbortSignal) => new Promise<readonly string[]>(resolve => calls.push({ signal, resolve })) };
    return localRequire(name);
  } });
  assert.ok(exported.useInvoicePartHints);
  return { context, calls, client, render: (enabled = true) => exported.useInvoicePartHints!("WOT-SYNTHETIC", parts, enabled),
    close: () => { unsubscribe?.(); client.clear(); } };
}
test("hidden part hints make no requests; one exact invalidation refetches once; account switch cancels old result", async () => {
  const h = hookHarness();
  try {
    h.render(false); h.context.visible = false; h.render(); assert.equal(h.calls.length, 0);
    h.context.visible = true; h.render(); assert.equal(h.calls.length, 1);
    h.calls[0].resolve([id(1)]); await tick(); assert.deepEqual(h.render().data, [id(1)]);
    await h.client.invalidateQueries({ queryKey: workOrderByIdKey("WOT-OTHER", directoryActorScope(actor)) });
    assert.equal(h.calls.length, 1);
    const refresh = h.client.invalidateQueries({ queryKey: workOrderByIdKey("WOT-SYNTHETIC", directoryActorScope(actor)) });
    assert.equal(h.calls.length, 2);
    h.context.actor = { ...actor, id: id(4) }; h.render(); assert.equal(h.calls[1].signal.aborted, true);
    h.calls[1].resolve([id(1)]); await refresh; await tick(); assert.equal(h.render().data, undefined);
    h.calls[2].resolve([]); await tick(); assert.deepEqual(h.render().data, []);
    h.context.visible = false; h.render();
    await h.client.invalidateQueries({ queryKey: workOrderByIdKey("WOT-SYNTHETIC", directoryActorScope(h.context.actor)), refetchType: "none" });
    assert.equal(h.calls.length, 3);
    h.context.visible = true; h.render(); assert.equal(h.calls.length, 4);
  } finally { h.close(); }
});
