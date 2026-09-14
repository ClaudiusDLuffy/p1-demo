import { existsSync, readFileSync } from "node:fs";

const read = path => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const app = read("src/server/billing-invoices/applicationService.ts");
const route = read("src/app/api/billing-invoices/route.ts");
if (existsSync("src/server/billing-invoices/billingUseCases.ts")) throw new Error("obsolete billingUseCases.ts remains");
if (/billingUseCases/.test(app) || /billingUseCases/.test(route)) throw new Error("POST/PATCH still reference billingUseCases.ts");
if (/\.from\s*\(|\.rpc\s*\(/.test(app) || /\.from\s*\(|\.rpc\s*\(/.test(route)) throw new Error("route/application service owns database access");
if (!app.includes("postBillingInvoice") || !app.includes("patchBillingInvoice")) throw new Error("focused POST/PATCH entries missing");
console.log("billing POST/PATCH command boundary verified");
