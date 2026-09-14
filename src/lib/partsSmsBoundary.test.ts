import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const read = (path: string) => readFileSync(resolve(path), "utf8");
function runtimeEdges(text: string): string[] {
  const result: string[] = [];
  const add = (node: ts.Expression) => { assert.ok(ts.isStringLiteralLike(node), "Dynamic local module edge requires review"); result.push(node.text); };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause; const names = clause?.namedBindings;
      const erased = clause?.isTypeOnly || (!clause?.name && names && ts.isNamedImports(names) && names.elements.length > 0 && names.elements.every(item => item.isTypeOnly));
      if (!erased) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(item => !item.isTypeOnly)) add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.arguments[0]
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) add(node.arguments[0]);
    else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) add(node.moduleReference.expression);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("boundary.ts", text, ts.ScriptTarget.Latest, true));
  return result;
}

test("every live client graph excludes Twilio credentials, provider lookup and service-owned delivery", () => {
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.[jt]sx?$/.test(path) && !/\.test\./.test(path) ? [path] : [];
  });
  const roots = files(resolve("src")).filter(path => ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true).statements.some(node =>
    ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === "use client"));
  const forbidden = new Set(["src/lib/server/twilioPartsSms.ts", "src/lib/server/partsSmsWorker.ts", "src/lib/supabase/server.ts"].map(path => resolve(path)));
  const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd()).options;
  const visited = new Set<string>();
  const visit = (path: string, chain: string[]): void => {
    assert.ok(!forbidden.has(path), chain.join(" -> "));
    if (visited.has(path)) return;
    visited.add(path); assert.ok(visited.size < 2000 && chain.length < 100);
    const text = read(path);
    assert.doesNotMatch(text, /TWILIO_AUTH_TOKEN|TWILIO_API_KEY_SECRET|TWILIO_ACCOUNT_SID/, path);
    for (const edge of runtimeEdges(text)) {
      if (!edge.startsWith(".") && !edge.startsWith("@/")) continue;
      const target = ts.resolveModuleName(edge, path, options, ts.sys).resolvedModule?.resolvedFileName;
      assert.ok(target, `Unresolved local edge ${edge}`); visit(target, [...chain, edge]);
    }
  };
  assert.ok(roots.length > 0); roots.forEach(root => visit(root, [root]));
});

test("parts boundary follows lazy/reexport/CommonJS edges but ignores erased types", () => {
  assert.deepEqual(runtimeEdges(`import type { Provider } from './server/twilioPartsSms';
    export type { Worker } from './server/partsSmsWorker'; export { type Only } from './only';
    import './side'; export * from './barrel'; const a = import('./lazy'); const b = require('./common');`), ["./side", "./barrel", "./lazy", "./common"]);
  assert.throws(() => runtimeEdges("import(arbitrary)"), /requires review/);
});

test("parts route retires raw old claim/completion and provider calls; email workers remain isolated", () => {
  const route = read("src/app/api/notifications/parts-order/route.ts");
  assert.doesNotMatch(route, /claim_p1_parts_alert_delivery|complete_p1_parts_alert_delivery|messages\.json|sendSms|TWILIO_AUTH|\.rpc\(/i);
  // The safe route code may mention TWILIO_NOT_CONFIGURED, not credentials.
  assert.match(route, /drainPartsSms/);
  for (const path of ["src/lib/server/receivingDispatchWorker.ts", "src/lib/server/financialNotificationWorker.ts"]) {
    assert.ok(runtimeEdges(read(path)).every(edge => !/partsSms|twilio/i.test(edge)));
  }
  const worker = read("src/lib/server/partsSmsWorker.ts");
  assert.doesNotMatch(worker, /graphClient|financialNotificationWorker|receivingDispatchWorker/);
  assert.match(worker, /prepare_parts_sms_send_v1/);
  assert.match(worker, /complete_parts_sms_status_v1/);
  assert.match(worker, /start_parts_sms_run_v1/);
  assert.match(worker, /finish_parts_sms_run_v1/);
});
