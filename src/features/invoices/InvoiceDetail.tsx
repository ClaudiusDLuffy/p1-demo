"use client";
// @ts-nocheck

import { Badge } from "../../components/ui/Badge";
import { Ico } from "../../components/ui/Ico";
import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { Modal } from "../../components/ui/Modal";
import { T, INV_STATE, P1_BUSINESS } from "../../lib/constants";
import { useMemo, useState } from "react";

export default function InvoiceDetail(props: any) {
  const { page, selectedInvoice, invoices, billingInvoices = [], workOrders, isManager, currentUser, getUser, setSelectedInvoice, onOpenBillingInvoice, doApproveInvoice, doMarkPaid, doDownloadInvoice, doDownloadInvoiceCsv, doDeleteInvoice, doRejectInvoice, doCorrectInvoiceTotal, pdfBusy, fmt, loadingStates = {} } = props;
  const controller = String(currentUser?.email || "").trim().toLowerCase()
    === "emilyb@phospitality.com";
  const canReview = isManager && !controller;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmMarkPaid, setConfirmMarkPaid] = useState(false);
  const [approving, setApproving] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [submittingReject, setSubmittingReject] = useState(false);
  const [correctingTotal, setCorrectingTotal] = useState(false);
  const [correctedTotal, setCorrectedTotal] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [submittingCorrection, setSubmittingCorrection] = useState(false);
  const inv = useMemo(
    () => invoices.find(i => i.id === selectedInvoice),
    [invoices, selectedInvoice]
  );
  const contractorProfile = inv
    ? getUser?.(inv.contractor)
      || (currentUser?.role === "contractor" ? currentUser : null)
    : null;
  const contractorName = contractorProfile?.company
    || contractorProfile?.name
    || "Contractor";
  const canCorrectTotal = isManager
    && inv?.state !== "paid"
    && (!controller || inv?.state === "approved");
  const wo = useMemo(
    () => inv ? workOrders.find(w => w.id === inv.wot) : null,
    [workOrders, inv]
  );
  const linkedStaffInvoices = useMemo(
    () => !isManager || !inv
      ? []
      : billingInvoices.filter((billingInvoice: any) =>
          (billingInvoice.sourceInvoiceIds || []).includes(inv.id),
        ),
    [billingInvoices, inv, isManager],
  );
  return (
    <>
          {page === "invoices" && selectedInvoice && (() => {
            if (!inv) return null;
            return (
              <div style={{ animation: "fadeUp 0.25s" }}>
                <div className="invoice-action-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, maxWidth: 860 }}>
                  <button className="invoice-back-button" onClick={() => setSelectedInvoice(null)} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: T.muted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0 }}><Ico d="M15 18l-6-6 6-6" size={14} /> Back to invoices</button>
                  <div className="invoice-action-buttons" style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => doDownloadInvoice(inv)} disabled={pdfBusy} className="btn-soft" style={{ display: "flex", alignItems: "center", gap: 6, opacity: pdfBusy ? 0.6 : 1, cursor: pdfBusy ? "default" : "pointer" }}>
                      <Ico d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" size={13} color="currentColor" />
                      {pdfBusy ? "Preparing…" : "Download PDF"}
                    </button>
                    <button onClick={() => doDownloadInvoiceCsv(inv)} className="btn-soft" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Ico d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8M8 17h8" size={13} color="currentColor" />
                      Download CSV
                    </button>
                    {canCorrectTotal && doCorrectInvoiceTotal && (
                      <button
                        type="button"
                        onClick={() => {
                          setCorrectedTotal(Number(inv.total || 0).toFixed(2));
                          setCorrectionReason("");
                          setCorrectingTotal(true);
                        }}
                        className="btn-soft"
                      >
                        Correct total
                      </button>
                    )}
                    {/* Multi-invoice: every action is per-invoice (inv.id).
                        Approving here updates ONE invoice; the WO advances
                        only when all its non-draft, non-rejected siblings are
                        approved/paid (logic in useWorkOrders). */}
                    {canReview && (inv.state === "submitted" || inv.state === "revised") && (
                      <>
                        <button
                          onClick={() => setConfirmApprove(true)}
                          disabled={loadingStates["approveInvoice_" + inv.id] || approving}
                          className="btn-primary"
                          style={{ display: "flex", alignItems: "center", gap: 6, opacity: loadingStates["approveInvoice_" + inv.id] || approving ? 0.7 : 1, cursor: loadingStates["approveInvoice_" + inv.id] || approving ? "default" : "pointer" }}
                        >
                          {loadingStates["approveInvoice_" + inv.id] || approving ? <><BtnSpinner />Approving...</> : "Approve"}
                        </button>
                        <button onClick={() => setRejecting(true)} className="btn-soft" style={{ color: T.danger, borderColor: `${T.danger}44` }}>Reject</button>
                      </>
                    )}
                    {isManager && inv.state === "approved" && doMarkPaid && (
                      <button
                        onClick={() => setConfirmMarkPaid(true)}
                        disabled={loadingStates["markPaid_" + inv.id] || markingPaid}
                        className="btn-primary"
                        style={{ display: "flex", alignItems: "center", gap: 6, opacity: loadingStates["markPaid_" + inv.id] || markingPaid ? 0.7 : 1, cursor: loadingStates["markPaid_" + inv.id] || markingPaid ? "default" : "pointer" }}
                      >{loadingStates["markPaid_" + inv.id] || markingPaid ? <><BtnSpinner />Sending...</> : "Sent to QuickBooks"}</button>
                    )}
                    {/* Staff-only soft delete (testing-phase cleanup) — contractors never see this. */}
                    {canReview && (
                      <button onClick={() => setConfirmDelete(true)} className="btn-soft" style={{ color: T.danger, borderColor: `${T.danger}44` }}>Delete</button>
                    )}
                  </div>
                </div>
                {confirmApprove && (
                  <Modal onClose={() => { if (!approving) setConfirmApprove(false); }} title={`Approve invoice #${inv.num}`} width={440}>
                    <div style={{ fontSize: 13, color: T.muted, marginBottom: 20, lineHeight: 1.55 }}>
                      Approve invoice <span className="mono" style={{ color: T.ink, fontWeight: 600 }}>#{inv.num}</span>? This updates only this invoice. The work order advances only when all live invoices are approved or sent to QuickBooks.
                    </div>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button onClick={() => setConfirmApprove(false)} disabled={approving} className="btn-soft">Cancel</button>
                      <button
                        onClick={async () => {
                          setApproving(true);
                          try {
                            await doApproveInvoice(inv.id);
                            setConfirmApprove(false);
                          } finally {
                            setApproving(false);
                          }
                        }}
                        disabled={approving || loadingStates["approveInvoice_" + inv.id]}
                        className="btn-primary"
                        style={{ padding: "10px 18px", opacity: approving || loadingStates["approveInvoice_" + inv.id] ? 0.7 : 1, cursor: approving || loadingStates["approveInvoice_" + inv.id] ? "default" : "pointer", display: "flex", alignItems: "center", gap: 6 }}
                      >{approving || loadingStates["approveInvoice_" + inv.id] ? <><BtnSpinner />Approving...</> : "Approve"}</button>
                    </div>
                  </Modal>
                )}
                {confirmMarkPaid && (
                  <Modal onClose={() => { if (!markingPaid) setConfirmMarkPaid(false); }} title={`Send invoice #${inv.num} to QuickBooks`} width={440}>
                    <div style={{ fontSize: 13, color: T.muted, marginBottom: 20, lineHeight: 1.55 }}>
                      Mark invoice <span className="mono" style={{ color: T.ink, fontWeight: 600 }}>#{inv.num}</span> as sent to QuickBooks? This records the handoff for this invoice only.
                    </div>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button onClick={() => setConfirmMarkPaid(false)} disabled={markingPaid} className="btn-soft">Cancel</button>
                      <button
                        onClick={async () => {
                          setMarkingPaid(true);
                          try {
                            await doMarkPaid(inv.id);
                            setConfirmMarkPaid(false);
                          } finally {
                            setMarkingPaid(false);
                          }
                        }}
                        disabled={markingPaid || loadingStates["markPaid_" + inv.id]}
                        className="btn-primary"
                        style={{ padding: "10px 18px", opacity: markingPaid || loadingStates["markPaid_" + inv.id] ? 0.7 : 1, cursor: markingPaid || loadingStates["markPaid_" + inv.id] ? "default" : "pointer", display: "flex", alignItems: "center", gap: 6 }}
                      >{markingPaid || loadingStates["markPaid_" + inv.id] ? <><BtnSpinner />Sending...</> : "Sent to QuickBooks"}</button>
                    </div>
                  </Modal>
                )}
                {rejecting && (
                  <Modal onClose={() => { setRejecting(false); setRejectReason(""); }} title={`Reject invoice #${inv.num}`} width={460}>
                    <div style={{ fontSize: 13, color: T.muted, marginBottom: 12, lineHeight: 1.55 }}>
                      The contractor sees this reason on their invoice. The WO does not advance until the remaining live invoices are approved.
                    </div>
                    <label style={{ fontSize: 11, fontWeight: 700, color: T.subtle, textTransform: "uppercase", letterSpacing: 0.6, display: "block", marginBottom: 6 }}>Rejection reason</label>
                    <textarea rows={3} value={rejectReason} onChange={(e: any) => setRejectReason(e.target.value)} placeholder="e.g. Missing parts receipt, labor hours unclear…" style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface, color: T.ink, resize: "vertical", boxSizing: "border-box", outline: "none" }} />
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                      <button onClick={() => { setRejecting(false); setRejectReason(""); }} className="btn-soft">Cancel</button>
                      <button
                        onClick={async () => {
                          setSubmittingReject(true);
                          const ok = await doRejectInvoice(inv, rejectReason);
                          setSubmittingReject(false);
                          if (ok) { setRejecting(false); setRejectReason(""); setSelectedInvoice(null); }
                        }}
                        disabled={!rejectReason.trim() || submittingReject}
                        style={{ padding: "10px 18px", borderRadius: 10, background: T.danger, color: "#fff", border: "none", cursor: rejectReason.trim() && !submittingReject ? "pointer" : "default", fontWeight: 600, fontSize: 12, fontFamily: "inherit", opacity: rejectReason.trim() && !submittingReject ? 1 : 0.5, display: "flex", alignItems: "center", gap: 6 }}
                      >{submittingReject ? <><BtnSpinner />Rejecting…</> : "Reject"}</button>
                    </div>
                  </Modal>
                )}
                {correctingTotal && (
                  <Modal
                    onClose={() => {
                      if (submittingCorrection) return;
                      setCorrectingTotal(false);
                      setCorrectionReason("");
                    }}
                    title={`Correct invoice #${inv.num} total`}
                    width={460}
                  >
                    <div style={{ fontSize: 13, color: T.muted, marginBottom: 14, lineHeight: 1.55 }}>
                      This updates the contractor-entered total only. The uploaded PDF and saved line items remain unchanged.
                    </div>
                    <label style={{ display: "block", marginBottom: 12 }}>
                      <span style={{ display: "block", marginBottom: 6, fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: T.subtle }}>Corrected total</span>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={correctedTotal}
                        onChange={(event) => setCorrectedTotal(event.target.value)}
                        inputMode="decimal"
                        autoFocus
                        style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontFamily: "inherit", fontSize: 14 }}
                      />
                    </label>
                    <label style={{ display: "block" }}>
                      <span style={{ display: "block", marginBottom: 6, fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: T.subtle }}>Reason (optional)</span>
                      <textarea
                        rows={2}
                        value={correctionReason}
                        onChange={(event) => setCorrectionReason(event.target.value)}
                        placeholder="Entered decimal did not match the uploaded PDF"
                        style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontFamily: "inherit", fontSize: 13, resize: "vertical" }}
                      />
                    </label>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
                      <button type="button" className="btn-soft" disabled={submittingCorrection} onClick={() => setCorrectingTotal(false)}>Cancel</button>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={submittingCorrection || !(Number(correctedTotal) > 0)}
                        onClick={async () => {
                          setSubmittingCorrection(true);
                          try {
                            const ok = await doCorrectInvoiceTotal(
                              inv,
                              Number(correctedTotal),
                              correctionReason,
                            );
                            if (ok) {
                              setCorrectingTotal(false);
                              setCorrectionReason("");
                            }
                          } finally {
                            setSubmittingCorrection(false);
                          }
                        }}
                        style={{ display: "flex", alignItems: "center", gap: 6 }}
                      >
                        {submittingCorrection ? <><BtnSpinner />Saving...</> : "Save correction"}
                      </button>
                    </div>
                  </Modal>
                )}
                {confirmDelete && (
                  <Modal onClose={() => setConfirmDelete(false)} title="Delete invoice" width={420}>
                    <div style={{ fontSize: 13, color: T.muted, marginBottom: 20, lineHeight: 1.55 }}>
                      Delete this invoice? This cannot be undone from the portal.
                    </div>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button onClick={() => setConfirmDelete(false)} className="btn-soft">Cancel</button>
                      <button
                        onClick={async () => {
                          setDeleting(true);
                          const ok = await doDeleteInvoice(inv);
                          setDeleting(false);
                          setConfirmDelete(false);
                          if (ok) setSelectedInvoice(null);
                        }}
                        disabled={deleting}
                        style={{ padding: "10px 18px", borderRadius: 10, background: T.danger, color: "#fff", border: "none", cursor: deleting ? "default" : "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit", opacity: deleting ? 0.7 : 1, display: "flex", alignItems: "center", gap: 6 }}
                      >{deleting ? <><BtnSpinner />Deleting...</> : "Delete"}</button>
                    </div>
                  </Modal>
                )}
                <div className="card invoice-detail-container" style={{ padding: 0, overflow: "hidden", maxWidth: 860 }}>
                  {/* Invoice header */}
                  <div style={{ padding: "28px 32px", borderBottom: `1px solid ${T.borderSoft}` }}>
                    <div className="invoice-top-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
                      <div className="invoice-top-header-left">
                        <div className="display invoice-title-text" style={{ fontSize: 36, color: T.ink, letterSpacing: -0.8, lineHeight: 1 }}>Invoice</div>
                        <div className="mono" style={{ fontSize: 16, color: T.accent, marginTop: 8, fontWeight: 600 }}>#{inv.num}</div>
                      </div>
                      <div className="invoice-top-header-right" style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 2 }}>From</div>
                        <div className="display invoice-company-name" style={{ fontSize: 18, color: T.ink, lineHeight: 1 }}>{contractorName}</div>
                        {contractorProfile?.company && contractorProfile?.name && <div className="invoice-company-legal" style={{ fontSize: 10, color: T.subtle, marginTop: 2 }}>{contractorProfile.name}</div>}
                        {contractorProfile?.email && <div style={{ fontSize: 10, color: T.muted, marginTop: 4 }}>{contractorProfile.email}</div>}
                        {contractorProfile?.phone && <div style={{ fontSize: 10, color: T.muted }}>{contractorProfile.phone}</div>}
                      </div>
                    </div>
                  </div>

                  {/* Bill-to / Ship-to / Metadata */}
                  <div className="invoice-header-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, borderBottom: `1px solid ${T.borderSoft}` }}>
                    <div style={{ padding: "20px 32px", borderRight: `1px solid ${T.borderSoft}` }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6 }}>Bill to</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: T.ink }}>{P1_BUSINESS.dba}</div>
                      <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6, marginTop: 2 }}>{P1_BUSINESS.addr1}<br />{P1_BUSINESS.addr2}</div>
                    </div>
                    <div style={{ padding: "20px 32px", borderRight: `1px solid ${T.borderSoft}` }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6 }}>Reference</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: T.ink }}>Store #{inv.store}</div>
                      <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6, marginTop: 2 }}>{inv.storeAddr || wo?.addr || "—"}</div>
                    </div>
                    <div style={{ padding: "20px 32px" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6 }}>Invoice details</div>
                      <div className="invoice-meta-grid" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 12px", fontSize: 11 }}>
                        <span style={{ color: T.muted }}>Invoice date</span><span className="mono" style={{ color: T.ink }}>{inv.invoiceDate}</span>
                        <span style={{ color: T.muted }}>Service date</span><span className="mono" style={{ color: T.ink }}>{inv.serviceDate}</span>
                        <span style={{ color: T.muted }}>Terms</span><span style={{ color: T.ink }}>{inv.terms || "Net 30"}</span>
                        <span style={{ color: T.muted }}>Work order</span>
                        <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: T.accent }}>
                          {inv.wot}
                          {inv.wot && <CopyWorkOrderButton value={inv.wot} />}
                        </span>
                        <span style={{ color: T.muted }}>CME</span><span className="mono" style={{ color: T.ink }}>{inv.cme || "—"}</span>
                        <span style={{ color: T.muted }}>Status</span><span><Badge conf={INV_STATE[inv.state]} small /></span>
                      </div>
                    </div>
                  </div>

                  {isManager && linkedStaffInvoices.length > 0 && (
                    <div style={{ padding: "16px 32px", borderBottom: `1px solid ${T.borderSoft}`, background: T.surfaceSoft }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: T.subtle, marginBottom: 8 }}>Used in P1 to 7-Eleven billing</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {linkedStaffInvoices.map((billingInvoice: any) => (
                          <button key={billingInvoice.id} type="button" className="btn-soft" onClick={() => onOpenBillingInvoice?.(billingInvoice)} style={{ padding: "7px 11px", fontSize: 11 }}>
                            <span className="mono" style={{ color: T.accent, fontWeight: 700 }}>#{billingInvoice.num}</span>
                            <span style={{ marginLeft: 8 }}>{fmt(billingInvoice.total || 0)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Line items */}
                  <div>
                    {(inv.lines || []).length === 0 && inv.pdfStoragePath && (
                      <div style={{ padding: "18px 32px", background: T.surfaceSoft, borderBottom: `1px solid ${T.borderSoft}`, fontSize: 12, color: T.muted }}>
                        Line-item details are contained in the uploaded contractor invoice PDF.
                      </div>
                    )}
                    {(inv.lines || []).length > 0 && (<>
                    <div className="desktop-only-table">
                      <div style={{ display: "grid", gridTemplateColumns: "36px 130px 1fr 60px 90px 100px", gap: 0, padding: "12px 32px", background: T.surfaceSoft, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.7, color: T.subtle, borderBottom: `1px solid ${T.borderSoft}` }}>
                        <div>#</div><div>Type</div><div>Description</div><div style={{ textAlign: "right" }}>Qty</div><div style={{ textAlign: "right" }}>Rate</div><div style={{ textAlign: "right" }}>Amount</div>
                      </div>
                      {(inv.lines || []).map((l: any, i: number) => (
                        <div key={i} style={{ display: "grid", gridTemplateColumns: "36px 130px 1fr 60px 90px 100px", gap: 0, padding: "14px 32px", borderBottom: `1px solid ${T.borderSoft}`, alignItems: "start", fontSize: 12 }}>
                          <div className="mono" style={{ color: T.subtle }}>{i + 1}</div>
                          <div style={{ color: T.inkSoft, fontWeight: 500 }}>{l.type}</div>
                          <div style={{ color: T.ink, lineHeight: 1.55, paddingRight: 14 }}>{l.desc}</div>
                          <div className="mono" style={{ textAlign: "right", color: T.muted }}>{l.qty}</div>
                          <div className="mono" style={{ textAlign: "right", color: T.muted }}>{fmt(l.rate)}</div>
                          <div className="mono" style={{ textAlign: "right", fontWeight: 600, color: T.ink }}>{fmt(Math.round(l.amount * 100) / 100)}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mobile-only-cards">
                      {(inv.lines || []).map((line: any, i: number) => (
                        <div
                          key={i}
                          style={{
                            padding: "14px 0",
                            borderBottom: `1px solid ${T.borderSoft}`,
                          }}
                        >
                          <div style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                            marginBottom: 6,
                          }}>
                            <div>
                              <div style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: T.ink,
                                marginBottom: 2,
                              }}>
                                {i + 1}. {line.lineType || line.type}
                              </div>
                              <div style={{
                                fontSize: 12,
                                color: T.muted,
                              }}>
                                {line.description || line.desc}
                              </div>
                            </div>
                            <div style={{
                              fontSize: 14,
                              fontWeight: 700,
                              color: T.ink,
                              textAlign: "right",
                              flexShrink: 0,
                              marginLeft: 12,
                            }}>
                              {fmt(Math.round(((line.qty || 1) * (line.rate || 0)) * 100) / 100)}
                            </div>
                          </div>
                          <div style={{
                            display: "flex",
                            gap: 16,
                            fontSize: 11,
                            color: T.muted,
                          }}>
                            <span>Qty: {line.qty || 1}</span>
                            <span>Rate: {fmt(line.rate || 0)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    </>)}
                  </div>

                  {/* Totals */}
                  <div className="invoice-totals-section" style={{ padding: "22px 32px", display: "flex", justifyContent: "flex-end" }}>
                    <div style={{ width: 300 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 0" }}>
                        <span style={{ color: T.muted }}>Subtotal</span>
                        <span className="mono" style={{ color: T.ink, fontWeight: 500 }}>{fmt(Math.round(inv.subtotal * 100) / 100)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 0", borderBottom: `1px solid ${T.border}` }}>
                        <span style={{ color: T.muted }}>Sales tax</span>
                        <span className="mono" style={{ color: T.ink, fontWeight: 500 }}>{fmt(Math.round(inv.salesTax * 100) / 100)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0 0" }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Total</span>
                        <span className="display" style={{ fontSize: 26, color: T.ink, letterSpacing: -0.5 }}>{fmt(Math.round(inv.total * 100) / 100)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Rejected reason */}
                  {inv.state === "rejected" && inv.reason && (
                    <div style={{ padding: "16px 32px", background: T.dangerSoft, borderTop: `1px solid ${T.danger}22` }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.danger, marginBottom: 4 }}>Rejection reason</div>
                      <div style={{ fontSize: 12, color: "#8B2C20" }}>{inv.reason}</div>
                    </div>
                  )}

                  {/* Footer — ways to pay (placeholder until Jeremy confirms) */}
                  <div style={{ padding: "18px 32px", background: T.surfaceSoft, borderTop: `1px solid ${T.borderSoft}`, fontSize: 11, color: T.subtle, textAlign: "center" }}>
                    Payment terms: {inv.terms || "Net 30"} · Questions? {contractorProfile?.email || contractorName}{contractorProfile?.phone ? ` · ${contractorProfile.phone}` : ""}
                  </div>
                </div>
              </div>
            );
          })()}


    </>
  );
}
