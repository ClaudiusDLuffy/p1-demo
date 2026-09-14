import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { QueryClient, QueryObserver, type QueryObserverOptions } from "@tanstack/react-query";
import { AppError } from "../../lib/errors/AppError";
import type { DirectoryActor } from "../directory/contracts";
import type * as BillingQueries from "./queries";

const actor: DirectoryActor = { id: "00000000-0000-4000-8000-000000000001", role: "manager", active: true };
type Read = { kind: string; input: unknown; signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: Error) => void };
function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const state = { actor: actor as DirectoryActor | null, visible: true };
  const reads: Read[] = [];
  const observers = new Map<string, QueryObserver>();
  const subscriptions: (() => void)[] = [];
  let label = "";
  const filename = resolve("src/features/billing/queries.ts");
  const exports = {};
  const requireHere = createRequire(import.meta.url);
  const read = (kind: string, input: unknown, signal: AbortSignal) => new Promise<unknown>((resolve, reject) => reads.push({ kind, input, signal, resolve, reject }));
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string): unknown => {
    if (name === "@tanstack/react-query") return { useQuery: (options: QueryObserverOptions) => {
      let observer = observers.get(label);
      if (!observer) {
        observer = new QueryObserver(client, options); observers.set(label, observer);
        subscriptions.push(observer.subscribe(() => undefined));
      } else observer.setOptions(options);
      return observer.getCurrentResult();
    } };
    if (name === "../directory/queries") return { useDirectoryActor: () => state.actor };
    if (name.endsWith("/counts/countQueryPolicy")) return {
      useCountQueryVisibility: (enabled: boolean) => enabled && state.visible,
      countReadPolicy: { staleTime: 30_000, refetchOnWindowFocus: false, refetchOnReconnect: false },
    };
    if (name === "./billingReads") return {
      readBillingRows: (input: unknown, signal: AbortSignal) => read("rows", input, signal),
      readBillingCount: (input: unknown, signal: AbortSignal) => read("count", input, signal),
      readBillingInvoice: (input: unknown, signal: AbortSignal) => read("exact", input, signal),
    };
    return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
  } }, { filename });
  const hooks = exports as typeof BillingQueries;
  return { client, reads, state,
    count: (enabled = true) => { label = "count"; return hooks.useBillingInvoiceCountQuery({ queue: "all" }, enabled); },
    page: (cursor: string | null = null, enabled = true) => { label = "page"; return hooks.useBillingInvoicePageQuery({ queue: "all", cursor, limit: 25 }, enabled); },
    exact: (id: string, source = false) => { label = "exact"; return source
      ? hooks.useBillingSourceInvoiceByIdQuery(id) : hooks.useBillingInvoiceByIdQuery(id); },
    close: () => { subscriptions.forEach(unsubscribe => unsubscribe()); client.clear(); },
  };
}
const tick = () => new Promise<void>(done => setImmediate(done));
const page = (id: string) => ({ items: [{ id }], hasMore: false, nextCursor: null, totalCount: null });

test("billing headers count only when rendered and visible, never loading a collapsed row page", async () => {
  const h = harness();
  try {
    h.state.visible = false; h.count(); h.page(null, false); assert.equal(h.reads.length, 0);
    h.state.visible = true; h.count(); assert.equal(h.reads.length, 1); assert.equal(h.reads[0].kind, "count");
    h.reads[0].resolve({ totalCount: 1001 }); await tick();
    assert.equal(h.count().data?.totalCount, 1001);
    h.count(false); h.count(); assert.equal(h.reads.length, 1, "fresh visible count reuses cache");
    h.state.visible = false; const hidden = h.count(); await hidden.refetch();
    assert.equal(h.reads.length, 1, "manual hidden count refetch cannot bypass visibility");
  } finally { h.close(); }
});
test("three billing row pages make three row requests and only one independent visible count", async () => {
  const h = harness();
  try {
    h.count(); h.reads[0].resolve({ totalCount: 1001 }); await tick();
    for (const cursor of [null, "second", "third"]) {
      h.page(cursor); h.reads.at(-1)!.resolve(page(`row-${cursor}`)); await tick(); h.count();
    }
    assert.equal(h.reads.filter(read => read.kind === "count").length, 1);
    assert.equal(h.reads.filter(read => read.kind === "rows").length, 3);
    const countKeys = h.client.getQueryCache().getAll().filter(query => query.queryKey[0] === "billing-invoice-count");
    assert.equal(countKeys.length, 1);
    assert.doesNotMatch(JSON.stringify(countKeys[0].queryKey), /cursor|limit|sort/);
  } finally { h.close(); }
});
test("count denial cannot block independently successful billing rows or become a zero", async () => {
  const h = harness();
  try {
    h.count(); h.page();
    h.reads[0].reject(new AppError("FORBIDDEN")); h.reads[1].resolve(page("synthetic")); await tick();
    assert.equal(h.count().isError, true); assert.equal(h.count().data, undefined);
    assert.equal(h.page().data?.items[0].id, "synthetic"); assert.equal(h.page().data?.totalCount, null);
    assert.equal(h.reads.length, 2);
  } finally { h.close(); }
});
test("billing account/scope switch cancels old responses and never exposes previous cache values", async () => {
  const h = harness();
  try {
    h.count(); const previous = h.reads[0];
    h.state.actor = { ...actor, id: "00000000-0000-4000-8000-000000000002", staffPermissions: ["invoice_controller"] };
    assert.equal(h.count().data, undefined); assert.equal(previous.signal.aborted, true);
    previous.resolve({ totalCount: 9876 }); h.reads[1].resolve({ totalCount: 3 }); await tick();
    assert.equal(h.count().data?.totalCount, 3);
    h.state.actor = { ...h.state.actor, active: false }; assert.equal(h.count().data, undefined);
    assert.equal(h.reads.length, 2);
  } finally { h.close(); }
});
test("billing production UI has separate header counts and gates every collapsed row bucket", () => {
  const ui = readFileSync(resolve("src/features/billing/BillingInvoiceList.tsx"), "utf8");
  for (const bucket of ["all", "draft", "submitted", "sent", "recently_approved", "ready"]) {
    assert.match(ui, new RegExp(`queryEnabled[^\\n]*expanded\\.${bucket} !== false`));
  }
  assert.doesNotMatch(ui, /totalCount\s*\|\|\s*0/);
  assert.match(ui, /useBillingInvoiceCountQuery/);
  assert.match(ui, /countEnabled: false/);
});

test("R3 billing and staff-source exact hooks reuse one canonical actor-scoped cache entry", async () => {
  const id = "b7300000-abcd-4000-8abc-000000000001";
  for (const source of [false, true]) {
    const h = harness();
    try {
      h.exact(id.toUpperCase(), source);
      assert.equal(h.reads.length, 1); assert.equal(h.reads[0].input, id);
      h.reads[0].resolve({ id }); await tick();
      h.exact(id, source);
      assert.equal(h.reads.length, 1);
      assert.equal(h.client.getQueryCache().getAll().length, 1);
      const key = h.client.getQueryCache().getAll()[0].queryKey;
      assert.equal(key[0], source ? "invoice-by-id" : "billing-invoice-by-id");
      assert.equal(key[1], id);
      if (source) assert.equal(key[3], "staff-source-summary-v1");
    } finally { h.close(); }
  }
});
