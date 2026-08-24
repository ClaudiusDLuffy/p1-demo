"use client";

import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BtnSpinner, BtnSpinnerDark } from "../../components/ui/BtnSpinner";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { Modal } from "../../components/ui/Modal";
import { Sel } from "../../components/ui/Sel";
import { TA } from "../../components/ui/TA";
import {
  convertContractorEstimateToInvoice,
  loadInvoiceById,
  saveContractorEstimate,
} from "../../lib/db";
import {
  canConvertContractorEstimate,
  canCreateContractorEstimate,
  canEditContractorEstimate,
  CONTRACTOR_ESTIMATE_LINE_TYPES,
  CONTRACTOR_ESTIMATE_MAX_DESCRIPTION_LENGTH,
  CONTRACTOR_ESTIMATE_MAX_NOTES_LENGTH,
  CONTRACTOR_ESTIMATE_MAX_TERMS_LENGTH,
  CONTRACTOR_ESTIMATE_STATE_LABELS,
  contractorEstimateLineAmount,
  contractorEstimateTotals,
  normalizeContractorEstimateLines,
  validateContractorEstimate,
  type ContractorEstimate,
  type ContractorEstimateLineType,
  type ContractorEstimateState,
  type EditableContractorEstimateLine,
} from "../../lib/contractorEstimate";
import { P1_BUSINESS, T } from "../../lib/constants";
import { isRpcConflict, rpcConflictMessage } from "../../lib/rpcConflict";
import {
  INVOICE_BY_ID_KEY,
  INVOICE_PAGES_KEY,
  INVOICES_KEY,
} from "../invoices/queries";
import { WORK_ORDER_DETAILS_KEY } from "../work-orders/queries";
import {
  CONTRACTOR_ESTIMATES_KEY,
  useContractorEstimatesQuery,
} from "./queries";

type EditorState = {
  id: string | null;
  quoteNum: string | null;
  state: ContractorEstimateState;
  expectedUpdatedAt: string | null;
  convertedInvoiceId: string | null;
  quoteDate: string;
  validUntil: string;
  terms: string;
  notes: string;
  salesTax: number | string;
  lines: EditableContractorEstimateLine[];
};

type ContractorEstimatePanelProps = {
  workOrder: { id: string; status: string; store?: string | null };
  currentUser: {
    name?: string | null;
    company?: string | null;
    canInvoice?: boolean;
  } | null;
  isManager: boolean;
  fire: (message: string) => void;
  fmt?: (amount: number) => string;
  onOpenInvoiceDraft?: (invoice: unknown) => void;
};

const todayIso = () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const emptyEditor = (): EditorState => ({
  id: null,
  quoteNum: null,
  state: "draft",
  expectedUpdatedAt: null,
  convertedInvoiceId: null,
  quoteDate: todayIso(),
  validUntil: "",
  terms: P1_BUSINESS.defaultTerms,
  notes: "",
  salesTax: "",
  lines: [],
});

const editorFromEstimate = (estimate: ContractorEstimate): EditorState => ({
  id: estimate.id,
  quoteNum: estimate.quoteNum,
  state: estimate.state,
  expectedUpdatedAt: estimate.updatedAt,
  convertedInvoiceId: estimate.convertedInvoiceId,
  quoteDate: estimate.quoteDate,
  validUntil: estimate.validUntil || "",
  terms: estimate.terms,
  notes: estimate.notes || "",
  salesTax: estimate.salesTax,
  lines: estimate.lines.map(line => ({
    type: line.type,
    description: line.description,
    qty: line.qty,
    rate: line.rate,
  })),
});

const statusStyle = (state: ContractorEstimateState) => {
  if (state === "converted") return { color: T.success, background: T.successSoft };
  if (state === "submitted") return { color: T.accent, background: T.accentSoft };
  return { color: T.subtle, background: T.surfaceSoft };
};

