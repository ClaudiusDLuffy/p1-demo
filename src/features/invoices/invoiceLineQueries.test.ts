import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { QueryClient, QueryObserver, type QueryObserverOptions } from "@tanstack/react-query";
import type { InvoiceLinePage } from "./invoiceReadContracts";
import type { useInvoiceLinePage } from "./invoiceLineQueries";
import { directoryActorScope } from "../../lib/counts/queryKeys";
import { matchesRealtimeTarget } from "../../lib/realtime/realtimeInvalidationPlan";

const filename = resolve("src/features/invoices/invoiceLineQueries.ts");
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const requireHere = createRequire(import.meta.url);
const actor = { id: "synthetic-actor", role: "manager", active: true };
const line = { id: "line-a", invoiceId: "invoice-a", position: 0, type: "Labor", description: "Synthetic work",
  qty: 1, rate: 10, amount: 10, isTaxable: false, sourceInvoiceLineId: null, sourceWorkOrderPartId: null,
  sourceUnitCost: null, markupPercent: null };
const page = (version = 0, hasMore = false): InvoiceLinePage => ({ projection: "line_page", invoiceVersion: version,
  items: [line], pageSize: 50, hasMore, nextCursor: hasMore ? "cursor-a" : null });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function harness() {
  const context = { actor, visible: true, version: 0 };
  const calls: { id: string; version: number; cursor: string | null; signal: AbortSignal; resolve(value: InvoiceLinePage): void }[] = [];
  const read = (id: string, version: number, cursor: string | null, signal: AbortSignal) => new Promise<InvoiceLinePage>(resolve => {
    calls.push({ id, version, cursor, signal, resolve });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let state: unknown;
  let observer: QueryObserver<InvoiceLinePage> | undefined;
  let unsubscribe: (() => void) | undefined;
  const exports: { useInvoiceLinePage?: typeof useInvoiceLinePage;
    invoiceLinesKey?: typeof import("./invoiceLineQueries").invoiceLinesKey } = {};
  runInNewContext(compiled, { exports, JSON, require: (name: string) => {
    if (name === "react") return { useState: (initial: unknown) => {
      if (state === undefined) state = initial;
      return [state, (next: unknown) => { state = next; }];
    } };
    if (name === "@tanstack/react-query") return { useQueryClient: () => client,
      useQuery: (options: QueryObserverOptions<InvoiceLinePage>) => {
        if (!observer) { observer = new QueryObserver(client, options); unsubscribe = observer.subscribe(() => undefined); }
        else observer.setOptions(options);
        return observer.getCurrentResult();
      } };
    if (name === "../directory/queries") return { useDirectoryActor: () => context.actor };
    if (name.endsWith("/browserVisibility")) return { usePortalVisibility: () => context.visible };
    if (name === "./invoiceReads") return { readInvoiceLines: read };
    if (name === "../billing/billingReads") return { readBillingLines: read };
    return requireHere(resolve(filename, "..", name));
  } });
  assert.ok(exports.useInvoiceLinePage);
  assert.ok(exports.invoiceLinesKey);
  const hook = exports.useInvoiceLinePage;
  return { context, calls, client, key: exports.invoiceLinesKey, render: (source = false, id = "invoice-a") => hook({ id, invoiceVersion: context.version,
    lineCount: 1001, projection: "summary", staff: source, source }),
    close: () => { unsubscribe?.(); client.clear(); } };
}

test("ordinary lines read one page, navigate without collecting and reset on invoice version", async () => {
  const h = harness();
  try {
    let result = h.render(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].version, 0);
    h.calls[0].resolve(page(0, true)); await tick(); result = h.render(); result.next(); result = h.render();
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].cursor, "cursor-a"); assert.equal(result.lines.length, 0);
    h.calls[1].resolve({ ...page(), items: [{ ...line, id: "line-b", position: 1 }] }); await tick();
    result = h.render(); assert.equal(result.lines.length, 1); assert.equal(result.lines[0].id, "line-b");
    h.context.version = 1; result = h.render(); assert.equal(result.page, 1); assert.equal(result.lines.length, 0);
    assert.equal(h.calls[2].cursor, null); assert.equal(h.calls[2].version, 1);
  } finally { h.close(); }
});
test("line continuation is cancelled on account switch; stale rows never enter the new observer", async () => {
  const h = harness();
  try {
    h.render(); const old = h.calls[0];
    h.context.actor = { ...actor, id: "other-actor" }; h.render(); assert.equal(old.signal.aborted, true);
    old.resolve(page()); await tick(); assert.equal(h.render().lines.length, 0);
    h.calls[1].resolve({ ...page(), items: [{ ...line, id: "authorized-new-line" }] }); await tick();
    assert.equal(h.render().lines[0].id, "authorized-new-line");
  } finally { h.close(); }
});
test("hidden line query stays disabled and one foreground activation reads one bounded page", async () => {
  const h = harness();
  try {
    h.context.visible = false; h.render(); assert.equal(h.calls.length, 0);
    await h.client.invalidateQueries(); assert.equal(h.calls.length, 0);
    h.context.visible = true; h.render(); assert.equal(h.calls.length, 1);
    h.calls[0].resolve(page()); await tick(); h.render(); assert.equal(h.calls.length, 1);
  } finally { h.close(); }
});
test("staff source line key responds only to its contractor invoice ID and actor", async () => {
  const h = harness();
  try {
    h.render(true); h.calls[0].resolve(page()); await tick();
    const key = h.client.getQueryCache().getAll()[0].queryKey;
    assert.equal(key[0], "invoice-by-id"); assert.equal(key[2], directoryActorScope(actor));
    assert.equal(matchesRealtimeTarget(key, { family: "invoice_detail", id: "invoice-a" }, actor), true);
    assert.equal(matchesRealtimeTarget(key, { family: "invoice_detail", id: "unrelated" }, actor), false);
    const refreshing = h.client.invalidateQueries({ predicate: query => matchesRealtimeTarget(query.queryKey,
      { family: "invoice_detail", id: "invoice-a" }, actor) });
    assert.equal(h.calls.length, 2); h.calls[1].resolve(page()); await refreshing;
  } finally { h.close(); }
});

test("R3 staff line keys and observer identity canonicalize UUIDs without changing contractor keys or cursor", async () => {
  const id = "b7300000-abcd-4000-8abc-000000000001";
  const h = harness();
  try {
    for (const source of [false, true]) {
      assert.deepEqual(h.key(id.toUpperCase(), "scope", 2, "cursor-SYNTHETIC", true, source),
        h.key(id, "scope", 2, "cursor-SYNTHETIC", true, source));
    }
    assert.notDeepEqual(h.key(id.toUpperCase(), "scope", 2, null, false), h.key(id, "scope", 2, null, false));
    h.render(true, id.toUpperCase());
    assert.equal(h.calls[0].id, id);
    h.calls[0].resolve({ ...page(0, true), items: [{ ...line, invoiceId: id }] }); await tick();
    let result = h.render(true, id.toUpperCase()); result.next();
    result = h.render(true, id);
    assert.equal(result.page, 2, "A case-only identity change must not reset the current cursor");
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].id, id); assert.equal(h.calls[1].cursor, "cursor-a");
    h.calls[1].resolve({ ...page(), items: [{ ...line, invoiceId: id }] }); await tick();
    assert.equal(h.client.getQueryCache().getAll().length, 2, "Two pages, not two differently cased invoice identities");
  } finally { h.close(); }
});
