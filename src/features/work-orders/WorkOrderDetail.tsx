"use client";
// @ts-nocheck

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Modal } from "../../components/ui/Modal";
import { Input } from "../../components/ui/Input";
import { Sel } from "../../components/ui/Sel";
import { TA } from "../../components/ui/TA";
import { Badge } from "../../components/ui/Badge";
import { Avatar } from "../../components/ui/Avatar";
import { Field } from "../../components/ui/Field";
import { Ico } from "../../components/ui/Ico";
import { BtnSpinner, BtnSpinnerDark } from "../../components/ui/BtnSpinner";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { SlaBadge } from "../../components/SlaBadge";
import { T, PRIORITY, STATUS, FUNCTIONAL_STATUS, MONTHS, P1_BUSINESS, SEVEN_BILL_TO } from "../../lib/constants";
import { computeSlaState } from "../../lib/slaConfig";
import { timezoneForWorkOrder } from "../../lib/billingRules";
import {
  getSlaAgingStyle,
  getWorkOrderDateMeta,
  getWorkOrderProgressSteps,
  isInternalWorkOrderActivity,
} from "../../lib/workOrderView";
import PhotoGallery from "../photos/PhotoGallery";

const WorkReportForm = dynamic(
  () => import("./WorkReportForm"),
  { ssr: false }
);
const CapitalFlagModal = dynamic(
  () => import("./CapitalFlagModal"),
  { ssr: false }
);
const QuoteCalculator = dynamic(
  () => import("./QuoteCalculatorWorkspace"),
  { ssr: false }
);

