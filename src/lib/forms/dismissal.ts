export type ModalDismissReason =
  | "close_button" | "escape" | "backdrop" | "cancel_button"
  | "navigation" | "programmatic" | "submitted";

export type DirtyPersistenceState =
  | "clean" | "dirty_not_persisted" | "dirty_persisting"
  | "dirty_persisted" | "persist_failed";

export type DismissalDecision =
  | { action: "close" }
  | { action: "confirm_discard" }
  | { action: "confirm_keep_draft" }
  | { action: "blocked"; reason: "operation_in_flight" };

export function decideDismissal(input: {
  reason: ModalDismissReason; dirty: boolean; busy: boolean;
  persistence: DirtyPersistenceState;
}): DismissalDecision {
  // Only the authoritative success path may use submitted. Incidental close
  // requests must not turn a pending/unknown operation into a local discard.
  if (input.reason === "submitted") return { action: "close" };
  if (input.busy) return { action: "blocked", reason: "operation_in_flight" };
  if (!input.dirty) return { action: "close" };
  return { action: input.persistence === "dirty_persisted"
    ? "confirm_keep_draft" : "confirm_discard" };
}

export function needsUnloadWarning(dirty: boolean, persistence: DirtyPersistenceState): boolean {
  return dirty && persistence !== "dirty_persisted";
}
