"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { calculateProfit } from "./profitCalculator";

const STORAGE_KEY = "p1-billing-profit-calculator-open";
const inputClass = "mt-1 w-full min-w-0 rounded-lg border border-p1-border bg-p1-surface px-2 py-2 text-base text-p1-ink min-h-11";

export default function BillingProfitCalculator({
  visible,
  fmt,
  host,
}: {
  visible: boolean;
  fmt: (value: number) => string;
  /** Owned by the Billing page or invoice dialog, outside any form. */
  host: HTMLElement | null;
}) {
  const panelId = useId();
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

  const values = useMemo(() => calculateProfit(cost, sell, targetMargin), [cost, sell, targetMargin]);

  if (!visible || !host) return null;

  const calculator = (
    <aside
      aria-label="Profit calculator"
      className="w-full min-w-0"
    >
      <div className={open ? "rounded-xl border border-p1-accent-ring bg-p1-surface p-3 shadow-lg" : ""}>
        <button type="button" onClick={event => {
          // Safari does not focus clicked buttons. Keep focus on the disclosure
          // before hiding an input that may still own the keyboard focus.
          event.currentTarget.focus({ preventScroll: true });
          setOpenPersisted(!open);
        }}
          aria-label={open ? "Collapse profit calculator" : "Profit calculator"}
          aria-expanded={open} aria-controls={panelId}
          className={open ? "flex min-h-11 w-full items-center justify-between gap-3 rounded-lg text-left text-sm font-bold text-p1-ink" : "btn-accent min-h-11 px-3 py-2"}>
          <span>Profit calculator</span>
          {open && <span aria-hidden="true">−</span>}
        </button>
        <div id={panelId} hidden={!open}>
          <p className="mb-3 text-xs text-p1-muted">Staff only · values are not saved or added to the invoice</p>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <label className="min-w-0 text-xs text-p1-muted">
                Cost
                <input value={cost} onChange={event => setCost(event.target.value)} type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00" className={inputClass} />
              </label>
              <label className="min-w-0 text-xs text-p1-muted">
                Sell price
                <input value={sell} onChange={event => setSell(event.target.value)} type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00" className={inputClass} />
              </label>
              <label className="col-span-2 min-w-0 text-xs text-p1-muted">
                Target margin %
                <input value={targetMargin} onChange={event => setTargetMargin(event.target.value)} type="number" min="0" max="99.99" step="0.1" inputMode="decimal" className={inputClass} />
              </label>
            </div>
            <dl aria-live="polite" className="grid content-center gap-2 rounded-lg border border-p1-border-soft bg-p1-surface-soft p-3 text-xs text-p1-muted">
              <div className="flex flex-wrap justify-between gap-2"><dt>Profit</dt><dd className={`mono break-all font-bold ${values.profit >= 0 ? "text-p1-success" : "text-p1-danger"}`}>{fmt(values.profit)}</dd></div>
              <div className="flex flex-wrap justify-between gap-2"><dt>Actual margin</dt><dd className="mono break-all font-bold text-p1-ink">{values.actualMargin == null ? "−" : `${values.actualMargin.toFixed(1)}%`}</dd></div>
              <div className="flex flex-wrap justify-between gap-2 border-t border-p1-border-soft pt-2"><dt>Sell for target</dt><dd className="mono break-all font-bold text-p1-accent">{fmt(values.targetSell)}</dd></div>
            </dl>
          </div>
        </div>
      </div>
    </aside>
  );

  // A native modal makes the background inert regardless of z-index. Move the
  // same calculator into its owned slot; component state survives both moves.
  return createPortal(calculator, host);
}
