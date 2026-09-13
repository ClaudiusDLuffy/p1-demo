import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : file.endsWith(".ts") ? [file] : [];
  });
}
const roots = [...files("src/server/controller-exports"), ...files("src/app/api/controller-exports"),
  ...files("src/lib/controller-export-test-support"),
  ...fs.readdirSync("src/lib").filter(file => /^controllerExport.*\.test\.ts$/.test(file)).map(file => `src/lib/${file}`),
  ...["contractorBillHandoffIntegrity", "duplicateWorkOrderWorkflow", "invoicePaymentHoldWorkflow", "quickBooksExportAccess",
    "quickBooksHandoffWorkflow", "serverRouteAuthorization"].map(name => `src/lib/${name}.test.ts`)];
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const program = ts.createProgram(roots, { ...parsed.options, strict: true, noImplicitAny: true,
  noEmit: true, incremental: false, tsBuildInfoFile: undefined });
const diagnostics = ts.getPreEmitDiagnostics(program);
console.log(JSON.stringify({ startedAt: new Date().toISOString(), roots, strict: true, noImplicitAny: true }, null, 2));
if (diagnostics.length) console.error(ts.formatDiagnostics(diagnostics, {
  getCanonicalFileName: name => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
}));
console.log(`Controller export strict compile: ${roots.length} explicit roots; ${diagnostics.length} diagnostics`);
process.exitCode = diagnostics.length ? 1 : 0;
