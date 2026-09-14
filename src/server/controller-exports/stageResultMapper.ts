import type { ControllerExportApplicationResult } from "./applicationResults";
import type { StageCommand, StageCommandResult } from "./stageCommandRepository";
import type { ControllerExportSignedResult, ControllerExportCleanupResult } from "./exportStorage";
import type { ExportCompensationState } from "./compensation";

/** Pure compatibility projection; unknown outcomes do not become a public success or rollback claim. */
export function mapControllerExportStageSuccess(command: StageCommand, filename: string,
  signed: Extract<ControllerExportSignedResult, { status: "confirmed" }>, replayed: boolean): ControllerExportApplicationResult {
  return { kind: "staged", replayed, body: { batchId: command.batchId, status: "pending", downloadUrl: signed.url,
    filename, format: "reference_manifest_v2", archiveSha256: command.archiveSha256, archiveBytes: command.archiveBytes } };
}

export function mapControllerExportStageFailure(input: {
  stage: Exclude<StageCommandResult, { status: "committed" | "replayed" }> | null;
  cleanup: ControllerExportCleanupResult; state: ExportCompensationState;
}): ControllerExportApplicationResult {
  const compensation = { ...input.state, cleanup: input.cleanup.status };
  const outcome = input.stage?.status === "outcome_unknown" ? "unknown"
    : input.stage?.status === "known_rejected" ? "known_rejected" : "known_not_dispatched";
  if (input.stage?.status === "known_rejected" && input.stage.absenceConfirmed
    && (input.cleanup.status === "confirmed" || input.cleanup.status === "not_found")) {
    return { kind: "failed", code: "CONFLICT", status: 409, outcome, compensation };
  }
  if (input.stage?.status === "not_dispatched" && input.stage.code === "REQUEST_ABORTED") {
    return { kind: "failed", code: "REQUEST_ABORTED", status: 408, outcome, compensation };
  }
  return { kind: "failed", code: "INTERNAL_ERROR", status: 500, outcome, compensation };
}
