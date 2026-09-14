import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

type RuntimeImport = {
  specifier: string;
  kind: "static" | "dynamic" | "require" | "re-export" | "worker";
};

type GraphHost = {
  readFile(fileName: string): string | undefined;
  resolveLocal(specifier: string, importer: string): string | undefined;
};

const nodeBuiltins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));

function forbiddenDependency(specifier: string): boolean {
  return specifier.startsWith("node:")
    || nodeBuiltins.has(specifier)
    || /^(?:@napi-rs\/canvas(?:-[^/]*)?|canvas|server-only)(?:\/|$)/.test(specifier)
    || /^next\/dist\/compiled\/server-only(?:\/|$)/.test(specifier)
    // These are the modern browser build and its separately emitted worker,
    // also re-exported/instantiated by the previous webpack.mjs entry.
    || (/^pdfjs-dist(?:\/|$)/.test(specifier) && ![
      "pdfjs-dist/webpack.mjs", "pdfjs-dist/build/pdf.mjs", "pdfjs-dist/build/pdf.worker.mjs",
    ].includes(specifier))
    || /\.node(?:[?#].*)?$/.test(specifier)
    || /(?:^|\/)invoicePdfServer(?:\.[cm]?[jt]sx?)?$/.test(specifier)
    || /(?:^|\/)server(?:\/|$)/.test(specifier)
    || /\.server(?:\.[cm]?[jt]sx?)?$/.test(specifier);
}

const platformGlobals = new Set([
  "window", "document", "navigator", "localStorage", "sessionStorage", "File",
  "FileList", "Blob", "URL", "Worker", "XMLHttpRequest", "fetch", "globalThis",
  "process", "Buffer", "__dirname", "__filename", "require",
]);

function platformGlobalUses(fileName: string, sourceText: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const uses = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && platformGlobals.has(node.text)) {
      const parent = node.parent;
      // A plain data field called "document" is not a browser-global reference.
      const propertyName = (ts.isPropertyAccessExpression(parent)
        || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
        && parent.name === node;
      if (!propertyName) uses.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...uses];
}

function runtimeImports(fileName: string, sourceText: string): RuntimeImport[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const imports: RuntimeImport[] = [];
  const add = (specifier: ts.Expression, kind: RuntimeImport["kind"]) => {
    if (ts.isStringLiteralLike(specifier)) {
      imports.push({ specifier: specifier.text, kind });
    } else {
      throw new Error(`Non-literal ${kind} in ${fileName}: boundary cannot be established`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyNamedTypes = !clause?.name
        && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0
        && bindings.elements.every(element => element.isTypeOnly);
      if (!clause?.isTypeOnly && !onlyNamedTypes) add(node.moduleSpecifier, "static");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.exportClause;
      const onlyNamedTypes = clause && ts.isNamedExports(clause)
        && clause.elements.length > 0
        && clause.elements.every(element => element.isTypeOnly);
      if (!node.isTypeOnly && !onlyNamedTypes) add(node.moduleSpecifier, "re-export");
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression) {
      add(node.moduleReference.expression, "require");
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Worker") {
      const workerUrl = node.arguments?.[0];
      if (!workerUrl || !ts.isNewExpression(workerUrl) || !ts.isIdentifier(workerUrl.expression)
        || workerUrl.expression.text !== "URL" || !workerUrl.arguments?.[0]) {
        throw new Error(`Unresolved worker URL in ${fileName}: boundary cannot be established`);
      }
      add(workerUrl.arguments[0], "worker");
    } else if (ts.isCallExpression(node) && node.arguments[0]) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node.arguments[0], "dynamic");
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add(node.arguments[0], "require");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

/**
 * Traverses application-owned runtime edges, including literal lazy imports.
 * Package internals/conditional exports and emitted worker assets are deliberately
 * left to the locked Next.js production build; this is not a replacement bundler.
 * Unresolved local edges and non-literal imports fail closed rather than being skipped.
 */
function browserGraphViolations(entry: string, host: GraphHost, pure = false): string[] {
  const visited = new Set<string>();
  const violations: string[] = [];
  const walk = (fileName: string, chain: string[]): void => {
    if (visited.has(fileName)) return;
    visited.add(fileName);
    const source = host.readFile(fileName);
    if (source === undefined) throw new Error(`Missing graph source: ${fileName}`);
    if (pure) {
      for (const global of platformGlobalUses(fileName, source)) {
        violations.push(`${chain.join(" -> ")} -> platform API: ${global}`);
      }
    }
    for (const edge of runtimeImports(fileName, source)) {
      const edgeChain = [...chain, `${edge.kind}: ${edge.specifier}`];
      const local = /^(?:\.|\/|@\/)/.test(edge.specifier);
      if (forbiddenDependency(edge.specifier) || (pure && !local)) {
        violations.push(edgeChain.join(" -> "));
      } else if (local) {
        const resolved = host.resolveLocal(edge.specifier, fileName);
        if (!resolved) throw new Error(`Unresolved local edge: ${edgeChain.join(" -> ")}`);
        if (forbiddenDependency(resolved)) {
          violations.push(edgeChain.join(" -> "));
        } else {
          walk(resolved, edgeChain);
        }
      }
    }
  };
  walk(entry, [entry]);
  return violations;
}

function fixtureHost(files: Record<string, string>): GraphHost {
  return {
    readFile: fileName => files[fileName],
    resolveLocal: (specifier, importer) => {
      const base = path.posix.resolve(path.posix.dirname(importer), specifier);
      return [base, `${base}.ts`, `${base}/index.ts`].find(candidate => candidate in files);
    },
  };
}

function repositoryHost(): GraphHost {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const compilerOptions: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    allowJs: true,
    baseUrl: root,
    paths: { "@/*": ["./src/*"] },
  };
  return {
    readFile: fileName => readFileSync(fileName, "utf8"),
    resolveLocal: (specifier, importer) => ts.resolveModuleName(
      specifier, importer, compilerOptions, ts.sys,
    ).resolvedModule?.resolvedFileName,
  };
}

test("browser PDF entry cannot transitively reach Node, native canvas, or server-only modules", () => {
  const entry = fileURLToPath(new URL("./invoicePdfParserClient.ts", import.meta.url));
  assert.deepEqual(browserGraphViolations(entry, repositoryHost()), []);
});

test("actual invoice upload component retains a browser-safe runtime graph", () => {
  const entry = fileURLToPath(new URL("../features/invoices/InvoiceCreateModal.tsx", import.meta.url));
  assert.deepEqual(browserGraphViolations(entry, repositoryHost()), []);
});

test("pure PDF types and extraction cannot reach runtime providers or platform APIs", () => {
  for (const relative of ["./pdf/invoicePdfTypes.ts", "./pdf/invoicePdfTextParser.ts"]) {
    const entry = fileURLToPath(new URL(relative, import.meta.url));
    assert.deepEqual(browserGraphViolations(entry, repositoryHost(), true), []);
  }
});

test("boundary guard follows static imports, re-exports, lazy imports, and CommonJS edges", () => {
  const files = {
    "/entry.ts": 'import "./middle"; export { value } from "./barrel";',
    "/middle.ts": 'export const load = () => import("./mixed");',
    "/barrel.ts": 'export { value } from "node:fs";',
    "/mixed.ts": 'if (typeof window === "undefined") { require("@napi-rs/canvas"); }',
  };
  const violations = browserGraphViolations("/entry.ts", fixtureHost(files));
  assert.equal(violations.length, 2);
  assert.ok(violations.some(chain => chain.includes("dynamic: ./mixed")
    && chain.endsWith("require: @napi-rs/canvas")));
  assert.ok(violations.some(chain => chain.endsWith("re-export: node:fs")));
});

test("boundary guard rejects each forbidden runtime dependency", () => {
  for (const specifier of [
    "canvas", "canvas/lib/bindings", "@napi-rs/canvas", "@napi-rs/canvas-darwin-arm64",
    "./native.node", "fs", "fs/promises", "node:fs", "path", "node:path",
    "child_process", "node:child_process", "server-only", "./pdf/invoicePdfServer",
    "next/dist/compiled/server-only", "next/dist/compiled/server-only/empty",
    "pdfjs-dist", "pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.mjs",
    "./pdf/parser.server", "./pdf/parser.server.ts", "./server/parser",
  ]) {
    const host = fixtureHost({ "/entry.ts": `import ${JSON.stringify(specifier)};` });
    assert.equal(browserGraphViolations("/entry.ts", host).length, 1, specifier);
  }
});

test("browser boundary follows separately emitted worker assets and rejects server worker substitutions", () => {
  for (const specifier of ["pdfjs-dist/build/pdf.worker.mjs", "pdfjs-dist/legacy/build/pdf.worker.mjs", "node:fs", "./server/worker"]) {
    const host = fixtureHost({ "/entry.ts": `new Worker(new URL(${JSON.stringify(specifier)}, import.meta.url), { type: "module" });` });
    assert.equal(browserGraphViolations("/entry.ts", host).length, specifier === "pdfjs-dist/build/pdf.worker.mjs" ? 0 : 1);
  }
  assert.throws(() => browserGraphViolations("/entry.ts", fixtureHost({ "/entry.ts": "new Worker(variableWorkerPath);" })), /Unresolved worker URL/);
});

test("pure graph guard catches transitive providers and browser/server API use", () => {
  for (const provider of ["react", "next", "pdfjs-dist/webpack.mjs", "@napi-rs/canvas"]) {
    const files = {
      "/entry.ts": 'export { value } from "./helper";',
      "/helper.ts": `import ${JSON.stringify(provider)}; export const value = 1;`,
    };
    assert.equal(browserGraphViolations("/entry.ts", fixtureHost(files), true).length, 1);
  }
  for (const global of platformGlobals) {
    const files = { "/entry.ts": `export const value = typeof ${global};` };
    assert.equal(browserGraphViolations("/entry.ts", fixtureHost(files), true).length, 1, global);
  }
  const safe = { "/entry.ts": 'export const value = { document: "data" }.document;' };
  assert.deepEqual(browserGraphViolations("/entry.ts", fixtureHost(safe), true), []);
});

test("boundary guard ignores type-only edges without hiding mixed value imports", () => {
  const files = {
    "/entry.ts": [
      'import type { PathLike } from "node:fs";',
      'import { type Stats } from "node:fs";',
      'export type { PathLike } from "node:fs";',
      'export { type Stats } from "node:fs";',
      'type Server = import("./pdf/invoicePdfServer").Server;',
      'import { type Value, value } from "./safe";',
      'export { type Value, value } from "./safe";',
    ].join("\n"),
    "/safe.ts": 'import "pdfjs-dist/webpack.mjs"; export const value = 1;',
  };
  assert.deepEqual(browserGraphViolations("/entry.ts", fixtureHost(files)), []);
  const unsafe = { ...files, "/safe.ts": 'import "server-only"; export const value = 1;' };
  assert.equal(browserGraphViolations("/entry.ts", fixtureHost(unsafe)).length, 1);
});

test("boundary guard handles cycles and rejects unresolved or computed local imports", () => {
  const cycle = fixtureHost({
    "/entry.ts": 'import "./other";',
    "/other.ts": 'import "./entry";',
  });
  assert.deepEqual(browserGraphViolations("/entry.ts", cycle), []);
  assert.throws(() => browserGraphViolations("/entry.ts", fixtureHost({
    "/entry.ts": 'import "./missing";',
  })), /Unresolved local edge/);
  assert.throws(() => browserGraphViolations("/entry.ts", fixtureHost({
    "/entry.ts": 'const target = "./other"; import(target);',
  })), /Non-literal dynamic/);
});
