"use client";

import { Modal } from "./Modal";
import type { DirtyPersistenceState } from "../../lib/forms/dismissal";

export type DiscardChangesDialogProps = {
  persistence: DirtyPersistenceState;
  pending?: boolean;
  failed?: boolean;
  onKeepEditing(): void;
  onDiscard(): void;
  onKeepDraft?: () => void;
};

export function DiscardChangesDialog({ persistence, pending = false, failed = false,
  onKeepEditing, onDiscard, onKeepDraft }: DiscardChangesDialogProps) {
  const canKeep = persistence === "dirty_persisted" && Boolean(onKeepDraft);
  return <Modal title="Unsaved changes" width={440}
    onRequestClose={() => { if (!pending) onKeepEditing(); }}
    closeOnBackdrop={false} dismissDisabled={pending}
    description={canKeep
      ? "Keep editing, close with your saved draft, or deliberately discard it. Signing out removes local drafts."
      : "These changes are not confirmed saved. Keep editing or deliberately discard them."}>
    {persistence === "dirty_persisting" && <p role="status">Draft save is still pending.</p>}
    {(persistence === "persist_failed" || failed) && <p role="alert">Draft recovery could not be confirmed. Keep editing and try again.</p>}
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
      <button type="button" className="btn-soft" data-modal-initial-focus="true"
        disabled={pending} onClick={onKeepEditing}>Keep editing</button>
      {canKeep && <button type="button" className="btn-soft" disabled={pending}
        onClick={onKeepDraft}>Close and keep draft</button>}
      <button type="button" className="btn-danger" data-destructive="true"
        disabled={pending} onClick={onDiscard}>{canKeep ? "Discard draft" : "Discard changes"}</button>
    </div>
  </Modal>;
}
