import { readFileSync } from "node:fs";
const read = p => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const source = read("src/server/billing-invoices/billingSourceRepository.ts");
const financial = read("src/server/billing-invoices/billingFinancialInputRepository.ts");
const save = read("src/server/billing-invoices/saveBillingInvoice.ts");
if (!/\.from\s*\(\s*["']invoices/.test(source) || !/\.from\s*\(\s*["']work_orders/.test(financial)) throw new Error("production query ownership missing");
if (/select\s*\(\s*["']\*["']/.test(source + financial)) throw new Error("select-star projection");
if (/\.from\s*\(|\.rpc\s*\(|billingPostRepositories|NextRequest|NextResponse/.test(save)) throw new Error("save use case owns direct reads");
if (![source, financial].every(owner => /\.safeParse\s*\(/.test(owner)
  && /readBillingInputData\s*\(/.test(owner) && /invalidBillingInputResult\s*\(/.test(owner)
  && /\.abortSignal\s*\(/.test(owner))) throw new Error("validated, cancellable production query ownership missing");
console.log("billing POST production query contracts verified");
