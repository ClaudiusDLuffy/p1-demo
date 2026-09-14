// Exact current render conditions from WorkOrderDetail and the shell-owned
// forms that consume woData. Selection stays cached when its view is hidden.
export const WORK_ORDER_DETAIL_VIEWS = ["work_orders", "wo_detail", "history"] as const;
const WORK_ORDER_FORMS = new Set(["setEta", "reassign", "unassign", "rejectUnassignedWO", "deleteWO", "duplicateForReassignment",
  "closeWithoutInvoice", "closeReopenedFollowUp", "editWO", "startWork", "pauseWork", "closeComplete", "createInvoice", "createBillingInvoice"]);
export function selectedWorkOrderReadVisible(page: string, modal: string | null): boolean {
  return WORK_ORDER_DETAIL_VIEWS.some(view => view === page) || (modal !== null && WORK_ORDER_FORMS.has(modal));
}
export function selectedWorkOrderDetailVisible(page: string): boolean {
  return WORK_ORDER_DETAIL_VIEWS.some(view => view === page);
}
