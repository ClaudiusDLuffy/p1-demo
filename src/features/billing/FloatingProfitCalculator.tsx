"use client";

import { useEffect, useMemo, useState } from "react";

import { T } from "../../lib/constants";

const STORAGE_KEY = "p1-billing-profit-calculator-open";
const number = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};
const money = (value: number) => Math.round(value * 100) / 100;

export default function FloatingProfitCalculator({
  visible,
  fmt,
}: {
  visible: boolean;
  fmt: (value: number) => string;
}) {
  const [open, setOpen] = useState(false);
  const [cost, setCost] = useState("");
  const [sell, setSell] = useState("");
  const [targetMargin, setTargetMargin] = useState("30");

  useEffect(() => {
    let storedOpen = false;
    try {
      storedOpen = window.localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      storedOpen = false;
    }
    const frame = window.requestAnimationFrame(() => setOpen(storedOpen));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const setOpenPersisted = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // The calculator still works when browser storage is unavailable.
    }
  };

  const values = useMemo(() => {
    const costValue = number(cost);
    const sellValue = number(sell);
    const requestedMargin = Math.min(number(targetMargin), 99.99);
    const profit = money(sellValue - costValue);
    const actualMargin = sellValue > 0 ? (profit / sellValue) * 100 : null;
    const targetSell = requestedMargin < 100
      ? money(costValue / (1 - requestedMargin / 100))
      : null;
    return { profit, actualMargin, targetSell };
  }, [cost, sell, targetMargin]);

  if (!visible) return null;

  return (
    <aside
      aria-label="Profit calculator"
      style={{ position: "fixed", right: 18, bottom: 18, zIndex: 60, width: open ? 310 : "auto", maxWidth: "calc(100vw - 28px)" }}
    >
      {open ? (
        <div className="card" style={{ padding: 16, boxShadow: "0 16px 46px rgba(31,30,28,0.22)", border: `1px solid ${T.accentRing}`, background: T.surface }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
            <div>
              <div style={{ color: T.ink, fontSize: 13, fontWeight: 800 }}>Profit calculator</div>
              <div style={{ color: T.subtle, fontSize: 9, marginTop: 2 }}>Staff only · values are not saved</div>
            </div>
            <button type="button" className="btn-soft" onClick={() => setOpenPersisted(false)} aria-label="Collapse profit calculator" style={{ width: 32, height: 32, padding: 0 }}>−</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <label style={{ color: T.muted, fontSize: 10 }}>
              Cost
              <input value={cost} onChange={event => setCost(event.target.value)} type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00" style={{ width: "100%", marginTop: 5, padding: "8px 9px", borderRadius: 8, border: `1px solid ${T.border}`, color: T.ink, background: T.surface }} />
            </label>
            <label style={{ color: T.muted, fontSize: 10 }}>
              Sell price
              <input value={sell} onChange={event => setSell(event.target.value)} type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00" style={{ width: "100%", marginTop: 5, padding: "8px 9px", borderRadius: 8, border: `1px solid ${T.border}`, color: T.ink, background: T.surface }} />
            </label>
            <label style={{ color: T.muted, fontSize: 10, gridColumn: "1 / -1" }}>
              Target margin %
              <input value={targetMargin} onChange={event => setTargetMargin(event.target.value)} type="number" min="0" max="99.99" step="0.1" inputMode="decimal" style={{ width: "100%", marginTop: 5, padding: "8px 9px", borderRadius: 8, border: `1px solid ${T.border}`, color: T.ink, background: T.surface }} />
            </label>
          </div>
          <div style={{ marginTop: 12, padding: "10px 11px", borderRadius: 9, background: T.surfaceSoft, border: `1px solid ${T.borderSoft}`, display: "grid", gap: 6, fontSize: 11 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: T.muted }}>Profit</span><strong className="mono" style={{ color: values.profit >= 0 ? T.success : T.danger }}>{fmt(values.profit)}</strong></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: T.muted }}>Actual margin</span><strong className="mono" style={{ color: T.ink }}>{values.actualMargin == null ? "−" : `${values.actualMargin.toFixed(1)}%`}</strong></div>
            <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 6, borderTop: `1px solid ${T.borderSoft}` }}><span style={{ color: T.muted }}>Sell for target</span><strong className="mono" style={{ color: T.accent }}>{values.targetSell == null ? "−" : fmt(values.targetSell)}</strong></div>
          </div>
        </div>
      ) : (
        <button type="button" className="btn-accent" onClick={() => setOpenPersisted(true)} style={{ minHeight: 44, padding: "10px 14px", boxShadow: "0 10px 28px rgba(31,30,28,0.18)" }}>
          Profit calculator
        </button>
      )}
    </aside>
  );
}
