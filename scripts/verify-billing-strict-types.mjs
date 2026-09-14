import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : file.endsWith(".ts") ? [file] : [];
  });
}
const roots = [
  ...files("src/server/billing-invoices"),
  ...files("src/app/api/billing-invoices"),
  ...files("src/lib/billing-post-test-support"),
  ...fs.readdirSync("src/lib").filter(file => /^billing.*Corrective\.test\.ts$/.test(file)).map(file => `src/lib/${file}`),
  "src/lib/billingFinancialRouteTestHarness.ts",
  "src/lib/billingIndependentCloseoutReview.test.ts",
  "src/lib/staffFinancialCommands.ts",
];
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const program = ts.createProgram(roots, { ...parsed.options, strict: true, noImplicitAny: true,
  noEmit: true, incremental: false, tsBuildInfoFile: undefined });
const diagnostics = ts.getPreEmitDiagnostics(program);
const host = { getCanonicalFileName: name => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" };
console.log(JSON.stringify({ startedAt: new Date().toISOString(), roots, strict: true, noImplicitAny: true }, null, 2));
if (diagnostics.length) console.error(ts.formatDiagnostics(diagnostics, host));
console.log(`Billing strict compile: ${roots.length} explicit roots; ${diagnostics.length} diagnostics`);
process.exitCode = diagnostics.length ? 1 : 0;
