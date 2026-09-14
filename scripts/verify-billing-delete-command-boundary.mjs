import { readFileSync } from "node:fs";
const read = path => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const app = read("src/server/billing-invoices/applicationService.ts");
const route = read("src/app/api/billing-invoices/route.ts");
const old = read("src/server/billing-invoices/billingMutationUseCases.ts");
if (/loadBillingUseCases\(\)\s*\.DELETE/.test(app)) throw new Error("DELETE still routed through billingUseCases");
if (/\.from\s*\(|\.rpc\s*\(/.test(route)) throw new Error("route owns database operation");
if (/export\s+async\s+function\s+DELETE|delete_invoice_admin_v1|deleteFinancialCommand/.test(old)) throw new Error("billingUseCases retains DELETE ownership");
const harness = read("src/lib/billingFinancialRouteTestHarness.ts");
if (!/DELETE:\s*async[\s\S]*loadDeleteBillingInvoice\(\)\)\.DELETE/.test(app)
  || !/billingInvoiceService\.DELETE\(request\)/.test(route)) throw new Error("DELETE boundary wiring missing");
if (!/compile\(resolve\(routePath\), routeExports\)/.test(harness)
  || !/exports\[method\] = routeExports\[method\]/.test(harness)
  || !harness.includes('"DELETE"') || /exports\.DELETE\s*=\s*async/.test(harness)) {
  throw new Error("DELETE tests must execute the actual outer route, not a synthetic method wrapper");
}
const repository = read("src/server/billing-invoices/billingCommandRepository.ts");
if (!repository.includes("reconcileBillingCommand") || !repository.includes("deleteFinancialCommand")
  || /\.from\s*\(/.test(repository)) throw new Error("DELETE must use the authoritative command and typed reconciliation");
console.log("billing DELETE command boundary verified");
