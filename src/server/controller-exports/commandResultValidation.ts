import { z } from "zod";
import { errorData } from "../../lib/errors/errorData";

export const controllerUuid = z.string().uuid();
export const controllerTimestamp = z.string().datetime({ offset: true });
export const controllerCount = z.number().int().min(1).max(500);
export const controllerTotal = z.number().finite();
export const controllerArchiveBytes = z.number().int().min(1).max(100 * 1024 * 1024);
export const controllerFingerprint = z.string().regex(/^[0-9a-f]{64}$/);

export function sameControllerUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Existing server-generated Storage identity: UTC calendar day / this exact batch UUID. */
export function validControllerBatchObjectPath(batchId: string, objectPath: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})\/([^/]+)\.zip$/.exec(objectPath);
  return match !== null && z.string().date().safeParse(match[1]).success
    && controllerUuid.safeParse(match[2]).success && match[2] === batchId;
}

export class ControllerCommandResultInvalid extends Error {
  readonly code = "CONTROLLER_EXPORT_RESULT_INVALID";
  constructor() { super("Controller export result could not be verified"); }
}

const envelope = z.object({ data: z.unknown(),
  error: z.union([z.null(), z.object({ code: z.string(), message: z.string() })]) });

/** No raw SDK/RPC result is trusted merely because its error field is falsy. */
export function parseControllerCommandEnvelope(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !Object.hasOwn(value, "data") || !Object.hasOwn(value, "error")) {
    throw new ControllerCommandResultInvalid();
  }
  const parsed = envelope.safeParse(value);
  if (!parsed.success || (parsed.data.error !== null && parsed.data.data !== null)) {
    throw new ControllerCommandResultInvalid();
  }
  return parsed.data;
}

export type ControllerCommandFailure =
  | { status: "known_rejected"; code: string; cause: unknown; absenceConfirmed?: boolean }
  | { status: "outcome_unknown"; code: "CONTROLLER_EXPORT_OUTCOME_UNKNOWN" | "CONTROLLER_EXPORT_RESULT_INVALID"; cause: unknown }
  | { status: "not_dispatched"; code: "REQUEST_ABORTED" | "CONTROLLER_EXPORT_COMMAND_INVALID"; cause: unknown };

const knownRejections = new Set(["22023", "42501", "P0002", "40001", "55000", "23505", "23514",
  "23503", "23502", "22P02", "22007", "22008", "22001", "22003", "P0001", "40P01", "57014", "42883", "PGRST202"]);

export function controllerCommandFailure(cause: unknown): ControllerCommandFailure {
  const code = errorData(cause, "code");
  if (typeof code === "string" && knownRejections.has(code)) return { status: "known_rejected", code, cause };
  return { status: "outcome_unknown", code: cause instanceof ControllerCommandResultInvalid
    ? "CONTROLLER_EXPORT_RESULT_INVALID" : "CONTROLLER_EXPORT_OUTCOME_UNKNOWN", cause };
}

export function unknownControllerOutcome(cause: unknown): ControllerCommandFailure {
  return { status: "outcome_unknown", code: "CONTROLLER_EXPORT_OUTCOME_UNKNOWN", cause };
}

export const CONTROLLER_RECONCILIATION_TIMEOUT_MS = 5000;
export function controllerReconciliationSignal(signal: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(CONTROLLER_RECONCILIATION_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
