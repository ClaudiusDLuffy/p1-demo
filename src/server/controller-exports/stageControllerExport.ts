import { AppError } from "../../lib/errors/AppError";
import type { ControllerExportStageCommand } from "./contracts";
import type { ControllerExportContext } from "./controllerExportContext";
import type { ControllerExportApplicationResult } from "./applicationResults";
import type { ControllerExportEligibilityRepository } from "./eligibilityRepository";
import type { ControllerExportPackageBuilder } from "./buildExportArchive";
import type { ControllerExportStorage, ControllerExportCleanupResult, ControllerExportObjectAttempt } from "./exportStorage";
import type { StageCommand, StageCommandRepository, StageCommandResult } from "./stageCommandRepository";
import type { StageReconciliation } from "./stageReconciliation";
import { decideCompensation, type ExportCompensationState } from "./compensation";
import { mapControllerExportStageFailure, mapControllerExportStageSuccess } from "./stageResultMapper";

export interface ControllerExportStageDependencies {
  eligibility: ControllerExportEligibilityRepository;
  packages: ControllerExportPackageBuilder;
  storage: ControllerExportStorage;
  commands: StageCommandRepository;
  reconciliation: StageReconciliation;
  createAttempt(): ControllerExportObjectAttempt & { filename: string };
}

/** Typed sequence only. Command and object ambiguity are separate facts throughout. */
export async function stageControllerExport(command: ControllerExportStageCommand, context: ControllerExportContext,
  dependencies: ControllerExportStageDependencies): Promise<ControllerExportApplicationResult> {
  if (!context.actor.canHandoff) throw new AppError("FORBIDDEN");
  context.signal?.throwIfAborted();
  const invoices = command.mode === "selected"
    ? await dependencies.eligibility.loadSelected(command.invoiceIds) : await dependencies.eligibility.loadAutomatic();
  const prepared = await dependencies.packages.prepare(invoices);
  context.signal?.throwIfAborted();
  const attempt = dependencies.createAttempt();
  const archive = await dependencies.packages.build(prepared);
  const save: StageCommand = Object.freeze({ batchId: attempt.batchId, actorId: context.actor.profileId, objectPath: attempt.objectPath,
    sources: Object.freeze(prepared.sources.map(source => Object.freeze({ ...source }))),
    archiveSha256: archive.sha256, archiveBytes: archive.byteLength, archiveFormat: "reference_manifest_v2" });
  let upload = await dependencies.storage.upload(attempt, archive.bytes);
  if (upload.status === "unknown") upload = await dependencies.storage.reconcileUpload(attempt, archive.sha256, archive.byteLength);
  const state: ExportCompensationState = { archiveBuilt: true, upload: upload.status,
    objectOwned: upload.ownership === "exact_attempt_object", stage: "not_dispatched", absenceConfirmed: false, cleanup: "not_attempted" };
  let cleanup: ControllerExportCleanupResult = { status: "not_attempted" };
  if (upload.status !== "confirmed") return mapControllerExportStageFailure({ stage: null, cleanup, state });
  const signed = await dependencies.storage.sign(attempt, attempt.filename);
  if (signed.status !== "confirmed") {
    if (decideCompensation(state).action === "cleanup_exact_object") cleanup = await dependencies.storage.cleanup(attempt);
    return mapControllerExportStageFailure({ stage: null, cleanup, state });
  }
  const dispatched = await dependencies.commands.execute(save);
  const result: StageCommandResult = dispatched.status === "committed" || dispatched.status === "replayed"
    ? dispatched : await dependencies.reconciliation.resolve(save, dispatched);
  if (result.status === "committed" || result.status === "replayed") {
    return mapControllerExportStageSuccess(save, attempt.filename, signed, result.status === "replayed");
  }
  state.stage = result.status === "known_rejected" ? "known_rejected"
    : result.status === "not_dispatched" ? "not_dispatched" : "unknown";
  state.absenceConfirmed = result.status === "known_rejected" && result.absenceConfirmed === true;
  if (decideCompensation(state).action === "cleanup_exact_object") cleanup = await dependencies.storage.cleanup(attempt);
  return mapControllerExportStageFailure({ stage: result, cleanup, state });
}
