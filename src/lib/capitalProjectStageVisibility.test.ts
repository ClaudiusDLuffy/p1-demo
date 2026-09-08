import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { isValidElement, type ReactElement } from "react";
import ts from "typescript";
import { Badge } from "../components/ui/Badge";
import { CapitalWorkOrderBadge } from "../components/ui/CapitalWorkOrderBadge";
import { T } from "./constants";

type Element = ReactElement<Record<string, unknown>>;
type CapitalRow = {
  id: string;
  status: string;
  isCapital: boolean;
  capitalStatus: string | null;
};

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(value)) return [];
  return [value, ...elements(value.props.children)];
}

// Execute the real Capital view with synthetic query data. This tests its
// rendering decisions and card navigation, not browser or database access.
function renderCapital(row: Partial<CapitalRow> = {}, visible = true) {
  const filename = resolve("src/features/work-orders/CapitalProjects.tsx");
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const requireHere = createRequire(import.meta.url);
  const queries: { args: unknown; enabled: boolean }[] = [];
  const navigation: unknown[] = [];
  const fixture: CapitalRow = {
    id: "WOT-SYNTHETIC", status: "capital", isCapital: true,
    capitalStatus: null, ...row,
  };
  const exports: { default?: (props: Record<string, unknown>) => unknown } = {};
  runInNewContext(compiled, { exports, require: (name: string) => {
    if (name === "react") return {
      useEffect: () => undefined,
      useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => undefined],
    };
    if (name === "./queries") return {
      useWorkOrdersPageQuery: (args: unknown, enabled: boolean) => {
        queries.push({ args, enabled });
        return { data: { items: [fixture], totalCount: 1, hasMore: false }, isFetching: false };
      },
    };
    return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
  } }, { filename });
  assert.ok(exports.default);
  const tree = exports.default({
    page: visible ? "capital" : "work_orders", isManager: true, capitalCount: 1,
    getUser: () => null,
    setSelectedWO: (id: string) => navigation.push(["selected", id]),
    setPage: (page: string) => navigation.push(["page", page]),
    setAiNote: (note: null) => navigation.push(["note", note]),
  });
  const rendered = elements(tree);
  const badges = rendered.filter(element => element.type === Badge).map(element => {
    const conf = element.props.conf;
    assert.ok(conf && typeof conf === "object" && "label" in conf);
    return conf;
  });
  return { rendered, badges, navigation, queries };
}

test("newly flagged capital work has a visible quote-preparation stage without inventing approval", () => {
  const result = renderCapital();
  assert.deepEqual(result.badges.map(badge => badge.label), ["Quote preparation"]);
  assert.ok(result.rendered.some(element => element.type === CapitalWorkOrderBadge));
  assert.equal(result.badges.some(badge => badge.label === "Pending approval"), false);
});

test("all persisted capital stages keep their original labels and existing violet palette", () => {
  for (const capitalStatus of [
    "Pending approval", "Approved - work authorized", "Equipment ordered",
    "Equipment received", "Installation scheduled", "Installed",
  ]) {
    const result = renderCapital({ capitalStatus });
    assert.deepEqual(result.badges.map(badge => badge.label), [capitalStatus]);
    const conf = result.badges[0];
    assert.ok("color" in conf && "bg" in conf);
    assert.equal(conf.color, T.violet);
    assert.equal(conf.bg, T.violetSoft);
  }
});

test("pending capital completion keeps its exact warning tag once without a quote-preparation fallback", () => {
  const result = renderCapital({ status: "pending_capital_completion" });
  assert.deepEqual(result.badges.map(badge => badge.label), ["Pending capital completion"]);
  const conf = result.badges[0];
  assert.ok("color" in conf);
  assert.equal(conf.color, T.danger);
  assert.deepEqual(renderCapital({
    status: "pending_capital_completion", capitalStatus: "Equipment ordered",
  }).badges.map(badge => badge.label), ["Equipment ordered", "Pending capital completion"]);
});

test("capital labels do not relabel unrelated workflow states as quote preparation", () => {
  for (const status of ["assigned", "wip", "parts", "pending_invoice", "closed"]) {
    assert.deepEqual(renderCapital({ status }).badges, []);
  }
});

test("capital card navigation and paginated query arguments remain unchanged", () => {
  const result = renderCapital();
  const card = result.rendered.find(element => element.props.className === "card card-hover mobile-card");
  assert.ok(card && typeof card.props.onClick === "function");
  card.props.onClick();
  assert.deepEqual(result.navigation, [["selected", "WOT-SYNTHETIC"], ["page", "work_orders"], ["note", null]]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.queries)), [{ args: {
    scope: "capital", sort: "newest", tableSortColumn: "created",
    tableSortDirection: "desc", limit: 24, cursor: null,
  }, enabled: true }]);
  const hidden = renderCapital({}, false);
  assert.deepEqual(hidden.badges, []);
  assert.equal(hidden.queries[0].enabled, false);
});
