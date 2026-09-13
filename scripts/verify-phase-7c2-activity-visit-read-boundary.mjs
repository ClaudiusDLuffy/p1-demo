import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const feature = "src/features/work-orders/data/";
const facadeName = "src/lib/db.ts";
const queriesName = "src/features/work-orders/queries.ts";
const parse = (name, source) => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true,
  name.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const walk = (node, visit) => { if (!node) return; visit(node); ts.forEachChild(node, child => walk(child, visit)); };
const calls = node => { const found = []; walk(node, child => { if (ts.isCallExpression(child)) found.push(child); }); return found; };
const called = call => ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text
  : ts.isIdentifier(call.expression) ? call.expression.text : "";
const imports = file => file.statements.filter(node => (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
  && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier));
const runtimeImports = file => imports(file).filter(node => {
  if (ts.isImportDeclaration(node)) return !node.importClause?.isTypeOnly
    && (!node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)
      || node.importClause.namedBindings.elements.some(item => !item.isTypeOnly));
  return !node.isTypeOnly && (!node.exportClause || !ts.isNamedExports(node.exportClause)
    || node.exportClause.elements.some(item => !item.isTypeOnly));
}).map(node => node.moduleSpecifier.text);
const fn = (file, name) => file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
const normalized = text => text.replace(/\s+/g, "");

