import { readFileSync } from "node:fs";

const routes = ["billing-invoices", "controller-exports"];
for (const route of routes) {
  const source = readFileSync(`src/app/api/${route}/route.ts`, "utf8");
  const facade = route === "controller-exports" ? "httpBoundary" : "applicationService";
  if (!source.includes(facade)) throw new Error(`${route}: missing ${facade}`);
  if (source.includes("legacyRouteImplementation")) throw new Error(`${route}: route imports legacy implementation`);
}
if (!readFileSync("src/server/controller-exports/httpBoundary.ts", "utf8").includes('from "./applicationService"')) {
  throw new Error("Controller HTTP boundary does not dispatch to the typed application service");
}
for (const file of ["src/server/billing-invoices/applicationService.ts", "src/server/controller-exports/applicationService.ts"]) {
  const source = readFileSync(file, "utf8");
  if (source.includes("legacyRouteImplementation")) throw new Error(`${file}: legacy monolith remains in production graph`);
  if (source.includes("next/server")) throw new Error(`${file}: imports Next request/response types`);
}
console.log("true ownership verified");
