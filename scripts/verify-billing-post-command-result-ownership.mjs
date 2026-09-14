import fs from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const read = file => fs.readFileSync(`${root}/${file}`, "utf8");
const save = read("src/server/billing-invoices/saveBillingInvoice.ts");
const app = read("src/server/billing-invoices/applicationService.ts");
const mutation = read("src/server/billing-invoices/billingMutationUseCases.ts");
const canonical = read("src/server/billing-invoices/billingSaveCanonicalizer.ts");
const command = read("src/server/billing-invoices/billingSaveCommandRepository.ts");
const mapper = read("src/server/billing-invoices/billingSaveResultMapper.ts");
const fail = message => { throw new Error(message); };
for (const token of ["saveStaffFinancialCommand", ".rpc(", ".from(", "NextResponse", "billingMutationUseCases", "JSON.parse("]) {
  if (save.includes(token)) fail(`saveBillingInvoice retains forbidden ownership: ${token}`);
}
if (app.includes("billingMutationUseCases")) fail("applicationService imports mutation monolith");
if (/StaffInvoiceSaveSchema|authorizeBillingSave|parseBillingSaveRequest/.test(mutation)) fail("mutation module retains POST front-half ownership");
if (/from \".*supabase|from \"next\//.test(canonical)) fail("canonicalizer imports runtime boundary");
if (!command.includes("saveStaffFinancialCommand")) fail("command repository does not own authoritative command");
if (/from \".*supabase|from \"next\//.test(mapper)) fail("result mapper imports runtime boundary");
console.log("billing POST command/result ownership guard: passed");
