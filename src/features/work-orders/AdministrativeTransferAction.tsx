"use client";

import { useId, useState } from "react";
import { administrativeTransferRequestSchema } from "../../lib/workOrderAssignmentContracts";
import { VISIT_DURATION_REVIEW_MESSAGE } from "../../lib/visitDurationReview";

type Props = {
  contractorId: string | null;
  disabled: boolean;
  onTransfer: (reason: string, confirmed: boolean) => Promise<boolean>;
  onDirtyChange?: (dirty: boolean) => void;
};

// Separate opt-in action. Database authorization, visit/state checks and the
// server timestamp remain authoritative even when a paginated visit is unseen.
export default function AdministrativeTransferAction({ contractorId, disabled, onTransfer, onDirtyChange }: Props) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = administrativeTransferRequestSchema.safeParse({ contractorId, reason, confirmed }).success;
  const submit = async () => {
    if (busy || disabled || !valid) return;
    setBusy(true);
    setError("");
    try {
      if (!await onTransfer(reason.trim(), confirmed)) setError("Transfer was not completed. Review the message and keep these details until the outcome is confirmed.");
    } catch {
      setError("Transfer could not be confirmed. Retry unchanged or refresh and review the work order.");
    } finally { setBusy(false); }
  };
  return (
    <section style={{ marginTop: 16, padding: 12, border: "1px solid #D97706", borderRadius: 8 }}>
      <p style={{ fontSize: 12, marginTop: 0 }}>An open visit blocks normal reassignment or unassignment. Ask the current contractor or technician to check out first.</p>
      <button type="button" className="btn-soft" aria-expanded={expanded} aria-controls={id} disabled={disabled || busy} onClick={() => setExpanded(value => !value)}>
        Emergency staff close-and-transfer
      </button>
      {expanded && <div id={id} style={{ marginTop: 12, display: "grid", gap: 10 }}>
        <p role="note" style={{ fontSize: 12, margin: 0 }}>
          This closes the current visit at server time and {contractorId ? "transfers the assignment" : "unassigns the contractor"}. {VISIT_DURATION_REVIEW_MESSAGE} The receiving contractor must start a new visit; no check-in is created by this action.
        </p>
        <label htmlFor={`${id}-reason`}>Emergency transfer reason</label>
        <textarea id={`${id}-reason`} value={reason} maxLength={500} required rows={3} disabled={busy || disabled}
          onChange={event => { setReason(event.target.value); setConfirmed(false); onDirtyChange?.(event.target.value.length > 0); }} />
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12 }}>
          <input type="checkbox" checked={confirmed} disabled={busy || disabled} onChange={event => { setConfirmed(event.target.checked); onDirtyChange?.(reason.length > 0 || event.target.checked); }} />
          I explicitly confirm this emergency administrative closure and transfer. The elapsed duration remains unverified and requires review.
        </label>
        {error && <div role="alert">{error}</div>}
        <button type="button" className="btn-primary" disabled={!valid || disabled || busy} onClick={() => void submit()}>
          {busy ? "Closing visit and transferring..." : "Confirm administrative close and transfer"}
        </button>
      </div>}
    </section>
  );
}
