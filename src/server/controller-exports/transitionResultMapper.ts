import type { ControllerExportApplicationResult } from "./applicationResults";
import type { TransitionCommandResult } from "./transitionCommandRepository";

export function mapControllerExportTransitionResult(result: TransitionCommandResult): ControllerExportApplicationResult {
  if (result.status === "committed" || result.status === "replayed") return { kind: "transition", batch: { ...result.receipt } };
  const outcome = result.status === "outcome_unknown" ? "unknown" : result.status === "known_rejected" ? "known_rejected" : "known_not_dispatched";
  if (result.status === "not_dispatched" && result.code === "REQUEST_ABORTED") return { kind: "failed", code: "REQUEST_ABORTED", status: 408, outcome };
  if (result.status === "known_rejected") {
    if (result.code === "42501") return { kind: "failed", code: "FORBIDDEN", status: 403, outcome };
    if (result.code === "P0002") return { kind: "failed", code: "NOT_FOUND", status: 404, outcome };
    if (result.code === "22023") return { kind: "failed", code: "INVALID_REQUEST", status: 400, outcome };
    if (result.code === "40001" || result.code === "55000") return { kind: "failed", code: "CONFLICT", status: 409, outcome };
  }
  return { kind: "failed", code: "INTERNAL_ERROR", status: 500, outcome };
}
