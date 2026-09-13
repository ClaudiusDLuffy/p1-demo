import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const feature = "src/features/work-orders/data/";
const facadeName = "src/lib/db.ts";
const queriesName = "src/features/work-orders/queries.ts";
const parse = (name, source) => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true,
  name.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
const calls = file => { const found = []; walk(file, node => { if (ts.isCallExpression(node)) found.push(node); }); return found; };
const called = call => ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text
  : ts.isIdentifier(call.expression) ? call.expression.text : "";
const imports = file => file.statements.filter(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
  .filter(node => node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier));
const runtimeImports = file => imports(file).filter(node => {
  if (ts.isImportDeclaration(node)) return !node.importClause?.isTypeOnly
    && (!node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)
      || node.importClause.namedBindings.elements.some(item => !item.isTypeOnly));
  return !node.isTypeOnly && (!node.exportClause || !ts.isNamedExports(node.exportClause)
    || node.exportClause.elements.some(item => !item.isTypeOnly));
}).map(node => node.moduleSpecifier.text);
const functionNamed = (file, name) => file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
const normalized = text => text.replace(/\s+/g, "");

/** AST supplement only; public-boundary, SQL/RLS and cancellation tests are primary. */
export function verifyWorkOrderReadBoundary(sources) {
  const failures = [];
  const fail = (condition, message) => { if (condition) failures.push(message); };
  const files = new Map([...sources].map(([name, source]) => [name, parse(name, source)]));
  const need = name => { const file = files.get(name); if (!file) throw new Error(`Missing work-order read owner: ${name}`); return file; };
  const repository = need(`${feature}workOrderReadRepository.ts`);
  const mapper = need(`${feature}workOrderMappers.ts`);
  const validator = need(`${feature}workOrderReadValidators.ts`);
  const contracts = need(`${feature}workOrderReadContracts.ts`);
  // These four new owners validate unknown results and need no type assertions.
  // Do not apply this new rule to unrelated legacy modules or the facade bridge.
  const assertionOwners = new Set([repository.fileName, mapper.fileName, validator.fileName, contracts.fileName]);
  const facade = need(facadeName);
  const queries = need(queriesName);

  for (const [name, file] of files) {
    if (!name.startsWith(feature)) continue;
    const edges = runtimeImports(file);
    fail(edges.some(edge => /(?:^react$|next\/|\/components\/|\.tsx$|\/server\/|server-only|\/db(?:\.ts)?$|privateObject|photoUpload|realtime|Storage|invoiceRead)/i.test(edge)),
      `${name}: read owner imports UI, legacy db, server, Storage, Realtime or unrelated feature`);
    const operations = calls(file);
    fail(operations.some(call => ["from", "insert", "upsert", "update", "delete", "upload", "download", "remove", "channel", "subscribe", "getUser", "getSession"].includes(called(call))),
      `${name}: read owner performs mutation, table, file, Realtime or authentication work`);
    fail(operations.some(call => called(call) === "select" && call.arguments.some(arg => ts.isStringLiteralLike(arg) && arg.text.includes("*"))),
      `${name}: broad projection`);
    walk(file, node => {
      fail(ts.isIdentifier(node) && ["File", "Blob", "window", "document"].includes(node.text), `${name}: browser file or UI global`);
      fail(ts.isPropertyAccessExpression(node) && node.expression.getText(file) === "process" && node.name.text === "env", `${name}: environment access`);
      fail(assertionOwners.has(name) && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)), `${name}: unchecked raw-result assertion`);
      if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
        fail(calls(node).some(call => ["read", "rpc", "boundedReadRpc", "loadWorkOrdersPage", "loadWorkOrderById"].includes(called(call))),
          `${name}: per-row query or all-page collector`);
      }
    });
  }
  fail(runtimeImports(mapper).some(edge => /supabase|readRpc|Repository|Validators|config|observability|node:/.test(edge)), "Mapper owns I/O, validation or configuration");
  fail(calls(mapper).some(call => ["now", "random", "randomUUID", "log", "warn", "error", "rpc", "fetch"].includes(called(call))), "Mapper uses ambient clock, randomness, logging or I/O");
  fail(runtimeImports(validator).some(edge => /supabase|readRpc|Repository|react|next\/|\/server\//.test(edge)), "Runtime validator imports an effectful owner");

  const repositoryImports = runtimeImports(repository);
  for (const edge of ["./workOrderReadValidators", "./workOrderMappers"]) {
    fail(!repositoryImports.includes(edge), `Repository missing production ${edge} edge`);
  }
  fail(!repositoryImports.some(edge => edge.endsWith("/counts/readRpc")), "Repository lacks the supported cancellable query transport");
  const repoCalls = calls(repository);
  for (const name of ["parseWorkOrderReadPage", "parseWorkOrderReadRow", "mapWorkOrderListRow"]) {
    fail(!repoCalls.some(call => called(call) === name), `Repository does not execute ${name}`);
  }
  fail(repoCalls.some(call => called(call) === "rpc"), "Repository bypasses the shared cancellable transport");
  const expectedRpcs = new Set(["list_work_orders_rows_v1", "list_work_orders_table_rows_v2", "get_portal_work_order"]);
  const rpcLiterals = [];
  walk(repository, node => {
    if (ts.isStringLiteralLike(node) && /^(?:list_|count_|get_portal_|save_|update_|delete_)/.test(node.text)) rpcLiterals.push(node.text);
  });
  fail(rpcLiterals.some(name => !expectedRpcs.has(name)), "Repository owns an unrelated query or count");
  for (const name of expectedRpcs) fail(!rpcLiterals.includes(name), `Repository missing exact ${name} contract`);
  for (const call of repoCalls.filter(call => called(call) === "read")) {
    fail(call.arguments.length !== 3 || call.arguments[2].getText(repository) !== "signal", "Request signal is not forwarded to supported read transport");
  }
  fail(repoCalls.filter(call => called(call) === "read").length !== 2, "Expected exactly one read in each page/exact method");

  const importedReads = new Map();
  for (const node of imports(facade).filter(ts.isImportDeclaration)) {
    if (!node.moduleSpecifier.text.endsWith("/workOrderReadRepository") || !node.importClause?.namedBindings
      || !ts.isNamedImports(node.importClause.namedBindings)) continue;
    for (const item of node.importClause.namedBindings.elements) importedReads.set(item.name.text, item.propertyName?.text || item.name.text);
  }
  for (const [name, parameter, type] of [
    ["loadWorkOrdersPage", "params", "WorkOrderPageParams"], ["loadWorkOrderById", "workOrderId", "string"],
  ]) {
    const fn = functionNamed(facade, name);
    fail(!fn?.body || fn.parameters.length !== 2, `${name}: missing compatible facade signature`);
    if (!fn?.body) continue;
    fail(fn.parameters[0].name.getText(facade) !== parameter || normalized(fn.parameters[0].type?.getText(facade) || "") !== type,
      `${name}: facade input changed`);
    fail(fn.parameters[1].name.getText(facade) !== "signal" || !fn.parameters[1].questionToken
      || fn.parameters[1].type?.getText(facade) !== "AbortSignal", `${name}: facade cancellation signature changed`);
    if (name === "loadWorkOrdersPage") fail(normalized(fn.parameters[0].initializer?.getText(facade) || "") !== "{}", "Page default argument changed");
    fail(fn.body.statements.length !== 1 || !ts.isReturnStatement(fn.body.statements[0]), `${name}: facade retained implementation`);
    const forwarded = calls(fn.body);
    fail(forwarded.length !== 1 || importedReads.get(called(forwarded[0])) !== name, `${name}: facade does not forward to the feature owner`);
    if (forwarded.length === 1) fail(forwarded[0].arguments.map(arg => arg.getText(facade)).join(",") !== `${parameter},signal`, `${name}: forwarding arguments changed`);
  }
  fail(Boolean(functionNamed(facade, "workOrderReadArgs")), "db.ts retains duplicate work-order query arguments");
  for (const name of ["mapWO", "mapWorkOrderListRow", "formatWorkOrderDateTime", "ageString"]) {
    walk(facade, node => fail((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(facade) === name,
      `db.ts retains migrated mapper ${name}`));
  }
  fail(!runtimeImports(queries).some(edge => edge.endsWith("/workOrderReadRepository")), "Work-order query hooks still use only the legacy owner");
  for (const [method, key] of [["useWorkOrdersPageQuery", "workOrderPagesKey"], ["useWorkOrderByIdQuery", "workOrderByIdKey"]]) {
    const fn = functionNamed(queries, method);
    fail(!fn || !calls(fn).some(call => called(call) === key), `${method}: established query key changed`);
  }
  fail(!calls(functionNamed(queries, "useWorkOrdersPageQuery")).some(call => called(call) === "useWorkOrdersCountQuery"), "Independent count subscription disappeared");

  for (const [name, file] of files) {
    if (!name.startsWith("src/") || /(?:\.test\.[jt]sx?$|\/testing\/|test-support)/.test(name)) continue;
    for (const node of imports(file)) {
      const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
      if (!bindings || (!ts.isNamedImports(bindings) && !ts.isNamedExports(bindings))) continue;
      for (const item of bindings.elements) {
        const imported = item.propertyName?.text || item.name.text;
        fail(imported === "useWorkOrdersQuery", `${name}: deprecated all-record hook import`);
        fail(imported === "loadWorkOrders" && name !== queriesName, `${name}: new deprecated all-record loader import`);
      }
    }
  }

  const visited = new Set();
  const visit = name => {
    if (visited.has(name)) return;
    visited.add(name);
    const file = files.get(name);
    if (!file) return;
    fail(name.startsWith("src/server/"), `Server-only code enters work-order client graph: ${name}`);
    for (const edge of runtimeImports(file)) {
      fail(/^(?:server-only|node:|fs(?:\/|$)|canvas$|@napi-rs\/canvas|sharp$)/.test(edge), `${name}: server/native client import ${edge}`);
      if (!edge.startsWith(".") && !edge.startsWith("@/")) continue;
      const stem = path.normalize(edge.startsWith("@/") ? path.join("src", edge.slice(2)) : path.join(path.dirname(name), edge));
      const next = [stem, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`].find(candidate => files.has(candidate));
      if (next) visit(next);
    }
  };
  visit(queriesName);
  if (failures.length) throw new Error([...new Set(failures)].join("\n"));
  return { passed: true, owners: [...files.keys()].filter(name => name.startsWith(feature)).length,
    clientModules: visited.size, facadeMethods: 2, rpcs: [...expectedRpcs] };
}

const collect = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const name = path.join(directory, entry.name);
  return entry.isDirectory() ? collect(name) : /\.[jt]sx?$/.test(name) ? [name] : [];
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = collect("src");
  console.log(JSON.stringify(verifyWorkOrderReadBoundary(new Map(names.map(name => [name, fs.readFileSync(name, "utf8")])))));
}
