import ts from "typescript";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const feature = "src/features/receiving-dispatch";
const roots = [
  ...readdirSync(feature).filter(name => /\.tsx?$/.test(name)).map(name => `${feature}/${name}`),
  "src/lib/server/receivingDispatchWorker.ts", "src/app/api/notifications/dispatch/route.ts",
  "src/app/api/notifications/dispatch/drain/route.ts", "src/lib/supabase/database.types.ts",
  ...readdirSync("src/lib").filter(name => /^receivingDispatch.*\.test\.ts$/.test(name)).map(name => `src/lib/${name}`),
  "src/lib/serverRouteAuthorization.test.ts", "src/lib/workOrderAssignmentClientBehavior.test.ts",
  "src/features/work-orders/useWorkOrders.ts", "src/features/work-orders/WorkOrderDetail.tsx", "src/components/PortalShell.tsx",
].map(path => resolve(path));
const legacy = ["src/components/PortalShell.tsx", "src/features/work-orders/WorkOrderDetail.tsx", "src/features/work-orders/useWorkOrders.ts"].map(path => resolve(path));
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
const snapshot = process.env.P1_CLOSEOUT_SNAPSHOT;
/** @type {ts.Diagnostic[]} */
let baseline = [];
if (currentLegacy.length) {
  if (!snapshot || !existsSync(join(snapshot,"path-manifest.json"))) throw new Error("Verified pre-closeout snapshot required for existing legacy diagnostic comparison");
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
  policy:"New modules strict clean; legacy composition roots retain only verified pre-closeout diagnostics. This is not repository-wide strict certification."},null,2));
if (clean.length || addedLegacy.length) process.exitCode=1;
