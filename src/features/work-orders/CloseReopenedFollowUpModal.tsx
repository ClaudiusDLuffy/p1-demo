"use client";

import { useState, type ChangeEvent } from "react";
import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { Field } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TA } from "../../components/ui/TA";
import { T } from "../../lib/constants";
import {
  FOLLOW_UP_CLOSE_REASON_MAX_LENGTH,
  normalizeFollowUpCloseReason,
  validateFollowUpCloseReason,
} from "../../lib/reopenedFollowUpClose";

type CloseReopenedFollowUpModalProps = {
  workOrderId: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<boolean>;
};

export default function CloseReopenedFollowUpModal({
  workOrderId,
  onClose,
  onConfirm,
}: CloseReopenedFollowUpModalProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const validationError = validateFollowUpCloseReason(reason);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const closed = await onConfirm(normalizeFollowUpCloseReason(reason));
      if (closed) {
        onClose();
      } else {
        setError("The follow-up was not closed. Refresh the work order, review its current state, and try again.");
      }
    } catch {
      setError("The close request could not be confirmed. Refresh the work order before trying again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      onClose={() => { if (!submitting) onClose(); }}
      closeOnBackdrop={!submitting}
      title="Close reopened follow-up"
      width={500}
    >
      <div style={{ fontSize: 13, color: T.muted, marginBottom: 16, lineHeight: 1.55 }}>
        Close <span className="mono" style={{ color: T.accent, fontWeight: 700 }}>{workOrderId}</span>{" "}
        <CopyWorkOrderButton value={workOrderId} /> with no additional billing for this follow-up?
      </div>

      <div role="note" style={{ padding: "11px 12px", borderRadius: 10, background: T.warnSoft, color: "#73560C", fontSize: 11, lineHeight: 1.5, marginBottom: 16 }}>
        Use this only when the reopened field work is finished and the prior 7-Eleven invoice already covers it. Existing contractor and P1 invoices will remain unchanged. Any open visit will be closed, and unresolved 7-Eleven or contractor-attention updates will block the action.
      </div>

      <Field label="Reason for no additional billing *">
        <TA
          autoFocus
          rows={3}
          maxLength={FOLLOW_UP_CLOSE_REASON_MAX_LENGTH}
          value={reason}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setReason(event.target.value);
            setError("");
          }}
          disabled={submitting}
          placeholder="Example: Replacement was included on the prior 7-Eleven invoice."
          aria-invalid={Boolean(error)}
        />
      </Field>
      <div style={{ marginTop: -8, marginBottom: 14, textAlign: "right", fontSize: 10, color: T.subtle }}>
        {reason.length}/{FOLLOW_UP_CLOSE_REASON_MAX_LENGTH}
      </div>

      {error && (
        <div role="alert" style={{ color: T.danger, background: T.dangerSoft, borderRadius: 9, padding: "9px 11px", fontSize: 11, marginBottom: 14 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button type="button" onClick={onClose} disabled={submitting} className="btn-soft">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
          className="btn-primary"
          style={{ opacity: submitting ? 0.7 : 1, cursor: submitting ? "default" : "pointer", display: "flex", alignItems: "center", gap: 6 }}
        >
          {submitting
            ? <><BtnSpinner />Closing...</>
            : "Close follow-up — no additional billing"}
        </button>
      </div>
    </Modal>
  );
}
