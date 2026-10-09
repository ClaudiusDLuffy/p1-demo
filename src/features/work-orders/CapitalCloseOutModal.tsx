"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "../../components/ui/Modal";
import { useUnsavedChangesGuard } from "../../lib/forms/useUnsavedChangesGuard";
import { directoryActorScope } from "../../lib/counts/queryKeys";
import { useDirectoryActor } from "../directory/queries";
import { canRecordExternalBilling } from "../billing/externalBillingContracts";
import { useWorkOrderByIdQuery } from "./queries";
import { capitalCloseOutError, createCapitalCloseOutAttempt, runCapitalCloseOutAttempt,
  type CapitalCloseOutOutcome, type CapitalCloseOutReceipt } from "./capitalCloseOut";

export type CapitalCloseOutDocument = {
  id: string; num: string; state: string; documentKind?: string; invoiceVersion: number;
  updatedAt?: string; createdAt?: string; submissionRecorded?: boolean;
};
type Props = {
  workOrderId: string; documents: readonly CapitalCloseOutDocument[]; hasCompleteEvidence: boolean;
  billedBlocker?: string; completionBlocker?: string;
  canLoadMoreHistory?: boolean; historyLoading?: boolean; onLoadMoreHistory?(): Promise<void>;
  onReviewDocument(documentId: string | null): void;
  onClose(): void; onDone?(outcome: CapitalCloseOutOutcome): void;
};

