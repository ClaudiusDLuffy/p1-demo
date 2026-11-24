"use client";

import { useId, useState } from "react";
import { T } from "../../lib/constants";
import { BillingPartPriceCorrectionSchema, correctedPartPrice, type BillingPartPriceCorrection } from "../../lib/billingPartPriceCorrection";

export default function BillingPartPriceEditor({ recordedCost, value, onChange, onEditingChange }: {
  recordedCost: number | null; value?: BillingPartPriceCorrection | null;
  onChange(value: BillingPartPriceCorrection | null): void;
  onEditingChange(open: boolean): void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [basis, setBasis] = useState<BillingPartPriceCorrection["basis"]>("purchase_cost");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const parsed = BillingPartPriceCorrectionSchema.safeParse({ basis, amount: Number(amount), reason });
  const preview = Number(amount) > 0 && Number.isFinite(Number(amount))
    ? correctedPartPrice({ basis, amount: Number(amount), reason }).rate : null;
  const show = () => {
    setBasis(value?.basis ?? "purchase_cost"); setAmount(String(value?.amount ?? recordedCost ?? ""));
    setReason(value?.reason ?? ""); setError(""); setOpen(true); onEditingChange(true);
  };
  return <div style={{ gridColumn: "1 / -1", fontSize: 12, padding: "6px 0" }}>
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ color: T.muted }}>Recorded source unit cost: {recordedCost == null ? "not available" : `$${recordedCost.toFixed(2)}`}</span>
      <button type="button" className="btn-soft" onClick={show}>Edit part price</button>
      {value && <span role="status">Price corrected · {value.basis === "purchase_cost" ? "cost + 25%" : "final unit price"}</span>}
    </div>
    {value && !open && <div style={{ marginTop: 5, color: T.muted, overflowWrap: "anywhere" }}>Correction reason: {value.reason}</div>}
    {open && <fieldset style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: 12, marginTop: 8 }}>
      <legend>Part price correction</legend>
      <p style={{ margin: "0 0 10px", color: T.muted }}>Use verified contractor notes or a receipt. This changes only this invoice, not the purchasing record or the contractor’s invoice.</p>
      <label htmlFor={`${id}-basis`}>Amount represents</label>
      <select id={`${id}-basis`} value={basis} onChange={event => { setBasis(event.target.value as BillingPartPriceCorrection["basis"]); setError(""); }}
        style={{ display: "block", width: "100%", padding: 8, margin: "4px 0 10px" }}>
        <option value="purchase_cost">Purchase unit cost before 25% markup</option>
        <option value="billing_rate">Final unit billing price — do not add markup</option>
      </select>
      <label htmlFor={`${id}-amount`}>{basis === "purchase_cost" ? "Corrected purchase unit cost" : "Final unit billing price"}</label>
      <input id={`${id}-amount`} type="number" min="0.01" max="99999999.99" step="0.01" inputMode="decimal" value={amount}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={event => { setAmount(event.target.value); setError(""); }} style={{ display: "block", width: "100%", padding: 8, margin: "4px 0 10px" }} />
      <label htmlFor={`${id}-reason`}>Reason / contractor note reference</label>
      <input id={`${id}-reason`} value={reason} maxLength={1000} aria-describedby={error ? `${id}-error` : undefined}
        onChange={event => { setReason(event.target.value); setError(""); }}
        placeholder="e.g. Verified receipt referenced in contractor note dated…" style={{ display: "block", width: "100%", padding: 8, margin: "4px 0 10px" }} />
      {preview !== null && <p aria-live="polite">Final unit billing price: ${preview.toFixed(2)}{basis === "purchase_cost" ? " (includes 25% markup)" : " (no additional markup)"}. Quantity and sales tax are calculated separately.</p>}
      {error && <p id={`${id}-error`} role="alert" style={{ color: T.danger }}>{error}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="button" className="btn-accent" onClick={() => {
          if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? "Check the correction");
            document.getElementById(`${id}-${parsed.error.issues[0]?.path[0] === "amount" ? "amount" : "reason"}`)?.focus();
            return;
          }
          onChange(parsed.data); setOpen(false); onEditingChange(false);
        }}>Apply price correction</button>
        {value && recordedCost != null && recordedCost > 0 && <button type="button" className="btn-soft" onClick={() => {
          onChange(null); setOpen(false); onEditingChange(false);
        }}>Restore recorded cost + 25%</button>}
        <button type="button" className="btn-soft" onClick={() => { setOpen(false); onEditingChange(false); }}>Cancel price edit</button>
      </div>
      <p style={{ color: T.muted, marginBottom: 0 }}>Apply or cancel this edit before saving or closing the invoice. The correction and its reason are recorded when you save the invoice.</p>
    </fieldset>}
  </div>;
}
