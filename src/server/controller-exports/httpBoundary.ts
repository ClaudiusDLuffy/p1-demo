import "server-only";
import { AppError } from "../../lib/errors/AppError";
import { currentRequestOperation } from "../../lib/server/requestOperation";
import { authorizeControllerExport, type ControllerExportContext } from "./controllerExportContext";
import { parseControllerExportGet, parseControllerExportStage, parseControllerExportTransition, readControllerExportBody } from "./contracts";
import { createControllerExportService, type ControllerExportApplicationService } from "./applicationService";
import { mapControllerExportHttp } from "./httpMapper";

export type ControllerExportHttpDependencies = {
  authorize(request: Request): Promise<ControllerExportContext>;
  createService(context: ControllerExportContext): ControllerExportApplicationService;
};
const production: ControllerExportHttpDependencies = { authorize: authorizeControllerExport, createService: createControllerExportService };
export async function handleControllerExportRequest(method: "GET" | "POST" | "PATCH", request: Request,
  dependencies: ControllerExportHttpDependencies = production): Promise<Response> {
  const authorized = await dependencies.authorize(request);
  const context = Object.freeze({ ...authorized, actor: Object.freeze({ ...authorized.actor }),
    requestId: currentRequestOperation()?.correlationId ?? authorized.requestId });
  const url = new URL(request.url);
  // Retain permission-before-input precedence for protected modes.
  if ((method !== "GET" || Boolean(url.searchParams.get("batch")?.trim())) && !context.actor.canHandoff) throw new AppError("FORBIDDEN");
  if (method === "GET") {
    const command = parseControllerExportGet(url);
    return mapControllerExportHttp(await dependencies.createService(context).list(command, context));
  }
  const body = await readControllerExportBody(request);
  if (method === "POST") {
    const command = parseControllerExportStage(body);
    return mapControllerExportHttp(await dependencies.createService(context).stage(command, context));
  }
  const command = parseControllerExportTransition(body);
  return mapControllerExportHttp(await dependencies.createService(context).transition(command, context));
}
