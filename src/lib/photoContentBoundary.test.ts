import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
const forbidden = (name: string) => name.startsWith("node:") || builtins.has(name)
  || /^(?:sharp|server-only|canvas|@napi-rs\/canvas(?:-[^/]+)?)(?:\/|$)/.test(name)
  || /(?:^|\/)server\/|\.node$|photoImageInspectionWorker/.test(name);

/** Application-owned runtime edges only. Package internals are certified by
 * the locked webpack build and packaged execution, not by this AST guard. */
function browserGraph(entry: string, read: (file: string) => string,
  resolve: (name: string, importer: string) => string | undefined): number {
  const visited = new Set<string>();
  const walk = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    assert.ok(!forbidden(file), "Browser entry reached server implementation");
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const edge = (expression: ts.Expression) => {
      assert.ok(ts.isStringLiteralLike(expression), "Computed runtime import cannot establish a safe boundary");
      if (!ts.isStringLiteralLike(expression)) return;
      const name = expression.text;
      assert.ok(!forbidden(name), `Forbidden browser runtime dependency: ${name}`);
      if (/^(?:\.|\/|@\/)/.test(name)) {
        const target = resolve(name, file);
        assert.ok(target, `Unresolved browser graph dependency: ${name}`);
        walk(target);
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isTypeNode(node)) return;
      if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
        assert.ok(!["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"].includes(node.text), "Browser graph reached a service credential reference");
      }
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        const typesOnly = !clause?.name && named && ts.isNamedImports(named)
          && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly);
        if (!clause?.isTypeOnly && !typesOnly) edge(node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const clause = node.exportClause;
        const typesOnly = clause && ts.isNamedExports(clause) && clause.elements.length > 0
          && clause.elements.every(element => element.isTypeOnly);
        if (!node.isTypeOnly && !typesOnly) edge(node.moduleSpecifier);
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly
        && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) {
        edge(node.moduleReference.expression);
      } else if (ts.isCallExpression(node) && node.arguments[0]
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || ts.isIdentifier(node.expression) && node.expression.text === "require")) edge(node.arguments[0]);
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  walk(entry);
  return visited.size;
}

test("actual photo gallery and upload browser graph cannot reach Sharp, Node, worker or service credentials", () => {
  const options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext, allowJs: true, baseUrl: process.cwd(), paths: { "@/*": ["./src/*"] } };
  const resolve = (name: string, importer: string) => ts.resolveModuleName(name, importer, options, ts.sys).resolvedModule?.resolvedFileName;
  for (const entry of ["src/lib/photoContentPolicy.ts", "src/lib/privateObjectClient.ts", "src/features/photos/PhotoGallery.tsx"]) {
    assert.ok(browserGraph(path.resolve(entry), file => readFileSync(file, "utf8"), resolve) > 0);
  }
});

test("photo boundary follows lazy imports and re-exports without following type-only server edges", () => {
  for (const dependency of ["sharp", "server-only", "node:fs", "child_process", "@napi-rs/canvas", "@napi-rs/canvas-darwin-arm64", "./native.node", "./server/decoder"]) {
    const files: Record<string, string> = {
      "/entry.ts": 'export { inspect } from "./middle";',
      "/middle.ts": `export const inspect = () => import(${JSON.stringify(dependency)});`,
    };
    const resolve = (name: string, importer: string) => `${path.posix.resolve(path.posix.dirname(importer), name)}.ts`;
    assert.throws(() => browserGraph("/entry.ts", file => files[file], resolve), /Forbidden browser runtime dependency/);
  }
  assert.equal(browserGraph("/entry.ts", () => 'import type { Image } from "./server/decoder"; export const safe = 1;', () => undefined), 1);
  assert.throws(() => browserGraph("/entry.ts", () => 'import sharp = require("sharp");', () => undefined), /Forbidden browser runtime dependency/);
  assert.throws(() => browserGraph("/entry.ts", () => "export const load = name => import(name);", () => undefined), /Computed runtime import/);
});
