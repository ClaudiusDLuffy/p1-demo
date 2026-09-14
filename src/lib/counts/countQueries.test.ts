import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { QueryClient, QueryObserver, type QueryObserverOptions } from "@tanstack/react-query";
import { AppError } from "../errors/AppError";
import { parseExactCount } from "./countContracts";
import { workOrderCountFilters, invoiceCountFilters } from "./countFilters";
import { directoryActorScope, workOrderCountKey, workOrderByIdKey, workOrderDetailsKey, invoiceCountKey,
  workOrderPartsKey, p1PartCostsKey, billableP1PartsKey, billingWorkOrderVisitsKey } from "./queryKeys";
import type { DirectoryActor } from "../../features/directory/contracts";
import type * as WorkQueries from "../../features/work-orders/queries";
import type * as InvoiceQueries from "../../features/invoices/queries";
import type { WorkOrderPageParams } from "../db";

const actor: DirectoryActor = { id: "00000000-0000-4000-8000-000000000001", active: true, role: "manager" };
const requireHere = createRequire(import.meta.url);
const tick = () => new Promise<void>(done => setImmediate(done));

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const context = { actor: actor as DirectoryActor | null, visible: true };
  const observers: QueryObserver[] = [];
  const cleanup: (() => void)[] = [];
  let slot = 0;
  let reactSlot = 0;
  const state: unknown[] = [];
  const effects = new Map<number, { deps: string; cleanup?: () => void }>();
  const calls: { kind: string; args: unknown; signal: AbortSignal; resolve(value: unknown): void; reject(error: Error): void }[] = [];
  const request = (kind: string, args: unknown, signal: AbortSignal) => new Promise<unknown>((resolve, reject) => calls.push({ kind, args, signal, resolve, reject }));
  const load = (file: string): unknown => {
    const exports = {};
    const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    runInNewContext(code, { exports, AbortController, Promise, Map, Set, Error, JSON, require: (name: string): unknown => {
      if (name === "react") return { useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
        useRef: (initial: unknown) => { const index = reactSlot++; if (!(index in state)) state[index] = { current: initial }; return state[index]; },
        useState: (initial: unknown) => { const index = reactSlot++; if (!(index in state)) state[index] = initial;
          return [state[index], (next: unknown) => { state[index] = typeof next === "function" ? next(state[index]) : next; }]; },
        useEffect: (run: () => (() => void), deps: unknown[]) => {
          const index = reactSlot++; const signature = JSON.stringify(deps); const previous = effects.get(index);
          if (previous?.deps !== signature) { previous?.cleanup?.(); effects.set(index, { deps: signature, cleanup: run() }); }
        },
      };
      if (name === "@tanstack/react-query") return { useQueryClient: () => client, useQuery: (options: QueryObserverOptions<unknown, Error, unknown, unknown, readonly unknown[]>) => {
        const index = slot++;
        if (!observers[index]) {
          observers[index] = new QueryObserver(client, options);
          cleanup.push(observers[index].subscribe(() => undefined));
        } else observers[index].setOptions(options);
        return observers[index].getCurrentResult();
      } };
      if (name.endsWith("/directory/queries")) return { useDirectoryActor: () => context.actor };
      if (name.endsWith("/countQueryPolicy")) return { countReadPolicy: { staleTime: 30_000, refetchOnWindowFocus: false, refetchOnReconnect: false },
        useCountQueryVisibility: (enabled: boolean) => enabled && context.visible };
      if (name.endsWith("/workOrderReadRepository")) return {
        loadWorkOrdersPage: (args: unknown, signal: AbortSignal) => request("rows", args, signal),
        loadWorkOrderById: (id: string, signal: AbortSignal) => request("exact", { id }, signal),
      };
      if (name.endsWith("/activityReadRepository")) return {
        loadWorkOrderActivitiesPage: (workOrder: unknown, cursor: string, limit: number, signal: AbortSignal) => request("append-activities", { workOrder, cursor, limit }, signal),
      };
      if (name.endsWith("/visitReadRepository")) return {
        loadWorkOrderVisitsPage: (id: string, cursor: string, limit: number, signal: AbortSignal) => request("append-visits", { id, cursor, limit }, signal),
      };
      if (name.endsWith("/photoMetadataReadRepository")) return {
        loadWorkOrderPhotosPage: (id: string, cursor: string, limit: number, signal: AbortSignal) => request("append-photos", { id, cursor, limit }, signal),
      };
      if (name.endsWith("/db")) return {
        loadWorkOrdersPage: (args: unknown, signal: AbortSignal) => request("rows", args, signal),
        loadWorkOrdersCount: (args: unknown, signal: AbortSignal) => request("count", args, signal),
        loadInvoicesPage: (args: unknown, signal: AbortSignal) => request("rows", args, signal),
        loadInvoicesCount: (args: unknown, signal: AbortSignal) => request("count", args, signal),
        loadPortalNavigationSummary: (signal: AbortSignal) => request("navigation", {}, signal),
        loadWorkOrderDetails: (args: unknown, signal: AbortSignal) => request("details", args, signal),
        loadWorkOrderChildCount: (id: string, section: string, signal: AbortSignal) => request("child-count", { id, section }, signal),
        loadWorkOrderActivitiesPage: (workOrder: unknown, cursor: string, limit: number, signal: AbortSignal) => request("append-activities", { workOrder, cursor, limit }, signal),
        loadWorkOrderPhotosPage: (id: string, cursor: string, limit: number, signal: AbortSignal) => request("append-photos", { id, cursor, limit }, signal),
        loadWorkOrderVisitsPage: (id: string, cursor: string, limit: number, signal: AbortSignal) => request("append-visits", { id, cursor, limit }, signal),
        loadWoPartsForWorkOrder: (id: string, signal: AbortSignal) => request("parts", { id }, signal),
        loadP1PartCostsForWorkOrder: (id: string, signal: AbortSignal) => request("part-costs", { id }, signal),
        loadBillableP1Parts: (id: string, excludedInvoiceId: string | null, signal: AbortSignal) => request("billable-parts", { id, excludedInvoiceId }, signal),
      };
      return name.startsWith(".") ? requireHere(resolve(file, "..", name)) : requireHere(name);
    } }, { filename: file });
    return exports;
  };
  const work = load(resolve("src/features/work-orders/queries.ts")) as typeof WorkQueries;
  const invoices = load(resolve("src/features/invoices/queries.ts")) as typeof InvoiceQueries;
  const render = <T,>(run: () => T) => { slot = 0; reactSlot = 0; return run(); };
  return { context, client, calls, work, invoices, render,
    close: () => { cleanup.forEach(fn => fn()); effects.forEach(effect => effect.cleanup?.()); client.clear(); } };
}
const rows = (id = "synthetic", next = "next") => ({ items: [{ id }], hasMore: !!next, nextCursor: next || null, totalCount: null });

