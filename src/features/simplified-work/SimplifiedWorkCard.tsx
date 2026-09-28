import { Badge } from "../../components/ui/Badge";
import { PRIORITY, STATUS } from "../../lib/constants";
import { capitalProjectStage } from "../work-orders/capitalProjectStage";
import type { WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";
import { isResolutionBreached, nextActionLabel } from "./simplifiedWorkModel";

type SimplifiedWorkCardProps = {
  contractorName: string;
  onOpen: (workOrderId: string) => void;
  workOrder: WorkOrderReadModel;
  showBreach?: boolean;
};

export function SimplifiedWorkCard({ contractorName, onOpen, workOrder, showBreach = false }: SimplifiedWorkCardProps) {
  const status = STATUS[workOrder.status] || STATUS.assigned;
  const priority = PRIORITY[workOrder.priority] || PRIORITY.p4;
  const capital = workOrder.isCapital || ["capital", "pending_capital_completion"].includes(workOrder.status)
    ? capitalProjectStage(workOrder)
    : null;

  return (
    <article className="overflow-hidden rounded-[13px] border border-p1-border bg-p1-surface">
      <button
        type="button"
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 bg-transparent p-[13px] text-left text-p1-ink transition-colors hover:bg-p1-surface-soft min-[701px]:grid-cols-[145px_minmax(0,1fr)_minmax(150px,.8fr)] min-[701px]:gap-4 min-[701px]:px-[18px] min-[701px]:py-4 min-[901px]:grid-cols-[minmax(145px,.7fr)_minmax(220px,1.6fr)_minmax(180px,1fr)_auto]"
        onClick={() => onOpen(workOrder.id)}
        aria-label={`Open ${workOrder.id}`}
      >
        <div className="grid min-w-0 gap-1">
          <strong className="font-mono text-xs text-p1-accent">{workOrder.id}</strong>
          <span className="overflow-hidden text-ellipsis text-[10px] whitespace-nowrap text-p1-muted">
            {workOrder.store ? `Store #${workOrder.store}` : "Store not listed"}
            {workOrder.city ? ` · ${workOrder.city}` : ""}
          </span>
        </div>

        <div className="col-span-full flex flex-wrap gap-1 min-[781px]:col-span-1">
          <Badge conf={{ ...priority, label: priority.short }} small />
          <Badge conf={status} small />
          {showBreach && isResolutionBreached(workOrder) && (
            <span className="rounded-full border border-[#ebc3bc] bg-p1-danger-soft px-[7px] py-[3px] text-[9px] font-extrabold text-p1-danger">
              Resolution breached
            </span>
          )}
          {capital && (
            <span className="rounded-full border border-[#d4c9e8] bg-p1-violet-soft px-[7px] py-[3px] text-[9px] font-extrabold text-p1-violet">
              {capital.label}
            </span>
          )}
        </div>

        <div className="col-span-full min-w-0 min-[701px]:col-span-1">
          <h2 className="mb-1.5 text-[13px] font-bold min-[701px]:overflow-hidden min-[701px]:text-ellipsis min-[701px]:whitespace-nowrap">
            {workOrder.summary || workOrder.description || "Work order details"}
          </h2>
          <p className="m-0 text-[10px] text-p1-muted min-[701px]:overflow-hidden min-[701px]:text-ellipsis min-[701px]:whitespace-nowrap">
            {workOrder.lineOfService || "Service"} · {workOrder.technicianOnJob || contractorName}
          </p>
        </div>

        <div className="col-span-full grid min-w-0 gap-1 border-t border-p1-border-soft pt-[9px] min-[701px]:col-span-1 min-[701px]:border-0 min-[701px]:pt-0">
          <span className="text-[9px] font-extrabold tracking-[.6px] text-p1-subtle uppercase">Next action</span>
          <strong className="text-[11px] leading-[1.4]">{nextActionLabel(workOrder)}</strong>
        </div>

        <span className="hidden text-[10px] font-extrabold whitespace-nowrap text-p1-accent min-[901px]:inline">View details →</span>
      </button>
    </article>
  );
}
