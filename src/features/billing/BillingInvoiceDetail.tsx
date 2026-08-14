"use client";
// @ts-nocheck

import { useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { Ico } from "../../components/ui/Ico";
import { Modal } from "../../components/ui/Modal";
import { T, STAFF_INV_STATE, P1_BUSINESS, SEVEN_STAFF_BILL_TO } from "../../lib/constants";
import { normalizeStaffBillingLineType } from "../../lib/staffBilling";
import { isInvoiceController } from "../../lib/staffPermissions";
import InvoiceLineTypeSubtotals from "./InvoiceLineTypeSubtotals";

export default function BillingInvoiceDetail(props: any) {
  const {
    invoice,
    workOrder,
    onBack,
    backLabel = "Back to billing",
    onEdit,
    onDownloadPdf,
    onDownloadCsv,
    onMarkBilled,
    onDelete,
    onOpenContractorInvoice,
    currentUser,
    fmt,
  } = props;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmBilled, setConfirmBilled] = useState(false);
  const [billing, setBilling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!invoice) return null;

  const lines = invoice.lines || [];
  const sourceInvoices = invoice.sourceInvoices || [];
  const controller = isInvoiceController(currentUser);
  const canDelete = !controller
    && ["manager", "dispatcher", "back_office"].includes(currentUser?.role || "");
  const canEdit = canDelete
    && ["draft", "submitted"].includes(invoice.state)
    && !invoice.qboInvoiceId
    && !invoice.qboSyncedAt;
  const canMarkBilled = canDelete && invoice.state === "submitted";
  const capitalHandoff = Boolean(
    workOrder?.isCapital
    && (
      ["capital", "pending_capital_completion"].includes(workOrder?.status)
      || workOrder?.capitalStatus === "Pending approval"
    ),
  );

  return (
    <div style={{ animation: "fadeUp 0.25s" }}>
      <div className="invoice-action-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, maxWidth: 860 }}>
        <button onClick={onBack} className="invoice-back-button" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: T.muted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0 }}><Ico d="M15 18l-6-6 6-6" size={14} /> {backLabel}</button>
        <div className="invoice-action-buttons" style={{ display: "flex", gap: 8 }}>
          <button onClick={onDownloadPdf} className="btn-soft" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Ico d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" size={13} color="currentColor" />
            Download PDF
          </button>
          {canMarkBilled && (
            <button onClick={() => setConfirmBilled(true)} className="btn-accent">
              {capitalHandoff ? "Send capital quote to 7-Eleven" : "Billed to 7-Eleven"}
            </button>
          )}
          {canEdit && (
            <button onClick={onEdit} className="btn-primary" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Ico d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" size={13} color="currentColor" />
              Edit invoice
            </button>
          )}
          <button onClick={onDownloadCsv} className="btn-soft" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Ico d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8M8 17h8" size={13} color="currentColor" />
            Download CSV
          </button>
          {canDelete && <button onClick={() => setConfirmDelete(true)} className="btn-soft" style={{ color: T.danger, borderColor: `${T.danger}44` }}>Delete</button>}
        </div>
      </div>

      {confirmDelete && (
        <Modal onClose={() => { if (!deleting) setConfirmDelete(false); }} title="Delete billing invoice" width={420}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 20, lineHeight: 1.55 }}>
            Delete invoice <span className="mono" style={{ color: T.ink, fontWeight: 700 }}>#{invoice.num}</span>? This soft-deletes the billing invoice.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmDelete(false)} disabled={deleting} className="btn-soft">Cancel</button>
            <button
              onClick={async () => {
                setDeleting(true);
                try {
                  await onDelete();
                } finally {
                  setDeleting(false);
                }
              }}
              disabled={deleting}
              style={{ padding: "10px 18px", borderRadius: 10, background: T.danger, color: "#fff", border: "none", cursor: deleting ? "default" : "pointer", fontWeight: 600, fontSize: 12, fontFamily: "inherit", opacity: deleting ? 0.7 : 1, display: "flex", alignItems: "center", gap: 6 }}
            >{deleting ? <><BtnSpinner />Deleting...</> : "Delete"}</button>
          </div>
        </Modal>
      )}

      {confirmBilled && (
        <Modal onClose={() => { if (!billing) setConfirmBilled(false); }} title="Confirm 7-Eleven billing" width={440}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 20, lineHeight: 1.55 }}>
            {capitalHandoff ? (
              <>Mark invoice <span className="mono" style={{ color: T.ink, fontWeight: 700 }}>#{invoice.num}</span> as sent to 7-Eleven? The work order will remain open in Pending Capital Completion until 7-Eleven authorizes the work.</>
            ) : (
              <>Mark invoice <span className="mono" style={{ color: T.ink, fontWeight: 700 }}>#{invoice.num}</span> as sent to 7-Eleven and close its linked work order? Linked contractor invoices will remain Approved.</>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmBilled(false)} disabled={billing} className="btn-soft">Cancel</button>
            <button
              onClick={async () => {
                setBilling(true);
                try {
                  await onMarkBilled?.();
                  setConfirmBilled(false);
                } finally {
                  setBilling(false);
                }
              }}
              disabled={billing}
              className="btn-accent"
              style={{ display: "flex", alignItems: "center", gap: 6, opacity: billing ? 0.7 : 1 }}
            >
              {billing
                ? <><BtnSpinner />Updating...</>
                : capitalHandoff ? "Send and await approval" : "Billed to 7-Eleven"}
            </button>
          </div>
        </Modal>
      )}

      <div className="card invoice-detail-container" style={{ padding: 0, overflow: "hidden", maxWidth: 860 }}>
        <div style={{ padding: "28px 32px", borderBottom: `1px solid ${T.borderSoft}` }}>
          <div className="invoice-top-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
            <div className="invoice-top-header-left">
              <div className="display invoice-title-text" style={{ fontSize: 36, color: T.ink, letterSpacing: -0.8, lineHeight: 1 }}>Invoice</div>
              <div className="mono" style={{ fontSize: 16, color: T.accent, marginTop: 8, fontWeight: 600 }}>#{invoice.num}</div>
            </div>
            <div className="invoice-top-header-right" style={{ textAlign: "right" }}>
              <div className="display invoice-company-name" style={{ fontSize: 18, color: T.ink, lineHeight: 1 }}>{P1_BUSINESS.dba}</div>
              <div className="invoice-company-details" style={{ fontSize: 11, color: T.muted, marginTop: 6, lineHeight: 1.55 }}>
                {P1_BUSINESS.addr1}<br />{P1_BUSINESS.addr2}<br />{P1_BUSINESS.email}<br />{P1_BUSINESS.phone}<br />{P1_BUSINESS.website}
              </div>
            </div>
          </div>
        </div>

        <div className="invoice-header-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, borderBottom: `1px solid ${T.borderSoft}` }}>
          <div style={{ padding: "20px 32px", borderRight: `1px solid ${T.borderSoft}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6 }}>Bill to</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.ink }}>{SEVEN_STAFF_BILL_TO.name}</div>
            <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6, marginTop: 2 }}>{SEVEN_STAFF_BILL_TO.addr1}<br />{SEVEN_STAFF_BILL_TO.addr2}</div>
          </div>
          <div style={{ padding: "20px 32px", borderRight: `1px solid ${T.borderSoft}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6 }}>Ship to</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.ink }}>7-ELEVEN STORE - {invoice.store || "-"}</div>
            <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6, marginTop: 2 }}>{invoice.storeAddr || "-"}</div>
          </div>
          <div style={{ padding: "20px 32px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6 }}>Invoice details</div>
            <div className="invoice-meta-grid" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 12px", fontSize: 11 }}>
              <span style={{ color: T.muted }}>Invoice date</span><span className="mono" style={{ color: T.ink }}>{invoice.invoiceDate}</span>
              <span style={{ color: T.muted }}>Service date</span><span className="mono" style={{ color: T.ink }}>{invoice.serviceDate || "-"}</span>
              <span style={{ color: T.muted }}>Due date</span><span className="mono" style={{ color: T.ink }}>{invoice.dueDate || "-"}</span>
              <span style={{ color: T.muted }}>Terms</span><span style={{ color: T.ink }}>{invoice.terms || "Net 30"}</span>
              <span style={{ color: T.muted }}>Work order</span>
              <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: invoice.wot ? T.accent : T.subtle }}>
                {invoice.wot || "Standalone"}
                {invoice.wot && <CopyWorkOrderButton value={invoice.wot} />}
              </span>
              <span style={{ color: T.muted }}>Territory</span><span style={{ color: invoice.territory ? T.ink : T.subtle }}>{invoice.territory || "-"}</span>
              <span style={{ color: T.muted }}>Status</span><span><Badge conf={STAFF_INV_STATE[invoice.state]} small /></span>
              <span style={{ color: T.muted }}>Tax jurisdiction</span>
              <span className="mono" style={{ color: invoice.taxState ? T.ink : T.subtle }}>
                {invoice.taxState || "-"}{invoice.taxRate != null ? ` (${(Number(invoice.taxRate) * 100).toFixed(3)}%)` : ""}
              </span>
            </div>
          </div>
        </div>

        {sourceInvoices.length > 0 && (
          <div style={{ padding: "18px 32px", borderBottom: `1px solid ${T.borderSoft}`, background: T.surfaceSoft }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: T.subtle }}>Built from contractor invoices</div>
                <div style={{ fontSize: 11, color: T.muted, marginTop: 3 }}>These source records remain linked in both directions.</div>
              </div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11 }}>
                <span style={{ color: T.muted }}>Cost <strong className="mono" style={{ color: T.ink }}>{fmt(invoice.contractorCost || 0)}</strong></span>
                <span style={{ color: T.muted }}>Profit <strong className="mono" style={{ color: (invoice.grossProfit || 0) >= 0 ? T.success : T.danger }}>{fmt(invoice.grossProfit || 0)}</strong></span>
                <span style={{ color: T.muted }}>Margin <strong className="mono" style={{ color: invoice.marginPercent == null ? T.subtle : invoice.marginPercent >= 30 ? T.success : T.danger }}>{invoice.marginPercent == null ? "-" : `${Number(invoice.marginPercent).toFixed(1)}%`}</strong></span>
              </div>
            </div>
            <div style={{ display: "grid", gap: 7 }}>
              {sourceInvoices.map((source: any) => (
                <button
                  key={source.id}
                  type="button"
                  onClick={() => onOpenContractorInvoice?.(source)}
                  className="btn-soft"
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, width: "100%", textAlign: "left", padding: "9px 12px" }}
                >
                  <span><span className="mono" style={{ color: T.accent, fontWeight: 700 }}>#{source.num}</span><span style={{ color: T.muted, marginLeft: 8, textTransform: "capitalize" }}>{source.state}</span></span>
                  <span className="mono" style={{ color: T.ink, fontWeight: 700 }}>{fmt(source.total || 0)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="desktop-only-table">
            <div style={{ display: "grid", gridTemplateColumns: "36px 130px 1fr 60px 90px 100px", padding: "12px 32px", background: T.surfaceSoft, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.7, color: T.subtle, borderBottom: `1px solid ${T.borderSoft}` }}>
              <div>#</div><div>Type</div><div>Description</div><div style={{ textAlign: "right" }}>Qty</div><div style={{ textAlign: "right" }}>Rate</div><div style={{ textAlign: "right" }}>Amount</div>
            </div>
            {lines.map((line: any, i: number) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "36px 130px 1fr 60px 90px 100px", padding: "14px 32px", borderBottom: `1px solid ${T.borderSoft}`, alignItems: "start", fontSize: 12 }}>
                <div className="mono" style={{ color: T.subtle }}>{i + 1}</div>
                <div style={{ color: T.inkSoft, fontWeight: 500 }}>{normalizeStaffBillingLineType(line.type)}</div>
                <div style={{ color: T.ink, lineHeight: 1.55, paddingRight: 14 }}>
                  {line.desc}
                  {line.isTaxable && <span style={{ display: "inline-block", marginLeft: 7, fontSize: 9, color: T.accent, fontWeight: 700 }}>TAXABLE</span>}
                </div>
                <div className="mono" style={{ textAlign: "right", color: T.muted }}>{line.qty}</div>
                <div className="mono" style={{ textAlign: "right", color: T.muted }}>{fmt(line.rate)}</div>
                <div className="mono" style={{ textAlign: "right", fontWeight: 600, color: T.ink }}>{fmt(Math.round(line.amount * 100) / 100)}</div>
              </div>
            ))}
          </div>
          <div className="mobile-only-cards">
            {lines.map((line: any, i: number) => (
              <div key={i} style={{ padding: "14px 0", borderBottom: `1px solid ${T.borderSoft}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.ink }}>{i + 1}. {normalizeStaffBillingLineType(line.type)}</div>
                    <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>{line.desc}</div>
                  </div>
                  <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{fmt(Math.round(line.amount * 100) / 100)}</div>
                </div>
                <div style={{ display: "flex", gap: 16, fontSize: 11, color: T.muted, marginTop: 6 }}>
                  <span>Qty: {line.qty}</span>
                  <span>Rate: {fmt(line.rate)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="invoice-totals-section" style={{ padding: "22px 32px", display: "flex", justifyContent: "flex-end" }}>
          <InvoiceLineTypeSubtotals
            lines={lines}
            salesTax={Number(invoice.salesTax || 0)}
            fmt={fmt}
          />
        </div>

        <div style={{ padding: "18px 32px", background: T.surfaceSoft, borderTop: `1px solid ${T.borderSoft}`, fontSize: 11, color: T.subtle, textAlign: "center" }}>
          Ways to pay - ACH / check. Questions? {P1_BUSINESS.email}
        </div>
      </div>
    </div>
  );
}
