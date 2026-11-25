import { loadInvoicesPage } from "../../lib/db";
import { readBillingRows } from "../billing/billingReads";
import { loadWorkOrderActivitiesPage } from "./data/activityReadRepository";
import type { ActivityReadWorkOrder } from "./data/activityReadContracts";
import { loadWorkOrderVisitsPage } from "./data/visitReadRepository";
import { collectCloseOutEvidencePages } from "./closeOutEvidencePages";

/** Existing bounded, actor-authorized reads only. No invoice lines, counts,
 * photos, writes, submission attestations, or provider calls are requested. */
export async function loadCapitalCloseOutEvidence(
  work: NonNullable<ActivityReadWorkOrder> & { workflowCycle?: number }, signal: AbortSignal,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.throwIfAborted(); signal.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, 60_000);
  const current = controller.signal;
  try {
    const [activities, visits, contractorInvoices, invoices] = await Promise.all([
      collectCloseOutEvidencePages(cursor => loadWorkOrderActivitiesPage(work, cursor, 100, current), current),
      collectCloseOutEvidencePages(cursor => loadWorkOrderVisitsPage(work.id, cursor, 100, current), current),
      collectCloseOutEvidencePages(cursor => loadInvoicesPage({ workOrderId: work.id, state: "all", sort: "recent", limit: 100, cursor }, current), current),
      collectCloseOutEvidencePages(cursor => readBillingRows({ workOrderId: work.id, queue: "work_order", sort: "recent", limit: 100, cursor }, current), current),
    ]);
    current.throwIfAborted();
    const documents = invoices.map(invoice => ({ ...invoice, submissionRecorded: activities.some(activity => {
      const data = activity.eventData;
      return activity.eventKey === "capital_quote_submitted" && data !== null && typeof data === "object" && !Array.isArray(data)
        && data.invoiceId === invoice.id && activity.workflowCycle === (work.workflowCycle ?? 0);
    }) }));
    return { documents, visits,
      hasUnresolvedContractorInvoices: contractorInvoices.some(invoice => !["approved", "paid"].includes(invoice.state)),
      hasPendingSevenElevenSync: activities.some(activity => activity.requiresSevenElevenSync && !activity.syncedToSevenElevenAt),
      hasPendingContractorAttention: activities.some(activity => activity.requiresContractorAttention && !activity.contractorAcknowledgedAt),
    };
  } finally {
    clearTimeout(deadline); signal.removeEventListener("abort", abort); controller.abort();
  }
}