test("separate counts reject missing, fractional, negative, overflow and malformed results instead of false zero", () => {
  for (const value of [null, {}, { totalCount: -1 }, { totalCount: 1.1 }, { totalCount: "5" }, { totalCount: Infinity },
    { totalCount: Number.MAX_SAFE_INTEGER + 1 }, "{", { totalCount: 1, aggregates: { invoiceTotal: "private" } }]) {
    assert.throws(() => parseExactCount(value), AppError);
  }
  assert.deepEqual(parseExactCount({ totalCount: 0 }), { totalCount: 0 });
  assert.deepEqual(parseExactCount({ totalCount: 12, aggregates: { invoiceTotal: 123.45 } }), { totalCount: 12, aggregates: { invoiceTotal: 123.45 } });
});
test("count keys exclude cursor/size/sort but retain all authorization scope and filter inputs", () => {
  const params: WorkOrderPageParams = { scope: "history", search: "needle", state: "FL", tableSortColumn: "priority", tableSortDirection: "desc", cursor: "p2", limit: 25 };
  assert.deepEqual(workOrderCountFilters(params), { scope: "history", search: "needle", state: "FL" });
  assert.deepEqual(workOrderCountFilters(params), workOrderCountFilters({ ...params, cursor: "p3", limit: 50, tableSortColumn: "created", tableSortDirection: "asc" }));
  assert.deepEqual(workOrderCountFilters({ ...params, summaryFilter: "compressor", slaFilter: "overdue" }),
    { scope: "history", search: "needle", state: "FL", summaryFilter: "compressor", slaFilter: "overdue" });
  assert.notDeepEqual(workOrderCountFilters(params), workOrderCountFilters({ ...params, search: "different" }));
  assert.deepEqual(invoiceCountFilters({ cursor: "a", limit: 5, sort: "total", state: "approved" }), invoiceCountFilters({ state: "approved" }));
  for (const other of [{ ...actor, id: "other" }, { ...actor, role: "contractor" }, { ...actor, active: false },
    { ...actor, contractorAccountId: "company" }, { ...actor, staffPermissions: ["quickbooks_handoff"] }]) {
    assert.notEqual(directoryActorScope(actor), directoryActorScope(other));
    assert.notDeepEqual(workOrderCountKey(directoryActorScope(actor)), workOrderCountKey(directoryActorScope(other)));
    assert.notDeepEqual(workOrderByIdKey("same", directoryActorScope(actor)), workOrderByIdKey("same", directoryActorScope(other)));
    assert.notDeepEqual(invoiceCountKey(directoryActorScope(actor)), invoiceCountKey(directoryActorScope(other)));
  }
});

