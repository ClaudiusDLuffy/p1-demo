import ts from "typescript";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const feature = "src/features/financial-notifications";
const roots = [
  ...readdirSync(feature).filter(name => /\.tsx?$/.test(name)).map(name => `${feature}/${name}`),
  "src/lib/server/financialNotificationWorker.ts", "src/lib/server/financialNotificationProvider.ts",
  "src/lib/server/financialNotificationHttp.ts", "src/lib/graphClient.ts",
  "src/app/api/notifications/invoice-review/route.ts", "src/app/api/contractor-invoice-holds/route.ts",
  "src/app/api/notifications/financial/drain/route.ts", "src/lib/supabase/database.types.ts",
  ...readdirSync("src/lib").filter(name => /^financialNotification.*\.ts$/.test(name)).map(name => `src/lib/${name}`),
  "src/lib/db.ts", "src/features/invoices/useInvoices.ts", "src/features/invoices/InvoiceDetail.tsx",
  "src/features/invoices/InvoiceList.tsx", "src/features/invoices/ControllerExportPanel.tsx",
  "src/lib/contractorInvoiceBatchReview.test.ts", "src/lib/contractorInvoiceRejectionLifecycle.test.ts",
  "src/lib/externalWorkOrderIdentitySurfaces.test.ts", "src/lib/invoicePaymentHoldWorkflow.test.ts",
  "src/lib/serverRouteAuthorization.test.ts", "src/lib/multiAdminContractorCompanyScope.test.ts",
  "src/lib/nonRetryableRpcConflicts.test.ts",
  "src/lib/financial-notification-test-support/baselineRouteHarness.ts",
].map(path => resolve(path));
const legacy = ["src/lib/db.ts", "src/features/invoices/useInvoices.ts", "src/features/invoices/InvoiceDetail.tsx",
  "src/features/invoices/InvoiceList.tsx", "src/features/invoices/ControllerExportPanel.tsx"].map(path => resolve(path));
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
if (config.error) throw new Error("Cannot read compiler configuration");
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const options = { ...parsed.options, strict: true, noImplicitAny: true, strictNullChecks: true, noEmit: true, incremental: false };
const program = ts.createProgram(roots, options);
const diagnostics = ts.getPreEmitDiagnostics(program);
const focused = diagnostics.filter(item => !item.file || roots.includes(resolve(item.file.fileName)));
const currentLegacy = focused.filter(item => item.file && legacy.includes(resolve(item.file.fileName)));
const clean = focused.filter(item => !currentLegacy.includes(item));
/** @param {ts.Diagnostic} item */
const identity = item => `${item.file ? relative(process.cwd(), item.file.fileName) : "compiler"}:${item.code}:${ts.flattenDiagnosticMessageText(item.messageText,"\n")}`;
const snapshot = process.env.P1_FINANCIAL_SNAPSHOT;
/** @type {ts.Diagnostic[]} */
let baseline = [];
if (currentLegacy.length) {
  if (!snapshot || !existsSync(join(snapshot,"path-manifest.json"))) throw new Error("Verified pre-financial snapshot required for existing legacy diagnostic comparison");
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile;
  host.readFile = filename => {
    const path = join(snapshot,"files",relative(process.cwd(),resolve(filename)));
    return resolve(filename).startsWith(process.cwd()+"/") && existsSync(path) ? readFileSync(path,"utf8") : originalRead(filename);
  };
  baseline = ts.getPreEmitDiagnostics(ts.createProgram(legacy, options, host))
    .filter(item => item.file && legacy.includes(resolve(item.file.fileName)));
}
const counts = new Map();
for (const item of baseline) counts.set(identity(item),(counts.get(identity(item)) || 0)+1);
const addedLegacy = currentLegacy.filter(item => {
  const count = counts.get(identity(item)) || 0;
  if (count) { counts.set(identity(item),count-1); return false; }
  return true;
});
/** @param {ts.Diagnostic} item */
const describe = item => ({ file: item.file && relative(process.cwd(),item.file.fileName), code: item.code,
  line: item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start).line+1 : null,
  message: ts.flattenDiagnosticMessageText(item.messageText,"\n") });
console.log(JSON.stringify({roots:roots.map(path=>relative(process.cwd(),path)),cleanRootDiagnostics:clean.map(describe),
  legacyBefore:baseline.length,legacyAfter:currentLegacy.length,newLegacyDiagnostics:addedLegacy.map(describe),
  transitiveDiagnostics:diagnostics.filter(item=>!focused.includes(item)).length,
  policy:"New modules strict clean; legacy composition roots retain only verified pre-financial diagnostics. This is not repository-wide strict certification."},null,2));
if (clean.length || addedLegacy.length) process.exitCode=1;
