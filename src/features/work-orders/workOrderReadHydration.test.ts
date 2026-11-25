import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Execute the actual two hydration effects, with React-style dependency checks.
// This exercises both arrival orders without loading persistence/provider code.
const text = readFileSync("src/features/work-orders/useWorkOrders.ts", "utf8");
const source = ts.createSourceFile("useWorkOrders.ts", text, ts.ScriptTarget.Latest, true);
const expressions: string[] = [];
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect") {
    const expression = node.getText(source);
    if (expression.includes("if (!workOrdersData) return")
      || expression.includes("if (!selectedWorkOrderId || !selectedWorkOrderDetails) return")) expressions.push(expression);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(expressions.length, 2);
const hydrate = new Function("workOrdersData", "selectedWorkOrderId", "selectedWorkOrderDetails", "setWorkOrders", "useEffect",
  ts.transpileModule(expressions.join(";"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);

test("authorized child data survives every base/children response order and a later base refresh", () => {
  for (const childFirst of [false, true]) {
    let rows: Record<string, unknown>[] = [];
    const previous: unknown[][] = [];
    const render = (base: unknown[], details: unknown, id = "SYNTHETIC-A") => {
      let index = 0;
      hydrate(base, id, details, (next: (rows: Record<string,unknown>[]) => Record<string,unknown>[]) => { rows = next(rows); },
        (effect: () => void, deps: unknown[]) => {
          const before = previous[index];
          if (!before || deps.some((value, i) => !Object.is(value, before[i]))) effect();
          previous[index++] = deps;
        });
    };
    const base = [{ id: "SYNTHETIC-A", detailsLoaded: false, summary: "original" }];
    const children = { activities: [{ id: "authorized-note" }], photos: ["synthetic/photo.png"], detailsLoaded: true };
    if (childFirst) { render([], children); render(base, children); }
    else { render(base, null); render(base, children); }
    assert.deepEqual(rows[0].activities, children.activities);
    assert.deepEqual(rows[0].photos, children.photos);
    render([{ ...base[0], summary: "refreshed" }], children);
    assert.equal(rows[0].summary, "refreshed");
    assert.deepEqual(rows[0].photos, children.photos);
    render([{ id: "SYNTHETIC-B", detailsLoaded: false }], null, "SYNTHETIC-B");
    assert.equal(rows[0].id, "SYNTHETIC-B");
    assert.equal(rows[0].activities, undefined, "Never hydrate a different call with the previous call's children");
  }
});