for (const domain of ["work", "invoice"] as const) {
  test(`${domain} rows render independently; three pages execute one count, not three`, async () => {
    const h = harness();
    try {
      const page = (cursor: string | null = null) => h.render(() => domain === "work"
        ? h.work.useWorkOrdersPageQuery({ scope: "active", cursor, limit: 25 })
        : h.invoices.useInvoicesPageQuery({ state: "active", cursor, limit: 25 }));
      page(); assert.equal(h.calls.filter(call => call.kind === "count").length, domain === "work" ? 0 : 1);
      h.calls.find(call => call.kind === "rows")?.resolve(rows()); await tick();
      let value = page();
      if (domain === "work") await tick();
      assert.equal(value.data?.items.length, 1); assert.equal(value.data?.totalCount, null);
      h.calls.find(call => call.kind === "count")?.resolve({ totalCount: 1001 }); await tick();
      value = page(); assert.equal(value.data?.totalCount, 1001);
      page("next"); h.calls.at(-1)?.resolve(rows("second", "third")); await tick();
      page("third"); h.calls.at(-1)?.resolve(rows("third", "")); await tick();
      value = page("third"); assert.equal(value.data?.hasMore, false);
      assert.equal(h.calls.filter(call => call.kind === "rows").length, 3);
      assert.equal(h.calls.filter(call => call.kind === "count").length, 1);
    } finally { h.close(); }
  });
}
test("hidden feature and inactive identity counts stay disabled; foreground fresh cache avoids duplicate count", async () => {
  const h = harness();
  try {
    const count = (enabled = true) => h.render(() => h.work.useWorkOrdersCountQuery({ scope: "active" }, enabled));
    count(false); assert.equal(h.calls.length, 0);
    h.context.visible = false; count(); assert.equal(h.calls.length, 0);
    h.context.visible = true; h.context.actor = { ...actor, active: false }; count(); assert.equal(h.calls.length, 0);
    h.context.actor = actor; count(); assert.equal(h.calls.length, 1);
    h.calls[0].resolve({ totalCount: 7 }); await tick();
    h.context.visible = false; count(); h.context.visible = true; count(); assert.equal(h.calls.length, 1);
  } finally { h.close(); }
});
test("count failure leaves bounded rows usable and never synthesizes zero", async () => {
  const h = harness();
  try {
    const page = () => h.render(() => h.work.useWorkOrdersPageQuery({ scope: "active" }));
    page(); h.calls.find(call => call.kind === "rows")?.resolve(rows()); await tick();
    page(); await tick();
    h.calls.find(call => call.kind === "count")?.reject(new AppError("FORBIDDEN")); await tick();
    const value = page(); assert.equal(value.isSuccess, true); assert.equal(value.data?.totalCount, null); assert.equal(value.countQuery.isError, true);
    assert.equal(h.calls.length, 2);
  } finally { h.close(); }
});
test("row-only open child lists never subscribe to an exact count", () => {
  const h = harness();
  try {
    h.render(() => h.invoices.useInvoicesPageQuery({ workOrderId: "synthetic" }, true, undefined, { countEnabled: false }));
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].kind, "rows");
  } finally { h.close(); }
});
test("account switch cancels old count/row requests; late results cannot populate the next identity", async () => {
  const h = harness();
  try {
    const page = () => h.render(() => h.work.useWorkOrdersPageQuery({ scope: "active" }));
    page(); h.calls.find(call => call.kind === "rows")?.resolve(rows("old")); await tick();
    page(); await tick();
    const previous = [...h.calls];
    assert.equal(previous.filter(call => call.kind === "count").length, 1);
    h.context.actor = { ...actor, id: "new-identity", contractorAccountId: "company-b" };
    let value = page();
    assert.ok(previous.filter(call => call.kind === "count").every(call => call.signal.aborted));
    assert.equal(value.data, undefined);
    previous.forEach(call => call.resolve(call.kind === "rows" ? rows("old") : { totalCount: 999 })); await tick();
    value = page(); assert.equal(value.data, undefined);
    h.calls.slice(previous.length).filter(call => call.kind === "rows").forEach(call => call.resolve(rows("new"))); await tick();
    page(); await tick();
    h.calls.slice(previous.length).filter(call => call.kind === "count").forEach(call => call.resolve({ totalCount: 1 })); await tick();
    value = page(); assert.equal(value.data?.items[0].id, "new"); assert.equal(value.data?.totalCount, 1);
  } finally { h.close(); }
});
test("count response after role revocation stays in old scope, never the revoked observer", async () => {
  const h = harness();
  try {
    const count = () => h.render(() => h.work.useWorkOrdersCountQuery({ scope: "all" }));
    count(); h.context.actor = { ...actor, active: false }; count();
    assert.equal(h.calls[0].signal.aborted, true);
    h.calls[0].resolve({ totalCount: 50_000 }); await tick(); assert.equal(count().data, undefined); assert.equal(h.calls.length, 1);
  } finally { h.close(); }
});

