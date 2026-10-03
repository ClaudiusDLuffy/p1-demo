"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "../../components/ui/Modal";
import { TA } from "../../components/ui/TA";
import { useUnsavedChangesGuard } from "../../lib/forms/useUnsavedChangesGuard";
import { useWorkOrderByIdQuery } from "../work-orders/queries";
import { LinkedBillingInvoicePicker } from "./LinkedBillingInvoicePicker";
import { billingClosureUnavailableReason } from "./billingClosurePolicy";
import { createLinkedBillingAttempt } from "./linkedBillingCommands";
import { linkedBillingError, linkedBillingFieldsSchema, type LinkedBillingCandidate, type LinkedBillingReceipt } from "./linkedBillingContracts";
import { runLinkedBillingAttempt } from "./linkedBillingRepository";

const changedRoots = new Set(["work-orders", "work-order-pages", "work-order-count", "work-order-by-id",
  "work-order-details", "work-order-child-count", "portal-navigation-summary", "contractor-workload-summary", "linked-billing"]);

export function LinkedBillingModal({ workOrderId, onClose }: { workOrderId: string; onClose(): void }) {
  const work = useWorkOrderByIdQuery(workOrderId);
  const qc = useQueryClient(); const fieldId = useId();
  const [candidate, setCandidate] = useState<LinkedBillingCandidate | null>(null);
  const [note, setNote] = useState(""); const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false); const [receipt, setReceipt] = useState<LinkedBillingReceipt | null>(null);
  const sending = useRef(false); const attempt = useRef<ReturnType<typeof createLinkedBillingAttempt> | null>(null);
  const dismissal = useUnsavedChangesGuard({ dirty: !receipt && Boolean(candidate || note || confirmed), busy, scopeKey: workOrderId, onClose });
  const unavailable = work.data ? billingClosureUnavailableReason(work.data.status) : null;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || receipt) return;
    const parsed = linkedBillingFieldsSchema.safeParse({ candidate, note, coverageConfirmed: confirmed });
    if (!parsed.success) { setError(linkedBillingError(parsed.error).message); return; }
    if (!work.data) { setError("Wait for the current work order to load."); return; }
    // Unknown outcomes must be reconciled with the original operation, even if
    // the live work-order query already sees the committed closed status.
    if (!uncertain && unavailable) { setError(unavailable); return; }
    sending.current = true; setBusy(true); setError("");
    try {
      attempt.current ??= createLinkedBillingAttempt(work.data, parsed.data.candidate, parsed.data.note, parsed.data.coverageConfirmed);
      const saved = await runLinkedBillingAttempt(attempt.current);
      setReceipt(saved); setUncertain(false);
      void qc.invalidateQueries({ predicate: query => changedRoots.has(String(query.queryKey[0])) }).catch(() => undefined);
    } catch (cause) {
      const safe = linkedBillingError(cause); setError(safe.message); setUncertain(safe.uncertain);
      if (!safe.uncertain) attempt.current = null;
    } finally { sending.current = false; setBusy(false); }
  }
  return <>
    <Modal title="Billed under another work order" description={workOrderId} width={560} dismissDisabled={busy} onRequestClose={dismissal.requestClose}>
      {receipt ? <div className="space-y-4">
        <p role="status">This work order is closed and removed from Ready to Bill. Billing is recorded under {receipt.billingWorkOrderId}, portal invoice #{receipt.invoiceNumber}.</p>
        <p className="text-sm">Both histories show the link. No invoice or additional revenue was created, and 7-Eleven submission status was not changed.</p>
        <button type="button" className="btn-primary" onClick={onClose}>Done</button>
      </div> : <form noValidate className="space-y-4" onSubmit={save}>
        <p className="text-sm">Use this when an existing portal invoice on another work order already covers this work. This is not external billing and does not merge the jobs.</p>
        {work.isPending && <p role="status">Loading current work order…</p>}
        {work.isError && <p role="alert">The work order could not be loaded. <button type="button" className="btn-soft" onClick={() => void work.refetch()}>Retry loading</button></p>}
        {unavailable && !uncertain && <p className="text-sm">{unavailable}</p>}
        <LinkedBillingInvoicePicker sourceWorkOrderId={workOrderId} selected={candidate} disabled={busy || uncertain}
          onSelect={value => { setCandidate(value); setConfirmed(false); setError(""); }} />
        <fieldset disabled={busy || uncertain} className="min-w-0 space-y-3 disabled:opacity-70">
          <label htmlFor={`${fieldId}-note`} className="grid gap-1 text-sm">Audit note (required)
            <TA id={`${fieldId}-note`} className="w-full min-w-0" rows={3} minLength={5} maxLength={1000}
              value={note} onChange={event => { setNote(event.target.value); setError(""); }} />
          </label>
          <p className="text-xs">5–1,000 characters. Explain why billing is under the other work order.</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 shrink-0" checked={confirmed} disabled={!candidate || busy || uncertain}
              onChange={event => { setConfirmed(event.target.checked); setError(""); }} />
            <span>I confirm the selected submitted invoice covers this work order and no separate invoice is needed.</span>
          </label>
        </fieldset>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-soft" disabled={busy} onClick={() => dismissal.requestClose("cancel_button")}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || !work.data || work.isError || (!uncertain && Boolean(unavailable))}>
            {busy ? "Recording…" : uncertain ? "Retry same request" : "Link invoice and close"}
          </button>
        </div>
      </form>}
    </Modal>
    {dismissal.dialog}
  </>;
}
