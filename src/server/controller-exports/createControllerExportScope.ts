import "server-only";
import { randomUUID } from "node:crypto";
import type { ControllerExportContext } from "./controllerExportContext";
import { createEligibilityRepository } from "./eligibilityRepository";
import { createHistoryRepository } from "./historyRepository";
import { createExportDocumentRepository } from "./exportDocumentRepository";
import { createArchiveBuilder } from "./archiveBuilder";
import { createExportStorage } from "./exportStorage";
import { createExportPackageBuilder } from "./buildExportArchive";
import { createSignedDownloadService } from "./signedDownloadService";
import { createStageCommandRepository } from "./stageCommandRepository";
import { createStageReconciliation } from "./stageReconciliation";
import { createTransitionCommandRepository } from "./transitionCommandRepository";
import { createTransitionReconciliation } from "./transitionReconciliation";
import { archiveFilename, controllerExportObjectPath } from "./snapshot";
import type { ControllerExportListDependencies } from "./listControllerExports";
import type { ControllerExportStageDependencies } from "./stageControllerExport";
import type { ControllerExportTransitionDependencies } from "./transitionControllerExport";

export type ControllerExportScope = {
  list: ControllerExportListDependencies;
  stage: ControllerExportStageDependencies;
  transition: ControllerExportTransitionDependencies;
};
export function createControllerExportScope(context: ControllerExportContext): ControllerExportScope {
  const { dataSession, signal } = context;
  const eligibility = createEligibilityRepository(dataSession, signal);
  const history = createHistoryRepository(context);
  const storage = createExportStorage(dataSession, signal);
  const documents = createExportDocumentRepository(dataSession, signal);
  return {
    list: { eligibility, history, downloads: createSignedDownloadService(history, storage), now: () => new Date() },
    stage: { eligibility, packages: createExportPackageBuilder(documents, createArchiveBuilder(signal), signal), storage,
      commands: createStageCommandRepository(context), reconciliation: createStageReconciliation(context),
      createAttempt() {
        const batchId = randomUUID();
        const date = new Date();
        return { batchId, objectPath: controllerExportObjectPath(batchId, date), filename: archiveFilename(batchId, "reference_manifest_v2", date) };
      } },
    transition: { commands: createTransitionCommandRepository(context), reconciliation: createTransitionReconciliation(context) },
  };
}
