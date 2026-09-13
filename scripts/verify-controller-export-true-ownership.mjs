import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const directory = "src/server/controller-exports/";
const route = "src/app/api/controller-exports/route.ts";
const parse = (name, source) => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
const runtimeImports = file => file.statements.filter(node => (ts.isImportDeclaration(node)
  && !node.importClause?.isTypeOnly && (!node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)
    || node.importClause.namedBindings.elements.some(item => !item.isTypeOnly)))
  || (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly
    && (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(item => !item.isTypeOnly))))
  .map(node => node.moduleSpecifier.text);
const calls = file => {
  const values = [];
  walk(file, node => { if (ts.isCallExpression(node)) values.push(node); });
  return values;
};
const callName = node => ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
  : ts.isIdentifier(node.expression) ? node.expression.text : "";

/** Static supplement to executable route/query/SQL/compensation tests. Comments are not evidence. */
export function verifyControllerExportOwnership(sources) {
  const failures = [];
  const fail = (condition, message) => { if (condition) failures.push(message); };
  const files = new Map([...sources].map(([name, source]) => [name, parse(name, source)]));
  const need = name => {
    const file = files.get(name);
    if (!file) throw new Error(`Missing required controller owner: ${name}`);
    return file;
  };
  for (const [name, file] of files) {
    if (!name.startsWith(directory) && name !== route) continue;
    if (name.includes("/testing/")) continue;
    const imports = runtimeImports(file);
    fail(imports.some(edge => edge.includes("legacyRouteImplementation")), `${name}: static legacy fallback`);
    for (const call of calls(file)) {
      fail(call.arguments.some(argument => ts.isStringLiteralLike(argument) && argument.text.includes("legacyRouteImplementation")), `${name}: dynamic legacy fallback`);
    }
    const names = new Set(calls(file).map(callName));
    const directResponsibilities = [names.has("getUser"), names.has("from"), names.has("rpc"),
      names.has("generateInvoicePDFBlob"), names.has("createZipArchive"), names.has("createSignedUrl"),
      calls(file).some(call => ts.isPropertyAccessExpression(call.expression) && ["Response", "NextResponse"].includes(call.expression.expression.getText(file)))];
    fail(directResponsibilities.filter(Boolean).length >= 4, `${name}: renamed broad runtime owner`);
  }
  const legacy = files.get(`${directory}legacyRouteImplementation.ts`);
  fail(Boolean(legacy?.statements.length), "Legacy controller implementation remains");
  for (const name of [route, `${directory}applicationService.ts`]) {
    const file = need(name);
    fail(calls(file).some(call => ["from", "rpc", "upload", "remove", "createSignedUrl", "createZipArchive", "generateInvoicePDFBlob", "generateContractorBillManifestCsv", "decideCompensation"].includes(callName(call))), `${name}: side effects or export rules in facade`);
    fail(runtimeImports(file).some(edge => /supabase|invoicePdf|zipArchive|Manifest|eligibilityRepository|exportStorage|Reconciliation/.test(edge)), `${name}: facade bypasses focused use case`);
  }
  fail(!runtimeImports(need(route)).includes("../../../server/controller-exports/httpBoundary"), "Route does not invoke strict boundary");
  const serviceImports = runtimeImports(need(`${directory}applicationService.ts`));
  for (const name of ["listControllerExports", "stageControllerExport", "transitionControllerExport"]) {
    fail(!serviceImports.includes(`./${name}`), `Missing typed ${name} dispatch`);
    const file = need(`${directory}${name}.ts`);
    fail(calls(file).some(call => ["from", "rpc", "json", "createSignedUrl", "createZipArchive", "generateInvoicePDFBlob", "createHash"].includes(callName(call))), `${name}: orchestration owns raw I/O or response`);
    fail(runtimeImports(file).some(edge => /next\/|supabase|invoicePdf|zipArchive|legacyRoute/.test(edge)), `${name}: orchestration imports implementation dependency`);
  }
  for (const name of ["snapshot.ts", "historyMapper.ts", "stageResultMapper.ts", "transitionResultMapper.ts"]) {
    const file = need(directory + name);
    fail(runtimeImports(file).some(edge => /supabase|next\/|react|config|observability|Repository|exportStorage|node:/.test(edge)), `${name}: pure mapper imports side effects`);
    walk(file, node => {
      fail(ts.isPropertyAccessExpression(node) && ["env", "log", "error", "warn"].includes(node.name.text)
        && ["process", "console"].includes(node.expression.getText(file)), `${name}: impure policy/mapper`);
    });
  }
  const http = need(`${directory}httpMapper.ts`);
  fail(runtimeImports(http).some(edge => /Repository|supabase|snapshot|Manifest|archiveBuilder|exportStorage/.test(edge)), "HTTP mapper owns persistence or archive policy");
  const archive = need(`${directory}archiveBuilder.ts`);
  fail(calls(archive).some(call => ["from", "rpc", "upload", "remove"].includes(callName(call))), "Archive builder performs provider I/O");
  const storage = need(`${directory}exportStorage.ts`);
  fail(calls(storage).some(call => callName(call) === "rpc"), "Storage adapter dispatches database commands");
  const eligibility = need(`${directory}eligibilityRepository.ts`);
  fail(calls(eligibility).some(call => ["build", "createZipArchive", "generateInvoicePDFBlob", "upload"].includes(callName(call))), "Eligibility owns archive work");
  for (const name of ["stageCommandRepository.ts", "transitionCommandRepository.ts"]) {
    const file = need(directory + name);
    fail(calls(file).some(call => ["insert", "update", "upsert", "delete"].includes(callName(call))), `${name}: direct table write`);
    fail(runtimeImports(file).some(edge => /next\/|react|invoicePdf|exportStorage/.test(edge)), `${name}: command repository owns HTTP/provider work`);
  }
  for (const name of ["stageReconciliation.ts", "transitionReconciliation.ts"]) {
    const file = need(directory + name);
    fail(calls(file).some(call => ["randomUUID", "random"].includes(callName(call))), `${name}: new operation identity during reconciliation`);
    fail(calls(file).some(call => call.arguments.some(argument => ts.isStringLiteralLike(argument)
      && argument.text === "stage_contractor_bill_handoff")), `${name}: non-idempotent stage retry`);
  }
  for (const [name, file] of files) {
    if (!name.startsWith(directory) || name.includes("/testing/")) continue;
    walk(file, node => {
      if (!ts.isPropertyAssignment(node)) return;
      fail(/^(?:operationId|operationUuid|batchId)$/.test(node.name.getText(file))
        && /requestId|correlationId/.test(node.initializer.getText(file)), `${name}: correlation used as operation identity`);
    });
  }
  const stage = need(`${directory}stageControllerExport.ts`);
  for (const call of calls(stage).filter(call => callName(call) === "cleanup")) {
    let parent = call.parent; let guarded = false;
    while (parent && parent !== stage) {
      if (ts.isIfStatement(parent) && ts.isBinaryExpression(parent.expression)
        && parent.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && ts.isPropertyAccessExpression(parent.expression.left) && parent.expression.left.name.text === "action"
        && ts.isCallExpression(parent.expression.left.expression) && callName(parent.expression.left.expression) === "decideCompensation"
        && ts.isStringLiteralLike(parent.expression.right) && parent.expression.right.text === "cleanup_exact_object"
        && call.pos >= parent.thenStatement.pos && call.end <= parent.thenStatement.end) guarded = true;
      parent = parent.parent;
    }
    fail(!guarded, "Stage cleanup lacks explicit compensation authorization");
  }
  const boundaryImports = runtimeImports(need(`${directory}httpBoundary.ts`));
  for (const edge of ["./controllerExportContext", "./contracts", "./applicationService", "./httpMapper"]) {
    fail(!boundaryImports.includes(edge), `HTTP boundary missing ${edge}`);
  }
  if (failures.length) throw new Error([...new Set(failures)].join("\n"));
  return { files: files.size, controllerOwners: [...files.keys()].filter(name => name.startsWith(directory)).length };
}

function collect(directoryName) {
  return fs.readdirSync(directoryName, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(directoryName, entry.name);
    return entry.isDirectory() ? collect(name) : /\.[jt]sx?$/.test(name) ? [name] : [];
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = [...collect(directory), route];
  const result = verifyControllerExportOwnership(new Map(names.map(name => [name, fs.readFileSync(name, "utf8")])));
  const clientFiles = collect("src").filter(name => /["']use client["']/.test(fs.readFileSync(name, "utf8").slice(0, 200)));
  const visited = new Set();
  const visit = name => {
    if (visited.has(name)) return;
    visited.add(name);
    if (name.startsWith(directory)) throw new Error(`Controller server owner in client import graph: ${name}`);
    const file = parse(name, fs.readFileSync(name, "utf8"));
    for (const edge of runtimeImports(file)) {
      if (!edge.startsWith(".") && !edge.startsWith("@/")) continue;
      const stem = path.normalize(edge.startsWith("@/") ? path.join("src", edge.slice(2)) : path.join(path.dirname(name), edge));
      const next = [stem, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (next) visit(next);
    }
  };
  clientFiles.forEach(visit);
  console.log(JSON.stringify({ ...result, clientRoots: clientFiles.length, clientModules: visited.size, passed: true }));
}
