"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal } from "../../components/ui/Modal";
import { Input } from "../../components/ui/Input";
import { T } from "../../lib/constants";
import { useUnsavedChangesGuard } from "../../lib/forms/useUnsavedChangesGuard";
import { directoryActorScope } from "../../lib/counts/queryKeys";
import { useDirectoryActor } from "../directory/queries";
import { canRecordExternalBilling } from "../billing/externalBillingContracts";
import { useWorkOrderByIdQuery } from "./queries";
import { loadCapitalCloseOutEvidence } from "./capitalCloseOutEvidence";
import { workOrderCloseOutOptions } from "../../lib/workOrderCloseOut";
import { capitalCloseOutError, createCapitalCloseOutAttempt, runCapitalCloseOutAttempt, validateCapitalCloseOutForm,
  type CapitalCloseOutField, type CapitalCloseOutFieldError, type CapitalCloseOutOutcome, type CapitalCloseOutReceipt } from "./capitalCloseOut";

export type CapitalCloseOutDocument = {
  id: string; num: string; state: string; documentKind?: string; invoiceVersion: number;
  updatedAt?: string; createdAt?: string; submissionRecorded?: boolean;
};
type Props = {
  workOrderId: string; documents: readonly CapitalCloseOutDocument[]; hasCompleteEvidence: boolean;
  billedBlocker?: string; completionBlocker?: string;
  onReviewDocument(documentId: string | null): void;
  onClose(): void; onDone?(outcome: CapitalCloseOutOutcome): void;
};

