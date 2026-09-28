import { Badge } from "../../components/ui/Badge";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { PRIORITY, STATUS } from "../../lib/constants";
import { capitalProjectStage } from "../work-orders/capitalProjectStage";
import type { WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";
import { AttachmentsButton } from "../work-orders/WorkOrderAttachments";

type HeaderWorkOrder = Pick<WorkOrderReadModel, "id" | "store" | "city" | "addr" | "summary" | "description" | "status" | "priority" | "functionalStatus" | "capitalStatus" | "isCapital" | "technicianOnJob">;

export function FocusedWorkOrderHeader({ workOrder, eta }: { workOrder: HeaderWorkOrder; eta: string }) {
  const capital = workOrder.isCapital || ["capital", "pending_capital_completion"].includes(workOrder.status);
  return (
    <header className="mb-4 min-w-0 rounded-xl border border-p1-border bg-p1-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="work-order-reference font-mono text-sm font-bold text-p1-accent">{workOrder.id}</span>
        <CopyWorkOrderButton value={workOrder.id} />
        <div className="ml-auto"><AttachmentsButton /></div>
      </div>
      <h1 className="mt-2 text-xl font-semibold break-words text-p1-ink">Store #{workOrder.store || "—"} · {workOrder.city || "Location not set"}</h1>
      <p className="mt-1 text-xs break-words text-p1-muted">{workOrder.addr}</p>
      <div className="my-3 flex flex-wrap gap-2">
        <Badge conf={PRIORITY[workOrder.priority]} />
        <Badge conf={STATUS[workOrder.status]} />
        {workOrder.functionalStatus && <span className="text-xs text-p1-muted">7-Eleven: {workOrder.functionalStatus}</span>}
        {capital && <span className="rounded bg-p1-violet-soft px-2 py-1 text-xs text-p1-violet">{capitalProjectStage(workOrder).label}</span>}
      </div>
      <p className="text-sm break-words text-p1-ink">{workOrder.summary || workOrder.description}</p>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-p1-muted">
        <span>Technician: {workOrder.technicianOnJob || "Not set"}</span>
        <span>ETA: {eta || "Not set"}</span>
      </div>
    </header>
  );
}
