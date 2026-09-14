import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

test("quote source choices exclude compact linked headers and retain legacy linked-ID exclusion", () => {
  const file = "src/features/work-orders/QuoteCalculatorWorkspace.tsx";
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "availableSources"
      && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback && ts.isArrowFunction(callback), "Run the production memoized filter, not a duplicate policy");
  const candidates = [
    { id: "available", wot: "SYNTHETIC-A", state: "approved" },
    { id: "compact-linked", wot: "SYNTHETIC-A", state: "approved", sourceStaffInvoiceId: "SYNTHETIC-STAFF" },
    { id: "legacy-linked", wot: "SYNTHETIC-A", state: "approved" },
    { id: "draft", wot: "SYNTHETIC-A", state: "draft" },
    { id: "rejected", wot: "SYNTHETIC-A", state: "rejected" },
    { id: "other-parent", wot: "SYNTHETIC-B", state: "approved" },
    { id: "null-link", wot: "SYNTHETIC-A", state: "approved", sourceStaffInvoiceId: null },
  ];
  const expression = ts.transpileModule(`(${callback.getText(source)})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const result: unknown = runInNewContext(expression, {
    contractorInvoices: candidates, workOrder: { id: "SYNTHETIC-A" }, linkedSourceIds: new Set(["legacy-linked"]),
  }, { timeout: 1000 });
  assert.ok(Array.isArray(result));
  const rows: unknown[] = result;
  assert.deepEqual(rows.map(row => {
    assert.ok(row && typeof row === "object" && "id" in row);
    return row.id;
  }), ["available", "null-link"]);
  assert.equal(candidates.length, 7, "Eligibility filtering never mutates a financial document");
});
