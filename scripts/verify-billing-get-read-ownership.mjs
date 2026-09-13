import { readFileSync } from "node:fs";

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const service = stripComments(readFileSync("src/server/billing-invoices/applicationService.ts", "utf8"));
const route = stripComments(readFileSync("src/app/api/billing-invoices/route.ts", "utf8"));
const mutations = stripComments(readFileSync("src/server/billing-invoices/billingMutationUseCases.ts", "utf8"));
const legacy = ["list_staff_invoices_page", "list_staff_invoices_rows_v1", "count_staff_invoices_v1", "get_invoice_summary_v1", "list_invoice_lines_page_v1"];
const harness = stripComments(readFileSync("src/lib/billingFinancialRouteTestHarness.ts", "utf8"));
if (/GET[\s\S]{0,500}billingUseCases/.test(service)) throw new Error("billing GET still imports the mutation module");
if (/loadBillingUseCases\(\)[\s\S]{0,120}\.GET/.test(service)) throw new Error("billing GET fallback remains");
if (/\.from\s*\(|\.rpc\s*\(/.test(route)) throw new Error("billing route owns a database call");
if (legacy.some(name => mutations.includes(name))) throw new Error("billingUseCases still contains a GET read RPC");
if (/export\s+async\s+function\s+GET/.test(mutations)) throw new Error("billingUseCases still exports GET");
if (!harness.includes("applicationService") || !/compile\(resolve\(routePath\), routeExports\)/.test(harness)
  || !/exports\[method\] = routeExports\[method\]/.test(harness)) throw new Error("billing GET test harness does not execute the actual outer route and application service");
const compactInput = stripComments(readFileSync("src/lib/server/billingCompactReadInput.ts", "utf8"));
const compactRead = stripComments(readFileSync("src/lib/server/billingCompactReads.ts", "utf8"));
const identity = stripComments(readFileSync("src/features/billing/billingReadUuid.ts", "utf8"));
if (!/\/i\.test\(value\)/.test(identity) || !identity.includes("value.toLowerCase()")) throw new Error("compact billing UUID spelling is no longer validated and canonicalized");
if (!/map\(value => canonicalBillingReadUuid\(value\)/.test(compactInput)
  || !/canonicalBillingReadUuid\(invoiceId\)/.test(compactInput)
  || !/invoiceId: canonicalId/.test(compactInput)) throw new Error("compact summary/source/line input no longer shares canonical UUID identity");
for (const binding of ["resultUuid(source.id)", "resultUuid(row.id)", "resultUuid(gate.id)", "resultUuid(line.invoice_id)", "resultUuid(line.id)"]) {
  if (!compactRead.includes(binding)) throw new Error(`compact returned UUID no longer validated before binding: ${binding}`);
}
console.log("billing GET read ownership verified");
