import fs from "node:fs";
const root = new URL("..", import.meta.url).pathname;
const read = p => fs.readFileSync(`${root}/${p}`, "utf8");
const app = read("src/server/billing-invoices/applicationService.ts");
const legacy = read("src/server/billing-invoices/billingMutationUseCases.ts");
if (app.includes("billingMutationUseCases") || legacy.includes("saveStaffFinancialCommand")) throw new Error("billing route still depends on mutation monolith");
for (const method of ["GET", "POST", "PATCH", "DELETE"]) if (!app.includes(`${method}:`)) throw new Error(`missing ${method} dispatch`);
console.log("billing route true ownership guard: passed");