// ETA is stored as an ISO timestamp (timestamptz). Render it in the user's
// locale. Falls through to the raw string for any legacy non-ISO value so
// historic rows still display.
const formatEta = (v: any, workOrder?: any): string => {
  if (!v) return "";
  const s = String(v);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("en-US", {
    timeZone: timezoneForWorkOrder(workOrder),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
};

export default function WorkOrderDetail(props: any) {
  const { page, selectedWO, woData, workOrders, invoices, billingInvoices = [], technicians, USERS = [], modal, isManager, setSelectedWO, setSelectedInvoice, setAiNote, setPage, slaLabel, slaRemaining, fmt, getUser, contractorsOnly, doAssign, doStraightToBilling, setReassignTarget, setModal, doCapitalFlag, doCapitalDecline, doMoveToInvoice, doApproveInvoice, doMarkPaid, doCloseWO, doDownloadInvoice, doDeleteInvoice, doRejectInvoice, openCreateInvoice, onConvertQuote, pdfBusy, activityMenuId, setActivityMenuId, setPendingDelete, currentUser, fire, aiNote, aiEnhancing, doAiEnhance, noteText, setNoteText, doPostNote, doSetTechnician, imageErrors, setImageErrors, setLightbox, doAddPhotos, doRemovePhoto, doDeleteActivity, doSetEta, doStartWork, doPauseWork, doCloseComplete, doMarkSevenElevenSynced, doMarkContractorAttention, doAcknowledgeContractorAttention, startDateInput, setStartDateInput, startTimeInput, setStartTimeInput, pauseDateInput, setPauseDateInput, pauseTimeInput, setPauseTimeInput, loadingStates = {}, woParts = [], doAddPart, doUpdatePart, doDeletePart } = props;
  const openCreate = openCreateInvoice || (() => setModal("createInvoice"));
  // Multi-invoice approvals happen per row in the invoice group below.
  const [rejectingInv, setRejectingInv] = useState<any>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [deletingInvId, setDeletingInvId] = useState<string | null>(null);
  const [markingPaidInvId, setMarkingPaidInvId] = useState<string | null>(null);
  const [busyInvId, setBusyInvId] = useState<string | null>(null);
  const [invoiceMenuId, setInvoiceMenuId] = useState<string | null>(null);
  const copyWorkOrderNumber = async () => {
    try {
      await navigator.clipboard.writeText(String(woData.id));
      fire(`Work order ${woData.id} copied`);
    } catch {
      fire("Could not copy the work order number");
    }
  };
  const viewInvoice = (inv: any) => {
    if (!inv?.id || !setSelectedInvoice) return;
    setInvoiceMenuId(null);
    setSelectedInvoice(inv.id);
    setSelectedWO(null);
    setAiNote(null);
    setPage("invoices");
  };
  const storeHistory = useMemo(
    () => woData ? workOrders.filter(w => w.store === woData.store && w.id !== woData.id) : [],
    [workOrders, woData]
  );
  const visibleActivities = useMemo(
    () => (woData?.activities || []).filter(
      (activity: any) => isManager || !isInternalWorkOrderActivity(activity),
    ),
    [isManager, woData?.activities],
  );
  const sameCategory = useMemo(
    () => woData ? storeHistory.filter(w => w.category === woData.category).length : 0,
    [storeHistory, woData]
  );
  const woInvoices = useMemo(
    () => woData ? invoices.filter(i => i.wot === woData.id && i.state !== "draft") : [],
    [invoices, woData]
  );
  // Parts tracking list for this WO (everyone — staff + contractor sees the
  // same list since the contractor view is for THEIR own job). Sort:
  // pending statuses first, received last, so what needs attention is at top.
  const PART_STATUS_ORDER: Record<string, number> = {
    backordered: 0,
    ordered: 1,
    shipped: 2,
    received: 3,
  };
  const myParts = useMemo(
    () => woData
      ? [...woParts]
          .filter(p => p.workOrderId === woData.id)
          .sort((a: any, b: any) => (PART_STATUS_ORDER[a.status] ?? 9) - (PART_STATUS_ORDER[b.status] ?? 9))
      : [],
    [woParts, woData]
  );
  // "Billed" hint: any non-rejected invoice line whose description loosely
  // matches a part's description tags it as already billed so the contractor
  // doesn't double-bill. Match is description-substring (case-insensitive).
  const billedDescriptions = useMemo(() => {
    const set = new Set<string>();
    for (const inv of woInvoices) {
      if (inv.state === "rejected") continue;
      for (const line of (inv.lines || [])) {
        if (line?.desc) set.add(String(line.desc).toLowerCase());
      }
    }
    return set;
  }, [woInvoices]);
  const isPartBilled = (desc: string) => {
    if (!desc) return false;
    const d = desc.toLowerCase();
    for (const b of billedDescriptions) {
      if (b.includes(d) || d.includes(b)) return true;
    }
    return false;
  };
  // All invoices on this WO (incl. drafts) for the per-WO group panel — drafts
  // get a "Resume" affordance, everything else gets state badges + actions.
  const woAllInvoices = useMemo(
    () => woData ? invoices.filter(i => i.wot === woData.id) : [],
    [invoices, woData]
  );
  const canInvoice = isManager
    ? false
    : currentUser?.contractorTier === "direct" || currentUser?.contractorTier === null;
  // Job-progress track runs PARALLEL to the invoice track. A contractor keeps
  // his work actions (pause / close complete / submit report / resume) as long
  // as the job itself is alive — driven by whether the WO is closed, NOT by the
  // invoice-driven status (submitting an invoice flips the WO to
  // pending_approval, which previously hid these). Capital is excluded (it has
  // its own staff flow). Pausing/closing never touches existing invoices.
  const jobOpen = !["closed", "capital"].includes(woData?.status);
  const invoiceController = String(currentUser?.email || "").trim().toLowerCase()
    === "emilyb@phospitality.com";
  const isLoading = (key: string) => !!loadingStates[key];
  const loadingStyle = (key: string) => ({
    opacity: isLoading(key) ? 0.7 : 1,
    cursor: isLoading(key) ? "default" : "pointer",
    display: "flex",
    alignItems: "center",
    gap: 6,
  });
  return (
    <>
          {/* ═════ WO DETAIL ═════ */}
          {(page === "work_orders" || page === "wo_detail" || page === "history") && selectedWO && woData && (() => {
            const repeatCount = storeHistory.length;
            const sla = slaLabel(woData);
            const slaR = slaRemaining(woData);
            const sla2 = computeSlaState(woData.responseBreachAt, woData.resolutionBreachAt, woData.startTimeRaw);
            const dates = getWorkOrderDateMeta(woData);
            const aging = getSlaAgingStyle(woData);
            return (
              <div style={{ animation: "fadeUp 0.25s" }}>
                <button onClick={() => { setSelectedWO(null); setAiNote(null); if (!isManager) setPage("my_jobs"); }} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: T.muted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", marginBottom: 16, padding: 0 }}><Ico d="M15 18l-6-6 6-6" size={14} /> Back</button>

                {/* Alert stack — two-breach SLA replaces the single-deadline view */}
                {isManager && woData.incidentReuse && (
                  <div className="card" style={{ background: T.warnSoft, border: `1px solid ${T.warn}44`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 20, color: T.warn, fontWeight: 800 }}>!</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: "#73560C", fontSize: 13 }}>
                        Reused incident number
                      </div>
                      <div style={{ fontSize: 11, color: "#73560C", marginTop: 2 }}>
                        {woData.incidentId} also appears on {woData.incidentReuse.relatedWorkOrderIds.join(", ")}.
                        {woData.incidentReuse.crossesState ? " The work orders span different states." : ""}
                        {" "}Treat each WOT as a separate call and verify the incident reference before updating 7-Eleven.
                      </div>
                    </div>
                  </div>
                )}
                {sla2 && (sla2.responseBreached || sla2.resolutionBreached) && (
                  <div className="card" style={{ background: T.dangerSoft, border: `1px solid ${T.danger}44`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 22 }}>🚨</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: T.danger, fontSize: 13 }}>
                        {sla2.responseBreached && sla2.resolutionBreached
                          ? "SLA breached"
                          : sla2.responseBreached
                            ? "Response SLA breached"
                            : "Resolution SLA breached"}
                      </div>
                      <div style={{ fontSize: 11, color: "#8B2C20", marginTop: 2, fontWeight: 600 }}>
                        {sla2.responseBreached && sla2.resolutionBreached
                          ? "Response and resolution deadlines were both missed."
                          : sla2.responseBreached
                            ? `${Math.floor(-sla2.responseRemainingHours)}h past response/arrival deadline.`
                            : `${Math.floor(-sla2.resolutionRemainingHours)}h past resolution deadline.`}
                      </div>
                      <div style={{ fontSize: 11, color: "#8B2C20", marginTop: 2 }}>Functional status is "{woData.functionalStatus || "—"}" — update immediately to close the gap with 7-Eleven.</div>
                    </div>
                  </div>
                )}
                {sla2 && !sla2.responseMet && !sla2.responseBreached && sla2.responseRemainingHours < 1 && (
                  <div className="card" style={{ background: T.dangerSoft, border: `1px solid ${T.danger}33`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 20 }}>⚠️</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: T.danger, fontSize: 13 }}>Response SLA at risk — {Math.round(sla2.responseRemainingHours * 60)} minutes to breach</div>
                      <div style={{ fontSize: 11, color: "#8B2C20", marginTop: 2 }}>Check in with the contractor — they need to be on site soon.</div>
                    </div>
                  </div>
                )}
                {isManager && woData.hasPendingSevenElevenSync && (
                  <div className="card" style={{ background: T.warnSoft, border: `1px solid ${T.warn}44`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 20, color: T.warn, fontWeight: 800 }}>!</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: "#73560C", fontSize: 13 }}>
                        {woData.pendingSevenElevenSyncCount} update{woData.pendingSevenElevenSyncCount === 1 ? "" : "s"} need to be copied to the 7-Eleven portal
                      </div>
                      <div style={{ fontSize: 11, color: "#73560C", marginTop: 2 }}>Use the checkboxes in Activity after each update is entered in 7-Eleven.</div>
                    </div>
                  </div>
                )}
                {/* Legacy single-deadline alert — only when the new fields are missing */}
                {!sla2 && sla?.severity === "breach" && (
                  <div className="card" style={{ background: T.dangerSoft, border: `1px solid ${T.danger}44`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 22 }}>🚨</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: T.danger, fontSize: 13 }}>SLA breach — {Math.floor(-slaR.remainingHours)}h past {PRIORITY[woData.priority].slaHours}h limit</div>
                      <div style={{ fontSize: 11, color: "#8B2C20", marginTop: 2 }}>Functional status is "{woData.functionalStatus || "—"}" — update immediately to close the gap with 7-Eleven.</div>
                    </div>
                  </div>
                )}
                {!sla2 && sla?.severity === "critical" && (
                  <div className="card" style={{ background: T.dangerSoft, border: `1px solid ${T.danger}33`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 20 }}>⚠️</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: T.danger, fontSize: 13 }}>SLA at risk — {Math.round(slaR.remainingHours * 60)} minutes to breach</div>
                      <div style={{ fontSize: 11, color: "#8B2C20", marginTop: 2 }}>Check in with the contractor and update functional status now.</div>
                    </div>
                  </div>
                )}
                {repeatCount >= 2 && (
                  <div className="card" style={{ background: T.warnSoft, border: `1px solid ${T.warn}33`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 20 }}>🔁</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: T.warn, fontSize: 12 }}>Repeat visit — Store #{woData.store} has {repeatCount} other work order{repeatCount !== 1 ? "s" : ""}{sameCategory > 0 ? ` (${sameCategory} same category)` : ""}</div>
                      <div style={{ fontSize: 11, color: "#73560C", marginTop: 2 }}>{sameCategory >= 2 ? "Consider flagging for capital replacement — chronic equipment issue." : "Cross-reference previous repairs before dispatch."}</div>
                    </div>
                  </div>
                )}
                <div className="detail-two-col" style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 20 }}>
                  <div>
                    {/* Header card */}
                    <div className="card" style={{ padding: 24, marginBottom: 16 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                        <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: T.accent }}>{woData.id}</span>
                        <CopyWorkOrderButton
                          value={woData.id}
                          onCopied={() => fire(`Work order ${woData.id} copied`)}
                        />
                        {woData.incidentId && <span style={{ color: T.subtle, fontSize: 12 }}>/</span>}
                        {woData.incidentId && <span className="mono" style={{ fontSize: 11, color: T.muted }}>{woData.incidentId}</span>}
                      </div>
                      <div className="display" style={{ fontSize: 28, fontWeight: 500, color: T.ink, letterSpacing: -0.4, lineHeight: 1.1 }}>
                        {[woData.store ? `Store #${woData.store}` : null, woData.city || null].filter(Boolean).join(" · ") || woData.id}
                      </div>
                      {woData.addr && <div style={{ fontSize: 13, color: T.muted, marginTop: 4 }}>{woData.addr}</div>}
                      <div className="wo-date-grid" style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                        {[
                          { label: "Created", value: dates.created, color: T.inkSoft, bg: T.surfaceSoft, ring: T.borderSoft },
                          { label: "Last updated", value: dates.updated, color: T.inkSoft, bg: T.surfaceSoft, ring: T.borderSoft },
                          { label: "SLA due", value: dates.slaDue, color: aging.color, bg: aging.bg, ring: aging.ring },
                        ].map((item) => (
                          <div key={item.label} style={{ padding: "10px 12px", borderRadius: 10, background: item.bg, border: `1px solid ${item.ring}`, minWidth: 0 }}>
                            <div style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.7, color: T.subtle, marginBottom: 4 }}>{item.label}</div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: item.color, lineHeight: 1.35 }}>{item.value}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 7, marginTop: 14, flexWrap: "wrap" }}>
                        <Badge conf={PRIORITY[woData.priority]} />
                        <Badge conf={STATUS[woData.status]} />
                        {woData.functionalStatus && <Badge conf={{ label: `FSM: ${woData.functionalStatus}`, ...FUNCTIONAL_STATUS[woData.functionalStatus] || { color: T.muted, bg: T.borderSoft } }} />}
                        {sla2
                          ? <SlaBadge responseBreachAt={woData.responseBreachAt} resolutionBreachAt={woData.resolutionBreachAt} responseMetAt={woData.startTimeRaw} size="sm" />
                          : sla && <span style={{ fontSize: 11, fontWeight: 700, color: sla.color, background: sla.bg, padding: "3px 10px", borderRadius: 20, border: `1px solid ${sla.color}22` }}>SLA: {sla.text}</span>}
                      </div>
                      {(() => {
                        const classParts = [woData.businessService, woData.category, woData.subCategory].filter(Boolean);
                        const hasClassification = classParts.length > 0;
                        const hasBody = hasClassification || woData.summary || woData.description;
                        if (!hasBody) return null;
                        return (
                          <div style={{ padding: "14px 18px", background: T.surfaceSoft, borderRadius: 12, border: `1px solid ${T.borderSoft}`, marginTop: 16 }}>
                            {hasClassification && <div style={{ fontSize: 12, color: T.subtle, marginBottom: 4, fontWeight: 600 }}>{classParts.join(" · ")}</div>}
                            {woData.summary && <div style={{ fontSize: 14, color: T.inkSoft, lineHeight: 1.6, fontWeight: 500 }}>{woData.summary}</div>}
                            {woData.description && woData.description !== woData.summary && <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6, marginTop: 8 }}>{woData.description}</div>}
                          </div>
                        );
                      })()}
                      <div className="detail-fields" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18, marginTop: 18 }}>
                        {[
                          { l: "Line of Service", v: woData.lineOfService || "Not set" },
                          { l: "ETA", v: formatEta(woData.eta, woData) || "Not set" },
                          ...(isManager ? [{ l: "Assigned to", v: woData.contractor ? getUser(woData.contractor)?.name : "Unassigned" }] : []),
                          { l: "Start time", v: woData.startTime || "Not started" },
                          // Contractors may see the AFM name, but contact details remain staff-only.
                          { l: "AFM", v: woData.afm || "—" },
                          { l: "Asset model", v: woData.assetModel || "Not captured" },
                          { l: "Serial #", v: woData.assetSerial || "Not captured" },
                          ...(isManager ? [{ l: "AFM email", v: woData.afmEmail || "—" }] : []),
                        ].map((d, i) => (
                          <div key={i}>
                            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 4 }}>{d.l}</div>
                            <div style={{ fontSize: 13, fontWeight: 500, color: ["Not captured", "Not set", "Not started", "Unassigned", "—"].includes(d.v) ? T.danger : T.ink }}>{d.v}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
                      {woData.status === "unassigned" && isManager && !invoiceController && (
                        <button
                          onClick={() => doStraightToBilling(woData.id)}
                          disabled={isLoading("straightToBilling_" + woData.id)}
                          className="btn-accent"
                          style={loadingStyle("straightToBilling_" + woData.id)}
                        >
                          {isLoading("straightToBilling_" + woData.id)
                            ? <><BtnSpinnerDark />Moving...</>
                            : "Straight to Billing"}
                        </button>
                      )}
                      {/* Quick-assign shows the FULL contractor list (same source as
                          the Create WO dropdown) so no contractor is unreachable. */}
                      {woData.status === "unassigned" && isManager && contractorsOnly.map(c => (
                        <button key={c.id} onClick={() => doAssign(woData.id, c.id)} disabled={isLoading("assign_" + woData.id)} className="btn-soft" style={loadingStyle("assign_" + woData.id)}>
                          {isLoading("assign_" + woData.id) ? <><BtnSpinnerDark />Assigning...</> : <>Assign to {c.name.split(" ")[0]}</>}
                        </button>
                      ))}
                      {isManager && ["assigned", "wip", "parts"].includes(woData.status) && (
                        <>
                          <button onClick={() => { setReassignTarget(woData.contractor || ""); setModal("reassign"); }} disabled={isLoading("reassign_" + woData.id)} className="btn-soft" style={loadingStyle("reassign_" + woData.id)}>
                            {isLoading("reassign_" + woData.id) ? <><BtnSpinnerDark />Reassigning...</> : "Reassign"}
                          </button>
                          <button onClick={() => setModal("unassign")} disabled={isLoading("unassign_" + woData.id)} className="btn-soft" style={loadingStyle("unassign_" + woData.id)}>
                            {isLoading("unassign_" + woData.id) ? <><BtnSpinnerDark />Unassigning...</> : "Unassign"}
                          </button>
                        </>
                      )}
                      {woData.status === "assigned" && (
                        <>
                          <button onClick={() => setModal("setEta")} disabled={isLoading("setEta_" + woData.id)} className="btn-soft" style={loadingStyle("setEta_" + woData.id)}>
                            {isLoading("setEta_" + woData.id) ? <><BtnSpinnerDark />Setting...</> : "Set ETA"}
                          </button>
                          <button onClick={() => setModal("startWork")} disabled={isLoading("startWork_" + woData.id)} className="btn-accent" style={loadingStyle("startWork_" + woData.id)}>
                            {isLoading("startWork_" + woData.id) ? <><BtnSpinner />Starting...</> : "Start work"}
                          </button>
                        </>
                      )}
                      {/* Job-progress actions are parallel to invoicing.
                           Shown at WIP for everyone (staff preserved),
                          and for a contractor any time the job is still open and not
                          already paused, so submitting an invoice (which flips the WO
                          to pending_approval) no longer hides them. Resume covers the
                          paused (parts) state below. */}
                      {(
                        (!isManager && jobOpen && !["assigned", "parts", "completed"].includes(woData.status))
                        || (isManager && ["wip", "pending_invoice", "pending_approval"].includes(woData.status))
                      ) && (
                        <>
                          <button onClick={() => setModal("pauseWork")} disabled={isLoading("pauseWork_" + woData.id)} className="btn-soft" style={loadingStyle("pauseWork_" + woData.id)}>
                            {isLoading("pauseWork_" + woData.id) ? <><BtnSpinnerDark />Pausing...</> : "Pause (parts)"}
                          </button>
                          {isManager && woData.status === "wip" && <button onClick={() => setModal("capitalFlag")} disabled={isLoading("capitalFlag_" + woData.id)} className="btn-soft" style={loadingStyle("capitalFlag_" + woData.id)}>{isLoading("capitalFlag_" + woData.id) ? <><BtnSpinnerDark />Flagging...</> : "Flag capital"}</button>}
                          {!isManager && (
                            <button onClick={() => setModal("closeComplete")} disabled={isLoading("closeComplete_" + woData.id)} className="btn-primary" style={loadingStyle("closeComplete_" + woData.id)}>
                              {isLoading("closeComplete_" + woData.id) ? <><BtnSpinner />Completing...</> : "Mark work complete"}
                            </button>
                          )}
                        </>
                      )}
                      {woData.status === "capital" && isManager && (
                        <button onClick={() => doCapitalDecline(woData.id)} disabled={isLoading("capitalDecline_" + woData.id)} className="btn-soft" style={loadingStyle("capitalDecline_" + woData.id)}>
                          {isLoading("capitalDecline_" + woData.id) ? <><BtnSpinnerDark />Returning...</> : "Capital declined - return to dispatched"}
                        </button>
                      )}
                      {woData.status === "parts" && (
                        <button onClick={() => setModal("startWork")} disabled={isLoading("startWork_" + woData.id)} className="btn-accent" style={loadingStyle("startWork_" + woData.id)}>
                          {isLoading("startWork_" + woData.id) ? <><BtnSpinner />Resuming...</> : "Resume work"}
                        </button>
                      )}
                      {woData.status === "completed" && isManager && (
                        <button onClick={() => doMoveToInvoice(woData.id)} disabled={isLoading("moveToInvoice_" + woData.id)} className="btn-accent" style={loadingStyle("moveToInvoice_" + woData.id)}>
                          {isLoading("moveToInvoice_" + woData.id) ? <><BtnSpinner />Updating...</> : "Portal updated - pending 7-Eleven submission"}
                        </button>
                      )}
                      {/* Multi-invoice: a contractor can keep adding invoices for
                          follow-up visits until the WO closes. The per-invoice
                          approve/reject/mark-paid actions are rendered in the
                          invoice group block below. */}
                      {woData.status !== "closed" && !isManager && canInvoice && <button onClick={() => openCreate(null)} className="btn-accent">Create invoice</button>}
                      {/* Manual close — staff judgement decides when the job is done.
                          QuickBooks handoff does not auto-close capital jobs. */}
                      {isManager && woData.status !== "closed" && (
                        <button onClick={() => setModal("closeWO")} disabled={isLoading("closeWO_" + woData.id)} className="btn-primary" style={loadingStyle("closeWO_" + woData.id)}>
                          {isLoading("closeWO_" + woData.id) ? <><BtnSpinnerDark />Closing...</> : "Close work order"}
                        </button>
                      )}
                      {/* Closed job: always-available invoice download + staff-only reopen. */}
                      {woData.status === "closed" && woInvoices[0] && <button onClick={() => doDownloadInvoice(woInvoices[0])} disabled={pdfBusy} className="btn-accent" style={{ opacity: pdfBusy ? 0.6 : 1, cursor: pdfBusy ? "default" : "pointer" }}>Download Invoice PDF</button>}
                      {woData.status === "closed" && isManager && (
                        <button onClick={() => setModal("reopen")} disabled={isLoading("reopen_" + woData.id)} className="btn-soft" style={loadingStyle("reopen_" + woData.id)}>
                          {isLoading("reopen_" + woData.id) ? <><BtnSpinnerDark />Reopening...</> : "Reopen"}
                        </button>
                      )}

                    </div>

                    {/* ─────────────── INVOICES ON THIS WORK ORDER ────────────────
                        Multi-invoice support: each visit is its own complete
                        invoice. Staff see per-invoice approve / reject / mark
                        paid / delete; contractor sees Resume on their drafts +
                        Download. The WO advances only when all live invoices
                        are approved/paid (logic lives in useWorkOrders). */}
                    {woAllInvoices.length > 0 && (
                      <div className="card wo-invoice-list" style={{ padding: 0, marginBottom: 16, overflow: "hidden" }}>
                        <div className="wo-invoice-list-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${T.borderSoft}`, background: T.surfaceSoft }}>
                          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle }}>
                            {woAllInvoices.length} invoice{woAllInvoices.length === 1 ? "" : "s"} on this work order
                          </div>
                          {!isManager && canInvoice && woData.status !== "closed" && (
                            <button onClick={() => openCreate(null)} className="btn-soft wo-invoice-action" style={{ padding: "6px 12px", fontSize: 11 }}>+ Add invoice</button>
                          )}
                        </div>
                        {woAllInvoices
                          .slice()
                          .sort((a: any, b: any) => (a.invoiceDate || "").localeCompare(b.invoiceDate || ""))
                          .map((inv: any, idx: number) => {
                            const isMyDraft = inv.state === "draft" && (inv.contractor === currentUser?.id || isManager);
                            const stateLabel = ({ draft: "Draft", submitted: "Submitted", revised: "Revised", approved: "Approved", rejected: "Rejected", paid: "Sent to QuickBooks" } as any)[inv.state] || inv.state;
                            const stateColor = (
                              inv.state === "paid" ? T.success :
                              inv.state === "approved" ? T.accent :
                              inv.state === "rejected" ? T.danger :
                              inv.state === "draft" ? T.subtle : T.warn
                            );
                            const stateBg = (
                              inv.state === "paid" ? T.successSoft :
                              inv.state === "approved" ? T.accentSoft :
                              inv.state === "rejected" ? T.dangerSoft :
                              inv.state === "draft" ? T.surfaceSoft : T.warnSoft
                            );
                            const rowBusy = busyInvId === inv.id;
                            const invoiceMenuKey = String(inv.id || inv.num);
                            const invoiceMenuOpen = invoiceMenuId === invoiceMenuKey;
                            return (
                              <div key={inv.id || inv.num} className="wo-invoice-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: idx < woAllInvoices.length - 1 ? `1px solid ${T.borderSoft}` : "none", flexWrap: "wrap" }}>
                                <div className="wo-invoice-row-main" style={{ minWidth: 0, flex: 1 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                    <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>#{inv.num}</span>
                                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: stateColor, background: stateBg, border: `1px solid ${stateColor}33`, padding: "2px 8px", borderRadius: 999 }}>{stateLabel}</span>
                                    <span className="mono" style={{ fontSize: 12, color: T.muted }}>{fmt(inv.total || 0)}</span>
                                    {inv.invoiceDate && <span style={{ fontSize: 11, color: T.subtle }}>{inv.invoiceDate}</span>}
                                  </div>
                                  {inv.state === "rejected" && inv.reason && (
                                    <div style={{ fontSize: 11, color: T.danger, marginTop: 4, lineHeight: 1.45 }}><strong>Rejected:</strong> {inv.reason}</div>
                                  )}
                                </div>
                                <div className="wo-invoice-actions" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                  <button onClick={() => viewInvoice(inv)} className="btn-soft wo-invoice-action" style={{ padding: "6px 10px", fontSize: 11 }}>View</button>
                                  {inv.state !== "draft" && (
                                    <button onClick={() => doDownloadInvoice && doDownloadInvoice(inv)} disabled={pdfBusy} className="btn-soft wo-invoice-action" style={{ padding: "6px 10px", fontSize: 11 }}>Download</button>
                                  )}
                                  {isMyDraft && !isManager && (
                                    <button onClick={() => openCreate(inv)} className="btn-accent wo-invoice-action" style={{ padding: "6px 10px", fontSize: 11 }}>Resume</button>
                                  )}
                                  {isManager && (inv.state === "submitted" || inv.state === "revised") && (
                                    <>
                                      <button
                                        onClick={async () => { setBusyInvId(inv.id); try { await doApproveInvoice(inv.id); } finally { setBusyInvId(null); } }}
                                        disabled={rowBusy || isLoading("approveInvoice_" + inv.id)}
                                        className="btn-accent wo-invoice-action"
                                        style={{ padding: "6px 10px", fontSize: 11, opacity: rowBusy ? 0.7 : 1, cursor: rowBusy ? "default" : "pointer" }}
                                      >{rowBusy || isLoading("approveInvoice_" + inv.id) ? <><BtnSpinner />Approving…</> : "Approve"}</button>
                                      <button onClick={() => { setRejectingInv(inv); setRejectReason(""); }} className="btn-soft wo-invoice-action" style={{ padding: "6px 10px", fontSize: 11, color: T.danger, borderColor: `${T.danger}44` }}>Reject</button>
                                    </>
                                  )}
                                  {isManager && inv.state === "approved" && (
                                    <button
                                      onClick={() => setMarkingPaidInvId(inv.id)}
                                      disabled={rowBusy || isLoading("markPaid_" + inv.id)}
                                      className="btn-primary wo-invoice-action"
                                      style={{ padding: "6px 10px", fontSize: 11, opacity: rowBusy ? 0.7 : 1, cursor: rowBusy ? "default" : "pointer" }}
                                    >{rowBusy || isLoading("markPaid_" + inv.id) ? <><BtnSpinner />…</> : "Sent to QuickBooks"}</button>
                                  )}
                                  {isManager && (
                                    <button onClick={() => setDeletingInvId(inv.id)} className="btn-soft wo-invoice-action" style={{ padding: "6px 10px", fontSize: 11, color: T.danger, borderColor: `${T.danger}44` }}>Delete</button>
                                  )}
                                </div>
                                <div className="wo-invoice-mobile-actions" style={{ display: "none", position: "relative", flexShrink: 0 }}>
                                  <button
                                    onClick={() => setInvoiceMenuId(invoiceMenuOpen ? null : invoiceMenuKey)}
                                    aria-label={`Invoice ${inv.num} actions`}
                                    style={{ width: 40, height: 40, borderRadius: 10, border: `1px solid ${T.borderSoft}`, background: T.surface, color: T.ink, cursor: "pointer", fontSize: 20, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
                                  >⋮</button>
                                  {invoiceMenuOpen && (
                                    <>
                                      <div className="wo-invoice-mobile-menu-backdrop" onClick={() => setInvoiceMenuId(null)} style={{ position: "fixed", inset: 0, zIndex: 42 }} />
                                      <div className="wo-invoice-mobile-menu" style={{ position: "absolute", top: 44, right: 0, zIndex: 43, minWidth: 156, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, boxShadow: "0 10px 28px rgba(31,30,28,0.16)", overflow: "hidden" }}>
                                        <button onClick={() => viewInvoice(inv)} style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 14px", background: "none", border: "none", borderBottom: `1px solid ${T.borderSoft}`, cursor: "pointer", fontSize: 13, color: T.ink, fontFamily: "inherit" }}>View</button>
                                        {inv.state !== "draft" && (
                                          <button onClick={() => { setInvoiceMenuId(null); doDownloadInvoice && doDownloadInvoice(inv); }} disabled={pdfBusy} style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 14px", background: "none", border: "none", borderBottom: `1px solid ${T.borderSoft}`, cursor: pdfBusy ? "default" : "pointer", fontSize: 13, color: T.ink, fontFamily: "inherit", opacity: pdfBusy ? 0.6 : 1 }}>Download</button>
                                        )}
                                        {isMyDraft && !isManager && (
                                          <button onClick={() => { setInvoiceMenuId(null); openCreate(inv); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 14px", background: "none", border: "none", borderBottom: `1px solid ${T.borderSoft}`, cursor: "pointer", fontSize: 13, color: T.ink, fontFamily: "inherit" }}>Resume</button>
                                        )}
                                        {isManager && (inv.state === "submitted" || inv.state === "revised") && (
                                          <>
                                            <button onClick={async () => { setInvoiceMenuId(null); setBusyInvId(inv.id); try { await doApproveInvoice(inv.id); } finally { setBusyInvId(null); } }} disabled={rowBusy || isLoading("approveInvoice_" + inv.id)} style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 14px", background: "none", border: "none", borderBottom: `1px solid ${T.borderSoft}`, cursor: rowBusy ? "default" : "pointer", fontSize: 13, color: T.ink, fontFamily: "inherit", opacity: rowBusy ? 0.6 : 1 }}>Approve</button>
                                            <button onClick={() => { setInvoiceMenuId(null); setRejectingInv(inv); setRejectReason(""); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 14px", background: "none", border: "none", borderBottom: `1px solid ${T.borderSoft}`, cursor: "pointer", fontSize: 13, color: T.danger, fontFamily: "inherit" }}>Reject</button>
                                          </>
                                        )}
                                        {isManager && inv.state === "approved" && (
                                          <button onClick={() => { setInvoiceMenuId(null); setMarkingPaidInvId(inv.id); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 14px", background: "none", border: "none", borderBottom: `1px solid ${T.borderSoft}`, cursor: "pointer", fontSize: 13, color: T.ink, fontFamily: "inherit" }}>Sent to QuickBooks</button>
                                        )}
                                        {isManager && (
                                          <button onClick={() => { setInvoiceMenuId(null); setDeletingInvId(inv.id); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 14px", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: T.danger, fontFamily: "inherit" }}>Delete</button>
                                        )}
                                      </div>
                                    </>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    )}

                    {/* Reject-invoice confirmation modal — staff-only, reason required. */}
                    {rejectingInv && (
                      <Modal onClose={() => { setRejectingInv(null); setRejectReason(""); }} title={`Reject invoice #${rejectingInv.num}`} width={460}>
                        <div style={{ fontSize: 13, color: T.muted, marginBottom: 12, lineHeight: 1.55 }}>
                          The contractor sees the reason on their invoice. The WO does not advance until the remaining live invoices are approved.
                        </div>
                        <label style={{ fontSize: 11, fontWeight: 700, color: T.subtle, textTransform: "uppercase", letterSpacing: 0.6, display: "block", marginBottom: 6 }}>Rejection reason</label>
                        <TA rows={3} value={rejectReason} onChange={(e: any) => setRejectReason(e.target.value)} placeholder="e.g. Missing parts receipt, labor hours unclear…" />
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                          <button onClick={() => { setRejectingInv(null); setRejectReason(""); }} className="btn-soft">Cancel</button>
                          <button
                            onClick={async () => {
                              const ok = await doRejectInvoice(rejectingInv, rejectReason);
                              if (ok) { setRejectingInv(null); setRejectReason(""); }
                            }}
                            disabled={!rejectReason.trim()}
                            style={{ padding: "10px 18px", borderRadius: 10, background: T.danger, color: "#fff", border: "none", cursor: rejectReason.trim() ? "pointer" : "default", fontWeight: 600, fontSize: 12, fontFamily: "inherit", opacity: rejectReason.trim() ? 1 : 0.5 }}
                          >Reject</button>
                        </div>
                      </Modal>
                    )}

                    {/* Per-row delete-invoice confirmation — staff only. */}
                    {markingPaidInvId && (() => {
                      const inv = woAllInvoices.find((i: any) => i.id === markingPaidInvId);
                      if (!inv) return null;
                      const isBusy = busyInvId === inv.id || isLoading("markPaid_" + inv.id);
                      return (
                        <Modal onClose={() => { if (!isBusy) setMarkingPaidInvId(null); }} title="Send invoice to QuickBooks" width={420}>
                          <div style={{ fontSize: 13, color: T.muted, marginBottom: 20, lineHeight: 1.55 }}>
                            Mark invoice <span className="mono" style={{ color: T.ink, fontWeight: 600 }}>#{inv.num}</span> as sent to QuickBooks?
                          </div>
                          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                            <button onClick={() => setMarkingPaidInvId(null)} disabled={isBusy} className="btn-soft">Cancel</button>
                            <button
                              onClick={async () => {
                                setBusyInvId(inv.id);
                                try {
                                  await doMarkPaid(inv.id);
                                  setMarkingPaidInvId(null);
                                } finally {
                                  setBusyInvId(null);
                                }
                              }}
                              disabled={isBusy}
                              className="btn-primary"
                              style={{ padding: "10px 18px", opacity: isBusy ? 0.7 : 1, cursor: isBusy ? "default" : "pointer" }}
                            >{isBusy ? <><BtnSpinner />Sending...</> : "Sent to QuickBooks"}</button>
                          </div>
                        </Modal>
                      );
                    })()}

                    {deletingInvId && (() => {
                      const inv = woAllInvoices.find((i: any) => i.id === deletingInvId);
                      if (!inv) return null;
                      const isBusy = busyInvId === inv.id || isLoading("deleteInvoice_" + inv.id);
                      return (
                        <Modal onClose={() => { if (!isBusy) setDeletingInvId(null); }} title="Delete invoice" width={420}>
                          <div style={{ fontSize: 13, color: T.muted, marginBottom: 20, lineHeight: 1.55 }}>
                            Delete invoice <span className="mono" style={{ color: T.ink, fontWeight: 600 }}>#{inv.num}</span>? This cannot be undone from the portal.
                          </div>
                          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                            <button onClick={() => setDeletingInvId(null)} disabled={isBusy} className="btn-soft">Cancel</button>
                            <button
                              onClick={async () => {
                                setBusyInvId(inv.id);
                                try {
                                  await doDeleteInvoice(inv);
                                  setDeletingInvId(null);
                                } finally {
                                  setBusyInvId(null);
                                }
                              }}
                              disabled={isBusy}
                              style={{ padding: "10px 18px", borderRadius: 10, background: T.danger, color: "#fff", border: "none", cursor: isBusy ? "default" : "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit", opacity: isBusy ? 0.7 : 1, display: "flex", alignItems: "center", gap: 6 }}
                            >{isBusy ? <><BtnSpinner />Deleting...</> : "Delete"}</button>
                          </div>
                        </Modal>
                      );
                    })()}

                    {/* Staff-only secondary actions, separated from primary
                        action zone. Edit work order opens a header-fields form;
                        Delete is the existing soft-delete. Contractors never see
                        either. Lifecycle-driven fields (status, assignment,
                        timestamps, WOT id, capital flags) are intentionally NOT
                        editable here — they have their own dedicated actions. */}
                    {isManager && (
                      <div style={{ marginBottom: 16, paddingTop: 2, borderTop: `1px solid ${T.borderSoft}`, display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
                        <button onClick={() => setModal("editWO")} disabled={isLoading("editWO_" + woData.id)} style={{ marginTop: 12, background: "none", border: "none", color: T.ink, fontSize: 12, fontWeight: 600, cursor: isLoading("editWO_" + woData.id) ? "default" : "pointer", fontFamily: "inherit", padding: "4px 2px", textDecoration: "underline", textUnderlineOffset: 3, opacity: isLoading("editWO_" + woData.id) ? 0.7 : 1, display: "flex", alignItems: "center", gap: 6 }}>
                          {isLoading("editWO_" + woData.id) ? <><BtnSpinnerDark />Saving...</> : "Edit work order"}
                        </button>
                        <button onClick={() => setModal("deleteWO")} disabled={isLoading("deleteWO_" + woData.id)} style={{ marginTop: 12, background: "none", border: "none", color: T.danger, fontSize: 12, fontWeight: 600, cursor: isLoading("deleteWO_" + woData.id) ? "default" : "pointer", fontFamily: "inherit", padding: "4px 2px", textDecoration: "underline", textUnderlineOffset: 3, opacity: isLoading("deleteWO_" + woData.id) ? 0.7 : 1, display: "flex", alignItems: "center", gap: 6 }}>
                          {isLoading("deleteWO_" + woData.id) ? <><BtnSpinnerDark />Deleting...</> : "Delete work order"}
                        </button>
                      </div>
                    )}

                    {/* Technician on Job — contractor picks who was on site (text
                        snapshot, optional). Staff see it read-only. Locked at closed
                        (Completion Record carries it then). */}
                    {isManager && (woData.assignmentHistory || []).length > 0 && (
                      <div className="card" style={{ padding: 18, marginBottom: 16 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6 }}>
                          Prior assignment history
                        </div>
                        <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.5, marginBottom: 12 }}>
                          Staff-only archive. Contractors cannot query these records or prior assignment artifacts.
                        </div>
                        {(woData.assignmentHistory || []).map((assignment: any) => {
                          const snapshot = assignment.workflowSnapshot || {};
                          const priorContractor = getUser(assignment.contractorId);
                          const nextContractor = assignment.nextContractorId
                            ? getUser(assignment.nextContractorId)
                            : null;
                          const details = [
                            ["ETA", snapshot.eta],
                            ["Started", snapshot.startTime],
                            ["Completed", snapshot.endTime],
                            ["Technician", snapshot.technicianOnJob],
                            ["Equipment make", snapshot.assetMake],
                            ["Asset model", snapshot.assetModel],
                            ["Serial number", snapshot.assetSerial],
                            ["Asset year", snapshot.assetYear],
                            ["Resolution", snapshot.resolutionCode],
                            ["Part needed", snapshot.partNeeded],
                            ["Part ETA", snapshot.partEta],
                            ["Invoice total", snapshot.invoiceTotal != null ? fmt(Number(snapshot.invoiceTotal)) : null],
                            ["Repair quote", snapshot.repairQuote != null ? fmt(Number(snapshot.repairQuote)) : null],
                            ["Install quote", snapshot.installQuote != null ? fmt(Number(snapshot.installQuote)) : null],
                          ].filter(([, value]) => value !== null && value !== undefined && value !== "");
                          return (
                            <details key={assignment.id} style={{ borderTop: `1px solid ${T.borderSoft}`, padding: "12px 0" }}>
                              <summary style={{ cursor: "pointer", color: T.ink, fontSize: 12, fontWeight: 700 }}>
                                {priorContractor?.company || priorContractor?.name || "Former contractor"}
                                {nextContractor ? ` to ${nextContractor.company || nextContractor.name}` : " to Unassigned"}
                                <span style={{ color: T.subtle, fontWeight: 500, marginLeft: 8 }}>
                                  {new Date(assignment.assignmentEndedAt).toLocaleString("en-US", {
                                    month: "short",
                                    day: "numeric",
                                    year: "numeric",
                                    hour: "numeric",
                                    minute: "2-digit",
                                  })}
                                </span>
                              </summary>
                              {details.length > 0 && (
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 12 }}>
                                  {details.map(([label, value]) => (
                                    <div key={String(label)}>
                                      <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", color: T.subtle, marginBottom: 2 }}>{label}</div>
                                      <div style={{ fontSize: 12, color: T.inkSoft, overflowWrap: "anywhere" }}>{String(value)}</div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {(snapshot.resolutionNotes || snapshot.capitalNotes) && (
                                <div style={{ marginTop: 12, color: T.inkSoft, fontSize: 12, lineHeight: 1.5 }}>
                                  {snapshot.resolutionNotes || snapshot.capitalNotes}
                                </div>
                              )}
                            </details>
                          );
                        })}
                      </div>
                    )}

                    {woData.status !== "closed" && (() => {
                      const isDispatchTier = currentUser?.contractorTier === "mr_freeze";
                      const isDirectTier = currentUser?.contractorTier === "direct" || currentUser?.contractorTier == null;
                      const isContractedTier = currentUser?.contractorTier === "contracted";
                      const isOwnContractor = !isManager && woData.contractor === currentUser?.id;
                      const dispatchTechs = isDispatchTier
                        ? USERS.filter((u: any) => u.dispatcherId === currentUser?.id)
                        : [];
                      const directTechs = technicians.filter((t: any) => t.contractorId === woData.contractor && t.isActive);
                      return (
                        <div className="card" style={{ padding: 18, marginBottom: 16 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 10 }}>Technician on Job</div>
                          {isManager ? (
                            <div style={{ fontSize: 14, fontWeight: 500, color: woData.technicianOnJob ? T.ink : T.subtle }}>{woData.technicianOnJob || "(not set)"}</div>
                          ) : isDispatchTier ? (
                            dispatchTechs.length > 0 ? (
                              <Sel value={woData.technicianOnJob || ""} onChange={(e: any) => doSetTechnician(woData.id, e.target.value)}>
                                <option value="">- Not set -</option>
                                {dispatchTechs.map((u: any) => <option key={u.id} value={u.name}>{u.name}</option>)}
                              </Sel>
                            ) : (
                              <div style={{ fontSize: 13, color: T.subtle, padding: "10px 13px", borderRadius: 10, border: `1px dashed ${T.border}`, background: T.surfaceSoft }}>No technicians on file</div>
                            )
                          ) : isDirectTier && isOwnContractor ? (
                            directTechs.length > 0 ? (
                              <Sel value={woData.technicianOnJob || ""} onChange={(e: any) => doSetTechnician(woData.id, e.target.value)}>
                                <option value="">— Not set —</option>
                                {directTechs.map((t: any) => <option key={t.id} value={t.name}>{t.name}</option>)}
                              </Sel>
                            ) : (
                              <div style={{ fontSize: 13, color: T.subtle, padding: "10px 13px", borderRadius: 10, border: `1px dashed ${T.border}`, background: T.surfaceSoft }}>No technicians on file</div>
                            )
                          ) : isContractedTier ? (
                            <Input value={currentUser?.name || ""} readOnly />
                          ) : (
                            <div style={{ fontSize: 14, fontWeight: 500, color: woData.technicianOnJob ? T.ink : T.subtle }}>{woData.technicianOnJob || "(not set)"}</div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Completion Record — the self-contained closure file. Shown
                        on completed/closed jobs; identical from the board and History
                        (same detail component). */}
                    {(["completed", "pending_invoice", "pending_approval", "closed"].includes(woData.status) || woData.assetModel || woData.resolutionCode) && (() => {
                      const closeAct = visibleActivities.find((a: any) => /(?:sent to QuickBooks|marked paid) by /i.test(a.text || ""));
                      const closedBy = closeAct ? (closeAct.text.match(/(?:sent to QuickBooks|marked paid) by ([^.]+)/i)?.[1]?.trim() || null) : null;
                      const rec = [
                        { l: "Equipment make", v: woData.assetMake || "—" },
                        { l: "Asset model", v: woData.assetModel || "—" },
                        { l: "Serial number", v: woData.assetSerial || "—" },
                        { l: "Resolution code (DSP closure)", v: woData.resolutionCode || "—" },
                        { l: "Technician on Job", v: woData.technicianOnJob || "—" },
                        { l: "Checked in", v: woData.startTime || "—" },
                        { l: "Clocked out", v: woData.endTime || "—" },
                      ];
                      return (
                        <div className="card" style={{ padding: 18, marginBottom: 16 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 14 }}>Completion Record</div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                            {rec.map((d, i) => (
                              <div key={i}>
                                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: T.subtle, marginBottom: 3 }}>{d.l}</div>
                                <div style={{ fontSize: 13, fontWeight: 500, color: d.v === "—" ? T.subtle : T.ink }}>{d.v}</div>
                              </div>
                            ))}
                          </div>
                          {woData.resolutionNotes && (
                            <div style={{ marginTop: 14 }}>
                              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: T.subtle, marginBottom: 3 }}>Closing notes</div>
                              <div style={{ fontSize: 13, color: T.inkSoft, lineHeight: 1.5 }}>{woData.resolutionNotes}</div>
                            </div>
                          )}
                          {woData.status === "closed" && (
                            <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.borderSoft}`, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
                              <span style={{ color: T.muted }}>Closed {woData.closedAt ? new Date(woData.closedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</span>
                              {closedBy && <span style={{ color: T.muted }}>by <span style={{ color: T.ink, fontWeight: 600 }}>{closedBy}</span></span>}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    <PhotoGallery woId={woData.id} photos={woData.photos || []} imageErrors={imageErrors} setImageErrors={setImageErrors} setLightbox={setLightbox} doAddPhotos={doAddPhotos} doRemovePhoto={doRemovePhoto} loadingStates={loadingStates} />

                    {/* Activity */}
                    <div className="card" style={{ padding: 22 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Activity · {visibleActivities.length}</div>
                        {isManager && (
                          <div className="desktop-only-activity-action" style={{ alignItems: "center", gap: 8 }}>
                            <button type="button" className="btn-soft" onClick={copyWorkOrderNumber} style={{ padding: "7px 12px", fontSize: 11 }}>
                              Copy work order number
                            </button>
                            <button onClick={doAiEnhance} disabled={aiEnhancing} style={{ padding: "7px 14px", borderRadius: 8, background: aiEnhancing ? T.borderSoft : T.ink, color: aiEnhancing ? T.muted : T.bg, border: "none", cursor: aiEnhancing ? "default" : "pointer", fontWeight: 600, fontSize: 11, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>{aiEnhancing ? <><span style={{ display: "inline-block", width: 12, height: 12, border: `2px solid ${T.border}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} /> Loadingâ€¦</> : <>AI enhance notes <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 6, background: T.accent, color: "#fff", letterSpacing: 0.4 }}>PREVIEW</span></>}</button>
                          </div>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                        <input value={noteText} onChange={e => setNoteText(e.target.value)} onKeyDown={e => { if (e.key === "Enter") doPostNote(woData.id); }} placeholder="Add a note..." style={{ flex: 1, padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surfaceSoft, outline: "none" }} />
                        <button
                          onClick={() => doPostNote(woData.id)}
                          disabled={isLoading("postNote_" + woData.id)}
                          className="btn-primary desktop-only-activity-action"
                          style={{ opacity: isLoading("postNote_" + woData.id) ? 0.7 : 1, cursor: isLoading("postNote_" + woData.id) ? "default" : "pointer", alignItems: "center", gap: 6 }}
                        >
                          {isLoading("postNote_" + woData.id) ? <><BtnSpinner />Posting...</> : "Post"}
                        </button>
                      </div>
                      <div className="mobile-only-activity-actions" style={{ display: "none", gap: 8, marginBottom: 18, justifyContent: "flex-end", flexWrap: "wrap" }}>
                        {isManager && (
                          <button type="button" onClick={copyWorkOrderNumber} className="btn-soft" style={{ fontSize: 11 }}>
                            Copy work order number
                          </button>
                        )}
                        {isManager && (
                          <button
                            onClick={doAiEnhance}
                            disabled={aiEnhancing}
                            className="btn-primary"
                            style={{ opacity: aiEnhancing ? 0.7 : 1, cursor: aiEnhancing ? "default" : "pointer", display: "flex", alignItems: "center", gap: 6 }}
                          >
                            {aiEnhancing
                              ? <><span style={{ display: "inline-block", width: 12, height: 12, border: `2px solid ${T.border}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} /> Loading…</>
                              : <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, lineHeight: 1.05 }}><span style={{ whiteSpace: "nowrap" }}>AI enhance notes</span><span style={{ fontSize: 8, fontWeight: 700, padding: "0 6px", borderRadius: 6, background: T.accent, color: "#fff", letterSpacing: 0.4, lineHeight: 1.4 }}>PREVIEW</span></span>}
                          </button>
                        )}
                        <button
                          onClick={() => doPostNote(woData.id)}
                          disabled={isLoading("postNote_" + woData.id)}
                          className="btn-primary"
                          style={{ opacity: isLoading("postNote_" + woData.id) ? 0.7 : 1, cursor: isLoading("postNote_" + woData.id) ? "default" : "pointer", display: "flex", alignItems: "center", gap: 6 }}
                        >
                          {isLoading("postNote_" + woData.id) ? <><BtnSpinner />Posting...</> : "Post"}
                        </button>
                      </div>
                      {aiNote && (
                        <div style={{ background: T.surfaceSoft, border: `1px dashed ${T.accent}`, borderRadius: 12, padding: 18, marginBottom: 16, animation: "fadeUp 0.3s" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.8, display: "flex", alignItems: "center", gap: 6 }}>✨ AI Enhance <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 6, background: T.accent, color: "#fff" }}>PREVIEW</span></span>
                            <button onClick={() => setAiNote(null)} className="btn-soft" style={{ padding: "4px 10px", fontSize: 10 }}>Close</button>
                          </div>
                          {aiNote === "__PREVIEW__" ? (
                            <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.65 }}>
                              <div style={{ fontWeight: 600, color: T.ink, marginBottom: 6 }}>This feature is wired up and ready.</div>
                              When live, this rewrites the contractor's raw note into a polished, AFM-ready summary using Claude — keeping technical accuracy but adding structure and professional tone. Eliminates the midnight rewriting bottleneck. <span style={{ color: T.accent, fontWeight: 600 }}>Activates at handover.</span>
                            </div>
                          ) : (
                            <div style={{ fontSize: 13, color: T.inkSoft, lineHeight: 1.65 }}>{aiNote}</div>
                          )}
                        </div>
                      )}
                      {visibleActivities.map((e: any, i: number) => {
                        const canDelete = !!e.id && e.type !== "system" && !!e.authorId && (isManager || e.authorId === currentUser.id);
                        const menuOpen = activityMenuId === e.id;
                        const staffEntered = ["manager", "dispatcher", "back_office"].includes(e.enteredByRole);
                        const originLabel = e.isStaffOverride
                          ? "Staff override"
                          : staffEntered
                            ? "Staff-entered"
                            : e.enteredByRole === "contractor"
                              ? "Contractor-entered"
                              : null;
                        return (
                          <div key={e.id || i} style={{ display: "flex", gap: 12, marginBottom: 16, animation: i === 0 ? "fadeUp 0.3s" : "none", position: "relative" }}>
                            <div style={{ width: 8, height: 8, borderRadius: "50%", background: e.type === "system" ? T.border : T.accent, marginTop: 6, flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12 }}>
                                <span style={{ fontWeight: 600, color: T.ink }}>{e.author}</span>
                                <span style={{ color: T.subtle, marginLeft: 8, fontSize: 11 }}>{e.time}</span>
                                {originLabel && (
                                  <span style={{ display: "inline-block", marginLeft: 8, padding: "2px 6px", borderRadius: 6, fontSize: 9, fontWeight: 700, color: e.isStaffOverride ? "#73560C" : T.muted, background: e.isStaffOverride ? T.warnSoft : T.surfaceSoft, border: `1px solid ${e.isStaffOverride ? `${T.warn}55` : T.borderSoft}` }}>
                                    {originLabel}
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.55, marginTop: 3 }}>{e.text}</div>
                              {isManager && e.requiresSevenElevenSync && (
                                <label style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 8, padding: "5px 8px", borderRadius: 8, background: e.syncedToSevenElevenAt ? T.successSoft : T.warnSoft, border: `1px solid ${e.syncedToSevenElevenAt ? `${T.success}44` : `${T.warn}55`}`, color: e.syncedToSevenElevenAt ? T.success : "#73560C", fontSize: 10, fontWeight: 700, cursor: isLoading("sync711_" + e.id) ? "wait" : "pointer" }}>
                                  <input
                                    type="checkbox"
                                    checked={!!e.syncedToSevenElevenAt}
                                    disabled={isLoading("sync711_" + e.id)}
                                    onChange={(event) => doMarkSevenElevenSynced(woData.id, e.id, event.target.checked)}
                                    style={{ width: 14, height: 14, accentColor: T.success, cursor: "inherit" }}
                                  />
                                  {e.syncedToSevenElevenAt ? "Updated in 7-Eleven" : "Needs 7-Eleven update"}
                                </label>
                              )}
                              {isManager && e.id && (staffEntered || e.isStaffOverride || e.requiresContractorAttention) && (
                                <label style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 8, marginLeft: e.requiresSevenElevenSync ? 7 : 0, padding: "5px 8px", borderRadius: 8, background: e.requiresContractorAttention && !e.contractorAcknowledgedAt ? "#DCFCE7" : T.surfaceSoft, border: `1px solid ${e.requiresContractorAttention && !e.contractorAcknowledgedAt ? "#22C55E66" : T.borderSoft}`, color: e.requiresContractorAttention && !e.contractorAcknowledgedAt ? "#166534" : T.muted, fontSize: 10, fontWeight: 700, cursor: isLoading("contractorAttention_" + e.id) ? "wait" : "pointer" }}>
                                  <input
                                    type="checkbox"
                                    checked={!!e.requiresContractorAttention}
                                    disabled={isLoading("contractorAttention_" + e.id)}
                                    onChange={(event) => doMarkContractorAttention(woData.id, e.id, event.target.checked)}
                                    style={{ width: 14, height: 14, accentColor: "#16A34A", cursor: "inherit" }}
                                  />
                                  {e.contractorAcknowledgedAt
                                    ? "Contractor acknowledged"
                                    : e.requiresContractorAttention
                                      ? "Needs contractor action"
                                      : "Request contractor action"}
                                </label>
                              )}
                              {!isManager && e.requiresContractorAttention && (
                                <label style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 8, padding: "6px 9px", borderRadius: 8, background: e.contractorAcknowledgedAt ? T.surfaceSoft : "#DCFCE7", border: `1px solid ${e.contractorAcknowledgedAt ? T.borderSoft : "#22C55E66"}`, color: e.contractorAcknowledgedAt ? T.muted : "#166534", fontSize: 10, fontWeight: 700, cursor: isLoading("contractorAck_" + e.id) ? "wait" : "pointer" }}>
                                  <input
                                    type="checkbox"
                                    checked={!!e.contractorAcknowledgedAt}
                                    disabled={!!e.contractorAcknowledgedAt || isLoading("contractorAck_" + e.id)}
                                    onChange={(event) => doAcknowledgeContractorAttention(woData.id, e.id, event.target.checked)}
                                    style={{ width: 14, height: 14, accentColor: "#16A34A", cursor: "inherit" }}
                                  />
                                  {e.contractorAcknowledgedAt ? "Reviewed" : "Needs your attention"}
                                </label>
                              )}
                            </div>
                            {canDelete && (
                              <div style={{ position: "relative", flexShrink: 0 }}>
                                <button
                                  onClick={() => setActivityMenuId(menuOpen ? null : e.id)}
                                  aria-label="Activity actions"
                                  style={{ width: 36, height: 36, padding: 0, borderRadius: 6, border: "none", background: menuOpen ? T.bgWarm : "transparent", color: T.subtle, cursor: "pointer", fontSize: 16, lineHeight: 1, fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center" }}
                                >…</button>
                                {menuOpen && (
                                  <>
                                    <div onClick={() => setActivityMenuId(null)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                                    <div style={{ position: "absolute", top: 28, right: 0, zIndex: 41, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(31,30,28,0.12)", minWidth: 120, overflow: "hidden" }}>
                                      <button
                                        onClick={() => { setActivityMenuId(null); setPendingDelete({ woId: woData.id, activityId: e.id }); setModal("deleteActivity"); }}
                                        style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", background: "none", border: "none", cursor: "pointer", fontSize: 12, color: T.danger, fontFamily: "inherit" }}
                                      >Delete</button>
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Right sidebar */}
                  <div>
                    {sla2 ? (
                      <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 10 }}>SLA countdown</div>
                        <div className="display" style={{ fontSize: 28, color: sla2.headlineRemainingHours <= 0 ? T.danger : sla2.headlineRemainingHours < 2 ? T.danger : sla2.headlineRemainingHours < 4 ? T.warn : T.ink, lineHeight: 1 }}>
                          {sla2.headlineRemainingHours > 0
                            ? `${Math.floor(sla2.headlineRemainingHours)}h ${Math.round((sla2.headlineRemainingHours % 1) * 60)}m`
                            : `-${Math.floor(-sla2.headlineRemainingHours)}h`}
                        </div>
                        <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>
                          {sla2.headline === "response" ? "to Response Breach" : "to Resolution Breach"} · {PRIORITY[woData.priority]?.label || woData.priority}
                        </div>
                        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.borderSoft}`, display: "grid", gap: 6, fontSize: 11 }}>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span style={{ color: T.muted }}>Response</span>
                            <span style={{ color: sla2.responseBreached || sla2.responseWasLate ? T.danger : sla2.responseMet ? T.success : T.ink, fontWeight: 600, textAlign: "right" }}>
                              {sla2.responseMet
                                ? `Met ${sla2.responseMetAt?.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${sla2.responseWasLate ? " · LATE" : ""}`
                                : `${sla2.responseBreachAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${sla2.responseBreached ? " · BREACHED" : ""}`}
                            </span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span style={{ color: T.muted }}>Resolution</span>
                            <span style={{ color: sla2.resolutionBreached ? T.danger : T.ink, fontWeight: 600 }}>
                              {sla2.resolutionBreachAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                              {sla2.resolutionBreached ? " · BREACHED" : ""}
                            </span>
                          </div>
                          {woData.slaStartedAt && (
                            <div style={{ fontSize: 10, color: T.subtle, marginTop: 2 }}>
                              Clock started {new Date(woData.slaStartedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                            </div>
                          )}
                        </div>
                      </div>
                    ) : slaR && (
                      <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 10 }}>SLA countdown</div>
                        <div className="display" style={{ fontSize: 28, color: slaR.remainingHours < 2 ? T.danger : slaR.percent > 50 ? T.warn : T.ink, lineHeight: 1 }}>{slaR.remainingHours > 0 ? `${Math.floor(slaR.remainingHours)}h ${Math.round((slaR.remainingHours % 1) * 60)}m` : `-${Math.floor(-slaR.remainingHours)}h`}</div>
                        <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>{PRIORITY[woData.priority].label} · {PRIORITY[woData.priority].slaHours}h SLA</div>
                        <div className="sla-bar" style={{ marginTop: 10 }}>
                          <div className="sla-fill" style={{ width: `${slaR.percent}%`, background: slaR.percent > 90 ? T.danger : slaR.percent > 75 ? T.accent : slaR.percent > 50 ? T.warn : T.success }} />
                        </div>
                      </div>
                    )}
                    {woData.contractor && (
                      <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 10 }}>Contractor</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <Avatar initials={getUser(woData.contractor)?.initials} color={getUser(woData.contractor)?.color} size={38} />
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 700 }}>{getUser(woData.contractor)?.name}</div>
                            <div style={{ fontSize: 11, color: T.muted }}>{getUser(woData.contractor)?.company}</div>
                            {getUser(woData.contractor)?.phone && <div className="mono" style={{ fontSize: 11, color: T.subtle, marginTop: 3 }}>{getUser(woData.contractor)?.phone}</div>}
                          </div>
                        </div>
                      </div>
                    )}
                    {woData.eta && (
                      <div className="card" style={{ padding: 18, marginBottom: 14, background: T.warnSoft, borderColor: `${T.warn}33` }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.warn, marginBottom: 6 }}>ETA</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: "#73560C" }}>{formatEta(woData.eta, woData)}</div>
                        <div style={{ fontSize: 10, color: T.warn, marginTop: 4 }}>Auto-notify if not checked in</div>
                      </div>
                    )}
                    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 14 }}>Progress</div>
                      {getWorkOrderProgressSteps(woData, visibleActivities).map((s, i, a) => (
                        <div key={i} style={{ display: "flex", gap: 12, position: "relative" }}>
                          {i < a.length - 1 && <div style={{ position: "absolute", left: 9, top: 20, width: 2, height: 20, background: s.done && a[i + 1]?.done ? T.success : T.borderSoft }} />}
                          <div style={{ width: 20, height: 20, borderRadius: "50%", border: s.done ? "none" : `2px solid ${T.border}`, background: s.done ? T.success : T.surface, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            {s.done && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>}
                          </div>
                          <div style={{ paddingBottom: 18 }}>
                            <div style={{ fontSize: 12, fontWeight: s.done ? 600 : 400, color: s.done ? T.ink : T.subtle }}>{s.label}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* Parts tracking panel — structured wo_parts list. Visible to
                        staff and to the assigned contractor. Both can edit
                        status / tracking / return date inline. Legacy yellow
                        card is the fallback when there are no rows yet (old
                        WOs that only have part_needed/part_eta scalars). */}
                    {isManager && onConvertQuote && (
                      <QuoteCalculator
                        workOrder={woData}
                        userId={currentUser?.id}
                        contractorInvoices={invoices}
                        billingInvoices={billingInvoices}
                        fmt={fmt}
                        fire={fire}
                        onConvert={onConvertQuote}
                      />
                    )}
                    {myParts.length > 0 ? (
                      <PartsPanel
                        woId={woData.id}
                        parts={myParts}
                        isManager={isManager}
                        doAddPart={doAddPart}
                        doUpdatePart={doUpdatePart}
                        doDeletePart={doDeletePart}
                        isPartBilled={isPartBilled}
                        loadingStates={loadingStates}
                        T={T}
                      />
                    ) : woData.partNeeded ? (
                      <div className="card" style={{ padding: 18, background: T.warnSoft, borderColor: `${T.warn}33` }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.warn }}>{woData.status === "capital" ? "Equipment" : "Part"} on order</div>
                          {doAddPart && (
                            <button
                              type="button"
                              onClick={() => doAddPart(woData.id, { description: "", status: "ordered" })}
                              className="btn-soft"
                              style={{ padding: "4px 10px", fontSize: 11 }}
                            >+ Add to list</button>
                          )}
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#73560C" }}>{woData.partNeeded}</div>
                        {woData.partEta && <div style={{ fontSize: 11, color: T.warn, marginTop: 4 }}>Expected return: {woData.partEta}</div>}
                      </div>
                    ) : (
                      doAddPart && (woData.status === "parts" || woData.status === "wip" || isManager) && (
                        <button
                          type="button"
                          onClick={() => doAddPart(woData.id, { description: "", status: "ordered" })}
                          className="btn-soft"
                          style={{ padding: "8px 14px", fontSize: 12 }}
                        >+ Add part</button>
                      )
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {modal === "workReport" && woData && (
            <WorkReportForm
              woId={woData.id}
              woStore={woData.store}
              technicianOnJob={woData.technicianOnJob}
              currentUser={currentUser}
              isManager={isManager}
              contractorId={woData.contractor}
              onClose={() => setModal(null)}
              onSuccess={() => {
                setModal(null);
                fire("Work report submitted");
              }}
            />
          )}

          {modal === "capitalFlag" && woData && (
            <CapitalFlagModal
              woId={woData.id}
              woStore={woData.store}
              onClose={() => setModal(null)}
              doCapitalFlag={doCapitalFlag}
            />
          )}

    </>
  );
}

// ── PartsPanel ─────────────────────────────────────────────────────────────
// Visible to staff and to the assigned contractor. Inline status pill toggle,
// editable tracking # and expected return date. "Billed" hint is a UI signal
// only (description loose-match to invoice lines) — not authoritative.
const PART_STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  ordered:     { label: "Ordered",     bg: "#FEF3C7", fg: "#92400E" },
  backordered: { label: "Backordered", bg: "#FECACA", fg: "#7F1D1D" },
  shipped:     { label: "Shipped",     bg: "#DBEAFE", fg: "#1E3A8A" },
  received:    { label: "Received",    bg: "#D1FAE5", fg: "#065F46" },
};

function PartsPanel({ woId, parts, isManager, doAddPart, doUpdatePart, doDeletePart, isPartBilled, loadingStates, T }: any) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<any>({});
  const startEdit = (p: any) => {
    setEditingId(p.id);
    setDraft({
      description: p.description,
      partNumber: p.partNumber || "",
      qty: p.qty || 1,
      trackingNumber: p.trackingNumber || "",
      expectedReturnDate: p.expectedReturnDate || "",
    });
  };
  const saveEdit = async (p: any) => {
    await doUpdatePart(p.id, woId, {
      description: draft.description,
      partNumber: draft.partNumber,
      qty: Number(draft.qty) || 1,
      trackingNumber: draft.trackingNumber,
      expectedReturnDate: draft.expectedReturnDate || null,
    });
    setEditingId(null);
  };
  const receivedCount = parts.filter((p: any) => p.status === "received").length;
  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle }}>Parts</div>
          <div style={{ fontSize: 11, color: T.muted }}>{receivedCount} of {parts.length} received</div>
        </div>
        <button
          type="button"
          onClick={() => doAddPart(woId, { description: "New part", status: "ordered" })}
          disabled={!!loadingStates["addPart_" + woId]}
          className="btn-soft"
          style={{ padding: "5px 12px", fontSize: 11 }}
        >+ Add part</button>
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {parts.map((p: any) => {
          const meta = PART_STATUS_META[p.status] || PART_STATUS_META.ordered;
          const isEditing = editingId === p.id;
          const billed = isPartBilled ? isPartBilled(p.description) : false;
          const updating = !!loadingStates["updatePart_" + p.id];
          return (
            <div key={p.id} style={{ padding: 12, background: T.surfaceSoft, borderRadius: 10, border: `1px solid ${T.borderSoft}` }}>
              {isEditing ? (
                <div style={{ display: "grid", gap: 8 }}>
                  <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1.4fr 110px 70px", gap: 8 }}>
                    <Field label="Description"><Input value={draft.description} onChange={(e: any) => setDraft((d: any) => ({ ...d, description: e.target.value }))} /></Field>
                    <Field label="Part #"><Input value={draft.partNumber} onChange={(e: any) => setDraft((d: any) => ({ ...d, partNumber: e.target.value }))} /></Field>
                    <Field label="Qty"><Input type="number" min="1" step="1" value={draft.qty} onChange={(e: any) => setDraft((d: any) => ({ ...d, qty: e.target.value }))} /></Field>
                  </div>
                  <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <Field label="Tracking #"><Input value={draft.trackingNumber} onChange={(e: any) => setDraft((d: any) => ({ ...d, trackingNumber: e.target.value }))} placeholder="e.g. 1Z..." /></Field>
                    <Field label="Expected return"><Input type="date" value={draft.expectedReturnDate} onChange={(e: any) => setDraft((d: any) => ({ ...d, expectedReturnDate: e.target.value }))} /></Field>
                  </div>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 4 }}>
                    <button type="button" onClick={() => setEditingId(null)} className="btn-soft" style={{ padding: "5px 12px", fontSize: 11 }}>Cancel</button>
                    <button type="button" onClick={() => saveEdit(p)} disabled={updating} className="btn-accent" style={{ padding: "5px 12px", fontSize: 11 }}>{updating ? "Saving..." : "Save"}</button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: T.ink, marginBottom: 2 }}>
                        {p.description || "(no description)"}
                        {p.qty && p.qty !== 1 ? <span style={{ fontSize: 11, color: T.subtle, fontWeight: 400, marginLeft: 6 }}>× {p.qty}</span> : null}
                      </div>
                      {p.partNumber && <div className="mono" style={{ fontSize: 11, color: T.muted }}>{p.partNumber}</div>}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: meta.fg, background: meta.bg, padding: "3px 9px", borderRadius: 10, letterSpacing: 0.4, textTransform: "uppercase" }}>{meta.label}</span>
                      {billed && <span style={{ fontSize: 9, fontWeight: 700, color: T.subtle, background: T.surface, padding: "3px 8px", borderRadius: 10, letterSpacing: 0.4, textTransform: "uppercase", border: `1px solid ${T.border}` }}>Billed</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", fontSize: 11, color: T.muted, marginTop: 4 }}>
                    {p.trackingNumber ? (
                      <span>Tracking <span className="mono" style={{ color: T.ink }}>{p.trackingNumber}</span></span>
                    ) : (
                      <span style={{ color: T.subtle, fontStyle: "italic" }}>No tracking #</span>
                    )}
                    {p.expectedReturnDate && <span>Expected return <span style={{ color: T.ink }}>{p.expectedReturnDate}</span></span>}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, gap: 8, flexWrap: "wrap" }}>
                    <Sel
                      value={p.status}
                      onChange={(e: any) => doUpdatePart(p.id, woId, { status: e.target.value })}
                      style={{ padding: "5px 10px", fontSize: 11, borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }}
                    >
                      <option value="ordered">Ordered</option>
                      <option value="backordered">Backordered</option>
                      <option value="shipped">Shipped</option>
                      <option value="received">Received</option>
                    </Sel>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button type="button" onClick={() => startEdit(p)} className="btn-soft" style={{ padding: "5px 10px", fontSize: 11 }}>Edit</button>
                      {isManager && doDeletePart && (
                        <button type="button" onClick={() => doDeletePart(p.id, woId)} className="btn-soft" style={{ padding: "5px 10px", fontSize: 11, color: T.danger }}>Remove</button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
