import { AppError } from "../../lib/errors/AppError";

export const CONTROLLER_EXPORT_BODY_BYTES = 64 * 1024;
export const CONTROLLER_EXPORT_MAX_INVOICES = 500;
export const EXPORT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type ControllerExportHistoryFilter = { from?: string; toExclusive?: string; actor?: string };
export type ControllerExportGetCommand =
  | { mode: "queue" }
  | { mode: "download"; batchId: string }
  | { mode: "history"; format: "json" | "csv"; filter: ControllerExportHistoryFilter };
export type ControllerExportStageCommand =
  | { mode: "automatic" }
  | { mode: "selected"; invoiceIds: readonly string[] };
export type ControllerExportTransitionCommand =
  | { action: "confirm"; batchId: string }
  | { action: "cancel"; batchId: string; reason: string };

const invalid = (): never => { throw new AppError("INVALID_REQUEST"); };
const uuid = (value: unknown): string => {
  if (typeof value !== "string" || !EXPORT_UUID.test(value.trim())) return invalid();
  return value.trim();
};
const calendarDate = (value: string | null): string | undefined => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
};

/** Existing query precedence and ignored invalid optional filters are intentional compatibility. */
export function parseControllerExportGet(url: URL): ControllerExportGetCommand {
  const query = url.searchParams;
  const batch = query.get("batch")?.trim();
  if (batch) return { mode: "download", batchId: uuid(batch) };
  if (query.get("history") !== "1") return { mode: "queue" };
  const from = calendarDate(query.get("from"));
  const to = calendarDate(query.get("to"));
  const next = to ? new Date(`${to}T00:00:00.000Z`) : undefined;
  if (next) next.setUTCDate(next.getUTCDate() + 1);
  const actor = query.get("actor");
  return { mode: "history", format: query.get("format") === "csv" ? "csv" : "json",
    filter: { ...(from ? { from } : {}), ...(next ? { toExclusive: next.toISOString() } : {}),
      ...(actor && EXPORT_UUID.test(actor) ? { actor } : {}) } };
}

/** Read actual UTF-8 bytes once; Content-Length is not an admission authority. */
export async function readControllerExportBody(request: Request): Promise<Record<string, unknown>> {
  request.signal.throwIfAborted();
  if (!request.body) return invalid();
  const reader = request.body.getReader();
  const cancelRead = () => { void reader.cancel(request.signal.reason).catch(() => undefined); };
  request.signal.addEventListener("abort", cancelRead, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const next = await reader.read();
      request.signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > CONTROLLER_EXPORT_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    request.signal.removeEventListener("abort", cancelRead);
    reader.releaseLock();
  }
  if (!length) return invalid();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return Object.fromEntries(Object.entries(value));
}

export function parseControllerExportStage(body: Record<string, unknown>): ControllerExportStageCommand {
  if (body.invoiceIds === undefined) return { mode: "automatic" };
  if (!Array.isArray(body.invoiceIds)) return invalid();
  // Malformed elements never collapse into an automatic export.
  const ids = body.invoiceIds.map(uuid);
  const seen = new Set<string>();
  const unique = ids.filter(id => {
    const key = id.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  if (unique.length > CONTROLLER_EXPORT_MAX_INVOICES) return invalid();
  return unique.length ? { mode: "selected", invoiceIds: unique } : { mode: "automatic" };
}

export function parseControllerExportTransition(body: Record<string, unknown>): ControllerExportTransitionCommand {
  const batchId = uuid(body.batchId);
  if (typeof body.action !== "string") return invalid();
  const action = body.action.trim();
  if (action === "confirm") return { action, batchId };
  if (action !== "cancel" || typeof body.reason !== "string") return invalid();
  const reason = body.reason.trim();
  if (!reason || reason.length > 500) return invalid();
  return { action, batchId, reason };
}