const formatDate = (value: string | null) => {
  if (!value) return "No expiration";
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

export default function ContractorEstimatePanel({
  workOrder,
  currentUser,
  isManager,
  fire,
  fmt = amount => `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  onOpenInvoiceDraft,
}: ContractorEstimatePanelProps) {
  const qc = useQueryClient();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"save" | "submit" | "convert" | "open" | null>(null);
  const [confirmAction, setConfirmAction] = useState<"submit" | "convert" | null>(null);
  const operationLock = useRef(false);
  const access = useMemo(() => ({
    isManager,
    canInvoice: currentUser?.canInvoice === true,
    workOrderStatus: workOrder.status,
  }), [currentUser?.canInvoice, isManager, workOrder.status]);
  const canCreate = canCreateContractorEstimate(access);
  const estimatesQuery = useContractorEstimatesQuery(
    workOrder.id,
    isManager || currentUser?.canInvoice === true,
  );
  const estimates = estimatesQuery.data || [];
  const totals = useMemo(
    () => editor ? contractorEstimateTotals(editor.lines, editor.salesTax) : null,
    [editor],
  );
  const editable = editor
    ? canEditContractorEstimate({ state: editor.state }, access)
    : false;

  const invalidateEstimateWorkflow = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: CONTRACTOR_ESTIMATES_KEY }),
      qc.invalidateQueries({ queryKey: WORK_ORDER_DETAILS_KEY }),
    ]);
  };

  const invalidateConvertedInvoice = async () => {
    await Promise.all([
      invalidateEstimateWorkflow(),
      qc.invalidateQueries({ queryKey: INVOICES_KEY }),
      qc.invalidateQueries({ queryKey: INVOICE_PAGES_KEY }),
      qc.invalidateQueries({ queryKey: INVOICE_BY_ID_KEY }),
    ]);
  };

  const openEstimate = (estimate: ContractorEstimate) => {
    setError("");
    setConfirmAction(null);
    setEditor(editorFromEstimate(estimate));
  };

  const updateLine = (
    index: number,
    patch: Partial<EditableContractorEstimateLine>,
  ) => {
    setEditor(current => current ? {
      ...current,
      lines: current.lines.map((line, lineIndex) => (
        lineIndex === index ? { ...line, ...patch } : line
      )),
    } : current);
  };

  const addLine = () => {
    setEditor(current => current ? {
      ...current,
      lines: [...current.lines, {
        type: "Labor",
        description: "",
        qty: 1,
        rate: "",
      }],
    } : current);
  };

  const save = async (submit: boolean) => {
    if (!editor || operationLock.current) return;
    const validationErrors = validateContractorEstimate(editor, { submitting: submit });
    if (validationErrors.length > 0) {
      setError(validationErrors[0]);
      setConfirmAction(null);
      return;
    }

    operationLock.current = true;
    setBusy(submit ? "submit" : "save");
    setError("");
    try {
      const result = await saveContractorEstimate({
        estimateId: editor.id,
        workOrderId: workOrder.id,
        quoteDate: editor.quoteDate,
        validUntil: editor.validUntil || null,
        terms: editor.terms.trim(),
        notes: editor.notes.trim() || null,
        salesTax: Number(editor.salesTax || 0),
        lines: normalizeContractorEstimateLines(editor.lines),
        submit,
        expectedUpdatedAt: editor.expectedUpdatedAt,
      });
      await invalidateEstimateWorkflow();
      setEditor(null);
      setConfirmAction(null);
      fire(submit
        ? `Estimate #${result.quoteNum} submitted — no invoice or billing status changed`
        : `Estimate #${result.quoteNum} saved as a draft`);
    } catch (caught) {
      if (isRpcConflict(caught)) {
        await invalidateEstimateWorkflow();
        setError(`${rpcConflictMessage("Estimate")} Close and reopen this estimate to continue.`);
      } else {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
      }
    } finally {
      operationLock.current = false;
      setBusy(null);
    }
  };

  const openInvoice = async (invoiceId: string) => {
    if (!invoiceId || operationLock.current) return;
    operationLock.current = true;
    setBusy("open");
    setError("");
    try {
      const invoice = await loadInvoiceById(invoiceId);
      if (!invoice) throw new Error("The converted invoice draft could not be loaded.");
      setEditor(null);
      onOpenInvoiceDraft?.(invoice);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      fire(`Could not open invoice: ${message}`);
    } finally {
      operationLock.current = false;
      setBusy(null);
    }
  };

  const convert = async () => {
    if (!editor?.id || operationLock.current) return;
    if (!canConvertContractorEstimate({ state: editor.state }, access)) return;
    operationLock.current = true;
    setBusy("convert");
    setError("");
    try {
      const result = await convertContractorEstimateToInvoice(editor.id);
      await invalidateConvertedInvoice();
      const invoice = await loadInvoiceById(result.invoiceId);
      setEditor(null);
      setConfirmAction(null);
      fire(result.alreadyConverted
        ? `Invoice #${result.invoiceNum} draft opened`
        : `Estimate #${result.quoteNum} converted to invoice #${result.invoiceNum} draft`);
      if (invoice) onOpenInvoiceDraft?.(invoice);
    } catch (caught) {
      if (isRpcConflict(caught)) {
        await invalidateConvertedInvoice();
        setError(rpcConflictMessage("Estimate"));
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      setConfirmAction(null);
    } finally {
      operationLock.current = false;
      setBusy(null);
    }
  };

  if (!isManager && currentUser?.canInvoice !== true) return null;
  if (isManager && !estimatesQuery.isLoading && !estimatesQuery.isError && estimates.length === 0) {
    return null;
  }

  return (
    <>
      <div className="card" style={{ padding: 0, marginBottom: 16, overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${T.borderSoft}`, background: T.surfaceSoft, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle }}>Estimates / quotes</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 3 }}>Not billed and not money owed until converted and the invoice is separately submitted.</div>
          </div>
          {canCreate && (
            <button
              type="button"
              className="btn-soft"
              onClick={() => {
                setError("");
                setConfirmAction(null);
                setEditor(emptyEditor());
              }}
              style={{ padding: "7px 12px", fontSize: 11 }}
            >+ New estimate</button>
          )}
        </div>

        {estimatesQuery.isLoading ? (
          <div style={{ padding: 18, fontSize: 12, color: T.muted }}>Loading estimates…</div>
        ) : estimatesQuery.isError ? (
          <div style={{ padding: 18, fontSize: 12, color: T.danger }}>Estimates could not be loaded. Existing work-order and invoice functions are unaffected.</div>
        ) : estimates.length === 0 ? (
          <div style={{ padding: 18, fontSize: 12, color: T.subtle }}>No estimates on this work order.</div>
        ) : estimates.map((estimate, index) => {
          const state = statusStyle(estimate.state);
          const canEdit = canEditContractorEstimate(estimate, access);
          const canConvert = canConvertContractorEstimate(estimate, access);
          return (
            <div
              key={estimate.id}
              style={{ padding: "14px 18px", borderBottom: index < estimates.length - 1 ? `1px solid ${T.borderSoft}` : "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                  <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>#{estimate.quoteNum}</span>
                  <span style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, borderRadius: 999, padding: "3px 8px", color: state.color, background: state.background, border: `1px solid ${state.color}33` }}>
                    {CONTRACTOR_ESTIMATE_STATE_LABELS[estimate.state]}
                  </span>
                  <span className="mono" style={{ fontSize: 12, color: T.muted }}>{fmt(estimate.total)}</span>
                </div>
                <div style={{ fontSize: 11, color: T.subtle, marginTop: 4 }}>
                  {estimate.lines.length} line{estimate.lines.length === 1 ? "" : "s"} · Estimate date {formatDate(estimate.quoteDate)}{estimate.validUntil ? ` · Valid through ${formatDate(estimate.validUntil)}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button type="button" className="btn-soft" onClick={() => openEstimate(estimate)} style={{ padding: "6px 10px", fontSize: 11 }}>
                  {canEdit ? "Edit" : "View"}
                </button>
                {canConvert && (
                  <button type="button" className="btn-accent" onClick={() => openEstimate(estimate)} style={{ padding: "6px 10px", fontSize: 11 }}>Convert</button>
                )}
                {estimate.state === "converted" && estimate.convertedInvoiceId && !isManager && (
                  <button
                    type="button"
                    className="btn-accent"
                    disabled={busy === "open"}
                    onClick={() => void openInvoice(estimate.convertedInvoiceId!)}
                    style={{ padding: "6px 10px", fontSize: 11, opacity: busy === "open" ? 0.65 : 1 }}
                  >{busy === "open" ? "Opening…" : "Open invoice"}</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {editor && (
        <Modal
          title={editor.quoteNum ? `Estimate #${editor.quoteNum}` : "Create estimate"}
          width={900}
          closeOnBackdrop={false}
          onClose={() => {
            if (busy) return;
            setEditor(null);
            setError("");
            setConfirmAction(null);
          }}
        >
          <style>{`
            .estimate-line-grid {
              display: grid;
              grid-template-columns: 145px minmax(180px, 1fr) 82px 112px 105px 36px;
              gap: 8px;
              align-items: end;
            }
            .estimate-mobile-label { display: none; }
            @media (max-width: 760px) {
              .estimate-header-grid { grid-template-columns: 1fr !important; }
              .estimate-line-grid {
                grid-template-columns: 1fr 1fr;
                padding: 12px;
                border: 1px solid ${T.borderSoft};
                border-radius: 12px;
                background: ${T.surfaceSoft};
              }
              .estimate-line-description { grid-column: 1 / -1; }
              .estimate-line-amount { align-self: center; }
              .estimate-mobile-label { display: block; font-size: 9px; font-weight: 700; color: ${T.subtle}; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; }
              .estimate-desktop-labels { display: none !important; }
              .estimate-footer { align-items: stretch !important; }
              .estimate-footer-actions { width: 100%; }
              .estimate-footer-actions button { flex: 1; }
            }
          `}</style>

          <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.55, marginBottom: 18 }}>
            {isManager
              ? `Contractor estimate for P1 Pros on work order ${workOrder.id}.`
              : `Estimate from ${currentUser?.company || currentUser?.name || "the assigned contractor"} to P1 Pros for work order ${workOrder.id}.`} This document is not an invoice and does not change billing or work-order status.
          </div>

          {editor.state !== "draft" && (
            <div style={{ padding: "11px 13px", marginBottom: 16, borderRadius: 10, color: editor.state === "converted" ? T.success : T.accent, background: editor.state === "converted" ? T.successSoft : T.accentSoft, border: `1px solid ${editor.state === "converted" ? T.success : T.accent}33`, fontSize: 12, lineHeight: 1.45 }}>
              {editor.state === "submitted"
                ? "This estimate is locked. Converting it creates one editable invoice draft; it does not submit the invoice."
                : "This estimate is locked because it has already been converted to an invoice draft."}
            </div>
          )}

          <div className="estimate-header-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
            <Field label="Estimate date">
              <Input type="date" value={editor.quoteDate} disabled={!editable} onChange={event => setEditor({ ...editor, quoteDate: event.target.value })} />
            </Field>
            <Field label="Valid until (optional)">
              <Input type="date" value={editor.validUntil} disabled={!editable} min={editor.quoteDate || undefined} onChange={event => setEditor({ ...editor, validUntil: event.target.value })} />
            </Field>
            <Field label="Terms">
              <Input value={editor.terms} disabled={!editable} maxLength={CONTRACTOR_ESTIMATE_MAX_TERMS_LENGTH} onChange={event => setEditor({ ...editor, terms: event.target.value })} />
            </Field>
          </div>

          <Field label="Notes / scope">
            <TA rows={3} value={editor.notes} disabled={!editable} maxLength={CONTRACTOR_ESTIMATE_MAX_NOTES_LENGTH} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setEditor({ ...editor, notes: event.target.value })} placeholder="Scope, exclusions, or estimate notes…" />
          </Field>

          <div style={{ marginTop: 18, marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: T.subtle, textTransform: "uppercase", letterSpacing: 0.8 }}>Line items</div>
            {editable && <button type="button" className="btn-soft" onClick={addLine} style={{ padding: "6px 11px", fontSize: 11 }}>+ Add line</button>}
          </div>

          <div className="estimate-line-grid estimate-desktop-labels" style={{ marginBottom: 6 }}>
            {["Type", "Description", "Qty", "Rate", "Amount", ""].map(label => (
              <div key={label} style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: T.subtle }}>{label}</div>
            ))}
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            {editor.lines.length === 0 ? (
              <div style={{ padding: "18px 14px", border: `1px dashed ${T.border}`, borderRadius: 12, color: T.subtle, fontSize: 12, textAlign: "center" }}>
                No line items yet.{editable ? " Add a line to begin the estimate." : ""}
              </div>
            ) : editor.lines.map((line, index) => (
              <div className="estimate-line-grid" key={`${editor.id || "new"}-${index}`}>
                <div>
                  <span className="estimate-mobile-label">Type</span>
                  <Sel value={line.type} disabled={!editable} onChange={(event: { target: { value: string } }) => updateLine(index, { type: event.target.value as ContractorEstimateLineType })}>
                    {CONTRACTOR_ESTIMATE_LINE_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                  </Sel>
                </div>
                <div className="estimate-line-description">
                  <span className="estimate-mobile-label">Description</span>
                  <Input value={line.description} disabled={!editable} maxLength={CONTRACTOR_ESTIMATE_MAX_DESCRIPTION_LENGTH} onChange={event => updateLine(index, { description: event.target.value })} placeholder={line.type === "Truck Charge" ? "Optional" : "Required when submitted"} />
                </div>
                <div>
                  <span className="estimate-mobile-label">Qty</span>
                  <Input type="number" inputMode="decimal" min="0.01" step="0.01" value={line.qty} disabled={!editable} onChange={event => updateLine(index, { qty: event.target.value })} />
                </div>
                <div>
                  <span className="estimate-mobile-label">Rate</span>
                  <Input type="number" inputMode="decimal" min="0" step="0.01" value={line.rate} disabled={!editable} onChange={event => updateLine(index, { rate: event.target.value })} placeholder="0.00" />
                </div>
                <div className="estimate-line-amount">
                  <span className="estimate-mobile-label">Amount</span>
                  <div className="mono" style={{ minHeight: 42, display: "flex", alignItems: "center", padding: "0 8px", fontSize: 12, fontWeight: 700, color: T.ink }}>{fmt(contractorEstimateLineAmount(line))}</div>
                </div>
                <button type="button" aria-label={`Remove line ${index + 1}`} disabled={!editable} onClick={() => setEditor({ ...editor, lines: editor.lines.filter((_, lineIndex) => lineIndex !== index) })} style={{ width: 36, minHeight: 42, border: `1px solid ${T.border}`, borderRadius: 10, background: T.surface, color: editable ? T.danger : T.subtle, cursor: editable ? "pointer" : "default", opacity: editable ? 1 : 0.45 }}>×</button>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
            <div style={{ width: 280, maxWidth: "100%", display: "grid", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12, color: T.muted }}><span>Subtotal</span><span className="mono">{fmt(totals?.subtotal || 0)}</span></div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 12, color: T.muted }}>Sales tax</span>
                <Input type="number" inputMode="decimal" min="0" step="0.01" value={editor.salesTax} disabled={!editable} onChange={event => setEditor({ ...editor, salesTax: event.target.value })} placeholder="0.00" style={{ textAlign: "right" }} />
              </div>
              <div style={{ paddingTop: 9, borderTop: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14, fontWeight: 800, color: T.ink }}><span>Estimate total</span><span className="mono">{fmt(totals?.total || 0)}</span></div>
            </div>
          </div>

          {error && (
            <div role="alert" style={{ marginTop: 16, padding: "10px 12px", borderRadius: 9, color: T.danger, background: T.dangerSoft, border: `1px solid ${T.danger}33`, fontSize: 12, lineHeight: 1.45 }}>{error}</div>
          )}

          {confirmAction && (
            <div style={{ marginTop: 16, padding: "12px 14px", borderRadius: 10, background: T.warnSoft, border: `1px solid ${T.warn}33` }}>
              <div style={{ fontSize: 12, color: "#73560C", lineHeight: 1.5 }}>
                {confirmAction === "submit"
                  ? "Submit and lock this estimate? It will remain outside invoicing and billing until you convert it."
                  : "Create one editable invoice draft from this estimate? The invoice will not be submitted and the work-order status will not change."}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                <button type="button" className="btn-soft" disabled={Boolean(busy)} onClick={() => setConfirmAction(null)}>Cancel</button>
                <button type="button" className="btn-primary" disabled={Boolean(busy)} onClick={() => confirmAction === "submit" ? void save(true) : void convert()}>
                  {busy === "submit" || busy === "convert" ? <><BtnSpinner />Working…</> : confirmAction === "submit" ? "Submit estimate" : "Create invoice draft"}
                </button>
              </div>
            </div>
          )}

          <div className="estimate-footer" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
            <div style={{ fontSize: 11, color: T.subtle }}>
              {editor.state === "draft" ? "Drafts and submitted estimates do not appear in invoice totals." : CONTRACTOR_ESTIMATE_STATE_LABELS[editor.state]}
            </div>
            <div className="estimate-footer-actions" style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn-soft" disabled={Boolean(busy)} onClick={() => setEditor(null)}>{editable ? "Cancel" : "Close"}</button>
              {editable && (
                <>
                  <button type="button" className="btn-soft" disabled={Boolean(busy)} onClick={() => void save(false)}>
                    {busy === "save" ? <><BtnSpinnerDark />Saving…</> : "Save draft"}
                  </button>
                  <button type="button" className="btn-accent" disabled={Boolean(busy)} onClick={() => { setError(""); setConfirmAction("submit"); }}>Submit estimate</button>
                </>
              )}
              {editor.state === "submitted" && canConvertContractorEstimate({ state: editor.state }, access) && (
                <button type="button" className="btn-accent" disabled={Boolean(busy)} onClick={() => { setError(""); setConfirmAction("convert"); }}>Convert to invoice</button>
              )}
              {editor.state === "converted" && editor.convertedInvoiceId && !isManager && (
                <button type="button" className="btn-accent" disabled={Boolean(busy)} onClick={() => void openInvoice(editor.convertedInvoiceId!)}>
                  {busy === "open" ? <><BtnSpinner />Opening…</> : "Open invoice"}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
