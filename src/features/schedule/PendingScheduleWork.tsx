"use client";

import { useState, type DragEvent } from "react";
import type { WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";

type PendingScheduleWorkProps = {
  workOrders: readonly WorkOrderReadModel[];
  onOpenWorkOrder: (workOrderId: string) => void;
  onSchedule: (workOrder: WorkOrderReadModel) => void;
};

function startWorkOrderDrag(event: DragEvent<HTMLElement>, workOrderId: string) {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/work-order-id", workOrderId);
}

export function PendingScheduleWork({ workOrders, onOpenWorkOrder, onSchedule }: PendingScheduleWorkProps) {
  const [page, setPage] = useState(0);
  const pageSize = 3;
  const lastPage = Math.max(0, Math.ceil(workOrders.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = workOrders.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  return (
    <section id="pending-schedule-work" className="mb-3.5 rounded-[14px] border border-p1-border bg-p1-surface-soft p-[11px] min-[481px]:p-[15px]" aria-labelledby="pending-schedule-heading">
      <div className="mb-[11px] flex justify-between gap-3">
        <div>
          <h2 id="pending-schedule-heading" className="m-0 mb-[3px] text-sm font-bold">Pending work</h2>
          <p className="m-0 text-[10px] text-p1-muted">Drag on desktop or tap Schedule on mobile.</p>
        </div>
      </div>

      {workOrders.length === 0 ? (
        <p className="m-0 text-xs text-p1-muted">No currently loaded work is awaiting an ETA.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 min-[701px]:grid-cols-2 min-[901px]:grid-cols-3">
          {visible.map(workOrder => (
            <article
              key={workOrder.id}
              className="grid min-w-0 gap-[9px] rounded-[11px] border border-p1-border bg-p1-surface p-2.5 min-[481px]:p-3"
              draggable
              onDragStart={event => startWorkOrderDrag(event, workOrder.id)}
            >
              <div className="grid gap-[3px]">
                <strong className="font-mono text-[11px] text-p1-accent">{workOrder.id}</strong>
                <span className="overflow-hidden text-ellipsis text-[9px] whitespace-nowrap text-p1-muted">
                  {workOrder.store ? `Store #${workOrder.store}` : workOrder.city || "Assigned work"}
                </span>
              </div>
              <p className="m-0 hidden overflow-hidden text-[10px] leading-[1.4] text-p1-ink-soft min-[481px]:[-webkit-box-orient:vertical] min-[481px]:[-webkit-line-clamp:2] min-[481px]:[display:-webkit-box]">
                {workOrder.summary || workOrder.description || "Work order details"}
              </p>
              <div className="mt-auto flex gap-1.5">
                <button type="button" className="btn-soft min-h-11 flex-1 px-2 py-1.5 text-xs" onClick={() => onOpenWorkOrder(workOrder.id)}>Details</button>
                <button type="button" className="btn-accent min-h-11 flex-1 px-2 py-1.5 text-xs" onClick={() => onSchedule(workOrder)}>Schedule</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {lastPage > 0 && (
        <nav className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-p1-muted" aria-label="Pending work pages">
          <button type="button" className="btn-soft min-h-11" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous work</button>
          <span aria-live="polite">{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, workOrders.length)} of {workOrders.length}</span>
          <button type="button" className="btn-soft min-h-11" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next work</button>
        </nav>
      )}
    </section>
  );
}
