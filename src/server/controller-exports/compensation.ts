/** Independent facts: an ambiguous upload is not a known failed stage or a cleaned object. */
export type ExportCompensationState = {
  archiveBuilt: boolean;
  upload: "not_dispatched" | "confirmed" | "known_failed" | "unknown";
  objectOwned: boolean;
  stage: "not_dispatched" | "confirmed" | "known_rejected" | "unknown";
  absenceConfirmed: boolean;
  cleanup: "not_attempted" | "confirmed" | "not_found" | "known_failed" | "unknown";
};
export type CompensationDecision =
  | { action: "return_success" }
  | { action: "cleanup_exact_object" }
  | { action: "retain_unknown" }
  | { action: "return_failure" };

export function decideCompensation(state: ExportCompensationState): CompensationDecision {
  if (state.stage === "confirmed") return { action: "return_success" };
  if (state.stage === "unknown" || state.upload === "unknown") return { action: "retain_unknown" };
  if (state.cleanup === "unknown" || state.cleanup === "known_failed") return { action: "retain_unknown" };
  if (state.cleanup === "confirmed" || state.cleanup === "not_found") return { action: "return_failure" };
  if (state.upload === "confirmed") return state.archiveBuilt && state.objectOwned
    && (state.stage === "not_dispatched" || (state.stage === "known_rejected" && state.absenceConfirmed))
    ? { action: "cleanup_exact_object" } : { action: "retain_unknown" };
  return { action: "return_failure" };
}
