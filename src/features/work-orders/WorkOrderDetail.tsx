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
import { SlaBadge } from "../../components/SlaBadge";
import { T, PRIORITY, STATUS, FUNCTIONAL_STATUS, MONTHS, P1_BUSINESS, SEVEN_BILL_TO } from "../../lib/constants";
import { computeSlaState } from "../../lib/slaConfig";
import PhotoGallery from "../photos/PhotoGallery";

const WorkReportForm = dynamic(
  () => import("./WorkReportForm"),
  { ssr: false }
);
const CapitalFlagModal = dynamic(
  () => import("./CapitalFlagModal"),
  { ssr: false }
);

// ETA is stored as an ISO timestamp (timestamptz). Render it in the user's
// locale. Falls through to the raw string for any legacy non-ISO value so
// historic rows still display.
const formatEta = (v: any): string => {
  if (!v) return "";
  const s = String(v);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
};

export default function WorkOrderDetail(props: any) {
  const { page, selectedWO, woData, workOrders, invoices, technicians, USERS = [], modal, isManager, setSelectedWO, setAiNote, setPage, slaLabel, slaRemaining, fmt, getUser, contractorsOnly, doAssign, setReassignTarget, setModal, doCapitalFlag, doCapitalDecline, doMoveToInvoice, doApproveInvoice, doMarkPaid, doCloseWO, doDownloadInvoice, doDeleteInvoice, doRejectInvoice, openCreateInvoice, pdfBusy, activityMenuId, setActivityMenuId, setPendingDelete, currentUser, fire, aiNote, aiEnhancing, doAiEnhance, noteText, setNoteText, doPostNote, doSetTechnician, imageErrors, setImageErrors, setLightbox, doAddPhotos, doRemovePhoto, doDeleteActivity, doSetEta, doEditNte, doEditNteFlag, doStartWork, doPauseWork, doCloseComplete, startDateInput, setStartDateInput, startTimeInput, setStartTimeInput, pauseDateInput, setPauseDateInput, pauseTimeInput, setPauseTimeInput, loadingStates = {} } = props;
  const openCreate = openCreateInvoice || (() => setModal("createInvoice"));
  // The single-invoice "Approve (on behalf of AFM)" button on the WO actions
  // row is gone — multi-invoice approvals happen per-row in the invoice
  // group below. Keep a noop fallback for any callsite that still expects
  // the prop.
  const [rejectingInv, setRejectingInv] = useState<any>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [deletingInvId, setDeletingInvId] = useState<string | null>(null);
  const [busyInvId, setBusyInvId] = useState<string | null>(null);
  const storeHistory = useMemo(
    () => woData ? workOrders.filter(w => w.store === woData.store && w.id !== woData.id) : [],
    [workOrders, woData]
  );
  const sameCategory = useMemo(
    () => woData ? storeHistory.filter(w => w.category === woData.category).length : 0,
    [storeHistory, woData]
  );
  const woInvoices = useMemo(
    () => woData ? invoices.filter(i => i.wot === woData.id && i.state !== "draft") : [],
    [invoices, woData]
  );
  // All invoices on this WO (incl. drafts) for the per-WO group panel — drafts
  // get a "Resume" affordance, everything else gets state badges + actions.
  const woAllInvoices = useMemo(
    () => woData ? invoices.filter(i => i.wot === woData.id) : [],
    [invoices, woData]
  );
  const currentSpend = useMemo(
    // NTE spend excludes rejected too — a rejected invoice isn't a real charge.
    () => woInvoices.filter(i => i.state !== "rejected").reduce((s, i) => s + (i.total || 0), 0),
    [woInvoices]
  );
  const canInvoice = isManager
    ? false
    : currentUser?.contractorTier === "direct" || currentUser?.contractorTier === null;
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
            // Current spend = sum of every non-draft invoice on the work order
            // (matches what the AFM sees when reviewing).
            const nte = woData.nte || 0;
            const nteBreach = currentSpend > nte && currentSpend > 0 && nte > 0;
            const nteHeadroom = nte - currentSpend;
            const ntePercent = nte > 0 ? (currentSpend / nte) * 100 : 0;
            const sla = slaLabel(woData);
            const slaR = slaRemaining(woData);
            const sla2 = computeSlaState(woData.responseBreachAt, woData.resolutionBreachAt);
            return (
              <div style={{ animation: "fadeUp 0.25s" }}>
                <button onClick={() => { setSelectedWO(null); setAiNote(null); if (!isManager) setPage("my_jobs"); }} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: T.muted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", marginBottom: 16, padding: 0 }}><Ico d="M15 18l-6-6 6-6" size={14} /> Back</button>

                {/* Alert stack — two-breach SLA replaces the single-deadline view */}
                {sla2 && (sla2.responseBreached || sla2.resolutionBreached) && (
                  <div className="card" style={{ background: T.dangerSoft, border: `1px solid ${T.danger}44`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 22 }}>🚨</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: T.danger, fontSize: 13 }}>
                        {sla2.responseBreached && sla2.resolutionBreached
                          ? "Both SLA deadlines breached"
                          : sla2.responseBreached
                            ? `Response breached — ${Math.floor(-sla2.responseRemainingHours)}h past arrival deadline`
                            : `Resolution breached — ${Math.floor(-sla2.resolutionRemainingHours)}h past resolve deadline`}
                      </div>
                      <div style={{ fontSize: 11, color: "#8B2C20", marginTop: 2 }}>Functional status is "{woData.functionalStatus || "—"}" — update immediately to close the gap with 7-Eleven.</div>
                    </div>
                  </div>
                )}
                {sla2 && !sla2.responseBreached && sla2.responseRemainingHours < 1 && (
                  <div className="card" style={{ background: T.dangerSoft, border: `1px solid ${T.danger}33`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 20 }}>⚠️</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: T.danger, fontSize: 13 }}>Response SLA at risk — {Math.round(sla2.responseRemainingHours * 60)} minutes to breach</div>
                      <div style={{ fontSize: 11, color: "#8B2C20", marginTop: 2 }}>Check in with the contractor — they need to be on site soon.</div>
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
                {nteBreach && (
                  <div className="card" style={{ background: T.dangerSoft, border: `1px solid ${T.danger}33`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 20 }}>⚠️</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: T.danger, fontSize: 12 }}>Spend exceeds NTE by {fmt(currentSpend - nte)}</div>
                      <div style={{ fontSize: 11, color: "#8B2C20", marginTop: 2 }}>Invoiced {fmt(currentSpend)} vs authorized {fmt(nte)} — requires AFM approval / justification.</div>
                    </div>
                  </div>
                )}
                {!nteBreach && currentSpend > 0 && (
                  <div className="card" style={{ background: T.successSoft, border: `1px solid ${T.success}33`, padding: "14px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 18 }}>✓</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: T.success, fontSize: 12 }}>Within budget — {fmt(nteHeadroom)} under NTE</div>
                      <div style={{ fontSize: 11, color: "#2F5B3C", marginTop: 2 }}>Invoiced {fmt(currentSpend)} of {fmt(nte)} authorized.</div>
                    </div>
                  </div>
                )}

                <div className="detail-two-col" style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 20 }}>
                  <div>
                    {/* Header card */}
                    <div className="card" style={{ padding: 24, marginBottom: 16 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                        <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: T.accent }}>{woData.id}</span>
                        {woData.incidentId && <span style={{ color: T.subtle, fontSize: 12 }}>/</span>}
                        {woData.incidentId && <span className="mono" style={{ fontSize: 11, color: T.muted }}>{woData.incidentId}</span>}
                      </div>
                      <div className="display" style={{ fontSize: 28, fontWeight: 500, color: T.ink, letterSpacing: -0.4, lineHeight: 1.1 }}>
                        {[woData.store ? `Store #${woData.store}` : null, woData.city || null].filter(Boolean).join(" · ") || woData.id}
                      </div>
                      {woData.addr && <div style={{ fontSize: 13, color: T.muted, marginTop: 4 }}>{woData.addr}</div>}
                      <div style={{ display: "flex", gap: 7, marginTop: 14, flexWrap: "wrap" }}>
                        <Badge conf={PRIORITY[woData.priority]} />
                        <Badge conf={STATUS[woData.status]} />
                        {woData.functionalStatus && <Badge conf={{ label: `FSM: ${woData.functionalStatus}`, ...FUNCTIONAL_STATUS[woData.functionalStatus] || { color: T.muted, bg: T.borderSoft } }} />}
                        {sla2
                          ? <SlaBadge responseBreachAt={woData.responseBreachAt} resolutionBreachAt={woData.resolutionBreachAt} size="sm" />
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
                          { l: "NTE", v: fmt(woData.nte) },
                          { l: "ETA", v: formatEta(woData.eta) || "Not set" },
                          { l: "Assigned to", v: woData.contractor ? getUser(woData.contractor)?.name : "Unassigned" },
                          { l: "Start time", v: woData.startTime || "Not started" },
                          // AFM name + email are hidden from contractors so a field tech
                          // can't contact the AFM directly — staff roles still see them.
                          ...(isManager ? [{ l: "AFM", v: woData.afm || "—" }] : []),
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

                    {/* NTE summary — visible on every WO. Edit in-place. No hard stop on overage. */}
                    <div className="card" style={{ padding: 18, marginBottom: 16, background: nteBreach ? T.dangerSoft : T.surface, border: nteBreach ? `1px solid ${T.danger}33` : `1px solid ${T.borderSoft}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle }}>NTE</div>
                          <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: T.ink }}>{nte > 0 ? fmt(nte) : "Not set"}</div>
                          {nteBreach && <span style={{ fontSize: 10, fontWeight: 700, color: "#fff", background: T.danger, padding: "2px 8px", borderRadius: 10, letterSpacing: 0.4 }}>EXCEEDS NTE</span>}
                        </div>
                        {isManager && (
                          <button onClick={() => setModal("editNte")} className="btn-soft" style={{ padding: "6px 12px", fontSize: 11 }}>{nte > 0 ? "Edit" : "Add NTE"}</button>
                        )}
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: T.muted, marginBottom: 8 }}>
                        <span>Current spend: <span className="mono" style={{ color: T.ink, fontWeight: 600 }}>{fmt(currentSpend)}</span></span>
                        <span style={{ color: nteBreach ? T.danger : T.muted, fontWeight: nteBreach ? 700 : 500 }}>{nte > 0 ? `${Math.round(ntePercent)}% of NTE` : "No NTE set"}</span>
                      </div>
                      {/* Progress bar — fills past 100% with red overflow when exceeded */}
                      <div style={{ height: 8, borderRadius: 4, background: T.borderSoft, overflow: "hidden", display: "flex" }}>
                        <div style={{ width: `${Math.min(100, ntePercent)}%`, height: "100%", background: ntePercent > 90 ? T.danger : ntePercent > 75 ? T.warn : T.success, transition: "width 300ms ease" }} />
                        {ntePercent > 100 && (
                          <div style={{ width: `${Math.min(100, ntePercent - 100)}%`, height: "100%", background: T.danger, opacity: 0.55 }} />
                        )}
                      </div>
                      {woInvoices.length > 0 && (
                        <div style={{ fontSize: 10, color: T.subtle, marginTop: 8 }}>
                          {woInvoices.length} invoice{woInvoices.length !== 1 ? "s" : ""} on file
                        </div>
                      )}
                      {/* NTE early-warning flag threshold ($900 default, editable by
                          staff). Separate from the actual NTE above. */}
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.borderSoft}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: T.subtle }}>NTE flag at</span>
                          <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>{fmt(woData.nteFlagThreshold != null ? woData.nteFlagThreshold : 900)}</span>
                          {woData.nteFlagged && <span style={{ fontSize: 10, fontWeight: 700, color: "#fff", background: T.warn, padding: "2px 8px", borderRadius: 10, letterSpacing: 0.3 }}>NTE APPROVAL NEEDED{woData.nteFlagAmount != null ? ` · ${fmt(woData.nteFlagAmount)}` : ""}</span>}
                        </div>
                        {isManager && <button onClick={() => setModal("editNteFlag")} className="btn-soft" style={{ padding: "5px 10px", fontSize: 11 }}>Edit flag</button>}
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
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
                      {woData.status === "assigned" && !isManager && (
                        <>
                          <button onClick={() => setModal("setEta")} disabled={isLoading("setEta_" + woData.id)} className="btn-soft" style={loadingStyle("setEta_" + woData.id)}>
                            {isLoading("setEta_" + woData.id) ? <><BtnSpinnerDark />Setting...</> : "Set ETA"}
                          </button>
                          <button onClick={() => setModal("startWork")} disabled={isLoading("startWork_" + woData.id)} className="btn-accent" style={loadingStyle("startWork_" + woData.id)}>
                            {isLoading("startWork_" + woData.id) ? <><BtnSpinner />Starting...</> : "Start work"}
                          </button>
                        </>
                      )}
                      {woData.status === "wip" && (
                        <>
                          <button onClick={() => setModal("pauseWork")} disabled={isLoading("pauseWork_" + woData.id)} className="btn-soft" style={loadingStyle("pauseWork_" + woData.id)}>
                            {isLoading("pauseWork_" + woData.id) ? <><BtnSpinnerDark />Pausing...</> : "Pause (parts)"}
                          </button>
                          {isManager && <button onClick={() => setModal("capitalFlag")} disabled={isLoading("capitalFlag_" + woData.id)} className="btn-soft" style={loadingStyle("capitalFlag_" + woData.id)}>{isLoading("capitalFlag_" + woData.id) ? <><BtnSpinnerDark />Flagging...</> : "Flag capital"}</button>}
                          <button onClick={() => setModal("closeComplete")} disabled={isLoading("closeComplete_" + woData.id)} className="btn-primary" style={loadingStyle("closeComplete_" + woData.id)}>
                            {isLoading("closeComplete_" + woData.id) ? <><BtnSpinner />Closing...</> : "Close complete"}
                          </button>
                        </>
                      )}
                      {woData.status === "capital" && isManager && (
                        <button onClick={() => doCapitalDecline(woData.id)} disabled={isLoading("capitalDecline_" + woData.id)} className="btn-soft" style={loadingStyle("capitalDecline_" + woData.id)}>
                          {isLoading("capitalDecline_" + woData.id) ? <><BtnSpinnerDark />Returning...</> : "Capital declined - return to dispatched"}
                        </button>
                      )}
                      {woData.status === "parts" && !isManager && (
                        <button onClick={() => setModal("startWork")} disabled={isLoading("startWork_" + woData.id)} className="btn-accent" style={loadingStyle("startWork_" + woData.id)}>
                          {isLoading("startWork_" + woData.id) ? <><BtnSpinner />Resuming...</> : "Resume work"}
                        </button>
                      )}
                      {woData.status === "completed" && isManager && (
                        <button onClick={() => doMoveToInvoice(woData.id)} disabled={isLoading("moveToInvoice_" + woData.id)} className="btn-accent" style={loadingStyle("moveToInvoice_" + woData.id)}>
                          {isLoading("moveToInvoice_" + woData.id) ? <><BtnSpinner />Updating...</> : "Portal updated to pending invoice"}
                        </button>
                      )}
                      {/* Multi-invoice: a contractor can keep adding invoices for
                          follow-up visits until the WO closes. The per-invoice
                          approve/reject/mark-paid actions are rendered in the
                          invoice group block below. */}
                      {woData.status !== "closed" && !isManager && canInvoice && <button onClick={() => openCreate(null)} className="btn-accent">Create invoice</button>}
                      {!isManager && ["wip", "parts", "completed"].includes(woData.status) && <button onClick={() => setModal("workReport")} className="btn-soft">Submit work report</button>}
                      {woData.status === "pending_payment" && isManager && (
                        <button onClick={() => setModal("markPaid")} disabled={isLoading("markPaid_" + woData.id)} className="btn-primary" style={loadingStyle("markPaid_" + woData.id)}>
                          {isLoading("markPaid_" + woData.id) ? <><BtnSpinner />Processing...</> : "Mark paid and close"}
                        </button>
                      )}
                      {/* Manual close — staff judgement decides when the job is done.
                          Paying invoices no longer auto-closes the WO (capital jobs
                          run for weeks while invoices land). Closing stamps closed_at,
                          clears the NTE flag, and starts the 24h linger to History. */}
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
                      <div className="card" style={{ padding: 0, marginBottom: 16, overflow: "hidden" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${T.borderSoft}`, background: T.surfaceSoft }}>
                          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle }}>
                            {woAllInvoices.length} invoice{woAllInvoices.length === 1 ? "" : "s"} on this work order
                          </div>
                          {!isManager && canInvoice && woData.status !== "closed" && (
                            <button onClick={() => openCreate(null)} className="btn-soft" style={{ padding: "6px 12px", fontSize: 11 }}>+ Add invoice</button>
                          )}
                        </div>
                        {woAllInvoices
                          .slice()
                          .sort((a: any, b: any) => (a.invoiceDate || "").localeCompare(b.invoiceDate || ""))
                          .map((inv: any, idx: number) => {
                            const isMyDraft = inv.state === "draft" && (inv.contractor === currentUser?.id || isManager);
                            const stateLabel = ({ draft: "Draft", submitted: "Submitted", revised: "Revised", approved: "Approved", rejected: "Rejected", paid: "Paid" } as any)[inv.state] || inv.state;
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
                            return (
                              <div key={inv.id || inv.num} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: idx < woAllInvoices.length - 1 ? `1px solid ${T.borderSoft}` : "none", flexWrap: "wrap" }}>
                                <div style={{ minWidth: 0, flex: 1 }}>
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
                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                  {inv.state !== "draft" && (
                                    <button onClick={() => doDownloadInvoice && doDownloadInvoice(inv)} disabled={pdfBusy} className="btn-soft" style={{ padding: "6px 10px", fontSize: 11 }}>Download</button>
                                  )}
                                  {isMyDraft && !isManager && (
                                    <button onClick={() => openCreate(inv)} className="btn-accent" style={{ padding: "6px 10px", fontSize: 11 }}>Resume</button>
                                  )}
                                  {isManager && (inv.state === "submitted" || inv.state === "revised") && (
                                    <>
                                      <button
                                        onClick={async () => { setBusyInvId(inv.id); try { await doApproveInvoice(inv.id); } finally { setBusyInvId(null); } }}
                                        disabled={rowBusy || isLoading("approveInvoice_" + inv.id)}
                                        className="btn-accent"
                                        style={{ padding: "6px 10px", fontSize: 11, opacity: rowBusy ? 0.7 : 1, cursor: rowBusy ? "default" : "pointer" }}
                                      >{rowBusy || isLoading("approveInvoice_" + inv.id) ? <><BtnSpinner />Approving…</> : "Approve"}</button>
                                      <button onClick={() => { setRejectingInv(inv); setRejectReason(""); }} className="btn-soft" style={{ padding: "6px 10px", fontSize: 11, color: T.danger, borderColor: `${T.danger}44` }}>Reject</button>
                                    </>
                                  )}
                                  {isManager && inv.state === "approved" && (
                                    <button
                                      onClick={async () => { setBusyInvId(inv.id); try { await doMarkPaid(inv.id); } finally { setBusyInvId(null); } }}
                                      disabled={rowBusy || isLoading("markPaid_" + inv.id)}
                                      className="btn-primary"
                                      style={{ padding: "6px 10px", fontSize: 11, opacity: rowBusy ? 0.7 : 1, cursor: rowBusy ? "default" : "pointer" }}
                                    >{rowBusy || isLoading("markPaid_" + inv.id) ? <><BtnSpinner />…</> : "Mark paid"}</button>
                                  )}
                                  {isManager && (
                                    <button onClick={() => setDeletingInvId(inv.id)} className="btn-soft" style={{ padding: "6px 10px", fontSize: 11, color: T.danger, borderColor: `${T.danger}44` }}>Delete</button>
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
                    {deletingInvId && (() => {
                      const inv = woAllInvoices.find((i: any) => i.id === deletingInvId);
                      if (!inv) return null;
                      return (
                        <Modal onClose={() => setDeletingInvId(null)} title="Delete invoice" width={420}>
                          <div style={{ fontSize: 13, color: T.muted, marginBottom: 20, lineHeight: 1.55 }}>
                            Delete invoice <span className="mono" style={{ color: T.ink, fontWeight: 600 }}>#{inv.num}</span>? This cannot be undone from the portal.
                          </div>
                          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                            <button onClick={() => setDeletingInvId(null)} className="btn-soft">Cancel</button>
                            <button
                              onClick={async () => { await doDeleteInvoice(inv); setDeletingInvId(null); }}
                              style={{ padding: "10px 18px", borderRadius: 10, background: T.danger, color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit" }}
                            >Delete</button>
                          </div>
                        </Modal>
                      );
                    })()}

                    {/* Destructive secondary action — deliberately separated from the
                        primary action zone above. Soft delete, manager/dispatcher/
                        back-office only (never contractor). */}
                    {isManager && (
                      <div style={{ marginBottom: 16, paddingTop: 2, borderTop: `1px solid ${T.borderSoft}` }}>
                        <button onClick={() => setModal("deleteWO")} disabled={isLoading("deleteWO_" + woData.id)} style={{ marginTop: 12, background: "none", border: "none", color: T.danger, fontSize: 12, fontWeight: 600, cursor: isLoading("deleteWO_" + woData.id) ? "default" : "pointer", fontFamily: "inherit", padding: "4px 2px", textDecoration: "underline", textUnderlineOffset: 3, opacity: isLoading("deleteWO_" + woData.id) ? 0.7 : 1, display: "flex", alignItems: "center", gap: 6 }}>
                          {isLoading("deleteWO_" + woData.id) ? <><BtnSpinnerDark />Deleting...</> : "Delete work order"}
                        </button>
                      </div>
                    )}

                    {/* Technician on Job — contractor picks who was on site (text
                        snapshot, optional). Staff see it read-only. Locked at closed
                        (Completion Record carries it then). */}
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
                    {(["completed", "pending_invoice", "pending_approval", "pending_payment", "closed"].includes(woData.status) || woData.assetModel || woData.resolutionCode) && (() => {
                      const closeAct = (woData.activities || []).find((a: any) => /marked paid by /i.test(a.text || ""));
                      const closedBy = closeAct ? (closeAct.text.match(/marked paid by ([^.]+)/i)?.[1]?.trim() || null) : null;
                      const rec = [
                        { l: "Equipment make", v: woData.assetMake || "—" },
                        { l: "Asset model", v: woData.assetModel || "—" },
                        { l: "Serial number", v: woData.assetSerial || "—" },
                        { l: "Resolution code (DSP closure)", v: woData.resolutionCode || "—" },
                        { l: "Technician on Job", v: woData.technicianOnJob || "—" },
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
                              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: T.subtle, marginBottom: 3 }}>Disposition notes</div>
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
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Activity · {woData.activities?.length || 0}</div>
                        {isManager && <button className="desktop-only-activity-action" onClick={doAiEnhance} disabled={aiEnhancing} style={{ padding: "7px 14px", borderRadius: 8, background: aiEnhancing ? T.borderSoft : T.ink, color: aiEnhancing ? T.muted : T.bg, border: "none", cursor: aiEnhancing ? "default" : "pointer", fontWeight: 600, fontSize: 11, fontFamily: "inherit", alignItems: "center", gap: 6 }}>{aiEnhancing ? <><span style={{ display: "inline-block", width: 12, height: 12, border: `2px solid ${T.border}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} /> Loadingâ€¦</> : <>AI enhance notes <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 6, background: T.accent, color: "#fff", letterSpacing: 0.4 }}>PREVIEW</span></>}</button>}
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
                      {(woData.activities || []).map((e: any, i: number) => {
                        const canDelete = !!e.id && e.type !== "system" && !!e.authorId && (isManager || e.authorId === currentUser.id);
                        const menuOpen = activityMenuId === e.id;
                        return (
                          <div key={e.id || i} style={{ display: "flex", gap: 12, marginBottom: 16, animation: i === 0 ? "fadeUp 0.3s" : "none", position: "relative" }}>
                            <div style={{ width: 8, height: 8, borderRadius: "50%", background: e.type === "system" ? T.border : T.accent, marginTop: 6, flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12 }}>
                                <span style={{ fontWeight: 600, color: T.ink }}>{e.author}</span>
                                <span style={{ color: T.subtle, marginLeft: 8, fontSize: 11 }}>{e.time}</span>
                              </div>
                              <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.55, marginTop: 3 }}>{e.text}</div>
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
                            <span style={{ color: sla2.responseBreached ? T.danger : T.ink, fontWeight: 600 }}>
                              {sla2.responseBreachAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                              {sla2.responseBreached ? " · BREACHED" : ""}
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
                        <div style={{ fontSize: 15, fontWeight: 700, color: "#73560C" }}>{formatEta(woData.eta)}</div>
                        <div style={{ fontSize: 10, color: T.warn, marginTop: 4 }}>Auto-notify if not checked in</div>
                      </div>
                    )}
                    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 14 }}>Progress</div>
                      {[
                        { label: "Created", done: true },
                        { label: "Dispatched + ETA", done: ["assigned", "wip", "parts", "capital", "completed", "pending_invoice", "pending_approval", "pending_payment", "closed"].includes(woData.status) },
                        { label: "Work started", done: ["wip", "parts", "capital", "completed", "pending_invoice", "pending_approval", "pending_payment", "closed"].includes(woData.status) },
                        { label: "Asset captured", done: !!woData.assetModel },
                        { label: "Completed", done: ["completed", "pending_invoice", "pending_approval", "pending_payment", "closed"].includes(woData.status) },
                        { label: "7-Eleven updated", done: ["pending_invoice", "pending_approval", "pending_payment", "closed"].includes(woData.status) },
                        { label: "Invoiced", done: ["pending_approval", "pending_payment", "closed"].includes(woData.status) },
                        { label: "Approved (AFM)", done: ["pending_payment", "closed"].includes(woData.status) },
                        { label: "Paid + closed", done: woData.status === "closed" },
                      ].map((s, i, a) => (
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
                    {woData.partNeeded && (
                      <div className="card" style={{ padding: 18, background: T.warnSoft, borderColor: `${T.warn}33` }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.warn, marginBottom: 6 }}>{woData.status === "capital" ? "Equipment" : "Part"} on order</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#73560C" }}>{woData.partNeeded}</div>
                        {woData.partEta && <div style={{ fontSize: 11, color: T.warn, marginTop: 4 }}>ETA: {woData.partEta}</div>}
                      </div>
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
