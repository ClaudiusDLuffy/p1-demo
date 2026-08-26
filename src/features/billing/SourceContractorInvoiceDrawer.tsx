"use client";

import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { T } from "../../lib/constants";
import { useInvoiceByIdQuery } from "../invoices/queries";

type SourceContractorInvoiceLine = {
  id?: string;
  type?: string | null;
  desc?: string | null;
  description?: string | null;
  qty?: number | null;
  rate?: number | null;
  amount?: number | null;
};

type SourceContractorInvoice = {
  num: string;
  wot?: string | null;
  invoiceDate?: string | null;
  state: string;
  lines?: SourceContractorInvoiceLine[];
  subtotal?: number | null;
  salesTax?: number | null;
  total?: number | null;
};

export default function SourceContractorInvoiceDrawer({
  invoiceId,
  onClose,
  fmt,
}: {
  invoiceId: string | null;
  onClose: () => void;
  fmt: (value: number) => string;
}) {
  const query = useInvoiceByIdQuery(invoiceId, Boolean(invoiceId));
  if (!invoiceId) return null;

  const invoice = query.data as unknown as SourceContractorInvoice | null | undefined;

  return (
    <div
      role="presentation"
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(31,30,28,0.28)",
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Source contractor invoice"
        style={{
          width: "min(620px, 96vw)",
          height: "100%",
          overflowY: "auto",
          background: T.surface,
          borderLeft: `1px solid ${T.border}`,
          boxShadow: "-14px 0 40px rgba(31,30,28,0.18)",
          padding: 22,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 18 }}>
          <div>
            <div className="display" style={{ fontSize: 22, color: T.ink }}>Source contractor invoice</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>
              Read-only reference. Your 7-Eleven invoice remains open underneath.
            </div>
          </div>
          <button type="button" className="btn-soft" onClick={onClose} aria-label="Close source invoice">
            Close
          </button>
        </div>

        {query.isPending && (
          <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, padding: 20, color: T.muted }}>
            <BtnSpinner /> Loading source invoice…
          </div>
        )}

        {query.isError && (
          <div role="alert" style={{ padding: 12, borderRadius: 9, color: T.danger, background: T.dangerSoft }}>
            This source invoice could not be loaded. Your access is checked again by the database.
          </div>
        )}

        {!query.isPending && !query.isError && !invoice && (
          <div role="alert" style={{ padding: 12, borderRadius: 9, color: T.danger, background: T.dangerSoft }}>
            The source invoice is no longer available.
          </div>
        )}

        {invoice && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, padding: 14, borderRadius: 10, background: T.surfaceSoft, marginBottom: 16 }}>
              <div><div style={{ fontSize: 9, color: T.subtle, textTransform: "uppercase", fontWeight: 800 }}>Invoice</div><div className="mono" style={{ marginTop: 3, fontWeight: 800, color: T.accent }}>#{invoice.num}</div></div>
              <div><div style={{ fontSize: 9, color: T.subtle, textTransform: "uppercase", fontWeight: 800 }}>Work order</div><div className="mono" style={{ marginTop: 3, fontWeight: 700 }}>{invoice.wot || "—"}</div></div>
              <div><div style={{ fontSize: 9, color: T.subtle, textTransform: "uppercase", fontWeight: 800 }}>Invoice date</div><div style={{ marginTop: 3 }}>{invoice.invoiceDate || "—"}</div></div>
              <div><div style={{ fontSize: 9, color: T.subtle, textTransform: "uppercase", fontWeight: 800 }}>Status</div><div style={{ marginTop: 3, textTransform: "capitalize" }}>{invoice.state}</div></div>
            </div>

            <div style={{ border: `1px solid ${T.borderSoft}`, borderRadius: 10, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "100px minmax(0, 1fr) 60px 90px 100px", gap: 8, padding: "9px 10px", background: T.surfaceSoft, fontSize: 9, color: T.subtle, fontWeight: 800, textTransform: "uppercase" }}>
                <span>Type</span><span>Description</span><span>Qty</span><span>Rate</span><span>Amount</span>
              </div>
              {(invoice.lines || []).map((line: SourceContractorInvoiceLine, index: number) => (
                <div key={line.id || index} style={{ display: "grid", gridTemplateColumns: "100px minmax(0, 1fr) 60px 90px 100px", gap: 8, padding: "10px", borderTop: `1px solid ${T.borderSoft}`, fontSize: 11, alignItems: "start" }}>
                  <span style={{ color: T.muted }}>{line.type || "Other"}</span>
                  <span style={{ color: T.ink, whiteSpace: "pre-wrap" }}>{line.desc || line.description || "—"}</span>
                  <span className="mono">{Number(line.qty || 0)}</span>
                  <span className="mono">{fmt(Number(line.rate || 0))}</span>
                  <span className="mono" style={{ fontWeight: 700 }}>{fmt(Number(line.amount ?? Number(line.qty || 0) * Number(line.rate || 0)))}</span>
                </div>
              ))}
              {(invoice.lines || []).length === 0 && (
                <div style={{ padding: 18, color: T.subtle, fontSize: 12 }}>No structured line items were saved on this invoice.</div>
              )}
            </div>

            <div style={{ display: "grid", justifyContent: "end", gap: 6, marginTop: 16, fontSize: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 50 }}><span style={{ color: T.muted }}>Subtotal</span><span className="mono">{fmt(Number(invoice.subtotal || 0))}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 50 }}><span style={{ color: T.muted }}>Sales tax</span><span className="mono">{fmt(Number(invoice.salesTax || 0))}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 50, paddingTop: 7, borderTop: `1px solid ${T.border}`, fontWeight: 800 }}><span>Total</span><span className="mono">{fmt(Number(invoice.total || 0))}</span></div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
