"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { Ico } from "../../components/ui/Ico";
import { Input } from "../../components/ui/Input";
import { Sel } from "../../components/ui/Sel";
import { T } from "../../lib/constants";
import {
  normalizeQuoteLineType,
  priceQuoteLines,
  quoteLineToBillingLine,
  quoteTotals,
  roundMoney,
  type QuoteCalculatorLine,
} from "../../lib/quoteCalculator";
import { STAFF_BILLING_LINE_TYPES } from "../../lib/staffBilling";
import {
  clampBulkQuoteLineCount,
  createQuoteCalculatorDraft,
  parseQuoteCalculatorDraft,
  quoteCalculatorDraftKey,
} from "../../lib/quoteCalculatorDraft";

const ICON = {
  add: "M12 5v14M5 12h14",
  back: "M15 18l-6-6 6-6",
  close: "M18 6 6 18M6 6l12 12",
  drag: "M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01",
  expand: "M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5",
  focus: "M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3M8 9h8v6H8z",
  forward: "m9 18 6-6-6-6",
  refresh: "M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5",
  reset: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
  table: "M3 4h18v16H3zM3 10h18M9 4v16",
  trash: "M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 10v6M14 10v6",
};

const localDate = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const addDays = (iso: string, days: number) => {
  const date = new Date(`${iso}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
};

const lineId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `quote-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const emptyLine = (laborRate = 110): QuoteCalculatorLine => ({
  id: lineId(),
  type: "Labor",
  desc: "",
  qty: 1,
  sourceRate: 0,
  rate: Number.isFinite(laborRate) && laborRate >= 0 ? laborRate : 110,
});

const DEFAULT_PRICING = {
  laborRate: 110,
  partsMarkupPercent: 25,
  overallMarginPercent: 0,
};

type SourceInvoiceLine = {
  id?: string | null;
  type?: string | null;
  desc?: string | null;
  description?: string | null;
  qty?: number | string | null;
  rate?: number | string | null;
};

type ContractorInvoice = {
  id: string;
  wot: string;
  state: string;
  num?: string | number | null;
  total?: number | string | null;
  lines?: SourceInvoiceLine[];
};

type BillingInvoice = {
  id: string;
  sourceInvoiceIds?: string[];
};

type QuoteWorkOrder = {
  id: string;
  store?: string | number | null;
  addr?: string | null;
  storeState?: string | null;
};

type QuoteCalculatorProps = {
  workOrder: QuoteWorkOrder;
  contractorInvoices?: ContractorInvoice[];
  billingInvoices?: BillingInvoice[];
  userId?: string | null;
  fmt: (amount: number) => string;
  fire?: (message: string) => void;
  onConvert?: (payload: Record<string, unknown>) => Promise<unknown>;
};

type ViewMode = "table" | "focus";
type FocusMotion = "next" | "previous";

const sourceLines = (
  invoice: ContractorInvoice | null | undefined,
): QuoteCalculatorLine[] => {
  if (!invoice) return [emptyLine()];
  if (!(invoice.lines || []).length) {
    return [{
      id: lineId(),
      type: "Other",
      desc: "Contracted service",
      qty: 1,
      sourceRate: Number(invoice.total || 0),
      rate: Number(invoice.total || 0),
    }];
  }

  return (invoice.lines || []).map((line) => ({
    id: lineId(),
    type: normalizeQuoteLineType(line.type),
    desc: line.desc || line.description || "Contractor service",
    qty: Number(line.qty || 1),
    sourceRate: Number(line.rate || 0),
    rate: Number(line.rate || 0),
    sourceInvoiceLineId: line.id || null,
  }));
};

const stateCodeForWorkOrder = (workOrder: QuoteWorkOrder) => {
  const direct = String(workOrder.storeState || "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(direct)) return direct;
  const addressMatch = String(workOrder.addr || "")
    .toUpperCase()
    .match(/(?:,|\s)(VA|TX|FL)(?:,|\s|$)/);
  return addressMatch?.[1] || "";
};

const territoryForState = (stateCode: string) => ({
  VA: "Virginia",
  TX: "Texas",
  FL: "Florida",
})[stateCode as "VA" | "TX" | "FL"] || stateCode;

const inputStyle = {
  minHeight: 38,
  padding: "8px 9px",
  borderRadius: 7,
  fontSize: 12,
};

const iconButtonStyle = {
  width: 38,
  height: 38,
  padding: 0,
  borderRadius: 7,
  border: `1px solid ${T.border}`,
  background: T.surface,
  color: T.muted,
  display: "grid",
  placeItems: "center",
  cursor: "pointer",
  flexShrink: 0,
};

export default function QuoteCalculatorWorkspace({
  workOrder,
  contractorInvoices = [],
  billingInvoices = [],
  userId,
  fmt,
  fire,
  onConvert,
}: QuoteCalculatorProps) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [lines, setLines] = useState<QuoteCalculatorLine[]>([emptyLine()]);
  const [laborRate, setLaborRate] = useState("110");
  const [partsMarkupPercent, setPartsMarkupPercent] = useState("25");
  const [overallMarginPercent, setOverallMarginPercent] = useState("0");
  const [hasDraft, setHasDraft] = useState(false);
  const [converting, setConverting] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkCount, setBulkCount] = useState(1);
  const [focusIndex, setFocusIndex] = useState(0);
  const [focusMotion, setFocusMotion] = useState<FocusMotion>("next");
  const [draggingLineId, setDraggingLineId] = useState<string | null>(null);
  const initializedWorkOrder = useRef("");
  const waitingForInitialSource = useRef(false);
  const hydratingDraft = useRef(false);
  const hydrationFrame = useRef<number | null>(null);
  const availableSourcesRef = useRef<ContractorInvoice[]>([]);
  const workspaceBodyRef = useRef<HTMLDivElement | null>(null);

  const linkedSourceIds = useMemo(
    () => new Set(
      billingInvoices.flatMap((invoice) => invoice.sourceInvoiceIds || []),
    ),
    [billingInvoices],
  );
  const availableSources = useMemo(
    () => contractorInvoices.filter((invoice) =>
      invoice.wot === workOrder?.id
      && !["draft", "rejected"].includes(invoice.state)
      && !linkedSourceIds.has(invoice.id),
    ),
    [contractorInvoices, linkedSourceIds, workOrder?.id],
  );
  availableSourcesRef.current = availableSources;

  const selectedSource = useMemo(
    () => availableSources.find((invoice) => invoice.id === selectedSourceId) || null,
    [availableSources, selectedSourceId],
  );
  const pricing = useMemo(
    () => ({
      laborRate: Number(laborRate) || 0,
      partsMarkupPercent: Number(partsMarkupPercent) || 0,
      overallMarginPercent: Number(overallMarginPercent) || 0,
    }),
    [laborRate, overallMarginPercent, partsMarkupPercent],
  );
  const totals = useMemo(
    () => quoteTotals(lines, pricing),
    [lines, pricing],
  );
  const draftStorageKey = useMemo(
    () => quoteCalculatorDraftKey(userId, workOrder.id),
    [userId, workOrder.id],
  );
  const focusedLine = lines[Math.min(focusIndex, lines.length - 1)] || lines[0];

  useEffect(() => {
    initializedWorkOrder.current = workOrder.id;
    waitingForInitialSource.current = false;
    hydratingDraft.current = true;
    setWorkspaceOpen(false);
    setBulkOpen(false);
    setFocusIndex(0);
    setFocusMotion("next");

    const rawDraft = window.localStorage.getItem(draftStorageKey);
    const recovered = parseQuoteCalculatorDraft(rawDraft, workOrder.id);
    if (rawDraft && !recovered) window.localStorage.removeItem(draftStorageKey);

    if (recovered) {
      setSelectedSourceId(recovered.selectedSourceId);
      setLines(recovered.lines);
      setLaborRate(recovered.pricing.laborRate);
      setPartsMarkupPercent(recovered.pricing.partsMarkupPercent);
      setOverallMarginPercent(recovered.pricing.overallMarginPercent);
      setHasDraft(true);
    } else {
      const source = availableSourcesRef.current[0] || null;
      setSelectedSourceId(source?.id || "");
      setLines(priceQuoteLines(sourceLines(source), DEFAULT_PRICING));
      setLaborRate(String(DEFAULT_PRICING.laborRate));
      setPartsMarkupPercent(String(DEFAULT_PRICING.partsMarkupPercent));
      setOverallMarginPercent(String(DEFAULT_PRICING.overallMarginPercent));
      setHasDraft(false);
      waitingForInitialSource.current = !source;
    }

    hydrationFrame.current = window.requestAnimationFrame(() => {
      hydratingDraft.current = false;
    });

    return () => {
      if (hydrationFrame.current != null) {
        window.cancelAnimationFrame(hydrationFrame.current);
      }
    };
  }, [draftStorageKey, workOrder.id]);

  useEffect(() => {
    if (
      initializedWorkOrder.current !== workOrder.id
      || !waitingForInitialSource.current
      || hasDraft
      || availableSources.length === 0
    ) {
      return;
    }

    const source = availableSources[0];
    waitingForInitialSource.current = false;
    setSelectedSourceId(source.id);
    setLines(priceQuoteLines(sourceLines(source), DEFAULT_PRICING));
  }, [availableSources, hasDraft, workOrder.id]);

  useEffect(() => {
    if (
      !hasDraft
      || hydratingDraft.current
      || initializedWorkOrder.current !== workOrder.id
    ) {
      return;
    }

    const draft = createQuoteCalculatorDraft({
      workOrderId: workOrder.id,
      selectedSourceId,
      lines,
      pricing: {
        laborRate,
        partsMarkupPercent,
        overallMarginPercent,
      },
    });
    window.localStorage.setItem(draftStorageKey, JSON.stringify(draft));
  }, [
    draftStorageKey,
    hasDraft,
    laborRate,
    lines,
    overallMarginPercent,
    partsMarkupPercent,
    selectedSourceId,
    workOrder.id,
  ]);

  useEffect(() => {
    setFocusIndex((current) =>
      Math.max(0, Math.min(current, Math.max(lines.length - 1, 0))),
    );
  }, [lines.length]);

  useEffect(() => {
    if (!workspaceOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (bulkOpen) {
        setBulkOpen(false);
      } else {
        setWorkspaceOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [bulkOpen, workspaceOpen]);

  const updateLine = (
    id: string,
    patch: Partial<QuoteCalculatorLine>,
  ) => {
    setLines((current) =>
      current.map((line) => line.id === id ? { ...line, ...patch } : line),
    );
    setHasDraft(true);
  };

  const removeLine = (id: string) => {
    setLines((current) =>
      current.length === 1
        ? current
        : current.filter((line) => line.id !== id),
    );
    setHasDraft(true);
  };

  const moveLine = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setLines((current) => {
      const from = current.findIndex((line) => line.id === sourceId);
      const to = current.findIndex((line) => line.id === targetId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setHasDraft(true);
  };

  const loadSource = (invoice: ContractorInvoice | null | undefined) => {
    if (
      hasDraft
      && invoice?.id !== selectedSourceId
      && !window.confirm("Replace the current calculator lines with this contractor quote?")
    ) {
      return;
    }

    setSelectedSourceId(invoice?.id || "");
    setLines(priceQuoteLines(sourceLines(invoice), pricing));
    setFocusIndex(0);
    setFocusMotion("next");
    setHasDraft(true);
  };

  const resetDraft = () => {
    if (!window.confirm("Discard the saved calculator draft for this work order?")) {
      return;
    }
    const source = availableSources[0] || null;
    window.localStorage.removeItem(draftStorageKey);
    setSelectedSourceId(source?.id || "");
    setLaborRate(String(DEFAULT_PRICING.laborRate));
    setPartsMarkupPercent(String(DEFAULT_PRICING.partsMarkupPercent));
    setOverallMarginPercent(String(DEFAULT_PRICING.overallMarginPercent));
    setLines(priceQuoteLines(sourceLines(source), DEFAULT_PRICING));
    setFocusIndex(0);
    setHasDraft(false);
    fire?.("Calculator draft discarded");
  };

  const applyPricing = () => {
    if (
      pricing.laborRate < 0
      || pricing.partsMarkupPercent < 0
      || pricing.partsMarkupPercent > 999
      || pricing.overallMarginPercent < 0
      || pricing.overallMarginPercent >= 100
    ) {
      fire?.("Check the quote pricing percentages");
      return;
    }
    setLines((current) => priceQuoteLines(current, pricing));
    setHasDraft(true);
  };

  const addBulkLines = () => {
    const count = clampBulkQuoteLineCount(bulkCount);
    const firstNewIndex = lines.length;
    const nextLines = Array.from(
      { length: count },
      () => emptyLine(pricing.laborRate),
    );
    setLines((current) => [...current, ...nextLines]);
    setHasDraft(true);
    setBulkOpen(false);
    setBulkCount(1);
    setFocusMotion("next");
    setFocusIndex(firstNewIndex);

    if (viewMode === "table") {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          workspaceBodyRef.current
            ?.querySelector<HTMLElement>(
              `[data-quote-line-index="${firstNewIndex}"]`,
            )
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      });
    }
  };

  const moveFocus = (nextIndex: number) => {
    const bounded = Math.max(0, Math.min(nextIndex, lines.length - 1));
    if (bounded === focusIndex) return;
    setFocusMotion(bounded > focusIndex ? "next" : "previous");
    setFocusIndex(bounded);
  };

  const openWorkspace = () => {
    setViewMode(
      window.matchMedia("(max-width: 900px)").matches ? "focus" : "table",
    );
    setWorkspaceOpen(true);
  };

  const convert = async () => {
    const validLines = lines
      .map(quoteLineToBillingLine)
      .filter((line) =>
        line.qty > 0
        && line.rate > 0
        && (line.desc || /^(travel|truck charge)$/i.test(line.type)),
      );
    if (!validLines.length || validLines.length !== lines.length) {
      fire?.("Complete each quote line before converting");
      return;
    }

    const storeState = stateCodeForWorkOrder(workOrder);
    const territory = territoryForState(storeState);
    if (!territory) {
      fire?.("Store state is required before converting this quote");
      return;
    }

    const invoiceDate = localDate();
    setConverting(true);
    try {
      await onConvert?.({
        invoiceDate,
        dueDate: addDays(invoiceDate, 30),
        serviceDate: "",
        workOrderId: workOrder.id,
        storeNumber: workOrder.store || "",
        storeAddress: workOrder.addr || "",
        terms: "Net 30",
        cme: "",
        state: "draft",
        territory,
        taxState: storeState,
        salesTaxOverride: 0,
        lines: validLines,
        sourceInvoiceIds: selectedSource ? [selectedSource.id] : [],
      });
      window.localStorage.removeItem(draftStorageKey);
      setHasDraft(false);
      setWorkspaceOpen(false);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      fire?.(`Quote conversion failed: ${message}`);
    } finally {
      setConverting(false);
    }
  };

  const workspace = workspaceOpen && typeof document !== "undefined"
    ? createPortal(
        <div
          className="quote-workspace-overlay"
          role="presentation"
          onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
            if (event.target === event.currentTarget) setWorkspaceOpen(false);
          }}
        >
          <section
            className="quote-workspace-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quote-workspace-title"
          >
            <header className="quote-workspace-header">
              <div style={{ minWidth: 0 }}>
                <div
                  id="quote-workspace-title"
                  style={{ fontSize: 18, fontWeight: 700, color: T.ink }}
                >
                  Quote calculator
                </div>
                <div
                  className="mono"
                  style={{ marginTop: 3, fontSize: 11, color: T.muted }}
                >
                  {workOrder.id} | Store #{workOrder.store || "-"} | {lines.length} line{lines.length === 1 ? "" : "s"}
                </div>
              </div>

              <div className="quote-workspace-tools">
                <div
                  className="quote-view-switch"
                  role="group"
                  aria-label="Calculator view"
                >
                  <button
                    type="button"
                    className={viewMode === "table" ? "active" : ""}
                    onClick={() => setViewMode("table")}
                    title="Table view"
                  >
                    <Ico d={ICON.table} size={15} />
                    <span>Table</span>
                  </button>
                  <button
                    type="button"
                    className={viewMode === "focus" ? "active" : ""}
                    onClick={() => setViewMode("focus")}
                    title="Focus view"
                  >
                    <Ico d={ICON.focus} size={15} />
                    <span>Focus</span>
                  </button>
                </div>

                <div className="quote-bulk-wrap">
                  <button
                    type="button"
                    className="quote-toolbar-button"
                    onClick={() => setBulkOpen((current) => !current)}
                    aria-expanded={bulkOpen}
                  >
                    <Ico d={ICON.add} size={15} />
                    <span>Add lines</span>
                  </button>
                  {bulkOpen && (
                    <div className="quote-bulk-popover">
                      <label
                        htmlFor="quote-bulk-count"
                        style={{ fontSize: 11, fontWeight: 700, color: T.ink }}
                      >
                        Lines to add
                      </label>
                      <div className="quote-bulk-stepper">
                        <button
                          type="button"
                          onClick={() => setBulkCount((current) =>
                            clampBulkQuoteLineCount(current - 1)
                          )}
                          aria-label="Decrease line count"
                        >
                          -
                        </button>
                        <input
                          id="quote-bulk-count"
                          type="number"
                          min="1"
                          max="25"
                          step="1"
                          value={bulkCount}
                          onChange={(event) =>
                            setBulkCount(clampBulkQuoteLineCount(event.target.value))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") addBulkLines();
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => setBulkCount((current) =>
                            clampBulkQuoteLineCount(current + 1)
                          )}
                          aria-label="Increase line count"
                        >
                          +
                        </button>
                      </div>
                      <div style={{ display: "flex", gap: 7 }}>
                        <button
                          type="button"
                          className="btn-soft"
                          onClick={() => setBulkOpen(false)}
                          style={{ flex: 1, minHeight: 36, padding: "7px 10px" }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={addBulkLines}
                          style={{ flex: 1, minHeight: 36, padding: "7px 10px" }}
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  style={iconButtonStyle}
                  onClick={resetDraft}
                  title="Discard calculator draft"
                  aria-label="Discard calculator draft"
                  disabled={!hasDraft}
                >
                  <Ico d={ICON.reset} size={16} />
                </button>
                <button
                  type="button"
                  style={iconButtonStyle}
                  onClick={() => setWorkspaceOpen(false)}
                  title="Close calculator"
                  aria-label="Close calculator"
                >
                  <Ico d={ICON.close} size={16} />
                </button>
              </div>
            </header>

            <div className="quote-pricing-bar">
              <label>
                <span>Contractor quote</span>
                <Sel
                  value={selectedSourceId}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    const source = availableSources.find(
                      (invoice) => invoice.id === event.target.value,
                    );
                    loadSource(source || null);
                  }}
                  style={inputStyle}
                >
                  <option value="">Manual quote</option>
                  {selectedSourceId && !selectedSource && (
                    <option value={selectedSourceId} disabled>
                      Saved source unavailable
                    </option>
                  )}
                  {availableSources.map((invoice) => (
                    <option
                      key={invoice.id}
                      value={invoice.id}
                      data-sub={fmt(Number(invoice.total || 0))}
                    >
                      #{invoice.num}
                    </option>
                  ))}
                </Sel>
              </label>
              <label>
                <span>P1 labor</span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={laborRate}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    setLaborRate(event.target.value);
                    setHasDraft(true);
                  }}
                  aria-label="P1 labor rate"
                  style={inputStyle}
                />
              </label>
              <label>
                <span>Parts %</span>
                <Input
                  type="number"
                  min="0"
                  max="999"
                  step="0.1"
                  value={partsMarkupPercent}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    setPartsMarkupPercent(event.target.value);
                    setHasDraft(true);
                  }}
                  aria-label="Parts markup percent"
                  style={inputStyle}
                />
              </label>
              <label>
                <span>Margin %</span>
                <Input
                  type="number"
                  min="0"
                  max="99.99"
                  step="0.1"
                  value={overallMarginPercent}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    setOverallMarginPercent(event.target.value);
                    setHasDraft(true);
                  }}
                  aria-label="Overall margin percent"
                  style={inputStyle}
                />
              </label>
              <button
                type="button"
                className="btn-soft quote-recalculate-button"
                onClick={applyPricing}
              >
                <Ico d={ICON.refresh} size={15} />
                <span>Recalculate</span>
              </button>
            </div>

            <div ref={workspaceBodyRef} className="quote-workspace-body">
              {viewMode === "table" ? (
                <div className="quote-table">
                  <div className="quote-table-head">
                    <span />
                    <span>#</span>
                    <span>Type</span>
                    <span>Description</span>
                    <span>Qty</span>
                    <span>Contractor</span>
                    <span>P1 rate</span>
                    <span>Amount</span>
                    <span />
                  </div>
                  {lines.map((line, index) => (
                    <div
                      key={line.id}
                      className="quote-table-row"
                      data-quote-line-index={index}
                      onDragOver={(event: DragEvent<HTMLDivElement>) =>
                        event.preventDefault()
                      }
                      onDrop={(event: DragEvent<HTMLDivElement>) => {
                        event.preventDefault();
                        if (draggingLineId) moveLine(draggingLineId, line.id);
                        setDraggingLineId(null);
                      }}
                      style={{
                        background:
                          draggingLineId === line.id ? T.accentSoft : T.surface,
                      }}
                    >
                      <button
                        type="button"
                        draggable
                        onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                          setDraggingLineId(line.id);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", line.id);
                        }}
                        onDragEnd={() => setDraggingLineId(null)}
                        className="quote-line-drag"
                        title="Drag to reorder line"
                        aria-label={`Drag line ${index + 1} to reorder`}
                      >
                        <Ico d={ICON.drag} size={15} />
                      </button>
                      <span className="quote-line-number">{index + 1}</span>
                      <Sel
                        value={line.type}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                          updateLine(line.id, { type: event.target.value })
                        }
                        style={inputStyle}
                        aria-label={`Quote line ${index + 1} type`}
                      >
                        {STAFF_BILLING_LINE_TYPES.map((type) => (
                          <option key={type} value={type}>{type}</option>
                        ))}
                      </Sel>
                      <textarea
                        value={line.desc}
                        onChange={(event) =>
                          updateLine(line.id, { desc: event.target.value })
                        }
                        placeholder={
                          /^(travel|truck charge)$/i.test(line.type)
                            ? "Description (optional)"
                            : "Description"
                        }
                        aria-label={`Quote line ${index + 1} description`}
                      />
                      <Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={line.qty}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                          updateLine(line.id, {
                            qty: Number(event.target.value),
                          })
                        }
                        aria-label={`Quote line ${index + 1} quantity`}
                        style={inputStyle}
                      />
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.sourceRate}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                          updateLine(line.id, {
                            sourceRate: Number(event.target.value),
                          })
                        }
                        aria-label={`Quote line ${index + 1} contractor rate`}
                        style={inputStyle}
                      />
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.rate}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                          updateLine(line.id, {
                            rate: Number(event.target.value),
                          })
                        }
                        aria-label={`Quote line ${index + 1} P1 rate`}
                        style={inputStyle}
                      />
                      <span className="mono quote-line-amount">
                        {fmt(roundMoney(line.qty * line.rate))}
                      </span>
                      <button
                        type="button"
                        className="quote-line-remove"
                        onClick={() => removeLine(line.id)}
                        disabled={lines.length === 1}
                        title="Remove line"
                        aria-label={`Remove quote line ${index + 1}`}
                      >
                        <Ico d={ICON.trash} size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="quote-focus-shell">
                  <div className="quote-focus-nav">
                    <button
                      type="button"
                      onClick={() => moveFocus(focusIndex - 1)}
                      disabled={focusIndex === 0}
                      aria-label="Previous quote line"
                      title="Previous line"
                    >
                      <Ico d={ICON.back} size={17} />
                    </button>
                    <span className="mono">
                      Line {focusIndex + 1} of {lines.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => moveFocus(focusIndex + 1)}
                      disabled={focusIndex >= lines.length - 1}
                      aria-label="Next quote line"
                      title="Next line"
                    >
                      <Ico d={ICON.forward} size={17} />
                    </button>
                  </div>

                  {focusedLine && (
                    <div className="quote-focus-track">
                      <div
                        key={`${focusedLine.id}-${focusMotion}`}
                        className={`quote-focus-card quote-focus-${focusMotion}`}
                      >
                        <div className="quote-focus-card-head">
                          <div>
                            <div
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                color: T.subtle,
                                textTransform: "uppercase",
                              }}
                            >
                              Line {focusIndex + 1}
                            </div>
                            <div
                              className="mono"
                              style={{
                                marginTop: 4,
                                fontSize: 16,
                                fontWeight: 700,
                                color: T.ink,
                              }}
                            >
                              {fmt(roundMoney(focusedLine.qty * focusedLine.rate))}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="quote-focus-remove"
                            onClick={() => removeLine(focusedLine.id)}
                            disabled={lines.length === 1}
                            title="Remove line"
                            aria-label={`Remove quote line ${focusIndex + 1}`}
                          >
                            <Ico d={ICON.trash} size={16} />
                          </button>
                        </div>

                        <div className="quote-focus-fields">
                          <label>
                            <span>Type</span>
                            <Sel
                              value={focusedLine.type}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateLine(focusedLine.id, {
                                  type: event.target.value,
                                })
                              }
                              style={inputStyle}
                            >
                              {STAFF_BILLING_LINE_TYPES.map((type) => (
                                <option key={type} value={type}>{type}</option>
                              ))}
                            </Sel>
                          </label>
                          <label className="quote-focus-description">
                            <span>Description</span>
                            <textarea
                              value={focusedLine.desc}
                              onChange={(event) =>
                                updateLine(focusedLine.id, {
                                  desc: event.target.value,
                                })
                              }
                              placeholder={
                                /^(travel|truck charge)$/i.test(focusedLine.type)
                                  ? "Description (optional)"
                                  : "Description"
                              }
                            />
                          </label>
                          <label>
                            <span>Quantity</span>
                            <Input
                              type="number"
                              min="0.01"
                              step="0.01"
                              value={focusedLine.qty}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateLine(focusedLine.id, {
                                  qty: Number(event.target.value),
                                })
                              }
                              style={inputStyle}
                            />
                          </label>
                          <label>
                            <span>Contractor rate</span>
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              value={focusedLine.sourceRate}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateLine(focusedLine.id, {
                                  sourceRate: Number(event.target.value),
                                })
                              }
                              style={inputStyle}
                            />
                          </label>
                          <label>
                            <span>P1 rate</span>
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              value={focusedLine.rate}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateLine(focusedLine.id, {
                                  rate: Number(event.target.value),
                                })
                              }
                              style={inputStyle}
                            />
                          </label>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <footer className="quote-workspace-footer">
              <div className="quote-footer-metrics">
                <div>
                  <span>Contractor cost</span>
                  <strong className="mono">{fmt(totals.sourceCost)}</strong>
                </div>
                <div>
                  <span>Parts markup</span>
                  <strong className="mono">
                    +{fmt(totals.partsMarkupUplift)}
                  </strong>
                </div>
                <div>
                  <span>P1 adjustment</span>
                  <strong className="mono">
                    {totals.p1RateAdjustment < 0 ? "-" : "+"}
                    {fmt(Math.abs(totals.p1RateAdjustment))}
                  </strong>
                </div>
                <div>
                  <span>Margin</span>
                  <strong className="mono">
                    {totals.overallMarginUplift < 0 ? "-" : "+"}
                    {fmt(Math.abs(totals.overallMarginUplift))}
                  </strong>
                </div>
                <div className="quote-footer-total">
                  <span>Quote total</span>
                  <strong className="mono">{fmt(totals.subtotal)}</strong>
                </div>
              </div>
              <button
                type="button"
                className="btn-primary quote-convert-button"
                onClick={convert}
                disabled={converting}
              >
                {converting ? "Creating draft..." : "Convert to invoice"}
              </button>
            </footer>
          </section>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <style>{`
        .quote-workspace-overlay {
          position: fixed;
          inset: 0;
          z-index: 80;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          background: rgba(31, 30, 28, 0.5);
          backdrop-filter: blur(4px);
        }
        .quote-workspace-panel {
          width: min(1180px, calc(100vw - 40px));
          height: min(840px, calc(100dvh - 40px));
          min-height: 560px;
          box-sizing: border-box;
          display: grid;
          grid-template-rows: auto auto minmax(0, 1fr) auto;
          overflow: hidden;
          border: 1px solid ${T.borderSoft};
          border-radius: 8px;
          background: ${T.surface};
          box-shadow: 0 24px 70px rgba(31, 30, 28, 0.24);
          animation: fadeUp 180ms ease;
        }
        .quote-workspace-header {
          min-width: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 16px 18px;
          border-bottom: 1px solid ${T.borderSoft};
          background: ${T.surface};
        }
        .quote-workspace-tools {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
          min-width: 0;
        }
        .quote-view-switch {
          display: flex;
          align-items: center;
          padding: 3px;
          border: 1px solid ${T.borderSoft};
          border-radius: 7px;
          background: ${T.surfaceSoft};
        }
        .quote-view-switch button {
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 0 10px;
          border: 0;
          border-radius: 5px;
          background: transparent;
          color: ${T.muted};
          font-family: inherit;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
        }
        .quote-view-switch button.active {
          background: ${T.surface};
          color: ${T.ink};
          box-shadow: 0 1px 3px rgba(31, 30, 28, 0.1);
        }
        .quote-toolbar-button {
          height: 38px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          padding: 0 12px;
          border: 1px solid ${T.border};
          border-radius: 7px;
          background: ${T.surface};
          color: ${T.ink};
          font-family: inherit;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
        }
        .quote-bulk-wrap {
          position: relative;
        }
        .quote-bulk-popover {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          z-index: 12;
          width: 220px;
          display: grid;
          gap: 11px;
          padding: 14px;
          border: 1px solid ${T.border};
          border-radius: 8px;
          background: ${T.surface};
          box-shadow: 0 14px 34px rgba(31, 30, 28, 0.16);
        }
        .quote-bulk-stepper {
          display: grid;
          grid-template-columns: 38px 1fr 38px;
          gap: 6px;
        }
        .quote-bulk-stepper button,
        .quote-bulk-stepper input {
          height: 38px;
          box-sizing: border-box;
          border: 1px solid ${T.border};
          border-radius: 7px;
          background: ${T.surface};
          color: ${T.ink};
          font-family: inherit;
          font-size: 13px;
          font-weight: 600;
          text-align: center;
        }
        .quote-bulk-stepper button {
          cursor: pointer;
        }
        .quote-pricing-bar {
          min-width: 0;
          display: grid;
          grid-template-columns: minmax(180px, 1.4fr) repeat(3, minmax(86px, 0.65fr)) auto;
          gap: 10px;
          align-items: end;
          padding: 12px 18px;
          border-bottom: 1px solid ${T.borderSoft};
          background: ${T.surfaceSoft};
        }
        .quote-pricing-bar label {
          min-width: 0;
        }
        .quote-pricing-bar input,
        .quote-focus-fields input {
          min-width: 0;
          max-width: 100%;
        }
        .quote-pricing-bar label > span,
        .quote-focus-fields label > span {
          display: block;
          margin-bottom: 5px;
          color: ${T.muted};
          font-size: 10px;
          font-weight: 700;
        }
        .quote-recalculate-button {
          min-height: 38px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          padding: 8px 12px;
          border-radius: 7px;
        }
        .quote-workspace-body {
          min-width: 0;
          min-height: 0;
          overflow: auto;
          overscroll-behavior: contain;
          background: ${T.surface};
        }
        .quote-table {
          min-width: 980px;
        }
        .quote-table-head,
        .quote-table-row {
          display: grid;
          grid-template-columns: 32px 34px 132px minmax(230px, 1fr) 72px 96px 96px 104px 36px;
          gap: 8px;
          align-items: center;
          padding: 9px 14px;
        }
        .quote-table-head {
          position: sticky;
          top: 0;
          z-index: 3;
          min-height: 34px;
          box-sizing: border-box;
          border-bottom: 1px solid ${T.borderSoft};
          background: ${T.surfaceSoft};
          color: ${T.subtle};
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
        }
        .quote-table-row {
          min-height: 58px;
          border-bottom: 1px solid ${T.borderSoft};
          transition: background 120ms ease;
        }
        .quote-table-row textarea {
          width: 100%;
          min-height: 38px;
          max-height: 90px;
          box-sizing: border-box;
          resize: vertical;
          padding: 8px 9px;
          border: 1px solid ${T.border};
          border-radius: 7px;
          background: ${T.surface};
          color: ${T.ink};
          font-family: inherit;
          font-size: 12px;
          line-height: 1.35;
        }
        .quote-line-drag,
        .quote-line-remove,
        .quote-focus-remove,
        .quote-focus-nav button {
          width: 34px;
          height: 34px;
          display: grid;
          place-items: center;
          padding: 0;
          border: 1px solid ${T.borderSoft};
          border-radius: 7px;
          background: ${T.surface};
          color: ${T.muted};
          cursor: pointer;
        }
        .quote-line-drag {
          border-color: transparent;
          background: transparent;
          cursor: grab;
        }
        .quote-line-remove,
        .quote-focus-remove {
          color: ${T.danger};
        }
        .quote-line-remove:disabled,
        .quote-focus-remove:disabled,
        .quote-focus-nav button:disabled {
          cursor: default;
          opacity: 0.35;
        }
        .quote-line-number {
          text-align: center;
          color: ${T.subtle};
          font-family: inherit;
          font-size: 11px;
          font-weight: 600;
        }
        .quote-line-amount {
          text-align: right;
          color: ${T.ink};
          font-size: 12px;
          font-weight: 700;
        }
        .quote-focus-shell {
          width: min(760px, calc(100% - 32px));
          min-height: 100%;
          margin: 0 auto;
          padding: 18px 0 28px;
          box-sizing: border-box;
        }
        .quote-focus-nav {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 14px;
          margin-bottom: 14px;
        }
        .quote-focus-nav span {
          min-width: 110px;
          text-align: center;
          color: ${T.muted};
          font-size: 11px;
          font-weight: 700;
        }
        .quote-focus-track {
          overflow: hidden;
        }
        .quote-focus-card {
          width: 100%;
          max-width: 100%;
          box-sizing: border-box;
          padding: 20px;
          border: 1px solid ${T.borderSoft};
          border-radius: 8px;
          background: ${T.surface};
          box-shadow: 0 4px 16px rgba(31, 30, 28, 0.06);
        }
        .quote-focus-next {
          animation: quote-slide-next 180ms ease-out;
        }
        .quote-focus-previous {
          animation: quote-slide-previous 180ms ease-out;
        }
        .quote-focus-card-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 18px;
        }
        .quote-focus-fields {
          display: grid;
          grid-template-columns: 1.1fr repeat(3, 0.7fr);
          gap: 12px;
          align-items: end;
        }
        .quote-focus-fields label {
          min-width: 0;
        }
        .quote-focus-description {
          grid-column: 1 / -1;
          grid-row: 2;
        }
        .quote-focus-fields textarea {
          width: 100%;
          min-height: 90px;
          box-sizing: border-box;
          resize: vertical;
          padding: 10px 11px;
          border: 1px solid ${T.border};
          border-radius: 7px;
          background: ${T.surface};
          color: ${T.ink};
          font-family: inherit;
          font-size: 13px;
          line-height: 1.45;
        }
        .quote-workspace-footer {
          min-width: 0;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 18px;
          align-items: center;
          padding: 13px 18px;
          border-top: 1px solid ${T.borderSoft};
          background: ${T.surfaceSoft};
          box-shadow: 0 -4px 14px rgba(31, 30, 28, 0.04);
        }
        .quote-footer-metrics {
          min-width: 0;
          display: grid;
          grid-template-columns: repeat(5, minmax(92px, 1fr));
          gap: 12px;
        }
        .quote-footer-metrics div {
          min-width: 0;
        }
        .quote-footer-metrics span,
        .quote-footer-metrics strong {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .quote-footer-metrics span {
          margin-bottom: 3px;
          color: ${T.subtle};
          font-size: 9px;
          font-weight: 700;
          text-transform: uppercase;
        }
        .quote-footer-metrics strong {
          color: ${T.ink};
          font-size: 12px;
        }
        .quote-footer-total strong {
          color: ${T.accent};
          font-size: 15px;
        }
        .quote-convert-button {
          min-width: 154px;
          min-height: 42px;
          padding: 10px 14px;
          border-radius: 7px;
        }
        @keyframes quote-slide-next {
          from { opacity: 0; transform: translateX(28px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes quote-slide-previous {
          from { opacity: 0; transform: translateX(-28px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @media(max-width: 900px) {
          .quote-workspace-header {
            align-items: flex-start;
          }
          .quote-workspace-tools {
            flex-wrap: wrap;
          }
          .quote-pricing-bar {
            grid-template-columns: repeat(4, minmax(0, 1fr));
          }
          .quote-pricing-bar label:first-child {
            grid-column: span 2;
          }
          .quote-recalculate-button {
            grid-column: span 2;
          }
          .quote-workspace-footer {
            grid-template-columns: 1fr;
          }
          .quote-convert-button {
            width: 100%;
          }
        }
        @media(max-width: 768px) {
          .quote-workspace-overlay {
            padding: 0;
          }
          .quote-workspace-panel {
            width: 100vw;
            height: 100dvh;
            min-height: 0;
            border: 0;
            border-radius: 0;
          }
          .quote-workspace-header {
            display: grid;
            gap: 12px;
            padding: 12px 14px;
          }
          .quote-workspace-tools {
            justify-content: flex-start;
            flex-wrap: nowrap;
            overflow: visible;
          }
          .quote-view-switch {
            flex: 1;
          }
          .quote-view-switch button {
            flex: 1;
          }
          .quote-toolbar-button span {
            display: none;
          }
          .quote-toolbar-button {
            width: 38px;
            padding: 0;
          }
          .quote-pricing-bar {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            padding: 10px 14px;
          }
          .quote-pricing-bar label:first-child,
          .quote-recalculate-button {
            grid-column: 1 / -1;
          }
          .quote-focus-shell {
            width: calc(100% - 28px);
            padding-top: 14px;
          }
          .quote-focus-card {
            padding: 16px;
          }
          .quote-focus-fields {
            grid-template-columns: 1fr 1fr;
          }
          .quote-focus-fields label:first-child {
            grid-column: 1 / -1;
          }
          .quote-focus-description {
            grid-column: 1 / -1;
            grid-row: auto;
          }
          .quote-workspace-footer {
            gap: 10px;
            padding: 10px 14px;
          }
          .quote-footer-metrics {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 8px;
          }
          .quote-footer-metrics div:nth-child(3),
          .quote-footer-metrics div:nth-child(4) {
            display: none;
          }
          .quote-footer-total {
            text-align: right;
          }
          .quote-bulk-popover {
            right: -92px;
          }
        }
        @media(max-width: 420px) {
          .quote-view-switch button span {
            display: none;
          }
          .quote-footer-metrics {
            grid-template-columns: 1fr 1fr;
          }
          .quote-footer-metrics div:nth-child(2) {
            display: none;
          }
          .quote-focus-fields {
            grid-template-columns: 1fr;
          }
          .quote-focus-fields label:first-child,
          .quote-focus-description {
            grid-column: auto;
          }
          .quote-bulk-popover {
            position: fixed;
            top: 104px;
            left: 14px;
            right: 14px;
            width: auto;
          }
        }
      `}</style>

      <div className="card" style={{ marginBottom: 14, overflow: "visible" }}>
        <div style={{ padding: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  color: T.subtle,
                }}
              >
                Quote calculator
              </div>
              <div
                className="mono"
                style={{
                  marginTop: 5,
                  fontSize: 20,
                  fontWeight: 700,
                  color: T.ink,
                }}
              >
                {fmt(totals.subtotal)}
              </div>
              <div style={{ marginTop: 4, fontSize: 10, color: T.muted }}>
                {lines.length} line{lines.length === 1 ? "" : "s"}
                {selectedSource ? ` | Quote #${selectedSource.num}` : " | Manual"}
              </div>
            </div>
            {hasDraft && (
              <span
                style={{
                  padding: "4px 7px",
                  borderRadius: 6,
                  background: T.successSoft,
                  color: T.success,
                  fontSize: 9,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                }}
              >
                Draft saved
              </span>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              marginTop: 13,
              paddingTop: 12,
              borderTop: `1px solid ${T.borderSoft}`,
            }}
          >
            <div>
              <div style={{ fontSize: 9, color: T.subtle, fontWeight: 700 }}>
                Contractor cost
              </div>
              <div
                className="mono"
                style={{ marginTop: 3, fontSize: 12, fontWeight: 700 }}
              >
                {fmt(totals.sourceCost)}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 9, color: T.subtle, fontWeight: 700 }}>
                Parts markup
              </div>
              <div
                className="mono"
                style={{
                  marginTop: 3,
                  fontSize: 12,
                  fontWeight: 700,
                  color: T.accent,
                }}
              >
                +{fmt(totals.partsMarkupUplift)}
              </div>
            </div>
          </div>

          <button
            type="button"
            className="btn-primary"
            onClick={openWorkspace}
            aria-label="Open quote calculator"
            style={{
              width: "100%",
              minHeight: 40,
              marginTop: 13,
              padding: "9px 12px",
              borderRadius: 7,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            <Ico d={ICON.expand} size={15} />
            <span>Open calculator</span>
          </button>
        </div>
      </div>
      {workspace}
    </>
  );
}
