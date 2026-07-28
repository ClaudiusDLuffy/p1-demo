"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { Input } from "../../components/ui/Input";
import { Sel } from "../../components/ui/Sel";
import { T, LINE_TYPES } from "../../lib/constants";
import {
  normalizeQuoteLineType,
  priceQuoteLines,
  quoteLineToBillingLine,
  quoteTotals,
  type QuoteCalculatorLine,
} from "../../lib/quoteCalculator";

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

const emptyLine = (): QuoteCalculatorLine => ({
  id: lineId(),
  type: "Labor",
  desc: "",
  qty: 1,
  sourceRate: 0,
  rate: 110,
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
};

type QuoteCalculatorProps = {
  workOrder: QuoteWorkOrder;
  contractorInvoices?: ContractorInvoice[];
  billingInvoices?: BillingInvoice[];
  fmt: (amount: number) => string;
  fire?: (message: string) => void;
  onConvert?: (payload: Record<string, unknown>) => Promise<unknown>;
};

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

export default function QuoteCalculator({
  workOrder,
  contractorInvoices = [],
  billingInvoices = [],
  fmt,
  fire,
  onConvert,
}: QuoteCalculatorProps) {
  const [expanded, setExpanded] = useState(true);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [lines, setLines] = useState<QuoteCalculatorLine[]>([emptyLine()]);
  const [laborRate, setLaborRate] = useState("110");
  const [partsMarkupPercent, setPartsMarkupPercent] = useState("25");
  const [overallMarginPercent, setOverallMarginPercent] = useState("0");
  const [converting, setConverting] = useState(false);
  const initializedWorkOrder = useRef("");
  const waitingForInitialSource = useRef(false);

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

  const loadSource = (invoice: ContractorInvoice | null | undefined) => {
    waitingForInitialSource.current = false;
    const next = priceQuoteLines(sourceLines(invoice), pricing);
    setSelectedSourceId(invoice?.id || "");
    setLines(next);
  };

  useEffect(() => {
    if (!workOrder?.id) return;
    const source = availableSources[0] || null;

    if (initializedWorkOrder.current === workOrder.id) {
      if (!source || !waitingForInitialSource.current) return;
      waitingForInitialSource.current = false;
      setSelectedSourceId(source.id);
      setLines(priceQuoteLines(sourceLines(source), DEFAULT_PRICING));
      return;
    }

    initializedWorkOrder.current = workOrder.id;
    waitingForInitialSource.current = !source;
    setLaborRate(String(DEFAULT_PRICING.laborRate));
    setPartsMarkupPercent(String(DEFAULT_PRICING.partsMarkupPercent));
    setOverallMarginPercent(String(DEFAULT_PRICING.overallMarginPercent));
    setSelectedSourceId(source?.id || "");
    setLines(priceQuoteLines(sourceLines(source), DEFAULT_PRICING));
  }, [availableSources, workOrder?.id]);

  const updateLine = (
    id: string,
    patch: Partial<QuoteCalculatorLine>,
  ) => {
    setLines((current) =>
      current.map((line) => line.id === id ? { ...line, ...patch } : line),
    );
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
        salesTaxOverride: 0,
        lines: validLines,
        sourceInvoiceIds: selectedSource ? [selectedSource.id] : [],
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      fire?.(`Quote conversion failed: ${message}`);
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 14, overflow: "visible" }}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        style={{
          width: "100%",
          padding: 18,
          border: 0,
          background: "transparent",
          color: T.ink,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left",
        }}
      >
        <span>
          <span style={{ display: "block", fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: T.subtle }}>
            Quote calculator
          </span>
          <span className="mono" style={{ display: "block", marginTop: 4, fontSize: 16, fontWeight: 700 }}>
            {fmt(totals.subtotal)}
          </span>
        </span>
        <span aria-hidden="true" style={{ color: T.muted, fontSize: 15 }}>
          {expanded ? "\u2212" : "+"}
        </span>
      </button>

      {expanded && (
        <div style={{ padding: "0 18px 18px" }}>
          {availableSources.length > 0 && (
            <label style={{ display: "block", marginBottom: 12 }}>
              <span style={{ display: "block", marginBottom: 5, color: T.muted, fontSize: 10, fontWeight: 700 }}>
                Contractor quote
              </span>
              <Sel
                value={selectedSourceId}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                  const source = availableSources.find(
                    (invoice) => invoice.id === event.target.value,
                  );
                  loadSource(source);
                }}
                style={{ minHeight: 38, fontSize: 12, padding: "8px 34px 8px 10px", borderRadius: 7 }}
              >
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
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 7, marginBottom: 8 }}>
            <label>
              <span style={{ display: "block", color: T.muted, fontSize: 9, marginBottom: 4 }}>P1 labor</span>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={laborRate}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setLaborRate(event.target.value)}
                aria-label="P1 labor rate"
                style={{ padding: "8px 7px", borderRadius: 7, fontSize: 11 }}
              />
            </label>
            <label>
              <span style={{ display: "block", color: T.muted, fontSize: 9, marginBottom: 4 }}>Parts %</span>
              <Input
                type="number"
                min="0"
                max="999"
                step="0.1"
                value={partsMarkupPercent}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setPartsMarkupPercent(event.target.value)}
                aria-label="Parts markup percent"
                style={{ padding: "8px 7px", borderRadius: 7, fontSize: 11 }}
              />
            </label>
            <label>
              <span style={{ display: "block", color: T.muted, fontSize: 9, marginBottom: 4 }}>Margin %</span>
              <Input
                type="number"
                min="0"
                max="99.99"
                step="0.1"
                value={overallMarginPercent}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setOverallMarginPercent(event.target.value)}
                aria-label="Overall margin percent"
                style={{ padding: "8px 7px", borderRadius: 7, fontSize: 11 }}
              />
            </label>
          </div>
          <button
            type="button"
            onClick={applyPricing}
            className="btn-soft"
            style={{ width: "100%", padding: "7px 10px", fontSize: 10, marginBottom: 12 }}
          >
            Recalculate rates
          </button>

          <div style={{ borderTop: `1px solid ${T.borderSoft}` }}>
            {lines.map((line, index) => (
              <div key={line.id} style={{ padding: "12px 0", borderBottom: `1px solid ${T.borderSoft}` }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 30px", gap: 6, marginBottom: 6 }}>
                  <Sel
                    value={line.type}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => updateLine(line.id, { type: event.target.value })}
                    style={{ minHeight: 34, fontSize: 11, padding: "7px 30px 7px 9px", borderRadius: 7 }}
                    aria-label={`Quote line ${index + 1} type`}
                  >
                    {LINE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                  </Sel>
                  <button
                    type="button"
                    onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))}
                    disabled={lines.length === 1}
                    aria-label={`Remove quote line ${index + 1}`}
                    title="Remove line"
                    style={{
                      width: 30,
                      height: 34,
                      border: `1px solid ${T.borderSoft}`,
                      borderRadius: 7,
                      background: T.surface,
                      color: T.danger,
                      cursor: lines.length === 1 ? "default" : "pointer",
                      opacity: lines.length === 1 ? 0.4 : 1,
                      fontSize: 17,
                    }}
                  >
                    {"\u00d7"}
                  </button>
                </div>
                <Input
                  value={line.desc}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => updateLine(line.id, { desc: event.target.value })}
                  placeholder={/^(travel|truck charge)$/i.test(line.type) ? "Description (optional)" : "Description"}
                  aria-label={`Quote line ${index + 1} description`}
                  style={{ padding: "8px 9px", borderRadius: 7, fontSize: 11, marginBottom: 6 }}
                />
                <div style={{ display: "grid", gridTemplateColumns: "54px 1fr 1fr", gap: 6 }}>
                  <label>
                    <span style={{ display: "block", color: T.subtle, fontSize: 8, marginBottom: 3 }}>Qty</span>
                    <Input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={line.qty}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => updateLine(line.id, { qty: Number(event.target.value) })}
                      aria-label={`Quote line ${index + 1} quantity`}
                      style={{ padding: "7px 5px", borderRadius: 7, fontSize: 10 }}
                    />
                  </label>
                  <label>
                    <span style={{ display: "block", color: T.subtle, fontSize: 8, marginBottom: 3 }}>Contractor</span>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.sourceRate}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => updateLine(line.id, { sourceRate: Number(event.target.value) })}
                      aria-label={`Quote line ${index + 1} contractor rate`}
                      style={{ padding: "7px 5px", borderRadius: 7, fontSize: 10 }}
                    />
                  </label>
                  <label>
                    <span style={{ display: "block", color: T.subtle, fontSize: 8, marginBottom: 3 }}>P1 rate</span>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.rate}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => updateLine(line.id, { rate: Number(event.target.value) })}
                      aria-label={`Quote line ${index + 1} P1 rate`}
                      style={{ padding: "7px 5px", borderRadius: 7, fontSize: 10 }}
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setLines((current) => [...current, emptyLine()])}
            className="btn-soft"
            style={{ width: "100%", padding: "7px 10px", marginTop: 9, fontSize: 10 }}
          >
            + Add line
          </button>

          <div style={{ padding: "12px 0 10px", display: "grid", gap: 5, fontSize: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", color: T.muted }}>
              <span>Contractor cost</span><span className="mono">{fmt(totals.sourceCost)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", color: T.muted }}>
              <span>Parts markup</span><span className="mono">{totals.partsMarkupUplift < 0 ? "-" : "+"}{fmt(Math.abs(totals.partsMarkupUplift))}</span>
            </div>
            {totals.p1RateAdjustment !== 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", color: T.muted }}>
                <span>P1 rate adjustment</span><span className="mono">{totals.p1RateAdjustment < 0 ? "-" : "+"}{fmt(Math.abs(totals.p1RateAdjustment))}</span>
              </div>
            )}
            {totals.overallMarginUplift !== 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", color: T.muted }}>
                <span>Overall margin</span><span className="mono">{totals.overallMarginUplift < 0 ? "-" : "+"}{fmt(Math.abs(totals.overallMarginUplift))}</span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 7, borderTop: `1px solid ${T.borderSoft}`, color: T.ink, fontWeight: 700, fontSize: 12 }}>
              <span>Quote total</span><span className="mono">{fmt(totals.subtotal)}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={convert}
            disabled={converting}
            className="btn-primary"
            style={{ width: "100%", padding: "9px 12px", fontSize: 11, opacity: converting ? 0.7 : 1 }}
          >
            {converting ? "Creating draft..." : "Convert to invoice"}
          </button>
        </div>
      )}
    </div>
  );
}
