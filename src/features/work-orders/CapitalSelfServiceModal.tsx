"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "../../components/ui/Modal";
import { useUnsavedChangesGuard } from "../../lib/forms/useUnsavedChangesGuard";
import { useWorkOrderByIdQuery } from "./queries";
import { useDirectoryActor } from "../directory/queries";
import { directoryActorScope } from "../../lib/counts/queryKeys";
import { closeOutAuditNote } from "../../lib/workOrderCloseOut";
import { capitalError, createCapitalAttempt, runCapitalAttempt, type CapitalReceipt, type CapitalSelfServiceAction } from "./capitalSelfService";

const titles: Record<CapitalSelfServiceAction, string> = { capital_external_handoff: "Record external capital quote",
  capital_confirmed_completion: "Confirm capital installation", capital_quote_revision: "Create capital quote revision" };
export function CapitalSelfServiceModal({ workOrderId, action, quote, onClose, onDone, guidedCloseOut = false }: {
  workOrderId: string; action: CapitalSelfServiceAction; quote?: { id: string; invoiceVersion: number };
  guidedCloseOut?: boolean;
  onClose(): void; onDone?(receipt: CapitalReceipt): void | Promise<void>;
}) {
  const work = useWorkOrderByIdQuery(workOrderId); const qc = useQueryClient(); const id = useId();
  const actor = useDirectoryActor();
  const scope = JSON.stringify([directoryActorScope(actor), workOrderId, action, quote?.id]);
  const session = useRef({ scope, generation: 0, mounted: true });
  if (session.current.scope !== scope) session.current = { scope, generation: session.current.generation + 1, mounted: true };
  useEffect(() => { session.current.mounted = true; return () => { session.current.mounted = false; session.current.generation++; }; }, []);
  const [note, setNote] = useState(""); const [reference, setReference] = useState("");
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [uncertain, setUncertain] = useState(false);
  const [receipt, setReceipt] = useState<CapitalReceipt | null>(null);
  const sending = useRef(false); const attempt = useRef<ReturnType<typeof createCapitalAttempt> | null>(null);
  const dismissal = useUnsavedChangesGuard({ dirty: !receipt && Boolean(note || reference || confirmed), busy, scopeKey: `${workOrderId}:${action}`, onClose });
  async function save(event: FormEvent) {
    event.preventDefault(); if (sending.current || receipt) return;
    if (!work.data) { setError("Wait for the current work order to load."); return; }
    let auditNote = note;
    try {
      if (guidedCloseOut && action !== "capital_quote_revision") auditNote = closeOutAuditNote(
        { id: workOrderId, workflowCycle: work.data.workflowCycle },
        action === "capital_external_handoff" ? "external_quote" : "capital_complete", note, reference);
    } catch { setError("Keep additional details to 350 characters and remove control characters."); return; }
    sending.current = true; setBusy(true); setError("");
    const generation = session.current.generation;
    const current = () => session.current.mounted && session.current.generation === generation && session.current.scope === scope;
    try {
      attempt.current ??= createCapitalAttempt(work.data, { action, note: auditNote, confirmed,
        ...(action === "capital_external_handoff" ? { reference } : {}),
        ...(action === "capital_quote_revision" ? { quoteId: quote?.id, invoiceVersion: quote?.invoiceVersion } : {}) });
      const saved = await runCapitalAttempt(attempt.current);
      if (!current()) return;
      setReceipt(saved); setUncertain(false);
      await qc.invalidateQueries({ predicate: query => /^(work-order|billing|portal-navigation|invoice)/.test(String(query.queryKey[0])) }).catch(() => undefined);
    } catch (cause) {
      if (!current()) return;
      const safe = capitalError(cause); setError(safe.message); setUncertain(safe.uncertain);
      if (!safe.uncertain) attempt.current = null;
    } finally { if (current()) { sending.current = false; setBusy(false); } }
  }
  return <><Modal title={titles[action]} description={workOrderId} width={550} dismissDisabled={busy} onRequestClose={dismissal.requestClose}>
    {receipt ? <div className="space-y-4">
      <p role="status">{action === "capital_confirmed_completion" ? "Installation recorded. This job has moved to final billing; it is not yet billed or closed."
        : action === "capital_external_handoff" ? "External quote reference recorded. No invoice was created. Capital installation can now be confirmed when finished."
          : "A separate draft revision was created. The original sent quote is unchanged. Review and submit the revision before completing installation."}</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" className="btn-primary" disabled={busy} onClick={async () => {
        setBusy(true); try { await onDone?.(receipt); onClose(); }
        catch { setError("The action saved, but the next screen could not open. Close this form and open the document from its history."); }
        finally { setBusy(false); }
      }}>{action === "capital_quote_revision" ? "Edit draft revision" : action === "capital_confirmed_completion" && onDone ? "Continue to final billing" : "Done"}</button>
    </div> : <form noValidate className="space-y-4" onSubmit={save}>
      <p className="text-sm">{action === "capital_external_handoff" ? "Use only when a P1 capital quote was sent and approved outside this portal. Record its real reference instead of creating a duplicate. This is not final customer billing."
        : action === "capital_confirmed_completion" ? "Confirm installation is finished. Active visits must be checked out first. The job leaves Active capital work and moves to final billing; existing quotes stay intact. Do not use Capital declined to clear completed work."
          : "Explain the requested changes. A new draft copies the quote’s lines and cost snapshot; the original sent quote and its contractor-source links stay intact. Final invoices and installed work cannot use this action."}</p>
      {work.isPending && <p role="status">Loading current work order…</p>}
      {work.isError && <p role="alert">Could not load the work order. <button type="button" onClick={() => void work.refetch()}>Retry</button></p>}
      <fieldset disabled={busy || uncertain} className="space-y-3">
        {action === "capital_external_handoff" && <label htmlFor={`${id}-ref`} className="grid gap-1 text-sm">Approved external quote reference (required)
          <input id={`${id}-ref`} className="input" maxLength={120} value={reference} onChange={e => setReference(e.target.value)} /></label>}
        <label htmlFor={`${id}-note`} className="grid gap-1 text-sm">{guidedCloseOut && action !== "capital_quote_revision" ? "Additional details (optional)" : "Audit note (required)"}
          <textarea id={`${id}-note`} className="input" rows={3} minLength={guidedCloseOut && action !== "capital_quote_revision" ? undefined : 5}
            maxLength={guidedCloseOut && action !== "capital_quote_revision" ? 350 : 1000} value={note} onChange={e => setNote(e.target.value)} /></label>
        {guidedCloseOut && action !== "capital_quote_revision" && <p className="text-xs">Your confirmed outcome and quote reference, when applicable, supply the audit note automatically.</p>}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
          <span>{action === "capital_external_handoff" ? "I confirm this quote was submitted and approved; the reference is correct."
            : action === "capital_confirmed_completion" ? "I confirm capital installation is finished and ready for final billing."
              : "I confirm a revised quote is needed, not another bill for the original work."}</span></label>
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex justify-end gap-2"><button type="button" className="btn-soft" disabled={busy} onClick={() => dismissal.requestClose("cancel_button")}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={busy || !work.data || work.isError}>{busy ? "Recording…" : uncertain ? "Retry same request" : titles[action]}</button></div>
    </form>}
  </Modal>{dismissal.dialog}</>;
}