/** Supplemental AST/import guard. Actual facade, transport, SQL/RLS and privacy tests are primary. */
export function verifyActivityVisitReadBoundary(sources) {
  const failures = [];
  const fail = (condition, message) => { if (condition) failures.push(message); };
  const files = new Map([...sources].map(([name, source]) => [name, parse(name, source)]));
  const need = name => { const file = files.get(name); if (!file) throw new Error(`Missing read owner: ${name}`); return file; };
  const facade = need(facadeName), queries = need(queriesName);
  const families = [
    { family: "activity", method: "loadWorkOrderActivitiesPage", mapper: "mapActivityPageRow", facadeMapper: "mapActivity", parser: "parseActivityReadPage",
      rpc: "list_work_order_activities_rows_v1", parent: "workOrder", parentType: "Parameters<typeofloadWorkOrderDetails>[0]", parentValue: "workOrder.id" },
    { family: "visit", method: "loadWorkOrderVisitsPage", mapper: "mapVisit", facadeMapper: "mapVisit", parser: "parseVisitReadPage",
      rpc: "list_work_order_visits_rows_v1", parent: "workOrderId", parentType: "string", parentValue: "workOrderId" },
  ];
  const ownerNames = families.flatMap(({ family }) => ["ReadContracts", "ReadValidators", "Mappers", "ReadRepository"]
    .map(suffix => `${feature}${family}${suffix}.ts`));
  for (const name of ownerNames) {
    const file = need(name), edges = runtimeImports(file), operations = calls(file);
    fail(edges.some(edge => /(?:^react(?:\/|$)|^next(?:\/|$)|\/components\/|\.tsx$|\/server\/|server-only|\/db(?:\.ts)?$|privateObject|photoUpload|realtime|Storage)/i.test(edge)),
      `${name}: UI, legacy db, server, Storage or Realtime import`);
    fail(operations.some(call => ["from", "rpc", "insert", "upsert", "update", "delete", "upload", "download", "remove", "channel", "subscribe", "getUser", "getSession", "fetch", "require", "eval", "Function"].includes(called(call))
      && !(called(call) === "from" && ts.isPropertyAccessExpression(call.expression) && call.expression.expression.getText(file) === "Array")),
      `${name}: query bypass, mutation, provider, Realtime or authentication operation`);
    fail(operations.some(call => called(call) === "select" && call.arguments.some(arg => ts.isStringLiteralLike(arg) && arg.text.includes("*"))), `${name}: broad projection`);
    walk(file, node => {
      fail(ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || node.kind === ts.SyntaxKind.AnyKeyword, `${name}: unchecked assertion or any`);
      fail(ts.isIdentifier(node) && ["File", "Blob", "window", "document"].includes(node.text), `${name}: browser file/UI global`);
      fail(ts.isPropertyAccessExpression(node) && node.expression.getText(file) === "process" && node.name.text === "env", `${name}: environment access`);
      if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)
        || (ts.isCallExpression(node) && ["map", "forEach", "flatMap", "reduce"].includes(called(node)))) {
        fail(calls(node).some(call => ["read", "rpc", "boundedReadRpc", ...families.map(item => item.method)].includes(called(call))), `${name}: per-row query or all-page collector`);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) fail(true, `${name}: hidden dynamic import`);
    });
  }

  for (const item of families) {
    const { family, method, mapper: mapperName, facadeMapper, parser, rpc, parent, parentType, parentValue } = item;
    const repository = need(`${feature}${family}ReadRepository.ts`);
    const mapper = need(`${feature}${family}Mappers.ts`);
    const validator = need(`${feature}${family}ReadValidators.ts`);
    const allowedRepositoryEdges = new Set(["../../../lib/counts/readRpc", "../../../lib/cursorPagination",
      `./${family}ReadValidators`, `./${family}Mappers`, ...(family === "activity" ? ["../../../lib/billingRules"] : [])]);
    fail(runtimeImports(repository).some(edge => !allowedRepositoryEdges.has(edge)), `${family}: repository delegates outside its focused graph`);
    fail(runtimeImports(mapper).length !== 0, `${family}: pure mapper gained a runtime import`);
    fail(runtimeImports(validator).some(edge => !["zod", "../../../lib/errors/AppError", "../../../lib/cursorPagination"].includes(edge)),
      `${family}: validator gained a cross-feature dependency`);
    for (const pure of [mapper, validator]) {
      fail(runtimeImports(pure).some(edge => /supabase|readRpc|Repository|react|next\/|config|observability|node:/.test(edge)), `${pure.fileName}: effectful dependency`);
    }
    fail(runtimeImports(mapper).some(edge => /Validators/.test(edge)), `${family} mapper owns validation`);
    fail(calls(mapper).some(call => ["now", "random", "randomUUID", "log", "warn", "error", "fetch"].includes(called(call))), `${family} mapper owns ambient effects`);
    walk(mapper, node => fail(ts.isNewExpression(node) && node.expression.getText(mapper) === "Date" && !node.arguments?.length,
      `${family} mapper reads ambient time`));
    for (const edge of [`./${family}ReadValidators`, `./${family}Mappers`]) {
      fail(!runtimeImports(repository).includes(edge), `${family} repository missing ${edge}`);
    }
    fail(!runtimeImports(repository).some(edge => edge.endsWith("/counts/readRpc")), `${family} repository lacks cancellable transport`);
    fail(runtimeImports(repository).some(edge => /(?:activity|visit)ReadRepository$/.test(edge)), `${family} repository delegates to the other family`);
    const operations = calls(repository);
    for (const symbol of [parser, mapperName, "clampPageSize"]) {
      const present = operations.some(call => called(call) === symbol)
        || (symbol === mapperName && operations.some(call => called(call) === "map" && call.arguments.some(arg => arg.getText(repository) === symbol)));
      fail(!present, `${family} production path does not execute ${symbol}`);
    }
    const readCalls = operations.filter(call => called(call) === "read");
    fail(readCalls.length !== 1, `${family} must have one RPC and no count/collector`);
    for (const call of readCalls) {
      fail(call.arguments.length !== 3 || call.arguments[2].getText(repository) !== "signal", `${family}: signal not forwarded`);
      fail(!ts.isStringLiteralLike(call.arguments[0]) || call.arguments[0].text !== rpc, `${family}: authoritative read/RLS contract changed`);
      const args = call.arguments[1];
      fail(!ts.isObjectLiteralExpression(args), `${family}: query arguments must remain explicit`);
      if (ts.isObjectLiteralExpression(args)) {
        const fields = new Map(args.properties.filter(ts.isPropertyAssignment).map(node => [node.name.getText(repository), normalized(node.initializer.getText(repository))]));
        fail(fields.size !== 3 || fields.get("p_work_order_id") !== parentValue || fields.get("p_limit") !== "clampPageSize(limit)"
          || fields.get("p_cursor") !== "cursor", `${family}: parent, page size or opaque cursor contract changed`);
      }
    }
    const literals = [];
    walk(repository, node => { if (ts.isStringLiteralLike(node) && /^(?:list_|count_|get_|save_|update_|delete_)/.test(node.text)) literals.push(node.text); });
    fail(literals.some(value => value !== rpc), `${family}: unrelated query family or count`);
    const parserCall = operations.find(call => called(call) === parser);
    fail(!parserCall || parserCall.arguments.length < 2 || parserCall.arguments[1].getText(repository) !== parentValue,
      `${family}: runtime page validation lost parent binding`);
    let validatedPage;
    walk(repository, node => {
      if (ts.isVariableDeclaration(node) && node.initializer === parserCall) validatedPage = node.name.getText(repository);
    });
    fail(!validatedPage || !operations.some(call => called(call) === "map"
      && ts.isPropertyAccessExpression(call.expression)
      && call.expression.expression.getText(repository) === `${validatedPage}.items`), `${family}: validated rows do not feed the mapper`);

    const imported = new Map();
    for (const node of imports(facade).filter(ts.isImportDeclaration)) {
      if (!node.moduleSpecifier.text.endsWith(`/${family}ReadRepository`) || !node.importClause?.namedBindings
        || !ts.isNamedImports(node.importClause.namedBindings)) continue;
      for (const binding of node.importClause.namedBindings.elements) imported.set(binding.name.text, binding.propertyName?.text || binding.name.text);
    }
    const bridge = fn(facade, method);
    fail(!bridge?.body || bridge.parameters.length !== 4, `${method}: compatible facade missing`);
    if (bridge?.body) {
      const params = bridge.parameters;
      fail(params[0].name.getText(facade) !== parent || normalized(params[0].type?.getText(facade) || "") !== parentType, `${method}: parent signature changed`);
      fail(params[1].name.getText(facade) !== "cursor" || normalized(params[1].type?.getText(facade) || "") !== "string|null"
        || params[1].initializer?.getText(facade) !== "null", `${method}: cursor default/signature changed`);
      fail(params[2].name.getText(facade) !== "limit" || params[2].initializer?.getText(facade) !== "30", `${method}: default page size changed`);
      fail(params[3].name.getText(facade) !== "signal" || !params[3].questionToken || params[3].type?.getText(facade) !== "AbortSignal", `${method}: abort signature changed`);
      fail(normalized(bridge.type?.getText(facade) || "") !== `Promise<CursorPage<ReturnType<typeof${facadeMapper}>>>`, `${method}: return contract changed`);
      fail(bridge.body.statements.length !== 1 || !ts.isReturnStatement(bridge.body.statements[0]), `${method}: duplicate facade implementation`);
      const forwarded = calls(bridge.body);
      fail(forwarded.length !== 1 || imported.get(called(forwarded[0])) !== method, `${method}: not a forwarding facade`);
      if (forwarded.length === 1) fail(forwarded[0].arguments.map(arg => arg.getText(facade)).join(",") !== `${parent},cursor,limit,signal`, `${method}: forwarding arguments changed`);
    }
    walk(facade, node => fail((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && [mapperName, facadeMapper].includes(node.name?.getText(facade)), `db.ts retains ${mapperName}`));
    fail(!runtimeImports(queries).some(edge => edge.endsWith(`/${family}ReadRepository`)), `${family}: query importer not feature-owned`);
  }
  const detailHook = fn(queries, "useWorkOrderDetailsQuery");
  const detailCalls = calls(detailHook);
  fail(detailCalls.filter(call => called(call) === "workOrderDetailsKey").length !== 2, "Detail/continuation query key changed");
  fail(detailCalls.filter(call => called(call) === "workOrderChildCountKey").length !== 3, "Separate child-count keys changed");
  for (const call of detailCalls.filter(call => called(call) === "workOrderDetailsKey")) {
    fail(call.arguments.map(arg => arg.getText(queries)).join(",") !== "workOrderId,scope", "Detail key lost parent or actor scope");
  }
  const childSections = new Set();
  for (const call of detailCalls.filter(call => called(call) === "workOrderChildCountKey")) {
    fail(call.arguments.length !== 3 || call.arguments[0].getText(queries) !== "scope"
      || call.arguments[1].getText(queries) !== "workOrderId" || !ts.isStringLiteralLike(call.arguments[2]), "Child-count key lost scope, parent or section");
    if (call.arguments[2] && ts.isStringLiteralLike(call.arguments[2])) childSections.add(call.arguments[2].text);
  }
  fail(["activities", "photos", "visits"].some(section => !childSections.has(section)), "Child-count sections changed");
  fail(detailCalls.filter(call => called(call) === "loadWorkOrderChildCount").length !== 3, "Independent counts changed");
  for (const item of families) fail(detailCalls.filter(call => called(call) === item.method).length !== 1, `${item.family}: continuation dispatch changed`);
  fail(calls(need("src/lib/counts/readRpc.ts")).filter(call => called(call) === "abortSignal").length !== 1, "Shared transport dropped request abort signal");
  for (const [name, file] of files) {
    if (!name.startsWith("src/") || /(?:\.test\.[jt]sx?$|\/testing\/|test-support)/.test(name)) continue;
    for (const declaration of imports(file)) {
      const bindings = ts.isImportDeclaration(declaration) ? declaration.importClause?.namedBindings : declaration.exportClause;
      if (!bindings || (!ts.isNamedImports(bindings) && !ts.isNamedExports(bindings))) continue;
      for (const binding of bindings.elements) fail((binding.propertyName?.text || binding.name.text) === "loadAllWorkOrderVisits"
        && name !== "src/features/billing/BillingInvoiceCreateModal.tsx", `${name}: new all-visit collector importer`);
    }
  }
  const visited = new Set();
  const visit = name => {
    if (visited.has(name)) return;
    visited.add(name);
    const file = files.get(name); if (!file) return;
    fail(name.startsWith("src/server/"), `${name}: server module enters client read graph`);
    for (const edge of runtimeImports(file)) {
      fail(/^(?:server-only|node:|fs(?:\/|$)|canvas$|@napi-rs\/canvas|sharp$)/.test(edge), `${name}: server/native import ${edge}`);
      if (!edge.startsWith(".") && !edge.startsWith("@/")) continue;
      const stem = path.normalize(edge.startsWith("@/") ? path.join("src", edge.slice(2)) : path.join(path.dirname(name), edge));
      const next = [stem, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`].find(candidate => files.has(candidate));
      if (next) visit(next);
    }
  };
  visit(queriesName);
  if (failures.length) throw new Error([...new Set(failures)].join("\n"));
  return { passed: true, owners: ownerNames.length, facadeMethods: 2, clientModules: visited.size, rpcs: families.map(item => item.rpc) };
}

const collect = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const name = path.join(directory, entry.name);
  return entry.isDirectory() ? collect(name) : /\.[jt]sx?$/.test(name) ? [name] : [];
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(verifyActivityVisitReadBoundary(new Map(collect("src").map(name => [name, fs.readFileSync(name, "utf8")])))));
}
