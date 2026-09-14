import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
const parse = name => ts.createSourceFile(name, readFileSync(name, "utf8"), ts.ScriptTarget.Latest, true, name.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
function edges(file) {
  const output = [];
  const visit = node => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const bindings = node.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.some(binding => !binding.isTypeOnly)) output.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(binding => !binding.isTypeOnly)) output.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === "require") && ts.isStringLiteralLike(node.arguments[0])) output.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(file); return output;
}
const expected = new Map([
  ["src/app/api/billing-invoices/route.ts", "../../../server/billing-invoices/applicationService"],
  ["src/app/api/controller-exports/route.ts", "../../../server/controller-exports/httpBoundary"],
  ["src/server/controller-exports/httpBoundary.ts", "./applicationService"],
]);
for (const [name, facade] of expected) {
  const imports = edges(parse(name));
  if (!imports.includes(facade)) throw new Error(`${name}: missing real typed facade ${facade}`);
  if (imports.some(edge => /legacyRouteImplementation|billingMutationUseCases/.test(edge))) throw new Error(`${name}: legacy owner remains`);
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? files(name) : /\.[jt]sx?$/.test(name) ? [name] : [];
  });
}
const roots = files("src").filter(name => /["']use client["']/.test(readFileSync(name, "utf8").slice(0, 200)));
const visited = new Set();
function inspect(name) {
  if (visited.has(name)) return;
  visited.add(name);
  if (name.startsWith("src/server/")) throw new Error(`Server owner in client graph: ${name}`);
  for (const edge of edges(parse(name))) {
    if (/^(?:server-only|node:fs|fs|@napi-rs\/canvas|canvas)$/.test(edge)) throw new Error(`Server dependency in client graph: ${name} -> ${edge}`);
    if (!edge.startsWith(".") && !edge.startsWith("@/")) continue;
    const stem = path.normalize(edge.startsWith("@/") ? path.join("src", edge.slice(2)) : path.join(path.dirname(name), edge));
    const target = [stem, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
    if (target) inspect(target);
  }
}
roots.forEach(inspect);
console.log(JSON.stringify({ passed: true, clientRoots: roots.length, clientModules: visited.size, typedFacadeEdges: expected.size }));
