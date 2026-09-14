import ts from "typescript";
import { readdirSync } from "node:fs";
import { resolve, relative } from "node:path";

const roots = [
  ...readdirSync("src/features/parts-sms").filter(name => /\.tsx?$/.test(name)).map(name => `src/features/parts-sms/${name}`),
  ...readdirSync("src/lib").filter(name => /^(partsSms|twilioPartsSms).*\.tsx?$/.test(name)).map(name => `src/lib/${name}`),
  "src/lib/parts-sms-test-support/legacyRouteHarness.ts",
  "src/lib/server/partsSmsWorker.ts", "src/lib/server/twilioPartsSms.ts",
  "src/app/api/notifications/parts-order/route.ts", "src/app/api/parts-order-settings/route.ts",
  "src/features/dashboard/PartsAlertSettings.tsx", "src/features/dashboard/Dashboard.tsx",
  "src/features/auth/useAuth.ts",
].map(path => resolve(path));
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
if (config.error) throw new Error("Cannot read TypeScript configuration");
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const options = { ...parsed.options, strict: true, noImplicitAny: true, strictNullChecks: true, noEmit: true, incremental: false };
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(roots, options));
const focused = diagnostics.filter(item => !item.file || roots.includes(resolve(item.file.fileName)));
console.log(JSON.stringify({ roots: roots.map(path => relative(process.cwd(), path)),
  focusedDiagnostics: focused.map(item => ({ file: item.file && relative(process.cwd(), item.file.fileName), code: item.code,
    line: item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start).line + 1 : null,
    message: ts.flattenDiagnosticMessageText(item.messageText, "\n") })),
  transitiveDiagnostics: diagnostics.length - focused.length,
  policy: "Every new/touched Batch 3C TypeScript root must be strict-clean. This does not claim repository-wide strict certification." }, null, 2));
if (focused.length) process.exitCode = 1;
