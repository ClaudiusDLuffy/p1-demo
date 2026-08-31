import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0103_combined_contractor_completion.sql");
const audit = read("supabase/audits/0103_combined_contractor_completion_verification.sql");
const dataLayer = read("src/lib/db.ts");
const hook = read("src/features/work-orders/useWorkOrders.ts");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const shell = read("src/components/PortalShell.tsx");
const completionControl = read("src/lib/contractorCompletion.ts");
const billingDetail = read("src/features/billing/BillingInvoiceDetail.tsx");

const rpcStart = migration.indexOf(
  "create or replace function public.complete_contractor_work_and_invoicing",
);
const rpc = migration.slice(rpcStart);
const completionCall = rpc.indexOf("public.complete_work_order_once(");
const invoicingCall = rpc.indexOf("public.finish_contractor_invoicing(");

test("contractor work and invoicing finish in one atomic database action", () => {
  assert.ok(rpcStart >= 0);
  assert.match(rpc, /language plpgsql[\s\S]*security definer/);
  assert.match(rpc, /set search_path = public, pg_temp/);
  assert.match(rpc, /profile\.active = true[\s\S]*profile\.role = 'contractor'/);
  assert.match(rpc, /can_invoice_for_contractor\(v_account_id\)/);
  assert.match(rpc, /can_access_contractor_work_order\(p_work_order_id\)/);
  assert.match(rpc, /from public\.work_orders work_order[\s\S]*for update/);
  assert.ok(completionCall >= 0);
  assert.ok(invoicingCall > completionCall);
  assert.match(rpc, /if v_work_order\.functional_status::text = 'Completed'[\s\S]*'already_completed'/);
  assert.doesNotMatch(rpc, /exception\s+when/i);
});

test("the combined action is contractor-only and not anonymously executable", () => {
  assert.match(rpc, /v_work_order\.contractor_id is distinct from v_account_id/);
  assert.match(rpc, /billing-only work orders do not require field-work completion/i);
  assert.match(
    rpc,
    /status in \([\s\S]*'assigned'[\s\S]*'parts'[\s\S]*'closed'[\s\S]*'capital'[\s\S]*'pending_capital_completion'/,
  );
  assert.match(
    migration,
    /revoke all on function public\.complete_contractor_work_and_invoicing\([\s\S]*from public, anon/,
  );
  assert.match(
    migration,
    /grant execute on function public\.complete_contractor_work_and_invoicing\([\s\S]*to authenticated, service_role/,
  );
});

test("invoice-capable contractors call the combined RPC and patch only after commit", () => {
  assert.match(dataLayer, /rpc\([\s\S]*"complete_contractor_work_and_invoicing"/);
  assert.match(hook, /currentUser\?\.canInvoice === true/);
  assert.match(hook, /await completeContractorWorkAndInvoicing\(woId/);
  const callIndex = hook.indexOf("await completeContractorWorkAndInvoicing(woId");
  const patchIndex = hook.indexOf("patchLocalWO(woId", callIndex);
  assert.ok(callIndex >= 0 && patchIndex > callIndex);
  assert.match(hook, /Could not complete work and invoicing/);
  assert.match(hook, /existing\?\.functionalStatus === "Completed" \? \{\} : patch/);
});

test("the portal exposes one combined contractor control while preserving exceptions", () => {
  assert.match(detail, /getContractorCompletionControl/);
  assert.match(detail, /contractorCompletionControl\.visible/);
  assert.match(detail, /contractorCompletionControl\.action === "create_invoice"[\s\S]*openCreate\(null\)/);
  assert.match(detail, /\["finish_invoice", "correct_invoice"\]\.includes[\s\S]*openCreate\(contractorInvoiceRequiringAttention\)/);
  assert.match(detail, /contractorCompletionControl\.action === "complete" && contractorCompletionControl\.enabled[\s\S]*setModal\("closeComplete"\)/);
  assert.doesNotMatch(detail, /disabled=\{!contractorCompletionControl\.enabled/);
  assert.match(detail, /canInvoice && !contractorCompletionGuidesInvoice/);
  assert.match(detail, /woAllInvoices\.length > 0 \|\| contractorCompletionControl\.visible/);
  assert.match(completionControl, /action: "create_invoice" \| "finish_invoice" \| "correct_invoice" \| "complete" \| null/);
  assert.match(completionControl, /Create invoice to complete job/);
  assert.match(completionControl, /Finish invoice to complete job/);
  assert.match(completionControl, /Correct invoice to complete job/);
  assert.match(completionControl, /Complete work & invoicing/);
  assert.match(detail, /Complete work & invoicing/);
  assert.match(detail, /!canInvoice && woData\.status !== "completed"/);
  assert.match(detail, /woData\?\.billingOnly && canFinishInvoicing/);
  assert.match(shell, /title=\{combinesContractorCompletion \? "Complete work & invoicing" : "Mark work complete"\}/);
  assert.match(shell, /This confirms that every contractor invoice/);
  assert.match(shell, /Once every invoice for this job is submitted/);
  assert.match(shell, /if \(completed !== false\) setModal\(null\)/);
  assert.match(detail, /setModal\("closeWithoutInvoice"\)/);
  assert.match(detail, /Close — no invoice/);
  assert.doesNotMatch(detail, /setModal\("closeWO"\)/);
  assert.match(billingDetail, /Billed to 7-Eleven/);
  assert.match(billingDetail, /close its linked work order/);
});

test("the deployment audit verifies authorization and atomic composition", () => {
  assert.match(audit, /combined_completion_rpc_present/);
  assert.match(audit, /active_contractor_required/);
  assert.match(audit, /assignment_and_invoice_scope_required/);
  assert.match(audit, /valid_work_state_required/);
  assert.match(audit, /atomic_composition_present/);
  assert.match(audit, /staff_no_invoice_close_preserved/);
  assert.match(audit, /as all_checks_pass/);
});