test("count invalidation is independent from continuation and unrelated domains; foreground stale count refetches once", async () => {
  const h = harness();
  try {
    const count = () => h.render(() => h.work.useWorkOrdersCountQuery({ scope: "active" }));
    count(); h.calls[0].resolve({ totalCount: 1001 }); await tick();
    const key = workOrderCountKey(directoryActorScope(actor), { scope: "active" });
    await h.client.invalidateQueries({ queryKey: invoiceCountKey(directoryActorScope(actor)) });
    assert.equal(h.calls.length, 1);
    h.context.visible = false; count();
    await h.client.invalidateQueries({ queryKey: key, refetchType: "none" });
    assert.equal(h.calls.length, 1);
    h.context.visible = true; count(); assert.equal(h.calls.length, 2);
    const flush = h.client.invalidateQueries({ queryKey: key, refetchType: "active" }, { cancelRefetch: false });
    assert.equal(h.calls.length, 2);
    h.calls[1].resolve({ totalCount: 1002 }); await flush; await tick();
    assert.equal(count().data?.totalCount, 1002);
  } finally { h.close(); }
});

test("new production row adapters use only count-independent RPCs; historical counted RPCs remain compatibility-only", () => {
  const file = ts.createSourceFile("db.ts", readFileSync("src/lib/db.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const featureOwners = new Map([
    ["loadWorkOrdersPage", ["workOrderReadRepository", "parseWorkOrderReadPage(data)"]],
    ["loadWorkOrderActivitiesPage", ["activityReadRepository", "parseActivityReadPage(data, workOrder.id)"]],
    ["loadWorkOrderVisitsPage", ["visitReadRepository", "parseVisitReadPage(data, workOrderId)"]],
    ["loadWorkOrderPhotosPage", ["photoMetadataReadRepository", "parsePhotoMetadataPage(data, workOrderId)"]],
  ]);
  const names = new Map([
    ["loadWorkOrdersPage", ["list_work_orders_table_rows_v2", "list_work_orders_rows_v1"]],
    ["loadInvoicesPage", ["list_contractor_invoices_rows_v2"]],
    ["loadWorkOrderActivitiesPage", ["list_work_order_activities_rows_v1"]],
    ["loadWorkOrderPhotosPage", ["list_work_order_photos_rows_v1"]],
    ["loadWorkOrderVisitsPage", ["list_work_order_visits_rows_v1"]],
  ]);
  for (const [name, rpcs] of names) {
    const featureOwner = featureOwners.get(name);
    if (featureOwner) {
      const [owner, validator] = featureOwner;
      const feature = name === "loadWorkOrderPhotosPage" ? "photos" : "work-orders";
      const workOrderFile = ts.createSourceFile(`${owner}.ts`,
        readFileSync(`src/features/${feature}/data/${owner}.ts`, "utf8"), ts.ScriptTarget.Latest, true);
      const methods: ts.MethodDeclaration[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isMethodDeclaration(node) && node.name.getText(workOrderFile) === name) methods.push(node);
        ts.forEachChild(node, visit);
      };
      visit(workOrderFile);
      assert.equal(methods.length, 1, `one real feature-owned ${name} implementation`);
      const body = methods[0].body?.getText(workOrderFile) || "";
      for (const rpc of rpcs) assert.ok(body.includes(`"${rpc}"`), `${name} owns ${rpc}`);
      assert.ok(!/count_work_|count_contractor|loadWorkOrdersCount|loadInvoicesCount|count:\s*["']exact/.test(body));
      assert.ok(body.includes(validator), `${name} validates the real result before mapping`);
      continue;
    }
    const fn = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(fn && ts.isFunctionDeclaration(fn) && fn.body, `${name} is an explicit row contract`);
    const body = fn.body.getText(file);
    for (const rpc of rpcs) assert.ok(body.includes(`"${rpc}"`), `${name} owns ${rpc}`);
    assert.ok(!/count_work_|count_contractor|loadWorkOrdersCount|loadInvoicesCount|count:\s*["']exact/.test(body), `${name} never requests count`);
  }
  const legacy = readFileSync("supabase/migrations/0076_cursor_pagination_and_portal_indexes.sql", "utf8");
  const child = legacy.slice(legacy.indexOf("create or replace function public.list_work_order_photos_page"),
    legacy.indexOf("create or replace function public.list_work_order_visits_page"));
  assert.ok(/'totalCount'[\s\S]*count\(\*\)/i.test(child), "historical first and continuation called the same unconditional full count");
});

test("visible navigation uses the additive optimized read while the legacy database contract remains available", () => {
  const file = ts.createSourceFile("db.ts", readFileSync("src/lib/db.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const fn = file.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === "loadPortalNavigationSummary");
  assert.ok(fn && ts.isFunctionDeclaration(fn) && fn.body);
  assert.ok(fn.body.getText(file).includes('boundedReadRpc("get_portal_navigation_summary_v2", {}, signal)'));
  assert.ok(readFileSync("supabase/migrations/0142_read_only_sla_policy_compatibility.sql", "utf8")
    .includes("create or replace function public.get_portal_navigation_summary()"));
});

test("count-only dashboard and contractor badges never fetch limit-one rows; selected-cache totals are forbidden", () => {
  for (const path of ["src/features/dashboard/Dashboard.tsx", "src/features/work-orders/MyJobs.tsx"]) {
    const source = readFileSync(path, "utf8");
    assert.ok(source.includes("useWorkOrdersCountQuery"));
    assert.ok(!/useWorkOrdersPageQuery\([^;]+limit:\s*1\s*[},]/.test(source), `${path} does not request a row just to count`);
  }
  const shell = readFileSync("src/components/PortalShell.tsx", "utf8");
  assert.ok(!/navigationSummary\?\.[\w]+\s*\?\?\s*(?:workOrders|invoices|myWOs|staffWorkRows)\.(?:filter|reduce)/.test(shell));
  assert.ok(shell.includes("const selectedWorkOrderDetailShown = selectedWorkOrderDetailVisible(page)"));
  assert.ok(shell.includes("countEnabled: selectedWorkOrderDetailShown"), "retained selected identity does not enable hidden child counts");
  const buckets = readFileSync("src/features/dashboard/DashboardWorkBuckets.tsx", "utf8");
  assert.equal((buckets.match(/countEnabled: false/g) || []).length, 7);
  assert.equal((buckets.match(/Boolean\(expanded\.[a-z0-9_]+\), undefined/g) || []).length, 7);
});

const detailFixture = () => ({ activities: [{ id: "first", type: "note" }], photos: ["first-photo"], visits: [{ id: "first-visit" }],
  latestNoteAt: null, latestContractorActivityAt: null, hasUnreadNotes: false, pendingSevenElevenActivities: [],
  pendingSevenElevenSyncCount: 0, hasPendingSevenElevenSync: false, pendingContractorActivities: [],
  pendingContractorAttentionCount: 0, hasPendingContractorAttention: false, assignmentHistory: [], detailsLoaded: true,
  activityPage: { hasMore: true, nextCursor: "activity-next", totalCount: null },
  photoPage: { hasMore: true, nextCursor: "photo-next", totalCount: null },
  visitPage: { hasMore: true, nextCursor: "visit-next", totalCount: null } });
test("detail append deduplicates and never repeats counts; safe failure preserves the continuation for explicit retry", async () => {
  const h = harness();
  try {
    const detail = () => h.render(() => h.work.useWorkOrderDetailsQuery({ id: "WOT-SYNTHETIC" }));
    detail();
    h.calls.forEach(call => call.resolve(call.kind === "details" ? detailFixture() : { totalCount: 123 })); await tick();
    let view = detail(); const first = view.loadMoreActivities(); const duplicate = view.loadMoreActivities();
    assert.equal(h.calls.filter(call => call.kind === "append-activities").length, 1);
    h.calls.at(-1)?.resolve({ items: [{ id: "first" }, { id: "second" }], hasMore: true, nextCursor: "third", totalCount: null });
    await Promise.all([first, duplicate]); view = detail();
    assert.equal(view.data?.activities.map((item: { id: string }) => item.id).join(","), "first,second");
    assert.equal(view.data?.activityPage.totalCount, 123);
    assert.equal(h.calls.filter(call => call.kind === "child-count").length, 3);
    const failed = view.loadMorePhotos(); h.calls.at(-1)?.reject(new AppError("INVALID_CURSOR")); await failed;
    view = detail(); assert.equal(view.paginationError?.code, "INVALID_CURSOR");
    assert.equal(view.data?.photoPage.nextCursor, "photo-next"); assert.equal(view.data?.photos.join(","), "first-photo");
    const retry = view.loadMorePhotos(); h.calls.at(-1)?.resolve({ items: ["next-photo"], hasMore: false, nextCursor: null, totalCount: null }); await retry;
    view = detail(); assert.equal(view.paginationError, null); assert.equal(view.data?.photoPage.hasMore, false);
  } finally { h.close(); }
});
test("old identity detail continuation is aborted and cannot append into the new account", async () => {
  const h = harness();
  try {
    const detail = () => h.render(() => h.work.useWorkOrderDetailsQuery({ id: "WOT-SYNTHETIC" }));
    detail(); h.calls.forEach(call => call.resolve(call.kind === "details" ? detailFixture() : { totalCount: 10 })); await tick();
    const pending = detail().loadMoreActivities(); const old = h.calls.at(-1);
    h.context.actor = { ...actor, id: "next-account" }; const next = detail(); assert.equal(next.data, undefined);
    assert.equal(old?.signal.aborted, true);
    old?.resolve({ items: [{ id: "old-only" }], hasMore: false, nextCursor: null, totalCount: null }); await pending;
    assert.equal(detail().data, undefined);
  } finally { h.close(); }
});

test("Realtime detail refetch during a continuation cannot skip intervening child history", async () => {
  const h = harness();
  try {
    const detail = () => h.render(() => h.work.useWorkOrderDetailsQuery({ id: "WOT-SYNTHETIC" }));
    detail(); h.calls.forEach(call => call.resolve(call.kind === "details" ? detailFixture() : { totalCount: 100 })); await tick();
    const second = detail().loadMoreActivities();
    h.calls.at(-1)?.resolve({ items: [{ id: "second" }], hasMore: true, nextCursor: "third-page", totalCount: null }); await second;
    const third = detail().loadMoreActivities(); const thirdRequest = h.calls.at(-1);
    const refetch = h.client.invalidateQueries({ queryKey: workOrderDetailsKey("WOT-SYNTHETIC", directoryActorScope(actor)), exact: true });
    assert.equal(h.calls.at(-1)?.kind, "details"); h.calls.at(-1)?.resolve(detailFixture()); await refetch;
    thirdRequest?.resolve({ items: [{ id: "third" }], hasMore: false, nextCursor: null, totalCount: null }); await third;
    assert.equal(detail().data?.activities.map(item => item.id).join(","), "first");
    assert.equal(detail().data?.activityPage.nextCursor, "activity-next");
    assert.equal(h.calls.filter(call => call.kind === "child-count").length, 3);
  } finally { h.close(); }
});

test("parts and billing visit keys isolate actors; live part reads cancel on account switch", async () => {
  const h = harness();
  try {
    const read = () => h.render(() => [h.work.useWorkOrderPartsQuery("WOT-SYNTHETIC"),
      h.work.useP1PartCostsQuery("WOT-SYNTHETIC"), h.work.useBillableP1PartsQuery("WOT-SYNTHETIC", "invoice")]);
    read(); assert.equal(h.calls.length, 3); const old = [...h.calls];
    const priorScope = directoryActorScope(actor); h.context.actor = { ...actor, contractorAccountId: "company-b" };
    const nextScope = directoryActorScope(h.context.actor); const current = read();
    assert.ok(old.every(call => call.signal.aborted)); assert.ok(current.every(query => query.data === undefined));
    for (const key of [workOrderPartsKey("wo", priorScope), p1PartCostsKey("wo", priorScope),
      billableP1PartsKey("wo", null, priorScope), billingWorkOrderVisitsKey("wo", priorScope)]) {
      assert.equal(key.at(-1), priorScope); assert.notEqual(key.at(-1), nextScope);
    }
    old.forEach(call => call.resolve([{ id: "old" }])); await tick(); assert.ok(read().every(query => query.data === undefined));
  } finally { h.close(); }
});
