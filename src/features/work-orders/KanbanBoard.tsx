"use client";
// @ts-nocheck

import { Badge } from "../../components/ui/Badge";
import { Ico } from "../../components/ui/Ico";
import { NewNotesDot } from "../../components/ui/NewNotesDot";
import { SevenElevenSyncBadge } from "../../components/ui/SevenElevenSyncBadge";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { CapitalWorkOrderBadge } from "../../components/ui/CapitalWorkOrderBadge";
import { SlaBadge } from "../../components/SlaBadge";
import { T, PRIORITY, STATUS } from "../../lib/constants";
import { getSlaAgingStyle, getWorkOrderDateMeta, sortWorkOrders } from "../../lib/workOrderView";
import { useMemo } from "react";

export default function KanbanBoard(props: any) {
  const { filteredWOs, activeStatuses, closingStatuses, getUser, slaLabel, setSelectedWO, setAiNote, setPage, isManager } = props;
  const cardsByStatus = useMemo(() => {
    const grouped: Record<string, any[]> = {};
    for (const w of filteredWOs) {
      (grouped[w.status] ||= []).push(w);
    }
    for (const key of Object.keys(grouped)) {
      grouped[key] = sortWorkOrders(grouped[key], "sla_due");
    }
    return grouped;
  }, [filteredWOs]);

  const renderCard = (wo: any) => {
    const pr = PRIORITY[wo.priority];
    const st = STATUS[wo.status];
    const sla = slaLabel(wo);
    const dates = getWorkOrderDateMeta(wo);
    const aging = getSlaAgingStyle(wo);
    return (
      <div key={wo.id} className="kcard" onClick={() => { setSelectedWO(wo.id); setAiNote(null); if (!isManager) setPage("wo_detail"); else setPage("work_orders"); }} style={{ position: "relative", padding: "12px 14px 12px 16px", borderRadius: 12, marginBottom: 8, cursor: "pointer", borderColor: aging.ring || st?.ring || T.borderSoft }}>
        <div style={{ position: "absolute", left: 0, top: 10, bottom: 10, width: 3, borderRadius: 2, background: st?.color || pr?.color || T.subtle }} />
        <div className="kanban-card-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, minWidth: 0 }}>
          <span className="kanban-card-id-row" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, maxWidth: "100%", flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: T.subtle, letterSpacing: 0.2 }}>{wo.id}</span>
            <CopyWorkOrderButton value={wo.id} />
            {isManager && <NewNotesDot show={wo.hasUnreadNotes} />}
            {isManager && <SevenElevenSyncBadge count={wo.pendingSevenElevenSyncCount} />}
          </span>
          <div className="kanban-card-flags" style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", justifyContent: "flex-end", minWidth: 0, maxWidth: "100%" }}>
            <span className="kanban-card-status" style={{ fontSize: 10, fontWeight: 700, color: st?.color, background: st?.bg, border: `1px solid ${st?.ring || st?.color}55`, borderRadius: 10, padding: "2px 6px", maxWidth: "100%", boxSizing: "border-box", lineHeight: 1.2 }}>{st?.label}</span>
            <CapitalWorkOrderBadge workOrder={wo} small />
            <span className="kanban-card-priority" style={{ fontSize: 11, fontWeight: 700, color: pr?.color, flexShrink: 0 }}>{pr?.short}</span>
          </div>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.ink, marginBottom: 3 }}>{wo.store ? `Store #${wo.store}` : wo.id}</div>
        <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{wo.summary || "—"}</div>
        <div style={{ marginTop: 8, display: "grid", gap: 3, fontSize: 10, color: T.subtle, lineHeight: 1.35 }}>
          <div>Created <span style={{ color: T.muted, fontWeight: 600 }}>{dates.created}</span></div>
          <div>Updated <span style={{ color: T.muted, fontWeight: 600 }}>{dates.updated}</span></div>
          <div style={{ color: aging.color, background: aging.bg, border: `1px solid ${aging.ring}66`, borderRadius: 8, padding: "3px 6px", fontWeight: 700 }}>
            SLA due <span>{dates.slaDue}</span>
          </div>
        </div>
        {wo.technicianOnJob && <div style={{ fontSize: 10, color: T.subtle, marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}><Ico d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" size={10} color={T.subtle} />{wo.technicianOnJob}</div>}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, paddingTop: 8, borderTop: `1px solid ${T.borderSoft}`, fontSize: 11, gap: 6 }}>
          <span style={{ fontWeight: 600, color: wo.contractor ? T.inkSoft : T.subtle }}>{wo.contractor ? getUser(wo.contractor)?.name.split(" ")[0] : "Unassigned"}</span>
          {(wo.responseBreachAt || wo.resolutionBreachAt)
            ? <SlaBadge responseBreachAt={wo.responseBreachAt} resolutionBreachAt={wo.resolutionBreachAt} responseMetAt={wo.startTimeRaw} size="sm" />
            : sla && <span style={{ fontSize: 10, fontWeight: 700, color: sla.color, background: sla.bg, padding: "2px 8px", borderRadius: 10, border: `1px solid ${sla.color}20` }}>{sla.text}</span>}
        </div>
      </div>
    );
  };

  const renderKanbanCol = (sk: string) => {
    const c = STATUS[sk];
    const cards = cardsByStatus[sk] || [];
    // Unassigned is the manual-dispatch triage bucket (Florida HVAC etc. have
    // no auto-routed vendor). Give it an explicit subtitle so it reads as
    // a deliberate queue, not an empty default.
    const isTriage = sk === "unassigned";
    return (
      <div key={sk} className="kcol" style={{ background: c.bg }} title={isTriage ? "Work orders with no auto-assigned vendor land here for manual dispatch." : undefined}>
        <div style={{ padding: "14px 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
            <div style={{ width: 9, height: 9, borderRadius: "50%", background: c.color, flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.ink, letterSpacing: -0.1 }}>{c.label}</div>
              {isTriage && <div style={{ fontSize: 9, fontWeight: 600, color: T.muted, letterSpacing: 0.4, textTransform: "uppercase", marginTop: 2 }}>Needs manual dispatch</div>}
            </div>
          </div>
          <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: c.color, background: T.surface, border: `1px solid ${c.ring || c.color}33`, borderRadius: 20, padding: "3px 10px", minWidth: 24, textAlign: "center" }}>{cards.length}</span>
        </div>
        <div style={{ padding: "0 10px 10px", minHeight: 60 }}>
          {cards.map(renderCard)}
          {cards.length === 0 && <div style={{ textAlign: "center", padding: "24px 0", fontSize: 11, color: T.subtle, fontWeight: 500 }}>{isTriage ? "No work orders awaiting dispatch" : "No items"}</div>}
        </div>
      </div>
    );
  };



  return (
    <>
      <div className="kanban-active" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 32 }}>
        {activeStatuses.map(renderKanbanCol)}
      </div>
      <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.4, color: T.muted, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 18, height: 2, background: T.border, display: "inline-block", borderRadius: 2 }} />Closing pipeline
      </div>
      <div className="kanban-closing" style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 12 }}>
        {closingStatuses.map(renderKanbanCol)}
      </div>
    </>
  );
}
