import { readFileSync } from "node:fs";

for (const file of ["src/app/api/billing-invoices/route.ts", "src/server/billing-invoices/applicationService.ts", "src/server/billing-invoices/contracts.ts"]) {
  if (readFileSync(file, "utf8").includes("legacyRouteImplementation")) throw new Error(`${file}: billing legacy route remains in the production graph`);
}
console.log("billing true ownership verified");