/** One confirmation screen. Submission is an attestation, never a provider call. */
export function CapitalCloseOutModal(props: Props) {
  const { workOrderId, onClose } = props;
  const actor = useDirectoryActor(); const qc = useQueryClient(); const id = useId();
  const work = useWorkOrderByIdQuery(workOrderId);
  const scope = JSON.stringify([directoryActorScope(actor), workOrderId]);
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
  const sending = useRef(false); const attempt = useRef<ReturnType<typeof createCapitalCloseOutAttempt> | null>(null);
  const attemptScope = useRef<string | null>(null);
  const reconciling = uncertain && attempt.current !== null && attemptScope.current === scope;
  const sorted = [...props.documents].sort((a, b) => Number(b.documentKind === "invoice") - Number(a.documentKind === "invoice")
    || Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""));
  const document = documentId ? sorted.find(row => row.id === documentId) : sorted[0];
  const needsSubmission = !document || (document.documentKind === "capital_quote"
    && (!document.submissionRecorded || !["approved", "paid"].includes(document.state)));
  const reference = invoiceReference ?? document?.num ?? "";
  const blocker = props.completionBlocker || (outcome === "billed" ? props.billedBlocker : undefined);
  const dirty = !receipt && Boolean(outcome !== "billed" || documentId || invoiceReference !== null || quoteReference || billedOn || markQuoteSubmitted);
  const dismissal = useUnsavedChangesGuard({ dirty, busy, scopeKey: scope, onClose });
  async function save(event: FormEvent) {
    event.preventDefault();
    if (sending.current || receipt || !canRecordExternalBilling(actor)) return;
    if (attempt.current && attemptScope.current !== scope) {
      setError("The account or work order changed. Close and reopen this form before continuing."); return;
    }
    if (!reconciling && (!work.data || work.data.id !== workOrderId || work.isError || !props.hasCompleteEvidence || blocker)) {
      setError(blocker || "Load the complete current work order, invoice, and activity history first."); return;
    }
    if (!reconciling && needsSubmission && (!markQuoteSubmitted || (!document && !quoteReference.trim()))) {
      setError("Confirm the actual quote submission here before closing out the capital."); return;
    }
    sending.current = true; setBusy(true); setError("");
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
  return <><Modal title="Close out capital" description={workOrderId} width={560} dismissDisabled={busy} onRequestClose={dismissal.requestClose}>
    {receipt ? <div className="space-y-3"><p role="status">{receipt.outcome === "billed" ? "Completed and billed. Moved to History." : "Completed and sent to billing. This job remains open until billed."}</p>
      {error && <p role="alert">{error}</p>}<button type="button" className="btn-primary" onClick={onClose}>Done</button></div>
      : <form noValidate onSubmit={save} className="space-y-4">
        <fieldset disabled={busy || uncertain} className="space-y-3">
          <legend className="mb-2 text-sm font-semibold">The capital job is finished</legend>
          <label className="flex items-start gap-2 rounded-lg border p-3"><input type="radio" name={`${id}-outcome`} value="billed" checked={outcome === "billed"}
            onChange={() => { setOutcome("billed"); setError(""); }} /><span><strong>Completed and billed</strong><span className="block text-sm">Move straight to History using the existing bill.</span></span></label>
          <label className="flex items-start gap-2 rounded-lg border p-3"><input type="radio" name={`${id}-outcome`} value="send_to_billing" checked={outcome === "send_to_billing"}
            onChange={() => { setOutcome("send_to_billing"); setError(""); }} /><span><strong>Completed, send to billing</strong><span className="block text-sm">Only if it has not been billed yet. Keep it open in billing.</span></span></label>
          {sorted.length > 1 && <label className="grid gap-1 text-sm" htmlFor={`${id}-document`}>Existing quote or invoice
            <select id={`${id}-document`} className="input" value={document?.id ?? ""} onChange={event => {
              setDocumentId(event.target.value); setInvoiceReference(null); setMarkQuoteSubmitted(false); setError("");
            }}>{sorted.map(row => <option key={row.id} value={row.id}>{row.num} ({row.documentKind === "capital_quote" ? "quote" : "invoice"}, {row.state})</option>)}</select></label>}
          {document && <p className="text-sm">Using {document.documentKind === "capital_quote" ? "quote" : "invoice"} #{document.num}.</p>}
          {needsSubmission && <div className="space-y-2 rounded-lg border p-3">
            {!document && <label className="grid gap-1 text-sm" htmlFor={`${id}-quote`}>Quote reference in 7-Eleven
              <input id={`${id}-quote`} className="input" maxLength={100} value={quoteReference} onChange={event => setQuoteReference(event.target.value)} /></label>}
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={markQuoteSubmitted} onChange={event => setMarkQuoteSubmitted(event.target.checked)} />
              <span>{document ? "Mark this quote submitted now. I already submitted it in 7-Eleven." : "I confirm this external quote was submitted and approved in 7-Eleven."}</span></label>
            <p className="text-xs">This records the actual submission in P1. It does not send anything to 7-Eleven.</p>
          </div>}
          {outcome === "billed" && <>
            <label className="grid gap-1 text-sm" htmlFor={`${id}-invoice`}>Existing billed invoice reference
              <input id={`${id}-invoice`} className="input" maxLength={100} value={reference} onChange={event => setInvoiceReference(event.target.value)} /></label>
            <label className="grid gap-1 text-sm" htmlFor={`${id}-date`}>Actual billing date
              <input id={`${id}-date`} className="input" type="date" value={billedOn} onChange={event => setBilledOn(event.target.value)} /></label>
          </>}
        </fieldset>
        {!props.hasCompleteEvidence && <div className="space-y-2"><p role="status">Complete invoice and activity history is needed to avoid duplicate billing.</p>
          {props.canLoadMoreHistory && props.onLoadMoreHistory && <button type="button" className="btn-soft" disabled={busy || uncertain || props.historyLoading}
            onClick={async () => { try { await props.onLoadMoreHistory?.(); } catch { setError("History could not load. Retry before confirming."); } }}>
            {props.historyLoading ? "Loading history…" : "Load more close-out history"}</button>}</div>}
        {work.isPending && <p role="status">Loading current capital…</p>}
        {work.isError && <p role="alert">The capital could not load. <button type="button" disabled={busy} onClick={() => void work.refetch()}>Retry loading</button></p>}
        {blocker && <p role="status" className="text-sm text-amber-800">{blocker}</p>}
        <p className="text-sm">{outcome === "billed" ? "By confirming, you attest the job is complete and already billed using this reference and date." : "By confirming, you attest the job is complete but still needs billing."} No new invoice or CSV export is created.</p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          {document && <button type="button" className="btn-soft" disabled={busy || uncertain} onClick={() => props.onReviewDocument(document.id)}>Review existing document</button>}
          <button type="button" className="btn-soft" disabled={busy} onClick={() => dismissal.requestClose("cancel_button")}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || (!reconciling && (!work.data || work.isError || !props.hasCompleteEvidence || Boolean(blocker)))}>
            {busy ? "Recording…" : uncertain ? "Retry same request" : outcome === "billed" ? "Confirm completed and billed" : "Confirm send to billing"}</button>
        </div>
      </form>}
  </Modal>{dismissal.dialog}</>;
}
