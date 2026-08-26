"use client";

import { useId, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { T, PRIORITY, STATUS } from "../../lib/constants";
import type { StoreHistoryWorkOrder } from "../../lib/storeWorkOrderHistory";

const dateLabel = (value: string | null | undefined): string => {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

export default function StoreWorkOrderHistory({
  currentWorkOrderId,
  storeNumber,
  rows,
  totalCount,
  loading = false,
  failed = false,
  getUser,
  onOpenWorkOrder,
  onViewAll,
}: {
  currentWorkOrderId: string;
  storeNumber: string;
  rows: StoreHistoryWorkOrder[];
  totalCount: number;
  loading?: boolean;
  failed?: boolean;
  getUser?: (profileId: string) => { name?: string | null } | null | undefined;
  onOpenWorkOrder?: (workOrderId: string) => void;
  onViewAll?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();

  return (
    <section className="card" aria-label={`Store ${storeNumber} work-order history`} style={{ padding: 18, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: expanded ? 12 : 0 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: T.ink }}>
            Store work-order history · {totalCount}
          </div>
          <div style={{ fontSize: 10, color: T.subtle, marginTop: 3, lineHeight: 1.45 }}>
            Current and previous calls for Store #{storeNumber}. Review prior equipment and contractor details before assigning.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn-soft"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setExpanded(value => !value)}
          >
            {expanded ? "Collapse history" : "Expand history"}
          </button>
          <button type="button" className="btn-soft" onClick={onViewAll} disabled={!onViewAll}>
            View all store calls
          </button>
        </div>
      </div>

      {expanded && (
        <div id={contentId}>
          {loading && rows.length <= 1 && (
            <div role="status" style={{ padding: "12px 0", fontSize: 11, color: T.muted }}>
              Loading previous store calls…
            </div>
          )}

          {failed && rows.length <= 1 && (
            <div role="alert" style={{ padding: "10px 12px", borderRadius: 9, background: T.dangerSoft, color: T.danger, fontSize: 11 }}>
              Previous store calls could not be loaded. Use “View all store calls” to retry in Work Orders.
            </div>
          )}

          <div style={{ display: "grid", gap: 8 }}>
            {rows.map(workOrder => {
          const current = workOrder.id === currentWorkOrderId;
          const status = STATUS[workOrder.status as keyof typeof STATUS]
            || { label: workOrder.status || "Unknown", color: T.muted, bg: T.borderSoft, ring: T.border };
          const priority = workOrder.priority
            ? PRIORITY[workOrder.priority as keyof typeof PRIORITY]
            : null;
          const contractorName = workOrder.contractor
            ? getUser?.(workOrder.contractor)?.name || "Assigned contractor"
            : "Unassigned";
          const equipment = [
            workOrder.category,
            workOrder.subCategory,
            workOrder.assetModel ? `Model ${workOrder.assetModel}` : null,
            workOrder.assetSerial ? `Serial ${workOrder.assetSerial}` : null,
          ].filter(Boolean).join(" · ");

              return (
            <button
              key={workOrder.id}
              type="button"
              aria-current={current ? "true" : undefined}
              onClick={() => {
                if (!current) onOpenWorkOrder?.(workOrder.id);
              }}
              disabled={current || !onOpenWorkOrder}
              style={{
                width: "100%",
                padding: "11px 12px",
                border: `1px solid ${current ? T.accentRing : T.borderSoft}`,
                borderRadius: 10,
                background: current ? T.accentSoft : T.surfaceSoft,
                color: T.ink,
                textAlign: "left",
                fontFamily: "inherit",
                cursor: current || !onOpenWorkOrder ? "default" : "pointer",
                opacity: 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                  <span className="mono" style={{ fontSize: 11, fontWeight: 800, color: T.accent }}>{workOrder.id}</span>
                  {current && <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: T.accent }}>Current call</span>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {priority && <Badge conf={priority} />}
                  <Badge conf={status} />
                </div>
              </div>
              <div style={{ marginTop: 7, fontSize: 11, fontWeight: 650, color: T.inkSoft, lineHeight: 1.45 }}>
                {workOrder.summary || workOrder.description || equipment || "No work summary provided"}
              </div>
              {equipment && (workOrder.summary || workOrder.description) && (
                <div style={{ marginTop: 3, fontSize: 10, color: T.muted, lineHeight: 1.4 }}>{equipment}</div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginTop: 7, fontSize: 10, color: T.subtle }}>
                <span>{contractorName}</span>
                <span>Created {dateLabel(workOrder.createdAt)}</span>
              </div>
            </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
