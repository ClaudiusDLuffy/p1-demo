import type { BillingSourceRepository, BillingSourceLoadRequest, BillingSourceReadModel } from "../../server/billing-invoices/billingSourceRepository";
import type { BillingFinancialInputRepository, BillingFinancialInputRequest, BillingFinancialInputReadModel } from "../../server/billing-invoices/billingFinancialInputRepository";
import type { BillingInputRepositoryContext } from "../../server/billing-invoices/billingInputValidation";

type FakeControls = { error?: Error; onLoad?: (context: BillingInputRepositoryContext) => void };

export function createFakeBillingSourceRepository(result: BillingSourceReadModel, controls: FakeControls = {}) {
  if (!result || !Array.isArray(result.sourceInvoiceIds) || result.sourceInvoiceIds.some(id => typeof id !== "string")) {
    throw new Error("An explicit typed source fixture is required");
  }
  const calls: BillingSourceLoadRequest[] = [];
  const contexts: BillingInputRepositoryContext[] = [];
  const repository: BillingSourceRepository = {
    async loadForSave(input, context) {
      context.signal?.throwIfAborted();
      calls.push({ ...input, sourceInvoiceIds: [...input.sourceInvoiceIds] }); contexts.push(context);
      controls.onLoad?.(context);
      context.signal?.throwIfAborted();
      if (controls.error) throw controls.error;
      return { sourceInvoiceIds: [...result.sourceInvoiceIds] };
    },
  };
  return { repository, calls, contexts };
}
export function createFakeBillingFinancialInputRepository(result: BillingFinancialInputReadModel, controls: FakeControls = {}) {
  if (!result || !["standalone", "work_order"].includes(result.kind)
    || (result.kind === "standalone" ? result.workOrderId !== null
      : typeof result.workOrderId !== "string" || !Number.isSafeInteger(result.assignmentVersion)
        || !Number.isSafeInteger(result.workflowCycle) || result.assignmentVersion < 0 || result.workflowCycle < 0
        || !(result.duplicateRootWorkOrderId === null || typeof result.duplicateRootWorkOrderId === "string")
        || !(result.storeState === null || typeof result.storeState === "string"))) {
    throw new Error("An explicit typed financial-input fixture is required");
  }
  const calls: BillingFinancialInputRequest[] = [];
  const contexts: BillingInputRepositoryContext[] = [];
  const repository: BillingFinancialInputRepository = {
    async loadForSave(input, context) {
      context.signal?.throwIfAborted();
      calls.push({ ...input }); contexts.push(context);
      controls.onLoad?.(context);
      context.signal?.throwIfAborted();
      if (controls.error) throw controls.error;
      return { ...result };
    },
  };
  return { repository, calls, contexts };
}
