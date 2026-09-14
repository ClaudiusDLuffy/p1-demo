import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])
  .filter(path => /\.[cm]?[jt]sx?$/.test(path) && !/\.test\.[cm]?[jt]sx?$/.test(path));
const parse = (path: string) => ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
const visit = (node: ts.Node, inspect: (node: ts.Node) => void): void => {
  inspect(node); ts.forEachChild(node, child => visit(child, inspect));
};
const retired = new Set(["loadAllProfiles", "loadProfiles", "loadStaffPermissionGrants", "loadTechnicians",
  "loadContractorTechnicians", "useProfilesQuery", "useTechniciansQuery"]);

test("all production imports, aliases, reexports and namespace accesses exclude retired directory loaders", () => {
  for (const path of files("src")) visit(parse(path), node => {
    if (!ts.isIdentifier(node)) return;
    assert.ok(!retired.has(node.text), `${path}: retired directory symbol ${node.text}`);
    assert.ok(!/^(?:load|get|fetch|use)All(?:Profiles|Users|Technicians|StaffGrants)(?:Query)?$/i.test(node.text),
      `${path}: new all-record directory symbol`);
  });
});

test("live browser profile/grant table reads remain exact self reads, not renamed broad collectors", () => {
  const paths = [...files("src/features"), ...files("src/components"), "src/lib/db.ts"];
  let exactQueries = 0;
  for (const path of paths) visit(parse(path), node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
      || node.expression.name.text !== "from" || !ts.isStringLiteral(node.arguments[0])) return;
    const table = node.arguments[0].text;
    if (!["profiles", "staff_permission_grants", "contractor_technicians"].includes(table)) return;
    let chain: ts.Node = node;
    while (chain.parent && (ts.isPropertyAccessExpression(chain.parent)
      || ts.isCallExpression(chain.parent) || ts.isAwaitExpression(chain.parent))) chain = chain.parent;
    let exact = false;
    visit(chain, child => {
      if (!ts.isCallExpression(child) || !ts.isPropertyAccessExpression(child.expression)
        || child.expression.name.text !== "eq" || !ts.isStringLiteral(child.arguments[0])) return;
      exact ||= child.arguments[0].text === (table === "staff_permission_grants" ? "profile_id" : "id");
    });
    assert.ok(exact, `${path}: ${table} browser collection must use a bounded directory RPC`);
    exactQueries++;
  });
  assert.equal(exactQueries, 4, "Only both established current-self/profile-permission reads remain");
});

test("new directory request modules cannot collect all pages or reach server/provider implementations", () => {
  for (const path of files("src/features/directory")) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /\b(?:while|do)\s*[({]|fetchNextPage|collectSupabasePages|\.select\s*\(/);
    visit(parse(path), node => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
      assert.doesNotMatch(node.moduleSpecifier.text, /server-only|\/server(?:\/|$)|graphClient|node:|invoicePdfServer|@napi-rs/);
    });
  }
});
