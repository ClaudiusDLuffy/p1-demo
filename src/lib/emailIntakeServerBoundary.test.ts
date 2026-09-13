import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

function runtimeEdges(source: ts.SourceFile): string[] {
  const edges: string[] = [];
  const add = (node: ts.Expression) => {
    assert.ok(ts.isStringLiteralLike(node), "Computed module edge requires explicit boundary review");
    edges.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typesOnly = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly));
      if (!typesOnly) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause)
        || node.exportClause.elements.some(item => !item.isTypeOnly)) add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments[0]
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

test("all application client roots exclude the processor, trusted log writer and service credentials", () => {
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.[jt]sx?$/.test(path) && !path.endsWith(".test.ts") ? [path] : [];
  });
  const roots = files(resolve("src")).filter(file => {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    return source.statements.some(node => ts.isExpressionStatement(node)
      && ts.isStringLiteral(node.expression) && node.expression.text === "use client");
  });
  assert.ok(roots.length > 0);
  const visited = new Set<string>();
  const forbidden = new Set(["src/lib/emailIntakeProcessor.ts", "src/lib/server/emailIntakeLog.ts", "src/lib/supabase/server.ts"].map(file => resolve(file)));
  const config = ts.readConfigFile(resolve("tsconfig.json"), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd()).options;
  const walk = (file: string, chain: string[]): void => {
    assert.equal(forbidden.has(file), false, chain.join(" -> "));
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const edge of runtimeEdges(source)) {
      assert.notEqual(edge, "server-only", chain.join(" -> "));
      if (!edge.startsWith(".") && !edge.startsWith("@/")) continue;
      const target = ts.resolveModuleName(edge, file, options, ts.sys).resolvedModule?.resolvedFileName;
      assert.ok(target, `Unresolved local edge: ${chain.join(" -> ")} -> ${edge}`);
      walk(target, [...chain, edge]);
    }
  };
  for (const root of roots) walk(root, [root]);
  // This covers local static/literal-lazy/CommonJS/re-export edges. Package
  // internals and emitted artifacts remain the locked production build's gate.
});

test("intake boundary edge inventory follows lazy imports and ignores erased type imports", () => {
  const source = ts.createSourceFile("fixture.ts", `
    import type { Server } from './server';
    import { type Only } from './types';
    export type { Hidden } from './hidden';
    export { value } from './barrel';
    import './side-effect';
    const lazy = () => import('./server/emailIntakeLog');
    const required = require('./supabase/server');
  `, ts.ScriptTarget.Latest, true);
  assert.deepEqual(runtimeEdges(source), ["./barrel", "./side-effect", "./server/emailIntakeLog", "./supabase/server"]);
  assert.throws(() => runtimeEdges(ts.createSourceFile("computed.ts", "import(target)", ts.ScriptTarget.Latest, true)), /Computed/);
});

test("processor and trusted adapter carry Next's compile-time server-only marker", () => {
  for (const file of ["src/lib/emailIntakeProcessor.ts", "src/lib/server/emailIntakeLog.ts"]) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    assert.ok(runtimeEdges(source).includes("server-only"));
  }
});
