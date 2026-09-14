import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { AppError } from "../errors/AppError";
import { NAVIGATION_METRICS, parseNavigationSummaryV2 } from "./navigationSummary";
import { portalNavigationSummaryKey } from "./queryKeys";

for (const scope of ["staff", "contractor"] as const) {
  test(`${scope} navigation returns only its exact visible metrics`, () => {
    const metrics = Object.fromEntries(NAVIGATION_METRICS[scope].map((key, index) => [key, index]));
    assert.deepEqual(parseNavigationSummaryV2({ scope, metrics }), { scope, metrics });
  });
}

test("unused operational navigation metrics remain absent for contractors", () => {
  const result = parseNavigationSummaryV2({ scope: "contractor", metrics: {
    contractorActiveCount: 7, historyCount: 3, contractorAttentionCount: 2, contractorInvoiceCount: 4,
  } });
  assert.equal(result.metrics.slaBreachedCount, undefined);
  assert.equal(Object.hasOwn(result.metrics, "staffWorkCount"), false);
});

test("report-only navigation can omit the unrendered invoice badge without claiming zero", () => {
  const parsed = parseNavigationSummaryV2({ scope: "contractor", metrics: {
    contractorActiveCount: 7, historyCount: 3, contractorAttentionCount: 2,
  } });
  assert.equal(Object.hasOwn(parsed.metrics, "contractorInvoiceCount"), false);
});

test("navigation keys isolate the new contract and the current actor scope", () => {
  const key = portalNavigationSummaryKey("synthetic-actor-company-A");
  assert.deepEqual(key, ["portal-navigation-summary", "synthetic-actor-company-A", "v2"]);
  assert.notDeepEqual(key, ["portal-navigation-summary", "synthetic-actor-company-A"]);
  assert.notDeepEqual(key, portalNavigationSummaryKey("synthetic-actor-company-B"));
});

test("malformed, extra, missing and imprecise navigation metrics fail safely", () => {
  const valid = { contractorActiveCount: 7, historyCount: 3, contractorAttentionCount: 2, contractorInvoiceCount: 4 };
  for (const value of [null, [], {}, { scope: "unknown", metrics: valid },
    { scope: "contractor", metrics: {} }, { scope: "contractor", metrics: { ...valid, hiddenCount: 1 } },
    ...[-1, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1, "7", null].map(metric => ({
      scope: "contractor", metrics: { ...valid, contractorActiveCount: metric },
    })), { scope: "contractor", metrics: valid, sensitive: "discard" }]) {
    assert.throws(() => parseNavigationSummaryV2(value), error => error instanceof AppError && error.code === "INTERNAL_ERROR");
  }
});

test("current navigation and table clients opt into additive v2 without broad fallback", () => {
  const db = readFileSync(new URL("../db.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("db.ts", db, ts.ScriptTarget.Latest, true);
  const owner = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "loadPortalNavigationSummary");
  assert.ok(owner && ts.isFunctionDeclaration(owner) && owner.body);
  const navigation = owner.body.getText(parsed);
  assert.match(navigation, /boundedReadRpc\("get_portal_navigation_summary_v2", \{\}, signal\)/);
  assert.match(navigation, /parseNavigationSummaryV2/);
  assert.doesNotMatch(navigation, /catch\s*\(|get_portal_navigation_summary_v1|from\("work_orders"\)/);
  const workOrderReads = readFileSync(new URL("../../features/work-orders/data/workOrderReadRepository.ts", import.meta.url), "utf8");
  assert.match(workOrderReads, /tableMode \? "list_work_orders_table_rows_v2"/);
  assert.match(db, /tableMode \? "count_work_orders_table_v2"/);
});
