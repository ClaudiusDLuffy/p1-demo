import type { ControllerExportGetCommand, ControllerExportStageCommand, ControllerExportTransitionCommand } from "./contracts";
import type { ControllerExportContext } from "./controllerExportContext";
import type { ControllerExportApplicationResult } from "./applicationResults";
import { createControllerExportScope, type ControllerExportScope } from "./createControllerExportScope";
import { listControllerExports } from "./listControllerExports";
import { stageControllerExport } from "./stageControllerExport";
import { transitionControllerExport } from "./transitionControllerExport";

export interface ControllerExportApplicationService {
  list(command: ControllerExportGetCommand, context: ControllerExportContext): Promise<ControllerExportApplicationResult>;
  stage(command: ControllerExportStageCommand, context: ControllerExportContext): Promise<ControllerExportApplicationResult>;
  transition(command: ControllerExportTransitionCommand, context: ControllerExportContext): Promise<ControllerExportApplicationResult>;
}
/** Request-scoped typed dispatch; no HTTP, query, archive, provider, or compensation implementation. */
export function createControllerExportService(context: ControllerExportContext,
  scope: ControllerExportScope = createControllerExportScope(context)): ControllerExportApplicationService {
  return Object.freeze({
    list: (command: ControllerExportGetCommand, authorized: ControllerExportContext) => listControllerExports(command, authorized, scope.list),
    stage: (command: ControllerExportStageCommand, authorized: ControllerExportContext) => stageControllerExport(command, authorized, scope.stage),
    transition: (command: ControllerExportTransitionCommand, authorized: ControllerExportContext) => transitionControllerExport(command, authorized, scope.transition),
  });
}
