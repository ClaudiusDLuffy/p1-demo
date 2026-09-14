import ts from "typescript";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

// Focused roots are explicit domains; transitive legacy diagnostics are
// reported separately and never hidden as repository-wide strict compliance.
const roots = [
  "next.config.ts", "src/features/invoices/InvoiceCreateModal.tsx",
  "src/app/api/invoice-pdf/parse-total/route.ts",
  "scripts/invoice-pdf-runtime-build.mjs", "scripts/verify-invoice-pdf-types.mjs",
  "scripts/verify-invoice-pdf-build.ts", "scripts/verify-invoice-pdf-security.ts",
  ...readdirSync("src/lib").filter(name => /^invoicePdf.*\.ts$/.test(name)).map(name => `src/lib/${name}`),
  ...readdirSync("src/lib/pdf").filter(name => /\.(?:ts|mjs)$/.test(name)).map(name => `src/lib/pdf/${name}`),
  ...readdirSync("src/lib/pdf/test-fixtures").filter(name => /\.(?:ts|mjs)$/.test(name)).map(name => `src/lib/pdf/test-fixtures/${name}`),
  ...readdirSync("src/lib/server").filter(name => /^invoicePdf.*\.ts$/.test(name)).map(name => `src/lib/server/${name}`),
].map(file => resolve(file));
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
if (config.error) throw new Error("Cannot read repository TypeScript configuration");
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const program = ts.createProgram(roots, { ...parsed.options, strict: true, noEmit: true,
  incremental: false, allowJs: true, checkJs: true });
const diagnostics = ts.getPreEmitDiagnostics(program);
const selected = diagnostics.filter(item => !item.file || roots.includes(resolve(item.file.fileName)));
/** @param {readonly ts.Diagnostic[]} items */
const display = items => items.map(item => ({ file: item.file?.fileName,
  line: item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start).line + 1 : null,
  code: item.code, message: ts.flattenDiagnosticMessageText(item.messageText, "\n") }));
console.log(JSON.stringify({ roots, focused: display(selected),
  transitive: display(diagnostics.filter(item => !selected.includes(item))) }, null, 2));
if (selected.length) process.exitCode = 1;
