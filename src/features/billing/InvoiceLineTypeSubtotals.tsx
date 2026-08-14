"use client";

import { useMemo } from "react";

import { T } from "../../lib/constants";
import { summarizeInvoiceLineTypes } from "../../lib/invoiceLineSubtotals";

export default function InvoiceLineTypeSubtotals({
  lines,
  salesTax,
  fmt,
  compact = false,
}: {
  lines: Array<Record<string, unknown>>;
  salesTax: number;
  fmt: (value: number) => string;
  compact?: boolean;
}) {
  const summary = useMemo(
    () => summarizeInvoiceLineTypes(lines, salesTax),
    [lines, salesTax],
  );

  return (
    <section
      aria-label="Invoice totals by line type"
      style={{
        width: compact ? "100%" : 320,
        maxWidth: "100%",
        border: `1px solid ${T.borderSoft}`,
        borderRadius: 12,
        background: T.surfaceSoft,
        padding: compact ? "12px 14px" : "14px 16px",
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase", color: T.subtle, marginBottom: 7 }}>
        P1 sell totals by type
      </div>
      {summary.categories.map(category => (
        <div key={category.category} style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "4px 0", fontSize: 12 }}>
          <span style={{ color: T.muted }}>
            {category.label}
            <span style={{ marginLeft: 5, color: T.subtle, fontSize: 9 }}>({category.lineCount})</span>
          </span>
          <span className="mono" style={{ color: T.ink, fontWeight: 650 }}>{fmt(category.amount)}</span>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "7px 0 4px", marginTop: 4, borderTop: `1px solid ${T.borderSoft}`, fontSize: 12 }}>
        <span style={{ color: T.muted }}>Pre-tax subtotal</span>
        <span className="mono" style={{ color: T.ink, fontWeight: 650 }}>{fmt(summary.subtotal)}</span>
      </div>
      {summary.salesTax > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "4px 0", fontSize: 12 }}>
          <span style={{ color: T.muted }}>Tax</span>
          <span className="mono" style={{ color: T.ink, fontWeight: 650 }}>{fmt(summary.salesTax)}</span>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, paddingTop: 8, marginTop: 4, borderTop: `1px solid ${T.border}`, fontSize: 13 }}>
        <strong style={{ color: T.ink }}>Grand total</strong>
        <strong className="mono" style={{ color: T.ink }}>{fmt(summary.grandTotal)}</strong>
      </div>
    </section>
  );
}
