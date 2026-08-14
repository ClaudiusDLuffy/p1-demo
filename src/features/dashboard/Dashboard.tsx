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
  const { page, isManager, workOrders, p1Unassigned, slaBreached, nav, doAutoAssign, invoices, currentUser, getUser, setSelectedWO, setAiNote, setPage, search, setSearch, woParts = [], staffProfiles = [] } = props;
  const controller = isInvoiceController(currentUser);
  return (
    <>
          {/* ═════ DASHBOARD ═════ */}
          {page === "dashboard" && isManager && (
            <div style={{ animation: "fadeUp 0.35s" }}>
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
              {!controller && p1Unassigned > 0 && (
                <div className="card" style={{ background: T.accentSoft, border: `1px solid ${T.accentRing}`, padding: "14px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: T.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>⚡</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, color: T.accent, fontSize: 13 }}>{p1Unassigned} P1 Critical call{p1Unassigned > 1 ? "s" : ""} need dispatch</div>
                    <div style={{ fontSize: 11, color: "#8A4428", marginTop: 2 }}>8-hour SLA clock is running. Auto-dispatch or assign manually.</div>
                  </div>
                  <button onClick={doAutoAssign} className="btn-accent">Auto-dispatch all</button>
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
