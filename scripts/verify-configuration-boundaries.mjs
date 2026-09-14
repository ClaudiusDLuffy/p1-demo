import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve('src');
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = resolve(directory, entry.name);
  return entry.isDirectory() ? files(path) : /\.[cm]?[jt]sx?$/.test(path) && !/\.test\./.test(path) ? [path] : [];
});
function edges(source) {
  const output = [];
  const add = expression => { assert.ok(ts.isStringLiteralLike(expression), 'Computed runtime dependency requires review'); output.push(expression.text); };
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause; const names = clause?.namedBindings;
      if (!(clause?.isTypeOnly || (!clause?.name && names && ts.isNamedImports(names) && names.elements.length && names.elements.every(item => item.isTypeOnly)))) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(item => !item.isTypeOnly)) add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) add(node.moduleReference.expression);
    else if (ts.isCallExpression(node) && node.arguments[0] && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source); return output;
}
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
assert.equal(config.error, undefined);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd()).options;
const serverConfig = resolve('src/lib/config/server');
const names = /\b(?:SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|CRON_SECRET|OUTLOOK_CLIENT_SECRET|TWILIO_AUTH_TOKEN|TWILIO_API_KEY_SECRET|QUICKBOOKS_(?:SANDBOX|PRODUCTION)_CLIENT_SECRET|QUICKBOOKS_TOKEN_ENCRYPTION_KEY(?:_V\d+)?)\b/;
if (process.argv.includes('--self-test')) {
  const source = ts.createSourceFile('synthetic.ts', `import type { A } from './erased';
    import { type B } from './also-erased'; export type { C } from './erased-export';
    import './static'; export { runtime } from './reexport'; const load = () => import('./lazy');
    const common = require('./common'); import alias = require('./alias');`, ts.ScriptTarget.Latest, true);
  assert.deepEqual(edges(source), ['./static', './reexport', './lazy', './common', './alias']);
  assert.throws(() => edges(ts.createSourceFile('synthetic.ts', 'import(runtimePath)', ts.ScriptTarget.Latest, true)), /Computed runtime dependency/);
  for (const name of ['CRON_SECRET', 'SUPABASE_SECRET_KEY', 'OUTLOOK_CLIENT_SECRET', 'TWILIO_API_KEY_SECRET', 'QUICKBOOKS_PRODUCTION_CLIENT_SECRET', 'QUICKBOOKS_TOKEN_ENCRYPTION_KEY_V2']) assert.ok(names.test(name));
}
const visited = new Set(); let roots = 0;
function visit(path) {
  assert.ok(!path.startsWith(serverConfig + '/'), 'Server configuration entered a client dependency graph');
  if (visited.has(path)) return;
  visited.add(path); assert.ok(visited.size < 2500);
  const text = readFileSync(path, 'utf8'); assert.ok(!names.test(text), 'Secret configuration name entered a client dependency graph');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  for (const edge of edges(source)) {
    if (!edge.startsWith('.') && !edge.startsWith('@/')) continue;
    const target = ts.resolveModuleName(edge, path, options, ts.sys).resolvedModule?.resolvedFileName;
    assert.ok(target, 'Unresolved local configuration boundary'); visit(target);
  }
}
for (const path of files(root)) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  if (source.statements.some(node => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'use client')) { roots++; visit(path); }
}
assert.ok(roots > 0);
let artifacts = 0;
if (process.argv.includes('--build')) {
  const directory = resolve('.next/static'); assert.ok(existsSync(directory), 'Run production build before artifact verification');
  for (const path of files(directory)) {
    assert.ok(++artifacts < 10000 && statSync(path).size < 100_000_000, 'Unexpected artifact inspection bound');
    assert.ok(!names.test(readFileSync(path, 'utf8')), 'Secret configuration name entered a static browser artifact');
  }
}
console.info(JSON.stringify({ clientRoots: roots, sourceFiles: visited.size, browserArtifacts: artifacts, result: 'passed' }));
