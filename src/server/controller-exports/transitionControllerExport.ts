import { AppError } from "../../lib/errors/AppError";
import type { ControllerExportContext } from "./controllerExportContext";
import type { ControllerExportTransitionCommand } from "./contracts";
import type { ControllerExportApplicationResult } from "./applicationResults";
import type { TransitionCommandRepository } from "./transitionCommandRepository";
import type { TransitionReconciliation } from "./transitionReconciliation";
import { mapControllerExportTransitionResult } from "./transitionResultMapper";

export interface ControllerExportTransitionDependencies {
  commands: TransitionCommandRepository; reconciliation: TransitionReconciliation;
}
export async function transitionControllerExport(command: ControllerExportTransitionCommand, context: ControllerExportContext,
  dependencies: ControllerExportTransitionDependencies): Promise<ControllerExportApplicationResult> {
  if (!context.actor.canHandoff) throw new AppError("FORBIDDEN");
  const captured = Object.freeze({ ...command });
  const result = await dependencies.commands.execute(captured);
  return mapControllerExportTransitionResult(result.status === "committed" || result.status === "replayed"
    ? result : await dependencies.reconciliation.resolve(captured, result));
}
