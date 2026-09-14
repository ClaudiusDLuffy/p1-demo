import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const read = (path: string) => readFileSync(resolve(path), "utf8");
const source = (path: string, contents = read(path)) =>
  ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true);

function runtimeEdges(file: ts.SourceFile): string[] {
  const edges: string[] = [];
  const add = (node: ts.Expression) => {
    assert.ok(ts.isStringLiteralLike(node), "Computed module edges need an explicit security review");
    edges.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const names = clause?.namedBindings;
      const erased = clause?.isTypeOnly || (!clause?.name && names && ts.isNamedImports(names)
        && names.elements.length > 0 && names.elements.every(item => item.isTypeOnly));
      if (!erased) add(node.moduleSpecifier);
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
  visit(file);
  return edges;
}

test("every application client graph excludes financial delivery, provider, credentials and templates", () => {
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.[jt]sx?$/.test(path) && !/\.test\.[jt]sx?$/.test(path) ? [path] : [];
  });
  const roots = files(resolve("src")).filter(path => source(path).statements.some(node =>
    ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === "use client"));
  assert.ok(roots.length > 0);
  const forbidden = new Set([
    "src/lib/server/financialNotificationWorker.ts", "src/lib/server/financialNotificationProvider.ts",
    "src/lib/server/financialNotificationHttp.ts", "src/lib/server/receivingDispatchWorker.ts",
    "src/lib/supabase/server.ts", "src/lib/graphClient.ts", "src/lib/notificationService.ts",
  ].map(path => resolve(path)));
  const config = ts.readConfigFile(resolve("tsconfig.json"), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd()).options;
  const visited = new Set<string>();
  const walk = (path: string, chain: string[]): void => {
    assert.equal(forbidden.has(path), false, chain.join(" -> "));
    if (visited.has(path)) return;
    assert.ok(visited.size < 2_000 && chain.length <= 100, "Client graph exceeded its review budget");
    visited.add(path);
    for (const edge of runtimeEdges(source(path))) {
      assert.notEqual(edge, "server-only", chain.join(" -> "));
      if (!edge.startsWith(".") && !edge.startsWith("@/")) continue;
      const target = ts.resolveModuleName(edge, path, options, ts.sys).resolvedModule?.resolvedFileName;
      assert.ok(target, `Unresolved local import: ${chain.join(" -> ")} -> ${edge}`);
      walk(target, [...chain, edge]);
    }
  };
  roots.forEach(root => walk(root, [root]));
  // Package internals/emitted assets remain production-build verification,
  // rather than being claimed as covered by this local TypeScript traversal.
});

test("the financial boundary follows static, lazy, CommonJS and re-export edges but erases types", () => {
  assert.deepEqual(runtimeEdges(source("synthetic.ts", `
    import type { Hidden } from './server/financialNotificationWorker';
    import { type HiddenAlso } from './server/financialNotificationHttp';
    export type { Provider } from './server/financialNotificationProvider';
    export { type Credentials } from './supabase/server';
    import './side-effect';
    export { send } from './provider-barrel';
    export * from './runtime-barrel';
    const later = () => import('./server/financialNotificationWorker');
    const common = require('./graphClient');
  `)), ["./side-effect", "./provider-barrel", "./runtime-barrel", "./server/financialNotificationWorker", "./graphClient"]);
  assert.throws(() => runtimeEdges(source("computed.ts", "import(target)")), /Computed module edges/);
});

test("financial compatibility and hold routes have no provider or arbitrary-recipient send path", () => {
  const review = read("src/app/api/notifications/invoice-review/route.ts");
  const hold = read("src/app/api/contractor-invoice-holds/route.ts");
  for (const route of [review, hold]) {
    assert.doesNotMatch(route, /sendInvoiceReviewNotification|sendInvoicePaymentHoldNotification|sendEmail|getAccessToken|graphClient/);
  }
  assert.match(review, /get_financial_notification_review_compatibility_v1/);
  assert.match(hold, /set_contractor_invoice_payment_hold_with_notification_v1/);
  const worker = read("src/lib/server/financialNotificationWorker.ts");
  assert.match(worker, /claim_financial_notification_deliveries_v1/);
  assert.match(worker, /prepare_financial_notification_send_v1/);
  assert.match(worker, /complete_financial_notification_delivery_v1/);
  assert.match(worker, /createInvoiceReviewNotificationPlan/);
  assert.match(worker, /createInvoicePaymentHoldNotificationPlan/);
  // Pre-fix runtime behavior is retained in financialNotificationBaseline.test
  // and frozen synthetic routes, not in requirements for the new live route.
});

test("the existing receiving worker and schedule remain a distinct notification owner", () => {
  const receiving = runtimeEdges(source("src/lib/server/receivingDispatchWorker.ts"));
  assert.ok(receiving.every(edge => !edge.includes("financialNotification")));
  const config: unknown = JSON.parse(read("vercel.json"));
  assert.ok(config && typeof config === "object" && "crons" in config && Array.isArray(config.crons));
  const paths = config.crons.map((entry: unknown) => {
    assert.ok(entry && typeof entry === "object" && "path" in entry && typeof entry.path === "string");
    return entry.path;
  });
  assert.equal(paths.filter(path => path === "/api/notifications/dispatch/drain").length, 1);
  assert.equal(paths.filter(path => path === "/api/notifications/financial/drain").length, 1);
});
