"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Modal } from "../../components/ui/Modal";
import { useUnsavedChangesGuard } from "../../lib/forms/useUnsavedChangesGuard";
import { reconcileDispatch } from "./api";
import { DISPATCH_REASON_LIMIT, safeDispatchError, type DispatchAction, type DispatchActionResult,
  type DispatchDelivery, type DispatchOperation } from "./contracts";

type Props = {
  delivery: DispatchDelivery;
  action: DispatchAction;
  onClose: () => void;
  onCommitted: (result: DispatchActionResult) => void;
  onConflict: () => void;
};

export default function DispatchReconciliationDialog({ delivery, action, onClose, onCommitted, onConflict }: Props) {
  const id = useId();
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const submitLock = useRef(false);
  const operation = useRef<DispatchOperation | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const resend = action === "resend";
  const title = resend ? "Confirm dispatch resend" : "Record contact another way";

  const dismissal = useUnsavedChangesGuard({ dirty: reason.length > 0 || confirmed, busy,
    onClose: () => { if (!submitLock.current) onClose(); } });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLock.current || conflicted) return;
    if (!reason.trim() || reason.trim().length > DISPATCH_REASON_LIMIT || !confirmed) {
      setError("Enter a reason and confirm this action.");
      return;
    }
    submitLock.current = true;
    setBusy(true);
    setError(null);
    // Preserve both the UUID and normalized payload after an unconfirmed response.
    operation.current ??= { deliveryId: delivery.id, assignmentVersion: delivery.assignmentVersion,
      operationId: crypto.randomUUID(), reason: reason.trim() };
    try {
      const result = await reconcileDispatch(action, operation.current);
      onCommitted(result);
      onClose();
    } catch (cause) {
      const failure = safeDispatchError(cause);
      setError(failure.message);
      setUncertain(failure.uncertain);
      if (!failure.uncertain) {
        setConflicted(true);
        onConflict();
      }
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  }

  return <><Modal title={title} description="Review the delivery state and confirm the intended action."
    onRequestClose={dismissal.requestClose} dismissDisabled={busy} initialFocusRef={reasonInput} width={540}>
    <form onSubmit={event => { void submit(event); }}>
      <p id={`${id}-guidance`}>
        {resend && delivery.state === "unknown"
          ? "Delivery could not be confirmed and the contractor may already have received the email. Resending can create a duplicate message. Enter a reason to continue."
          : resend ? "This queues a new dispatch attempt for the current contractor. The original delivery history will be preserved."
            : "Record that you contacted the contractor by telephone or another method. This does not mark the email as sent."}
      </p>
      <label htmlFor={`${id}-reason`}>{resend ? "Reason for resend" : "Contact note"} (required, up to 500 characters)</label>
      <textarea ref={reasonInput} id={`${id}-reason`} required maxLength={DISPATCH_REASON_LIMIT} rows={4}
        aria-describedby={`${id}-guidance${error ? ` ${id}-error` : ""}`} aria-invalid={Boolean(error)}
        disabled={busy || uncertain || conflicted} value={reason}
        onChange={event => { setReason(event.target.value); setConfirmed(false); setError(null); }}
        style={{ display: "block", width: "100%", margin: "8px 0 16px", padding: 8 }} />
      <label style={{ display: "flex", gap: 8, alignItems: "start" }}>
        <input type="checkbox" checked={confirmed} disabled={busy || uncertain || conflicted}
          onChange={event => setConfirmed(event.target.checked)} />
        {resend ? "I confirm that a new email attempt should be queued, including the risk of duplicate delivery."
          : "I confirm that the contractor was contacted another way."}
      </label>
      {error && <p id={`${id}-error`} role="alert">{error}</p>}
      {uncertain && <p>The original reason and request identity are locked for a safe retry. Cancelling does not undo a request that may have succeeded; review the status before starting another action.</p>}
      {conflicted && <p>Close this dialog and review the refreshed assignment and delivery status.</p>}
      <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
        <button type="button" className="btn-soft" disabled={busy} onClick={() => dismissal.requestClose("cancel_button")}>Cancel</button>
        <button type="submit" className="btn-primary"
          style={resend ? { background: "#9f1239", border: "1px solid #881337" } : undefined}
          disabled={busy || conflicted || !reason.trim() || !confirmed}>
          {busy ? "Saving…" : uncertain ? "Retry same request" : resend ? "Confirm resend" : "Confirm contact"}
        </button>
      </div>
      <span role="status" aria-live="polite">{busy ? "Saving your confirmed action." : ""}</span>
    </form>
  </Modal>{dismissal.dialog}</>;
}