/** One confirmation screen. Submission is an attestation, never a provider call. */
export function CapitalCloseOutModal(props: Props) {
  const { workOrderId, onClose } = props;
  const actor = useDirectoryActor(); const qc = useQueryClient(); const id = useId();
  const work = useWorkOrderByIdQuery(workOrderId);
  const scope = JSON.stringify([directoryActorScope(actor), workOrderId]);
  const history = useQuery({
    queryKey: ["capital-close-out-evidence", scope, work.data?.lifecycleVersion, work.data?.updatedAt],
    queryFn: ({ signal }) => loadCapitalCloseOutEvidence(work.data!, signal),
    enabled: !props.hasCompleteEvidence && work.data?.id === workOrderId && canRecordExternalBilling(actor),
    staleTime: 0, retry: false,
  });
  const loadedHistory = props.hasCompleteEvidence || history.isError || history.isFetching ? undefined : history.data;
  const hasCompleteEvidence = props.hasCompleteEvidence || Boolean(loadedHistory);
  const checkedOptions = loadedHistory && work.data ? workOrderCloseOutOptions({
    workOrder: { ...work.data, visits: loadedHistory.visits,
      hasPendingSevenElevenSync: work.data.hasPendingSevenElevenSync || loadedHistory.hasPendingSevenElevenSync,
      hasPendingContractorAttention: work.data.hasPendingContractorAttention || loadedHistory.hasPendingContractorAttention },
    hasCompleteEvidence: true, hasCurrentInvoice: false, hasStaffDocuments: loadedHistory.documents.length > 0,
    hasAnyDocuments: loadedHistory.documents.length > 0,
    hasUnresolvedContractorInvoices: loadedHistory.hasUnresolvedContractorInvoices, canCloseFollowUp: false,
  }) : null;
  const session = useRef({ scope, generation: 0, mounted: true });
  if (session.current.scope !== scope) session.current = { scope, generation: session.current.generation + 1, mounted: true };
  useEffect(() => { session.current.mounted = true; return () => { session.current.mounted = false; session.current.generation++; }; }, []);
  const [outcome, setOutcome] = useState<CapitalCloseOutOutcome>("billed");
  const [documentId, setDocumentId] = useState("");
  const [invoiceReference, setInvoiceReference] = useState<string | null>(null);
  const [quoteReference, setQuoteReference] = useState(""); const [billedOn, setBilledOn] = useState("");
  const [markQuoteSubmitted, setMarkQuoteSubmitted] = useState(false);
  const [busy, setBusy] = useState(false); const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(""); const [receipt, setReceipt] = useState<CapitalCloseOutReceipt | null>(null);
  const [fieldError, setFieldError] = useState<CapitalCloseOutFieldError | null>(null);
  const quoteInput = useRef<HTMLInputElement>(null); const submissionInput = useRef<HTMLInputElement>(null);
  const invoiceInput = useRef<HTMLInputElement>(null); const dateInput = useRef<HTMLInputElement>(null);
  const fieldFeedbackRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!fieldError) return;
    // Run after the inline message has committed; its height can change the
    // scrollable dialog. Keep both the control and its explanation in view.
    const control = { quoteReference: quoteInput, markQuoteSubmitted: submissionInput,
      invoiceReference: invoiceInput, billedOn: dateInput }[fieldError.field].current;
    control?.focus(); control?.scrollIntoView({ block: "center" });
    fieldFeedbackRef.current?.scrollIntoView({ block: "nearest" });
  }, [fieldError]);
  const sending = useRef(false); const attempt = useRef<ReturnType<typeof createCapitalCloseOutAttempt> | null>(null);
  const attemptScope = useRef<string | null>(null);
  const reconciling = uncertain && attempt.current !== null && attemptScope.current === scope;
  const sorted = [...(loadedHistory?.documents ?? props.documents)].sort((a, b) => Number(b.documentKind === "invoice") - Number(a.documentKind === "invoice")
    || Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""));
  const document = documentId ? sorted.find(row => row.id === documentId) : sorted[0];
  const needsSubmission = !document || (document.documentKind === "capital_quote"
    && (!document.submissionRecorded || !["approved", "paid"].includes(document.state)));
  const reference = invoiceReference ?? document?.num ?? "";
  const checkedCompletion = checkedOptions?.find(option => option.action === "capital_to_billing");
  const checkedBilling = checkedOptions?.find(option => option.action === "capital_billed");
  const changedCapital = "This capital changed. Close and reopen the form to review its current status.";
  const completionBlocker = checkedOptions ? checkedCompletion ? checkedCompletion.blocked : changedCapital : props.completionBlocker;
  const billedBlocker = checkedOptions ? checkedBilling ? checkedBilling.blocked : changedCapital : props.billedBlocker;
  const blocker = completionBlocker || (outcome === "billed" ? billedBlocker : undefined);
  const dirty = !receipt && Boolean(outcome !== "billed" || documentId || invoiceReference !== null || quoteReference || billedOn || markQuoteSubmitted);
  const dismissal = useUnsavedChangesGuard({ dirty, busy, scopeKey: scope, onClose });
  const clearFieldError = (field: CapitalCloseOutField) => {
    setFieldError(current => current?.field === field ? null : current); setError("");
  };
  const inputStyle = (field: CapitalCloseOutField) => ({ minHeight: 44, fontSize: 16,
    borderColor: fieldError?.field === field ? T.danger : T.muted });
  const fieldFeedback = (field: CapitalCloseOutField) => fieldError?.field === field
    ? <p ref={fieldFeedbackRef} id={`${id}-${field}-error`} role="alert" className="text-sm text-red-700">{fieldError.message}</p> : null;
  const describedBy = (field: CapitalCloseOutField, hint?: string) =>
    [hint, fieldError?.field === field ? `${id}-${field}-error` : null].filter(Boolean).join(" ") || undefined;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (sending.current || receipt || !canRecordExternalBilling(actor)) return;
    if (attempt.current && attemptScope.current !== scope) {
      setError("The account or work order changed. Close and reopen this form before continuing."); return;
    }
    if (!reconciling && (!work.data || work.data.id !== workOrderId || work.isError || !hasCompleteEvidence || blocker)) {
      setError(blocker || "Load the complete current work order, invoice, and activity history first."); return;
    }
    if (!reconciling) {
      const invalid = validateCapitalCloseOutForm({ outcome, needsSubmission, hasDocument: Boolean(document),
        markQuoteSubmitted, quoteReference, invoiceReference: reference, billedOn });
      if (invalid) {
        setError(""); setFieldError(invalid);
        return;
      }
    }
    sending.current = true; setBusy(true); setError(""); setFieldError(null);
    const generation = session.current.generation;
    const current = () => session.current.mounted && session.current.generation === generation && session.current.scope === scope;
    try {
      if (!attempt.current) {
        attempt.current = createCapitalCloseOutAttempt(work.data, {
        outcome, confirmed: true, documentId: document?.id ?? null, invoiceVersion: document?.invoiceVersion ?? null,
        markQuoteSubmitted: needsSubmission && markQuoteSubmitted,
        quoteReference: document ? "" : quoteReference,
        invoiceReference: outcome === "billed" ? reference : "", billedOn: outcome === "billed" ? billedOn : null,
        });
        attemptScope.current = scope;
      }
      const saved = await runCapitalCloseOutAttempt(attempt.current);
      if (!current()) return;
      setReceipt(saved); setUncertain(false);
      // A confirmed save is not downgraded by a later refresh/navigation failure.
      void qc.invalidateQueries({ predicate: query => /^(work-order|billing|portal-navigation|invoice|external-billing)/.test(String(query.queryKey[0])) }).catch(() => undefined);
      try { props.onDone?.(saved.outcome); onClose(); }
      catch { setError("The outcome saved, but navigation failed. Close this form and open History or billing; do not submit again."); }
    } catch (cause) {
      if (!current()) return;
      const safe = capitalCloseOutError(cause); setError(safe.message); setUncertain(safe.uncertain);
      if (!safe.uncertain) { attempt.current = null; attemptScope.current = null; }
    } finally { if (current()) { sending.current = false; setBusy(false); } }
  }
  if (!canRecordExternalBilling(actor)) return null;
  return <><Modal title="Close out capital" description={workOrderId} width={560} contentStyle={{ width: "100%", padding: 20 }} dismissDisabled={busy} onRequestClose={dismissal.requestClose}>
    {receipt ? <div className="space-y-3"><p role="status">{receipt.outcome === "billed" ? "Completed and billed. Moved to History." : "Completed and sent to billing. This job remains open until billed."}</p>
      {error && <p role="alert">{error}</p>}<button type="button" className="btn-primary" onClick={onClose}>Done</button></div>
      : <form noValidate onSubmit={save} className="space-y-4">
        <fieldset disabled={busy || uncertain} className="min-w-0 space-y-3">
          <legend className="mb-2 text-sm font-semibold">The capital job is finished</legend>
          <label className="flex items-start gap-2 rounded-lg border p-3"><input type="radio" name={`${id}-outcome`} value="billed" checked={outcome === "billed"}
            onChange={() => { setOutcome("billed"); setError(""); setFieldError(null); }} /><span><strong>Completed and billed</strong><span className="block text-sm">Move straight to History using the existing bill.</span></span></label>
          <label className="flex items-start gap-2 rounded-lg border p-3"><input type="radio" name={`${id}-outcome`} value="send_to_billing" checked={outcome === "send_to_billing"}
            onChange={() => { setOutcome("send_to_billing"); setError(""); setFieldError(null); }} /><span><strong>Completed, send to billing</strong><span className="block text-sm">Only if it has not been billed yet. Keep it open in billing.</span></span></label>
          {sorted.length > 1 && <label className="grid gap-1 text-sm" htmlFor={`${id}-document`}>Existing quote or invoice
            <select id={`${id}-document`} className="input" value={document?.id ?? ""} onChange={event => {
              setDocumentId(event.target.value); setInvoiceReference(null); setMarkQuoteSubmitted(false); setError(""); setFieldError(null);
            }}>{sorted.map(row => <option key={row.id} value={row.id}>{row.num} ({row.documentKind === "capital_quote" ? "quote" : "invoice"}, {row.state})</option>)}</select></label>}
          {document && <p className="text-sm">Using {document.documentKind === "capital_quote" ? "quote" : "invoice"} #{document.num}.</p>}
          {needsSubmission && <div className="space-y-2 rounded-lg border p-3">
            {!document && <>
              <p id={`${id}-quote-help`} className="text-sm">No P1 quote is attached. Enter the real approved quote reference from 7-Eleven here, not the billed invoice reference.</p>
              <label className="grid min-w-0 gap-2 text-sm font-semibold" htmlFor={`${id}-quote`}>Quote reference in 7-Eleven (required)
                <Input ref={quoteInput} id={`${id}-quote`} className="w-full min-w-0" style={inputStyle("quoteReference")}
                  required maxLength={100} placeholder="Enter the approved quote reference" value={quoteReference}
                  aria-invalid={fieldError?.field === "quoteReference" || undefined} aria-describedby={describedBy("quoteReference", `${id}-quote-help`)}
                  onChange={event => { setQuoteReference(event.target.value); clearFieldError("quoteReference"); }} /></label>
              {fieldFeedback("quoteReference")}
            </>}
            <label className="flex items-start gap-2 text-sm"><input ref={submissionInput} id={`${id}-submitted`} type="checkbox" required checked={markQuoteSubmitted}
              aria-invalid={fieldError?.field === "markQuoteSubmitted" || undefined} aria-describedby={describedBy("markQuoteSubmitted")}
              onChange={event => { setMarkQuoteSubmitted(event.target.checked); clearFieldError("markQuoteSubmitted"); }} />
              <span>{document ? "Mark this quote submitted now. I already submitted it in 7-Eleven." : "I confirm this external quote was submitted and approved in 7-Eleven."}</span></label>
            {fieldFeedback("markQuoteSubmitted")}
            <p className="text-xs">This records the actual submission in P1. It does not send anything to 7-Eleven.</p>
          </div>}
          {outcome === "billed" && <>
            <label className="grid min-w-0 gap-2 text-sm font-semibold" htmlFor={`${id}-invoice`}>Existing billed invoice reference (required)
              <Input ref={invoiceInput} id={`${id}-invoice`} className="w-full min-w-0" style={inputStyle("invoiceReference")}
                required maxLength={100} placeholder="Enter the existing billed invoice reference" value={reference}
                aria-invalid={fieldError?.field === "invoiceReference" || undefined} aria-describedby={describedBy("invoiceReference", `${id}-invoice-help`)}
                onChange={event => { setInvoiceReference(event.target.value); clearFieldError("invoiceReference"); }} /></label>
            <p id={`${id}-invoice-help`} className="text-xs">Use the invoice that already billed this job. A quote reference alone does not confirm billing.</p>
            {fieldFeedback("invoiceReference")}
            <label className="grid min-w-0 gap-2 text-sm font-semibold" htmlFor={`${id}-date`}>Actual billing date (required)
              <Input ref={dateInput} id={`${id}-date`} className="w-full min-w-0" style={inputStyle("billedOn")}
                required type="date" value={billedOn} aria-invalid={fieldError?.field === "billedOn" || undefined}
                aria-describedby={describedBy("billedOn")}
                onChange={event => { setBilledOn(event.target.value); clearFieldError("billedOn"); }} /></label>
            {fieldFeedback("billedOn")}
          </>}
        </fieldset>
        {!hasCompleteEvidence && <div className="space-y-2" aria-live="polite">
          {history.isError ? <><p role="alert" className="text-sm text-red-700">The complete history could not be checked. Nothing was changed. Retry before closing.</p>
            <button type="button" className="btn-soft min-h-11" disabled={busy || uncertain || history.isFetching}
              onClick={() => void history.refetch()}>Retry history check</button></>
            : <p role="status">Checking invoice, activity and visit history automatically…</p>}
        </div>}
        {work.isPending && <p role="status">Loading current capital…</p>}
        {work.isError && <p role="alert">The capital could not load. <button type="button" disabled={busy} onClick={() => void work.refetch()}>Retry loading</button></p>}
        {blocker && hasCompleteEvidence && <p role="status" className="text-sm text-amber-800">{blocker}</p>}
        <p className="text-sm">{outcome === "billed" ? "By confirming, you attest the job is complete and already billed using this reference and date." : "By confirming, you attest the job is complete but still needs billing."} No new invoice or CSV export is created.</p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          {document && <button type="button" className="btn-soft" disabled={busy || uncertain} onClick={() => props.onReviewDocument(document.id)}>Review existing document</button>}
          <button type="button" className="btn-soft" disabled={busy} onClick={() => dismissal.requestClose("cancel_button")}>Cancel</button>
          <button type="submit" className="btn-primary min-h-11" disabled={busy || (!reconciling && (!work.data || work.isError || !hasCompleteEvidence || Boolean(blocker)))}>
            {busy ? "Recording…" : uncertain ? "Retry same request" : outcome === "billed" ? "Close and send to History" : "Confirm send to billing"}</button>
        </div>
      </form>}
  </Modal>{dismissal.dialog}</>;
}
