"use client";

import { T } from "../../lib/constants";
import {
  isInvoiceController,
  type StaffPermissionProfile,
} from "../../lib/staffPermissions";
import ControllerExportPanel from "../invoices/ControllerExportPanel";
import DashboardWorkBuckets from "./DashboardWorkBuckets";
import PartsAlertSettings from "./PartsAlertSettings";
import type {
  DashboardInvoice,
  DashboardPart,
  DashboardWorkOrder,
} from "./workBuckets";

type DashboardProps = {
  page: string;
  isManager: boolean;
  workOrders: DashboardWorkOrder[];
  p1Unassigned: number;
  slaBreached: number;
  nav: (page: string) => void;
  onViewUnassigned: () => void;
  doAutoAssign: () => void | Promise<void>;
  invoices: Array<DashboardInvoice & { id: string }>;
  currentUser: StaffPermissionProfile | null | undefined;
  getUser: (id: string) => { company?: string | null; name?: string | null } | null;
  setSelectedWO: (workOrderId: string) => void;
  setAiNote: (note: null) => void;
  setPage: (page: string) => void;
  search: string;
  setSearch: (search: string) => void;
  woParts?: DashboardPart[];
  staffProfiles?: Array<{
    id: string;
    name: string;
    email?: string | null;
    active?: boolean | null;
  }>;
};

export default function Dashboard(props: DashboardProps) {
  const { page, isManager, workOrders, p1Unassigned, slaBreached, nav, onViewUnassigned, doAutoAssign, invoices, currentUser, getUser, setSelectedWO, setAiNote, setPage, search, setSearch, woParts = [], staffProfiles = [] } = props;
  const controller = isInvoiceController(currentUser);
  const unassignedCount = workOrders.filter(workOrder => workOrder.status === "unassigned").length;
  const hasUnassignedWork = unassignedCount > 0;
  const unassignedColor = hasUnassignedWork ? T.danger : T.success;
  const unassignedBackground = hasUnassignedWork ? T.dangerSoft : T.successSoft;
  return (
    <>
          {/* ═════ DASHBOARD ═════ */}
          {page === "dashboard" && isManager && (
            <div style={{ animation: "fadeUp 0.35s" }}>
              {!controller && (
                <section
                  className="card dashboard-unassigned-summary"
                  aria-label="Unassigned work orders"
                  aria-live="polite"
                  style={{
                    background: unassignedBackground,
                    border: `1px solid ${unassignedColor}44`,
                    padding: "16px 18px",
                    marginBottom: 12,
                  }}
                >
                  <div
                    aria-hidden="true"
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 11,
                      background: unassignedColor,
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 18,
                      fontWeight: 850,
                    }}
                  >
                    {hasUnassignedWork ? "!" : "✓"}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: T.ink, fontSize: 13, fontWeight: 850 }}>
                      Unassigned work orders
                    </div>
                    <div style={{ marginTop: 3, color: unassignedColor, fontSize: 18, fontWeight: 900 }}>
                      {unassignedCount} waiting
                    </div>
                    <div style={{ marginTop: 3, color: T.muted, fontSize: 10, lineHeight: 1.45 }}>
                      {hasUnassignedWork
                        ? `${p1Unassigned > 0 ? `${p1Unassigned} P1 critical. ` : ""}Includes all priorities and states that still need a contractor assignment.`
                        : "Every active work order currently has an assignment."}
                    </div>
                  </div>
                  <div className="dashboard-unassigned-summary-actions">
                    <button
                      type="button"
                      className="btn-soft dashboard-unassigned-summary-action"
                      onClick={onViewUnassigned}
                      style={{ borderColor: `${unassignedColor}44`, color: unassignedColor, background: T.surface }}
                    >
                      View unassigned →
                    </button>
                    {p1Unassigned > 0 && (
                      <button type="button" onClick={doAutoAssign} className="btn-accent dashboard-unassigned-summary-action">
                        Auto-dispatch
                      </button>
                    )}
                  </div>
                </section>
              )}
              {/* Operational alerts are outside the controller permission ceiling. */}
              {!controller && slaBreached > 0 && (
                <div className="card" style={{ background: T.dangerSoft, border: `1px solid ${T.danger}33`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: T.danger, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, animation: "pulse 1.6s infinite" }}>!</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, color: T.danger, fontSize: 13 }}>{slaBreached} SLA breach{slaBreached > 1 ? "es" : ""} — act now</div>
                    <div style={{ fontSize: 11, color: "#8B2C20", marginTop: 2 }}>7-Eleven KPI missed. Update functional status immediately to stop further damage.</div>
                  </div>
                  <button onClick={() => nav("work_orders")} className="btn-soft" style={{ borderColor: `${T.danger}33`, color: T.danger }}>View →</button>
                </div>
              )}
              <ControllerExportPanel
                invoices={invoices}
                currentUser={currentUser}
                compact
              />

              {!controller && (
                <>
                  <DashboardWorkBuckets
                    workOrders={workOrders}
                    invoices={invoices}
                    parts={woParts}
                    search={search}
                    setSearch={setSearch}
                    getUser={getUser}
                    onViewAll={() => nav("work_orders")}
                    onOpenWorkOrder={(workOrderId: string) => {
                      setSelectedWO(workOrderId);
                      setAiNote(null);
                      setPage("work_orders");
                    }}
                  />
                  <PartsAlertSettings staffProfiles={staffProfiles} />
                </>
              )}
            </div>
          )}



    </>
  );
}
