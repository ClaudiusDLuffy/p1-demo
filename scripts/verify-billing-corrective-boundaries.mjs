import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const root = new URL("..", import.meta.url);
const source = path => readFileSync(new URL(path, root), "utf8");
const parse = (value, name = "guard.ts") => ts.createSourceFile(name, value, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function nodes(tree, predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(tree);
  return found;
}
const calls = (tree, name) => nodes(tree, node => ts.isCallExpression(node)
  && ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name)
    || (ts.isIdentifier(node.expression) && node.expression.text === name)));
const fail = (condition, message) => { if (condition) throw new Error(message); };
const printed = tree => ts.createPrinter({ removeComments: true }).printFile(tree);

function noLateCommandAbort(tree, label) {
  for (const block of nodes(tree, ts.isBlock)) {
    let dispatched = false;
    for (const statement of block.statements) {
      fail(dispatched && calls(statement, "throwIfAborted").length > 0,
        `${label}: a post-dispatch abort check can erase a confirmed command receipt`);
      if (nodes(statement, ts.isAwaitExpression).length > 0) dispatched = true;
    }
  }
}
function noRawReceiptCast(tree, label) {
  for (const cast of nodes(tree, ts.isAsExpression)) {
    fail(/\b(?:data|raw|result|row|receipt)\b/.test(cast.expression.getText(tree))
      && !/^const$/.test(cast.type.getText(tree)), `${label}: unchecked raw-result assertion`);
  }
}
function noOperationReplacement(tree, label) {
  fail(calls(tree, "randomUUID").length > 0 || calls(tree, "random").length > 0 || calls(tree, "uuid").length > 0,
    `${label}: reconciliation must not generate operation identities`);
  for (const property of nodes(tree, ts.isPropertyAssignment)) {
    fail(/^(?:p_operation_id|operationId)$/.test(property.name.getText(tree))
      && /requestId|correlationId/.test(property.initializer.getText(tree)), `${label}: correlation is not operation identity`);
  }
}
function noBroadRead(tree, label) {
  fail(calls(tree, "select").some(call => call.arguments.some(arg => ts.isStringLiteral(arg) && arg.text.includes("*"))), `${label}: broad projection`);
  fail(nodes(tree, ts.isIdentifier).some(node => /collectSupabasePages|collectAll|loadAll|list_invoice_lines_page/.test(node.text)), `${label}: complete-document collector in compact reader`);
  fail(nodes(tree, ts.isStringLiteral).some(node => /invoice_lines|staff_invoice_sources|list_staff_invoices_page/.test(node.text)), `${label}: legacy fanout in compact reader`);
}

const base = "src/server/billing-invoices/";
for (const name of ["saveBillingInvoice.ts", "updateBillingInvoice.ts"]) {
  const tree = parse(source(base + name), name);
  fail(["from", "rpc", "json", "requireStaff", "saveStaffFinancialCommand", "parse"].some(call => calls(tree, call).length), `${name}: orchestration owns an I/O/parser boundary`);
  fail(/billingMutationUseCases|NextRequest|NextResponse|Math\.(round|ceil|floor)|normalizeInvoiceQuantity|applyStaffBillingPartsMarkup/.test(printed(tree)), `${name}: legacy/HTTP/financial policy ownership`);
  noLateCommandAbort(tree, name);
}
const compact = parse(source(base + "billingPostReadAfterWrite.ts"));
noBroadRead(compact, "post-commit compact reader");
fail(calls(compact, "abortSignal").length === 0 || calls(compact, "parseCommittedBillingSummary").length !== 1,
  "post-commit reader must forward cancellation and validate actual summary");
const secondary = parse(source(base + "billingPostCommitResult.ts"));
const rawSummary = nodes(secondary, ts.isFunctionDeclaration).find(node => node.name?.text === "parseCommittedBillingSummary");
const dtoSummary = nodes(secondary, ts.isFunctionDeclaration).find(node => node.name?.text === "validateCommittedBillingSummary");
fail(!rawSummary || !dtoSummary || calls(rawSummary, "parseInvoiceSummary").length !== 1
  || calls(rawSummary, "parse").length !== 1 || calls(dtoSummary, "parse").length < 2,
  "post-commit required raw/DTO counts must be validated before shared mapper defaults");
function requiredReceiptCounts(tree) {
  for (const [detail, receipt] of [["lineCount", "lineCount"], ["sourceCount", "sourceInvoiceCount"]]) {
    fail(!nodes(tree, ts.isBinaryExpression).some(node => node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      && node.left.getText() === `detail.${detail}` && node.right.getText() === `receipt.${receipt}`),
    "same-version post-commit detail must bind both authoritative receipt counts");
  }
}
const binding = nodes(secondary, ts.isFunctionDeclaration).find(node => node.name?.text === "validateBillingPostCommitDetail");
fail(!binding, "pure version-aware post-commit binding required");
requiredReceiptCounts(binding);
fail(calls(secondary, "validateBillingPostCommitDetail").length !== 1,
  "secondary refresh must execute the binding validator, not merely define it");
noBroadRead(secondary, "post-commit binding");
fail(["rpc", "from", "execute", "randomUUID"].some(name => calls(secondary, name).length),
  "secondary detail validation cannot retry or replace the committed command");
for (const name of ["postBillingInvoice.ts", "patchBillingInvoice.ts"]) {
  const tree = parse(source(base + name));
  fail(nodes(tree, ts.isPropertyAccessExpression).some(node => ["lineCount", "sourceInvoiceCount", "sourceCount"].includes(node.name.text)),
    "HTTP method boundary must not own receipt/detail count binding");
}

for (const name of ["billingSourceRepository.ts", "billingFinancialInputRepository.ts"]) {
  const tree = parse(source(base + name), name);
  fail(calls(tree, "abortSignal").length === 0 || calls(tree, "safeParse").length === 0
    || calls(tree, "readBillingInputData").length === 0, `${name}: typed validators and real transport cancellation required`);
  noRawReceiptCast(tree, name);
}
const financial = parse(source(base + "billingFinancialInputRepository.ts"));
const standalone = nodes(financial, ts.isIfStatement).find(node => /input\.workOrderId === null/.test(node.expression.getText(financial))
  && /kind: ["']standalone["']/.test(node.thenStatement.getText(financial)));
fail(!standalone || standalone.pos > calls(financial, "from")[0]?.pos,
  "standalone financial context must return before any work-order query");

const legacy = parse(source(base + "billingLegacyReadRepository.ts"));
fail(calls(legacy, "abortSignal").length === 0 || calls(legacy, "safeParse").length === 0,
  "legacy repository requires actual transport cancellation and runtime validation");
fail(calls(legacy, "select").some(call => call.arguments.some(arg => ts.isStringLiteral(arg) && arg.text.includes("*"))), "legacy repository explicit projections required");
const legacyUseCase = parse(source(base + "legacyReadUseCases.ts"));
fail(calls(legacyUseCase, "rpc").length || calls(legacyUseCase, "from").length, "legacy use case must delegate next-number and document queries");

for (const name of ["billingSaveCommandRepository.ts", "billingUpdateCommandRepository.ts", "billingCommandRepository.ts", "billingCommandReconciliation.ts"]) {
  const tree = parse(source(base + name), name);
  noLateCommandAbort(tree, name);
  noRawReceiptCast(tree, name);
  if (name.includes("Reconciliation")) noOperationReplacement(tree, name);
}
const financialCommands = parse(source("src/lib/staffFinancialCommands.ts"));
noLateCommandAbort(financialCommands, "staff financial command transport");
noRawReceiptCast(financialCommands, "staff financial command transport");
fail(calls(financialCommands, "safeParse").length < 3 || calls(financialCommands, "abortSignal").length < 2,
  "save/delete RPC envelope, receipt validation and supported cancellation required");
const update = parse(source(base + "billingUpdateCommandRepository.ts"));
fail(calls(update, "safeParse").length === 0 || calls(update, "parseStaffFinancialRpcResponse").length === 0,
  "every legacy PATCH action requires envelope and receipt validation");
fail(nodes(update, ts.isReturnStatement).some(node => node.expression?.getText(update) === "result.data"),
  "PATCH raw action result pass-through");
const reconciliation = parse(source(base + "billingCommandReconciliation.ts"));
const operationReconcile = nodes(reconciliation, ts.isFunctionDeclaration).find(node => node.name?.text === "reconcileBillingCommand");
fail(!operationReconcile || calls(operationReconcile, "attempt").length !== 2 || calls(operationReconcile, "timeout").length !== 1,
  "save/delete reconciliation must be bounded to one original and one timeout-bound same-operation attempt");
const actionReconcile = nodes(reconciliation, ts.isFunctionDeclaration).find(node => node.name?.text === "executeBillingAction");
fail(!actionReconcile || calls(actionReconcile, "attempt").length !== 1, "operation-less legacy actions must not auto-retry");

const harness = parse(source("src/lib/billingFinancialRouteTestHarness.ts"));
for (const option of ["active", "role", "controller", "authFailure", "missingProfile", "profileError", "permissionError", "staffPermissions"]) {
  fail(!nodes(harness, ts.isPropertyAccessExpression).some(node => node.expression.getText(harness) === "options" && node.name.text === option),
    `auth harness ignores configured ${option}`);
}
fail(!calls(harness, "compile").some(call => call.arguments[0]?.getText(harness) === "resolve(routePath)"),
  "billing harness must compile the real HTTP route");
fail(/billingMutationUseCases|legacyRouteImplementation/.test(printed(harness)), "billing harness compiles a retired behavior owner");

// Negative probes exercise the checks themselves; passing source checks alone
// never replace the production-route behavioral and SQL suites.
assert.throws(() => noLateCommandAbort(parse("async function save(){ const result=await command(); signal.throwIfAborted(); return result; }"), "probe"), /post-dispatch/);
assert.throws(() => noRawReceiptCast(parse("const receipt=raw as CommandReceipt;"), "probe"), /raw-result/);
assert.throws(() => noOperationReplacement(parse("const command={operationId:context.requestId};"), "probe"), /correlation/);
assert.throws(() => noOperationReplacement(parse("const id=crypto.randomUUID();"), "probe"), /generate/);
assert.throws(() => noBroadRead(parse("db.from('invoices').select('*');"), "probe"), /projection/);
assert.throws(() => noBroadRead(parse("collectSupabasePages(load);"), "probe"), /collector/);
noLateCommandAbort(parse("async function save(){ signal.throwIfAborted(); const result=await command(); return result; }"), "safe probe");
assert.throws(() => requiredReceiptCounts(parse("const same = detail.lineCount !== receipt.lineCount;")), /both authoritative receipt counts/);
console.log("billing corrective boundary guard passed (AST anti-pattern checks + seven negative probes; behavioral/SQL tests remain primary)");
