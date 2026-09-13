import { validatePhotoFile } from "./browserPhotoFileAdapter";
import { PhotoUploadError } from "./photoUploadError";
export { PhotoUploadError } from "./photoUploadError";

export const PHOTO_UPLOAD_MAX_FILES = 8;
export const PHOTO_UPLOAD_CONCURRENCY = 2;
export type PhotoUploadStatus = "queued" | "authorizing" | "uploading" | "validating" | "finalizing"
  | "confirmed" | "failed" | "cleanup_required" | "cancelled";
export type PhotoUploadItem = Readonly<{
  operationId: string;
  batchId: string;
  name: string;
  size: number;
  status: PhotoUploadStatus;
  storagePath?: string;
  message?: string;
  retryable: boolean;
}>;
export type PhotoUploadOutcome =
  | { status: "confirmed"; storagePath: string }
  | { status: "upload_required" }
  | { status: "cleanup_required"; message?: string }
  | { status: "cancelled" };
export type PhotoUploadAuthorization<Intent> = {
  intent: Intent;
  status: "upload_required" | "uploaded" | "confirmed" | "cleanup_required" | "cancelled";
  storagePath?: string;
};
export type PhotoUploadPorts<Intent> = {
  // Before returning an intent, a nonretryable PhotoUploadError must mean this
  // attempt definitely reserved nothing (for example, local duplicate input).
  // Unknown transport outcomes must remain retryable for same-operation cleanup.
  begin: (file: File, operationId: string, batchId: string, signal: AbortSignal) => Promise<PhotoUploadAuthorization<Intent>>;
  upload: (intent: Intent, file: File, signal: AbortSignal) => Promise<void>;
  finalize: (intent: Intent, signal: AbortSignal, onFinalizing: () => void) => Promise<PhotoUploadOutcome>;
  cancel: (intent: Intent) => Promise<void | Exclude<PhotoUploadOutcome, { status: "upload_required" }>>;
};

type Entry<Intent> = {
  item: PhotoUploadItem;
  file?: File;
  intent?: Intent;
  controller?: AbortController;
  reconcile: boolean;
  cancelRequested: boolean;
  begun: boolean;
};

export type PhotoUploadController = ReturnType<typeof createPhotoUploadController>;

export function createPhotoUploadController<Intent>(ports: PhotoUploadPorts<Intent>, options: {
  onChange?: (items: readonly PhotoUploadItem[]) => void;
  createId?: () => string;
} = {}) {
  const createId = options.createId ?? (() => crypto.randomUUID());
  let entries: Entry<Intent>[] = [];
  let running: Promise<readonly PhotoUploadItem[]> | null = null;
  let cancelling: Promise<readonly PhotoUploadItem[]> | null = null;
  let disposed = false;
  const cancellationTargets = new Set<Entry<Intent>>();
  const snapshot = (): readonly PhotoUploadItem[] => entries.map(entry => ({ ...entry.item }));
  const update = (entry: Entry<Intent>, patch: Partial<PhotoUploadItem>) => {
    if (disposed) return;
    entry.item = { ...entry.item, ...patch };
    options.onChange?.(snapshot());
  };
  const terminal = (entry: Entry<Intent>, outcome: Exclude<PhotoUploadOutcome, { status: "upload_required" }>) => {
    if (outcome.status === "confirmed") {
      update(entry, { status: "confirmed", storagePath: outcome.storagePath, retryable: false, message: undefined });
      entry.file = undefined;
      entry.intent = undefined;
    } else {
      if (outcome.status === "cleanup_required") entry.cancelRequested = true;
      update(entry, { status: outcome.status, retryable: outcome.status === "cleanup_required",
        message: outcome.status === "cleanup_required" ? outcome.message ?? "Cleanup is pending. Retry to check this same upload." : undefined });
      if (outcome.status === "cancelled") { entry.file = undefined; entry.intent = undefined; }
    }
  };
  const cancelEntry = async (entry: Entry<Intent>) => {
    if (disposed) return;
    if (entry.item.status === "confirmed" || entry.item.status === "cancelled") return;
    if (!entry.begun) { terminal(entry, { status: "cancelled" }); return; }
    let recoveryController: AbortController | undefined;
    try {
      // A lost begin response may already own a path. Resolve the same operation
      // before cleanup; never manufacture another path or forget its identity.
      if (entry.intent === undefined && entry.file) {
        recoveryController = new AbortController();
        entry.controller = recoveryController;
        const result = await ports.begin(entry.file, entry.item.operationId, entry.item.batchId, recoveryController.signal);
        if (disposed) return;
        entry.intent = result.intent;
        if (result.status === "confirmed" && result.storagePath) {
          terminal(entry, { status: "confirmed", storagePath: result.storagePath }); return;
        }
      }
      if (entry.intent === undefined) throw new PhotoUploadError("Cleanup is pending.");
      const result = await ports.cancel(entry.intent);
      terminal(entry, result && typeof result === "object" ? result : { status: "cancelled" });
    } catch {
      if (disposed) return;
      terminal(entry, { status: "cleanup_required" });
    } finally {
      if (entry.controller === recoveryController) entry.controller = undefined;
    }
  };
  const finalize = async (entry: Entry<Intent>, intent: Intent, signal: AbortSignal) => {
    update(entry, { status: "validating" });
    const result = await ports.finalize(intent, signal, () => update(entry, { status: "finalizing" }));
    if (disposed) return result;
    if (result.status !== "upload_required") {
      update(entry, { status: "finalizing" });
      terminal(entry, result);
    }
    return result;
  };
  const processEntry = async (entry: Entry<Intent>) => {
    if (disposed) return;
    if (entry.cancelRequested) { await cancelEntry(entry); return; }
    if (!entry.file) return;
    const previouslyBegun = entry.begun;
    const signal = (entry.controller = new AbortController()).signal;
    try {
      update(entry, { status: "authorizing", message: undefined, retryable: false });
      await validatePhotoFile(entry.file);
      if (disposed) return;
      if (entry.cancelRequested) { await cancelEntry(entry); return; }
      entry.begun = true;
      const authorization = await ports.begin(entry.file, entry.item.operationId, entry.item.batchId, signal);
      if (disposed) return;
      entry.intent = authorization.intent;
      if (authorization.status === "confirmed" && authorization.storagePath) {
        terminal(entry, { status: "confirmed", storagePath: authorization.storagePath }); return;
      }
      if (entry.cancelRequested) { await cancelEntry(entry); return; }
      if (authorization.status === "cleanup_required" || authorization.status === "cancelled") {
        terminal(entry, { status: authorization.status }); return;
      }
      if (entry.reconcile || authorization.status === "uploaded" || authorization.status === "confirmed") {
        const result = await finalize(entry, authorization.intent, signal);
        if (result.status !== "upload_required") return;
      }
      if (entry.cancelRequested) { await cancelEntry(entry); return; }
      update(entry, { status: "uploading" });
      // Set before the request: a rejected transport promise does not prove
      // Storage rejected the bytes. A retry must first reconcile this path.
      entry.reconcile = true;
      await ports.upload(authorization.intent, entry.file, signal);
      if (disposed) return;
      if (entry.cancelRequested) { await cancelEntry(entry); return; }
      const result = await finalize(entry, authorization.intent, signal);
      if (result.status === "upload_required") throw new PhotoUploadError("Upload was not confirmed. Retry this photo to check its status.");
    } catch (error: unknown) {
      if (disposed) return;
      // A definite first-attempt pre-reservation rejection has nothing to clean.
      // Never discard an earlier uncertain begin when a later retry is rejected.
      if (!previouslyBegun && entry.intent === undefined && error instanceof PhotoUploadError && !error.retryable) {
        entry.begun = false;
      }
      if (entry.cancelRequested) await cancelEntry(entry);
      else update(entry, { status: "failed", retryable: error instanceof PhotoUploadError ? error.retryable : true,
        message: error instanceof PhotoUploadError ? error.message : "Photo upload could not be confirmed. Retry this photo to check its status." });
    } finally {
      entry.controller = undefined;
    }
  };
  const run = (): Promise<readonly PhotoUploadItem[]> => {
    if (running) return running;
    const worker = async () => {
      for (;;) {
        const next = entries.find(entry => entry.item.status === "queued");
        if (!next) return;
        // Claim synchronously before another worker inspects the queue.
        update(next, { status: "authorizing" });
        await processEntry(next);
      }
    };
    running = Promise.all(Array.from({ length: PHOTO_UPLOAD_CONCURRENCY }, worker))
      .then(() => snapshot()).finally(() => { running = null; });
    return running;
  };
  return {
    snapshot,
    get busy() { return running !== null || cancelling !== null; },
    start(files: readonly File[]): Promise<readonly PhotoUploadItem[]> {
      if (disposed) return Promise.reject(new PhotoUploadError("This upload session has ended. Select the photos again after signing in.", false));
      if (cancelling) return cancelling;
      if (running) return running;
      if (files.length === 0 || files.length > PHOTO_UPLOAD_MAX_FILES) {
        return Promise.reject(new PhotoUploadError(`Choose between 1 and ${PHOTO_UPLOAD_MAX_FILES} photos at a time.`, false));
      }
      if (entries.some(entry => entry.item.status !== "confirmed" && entry.item.status !== "cancelled")) {
        return Promise.reject(new PhotoUploadError("Retry or cancel the unfinished photos before choosing another batch.", false));
      }
      const batchId = createId();
      entries = files.map(file => ({ file, reconcile: false, begun: false, cancelRequested: false,
        item: { operationId: createId(), batchId, name: file.name, size: file.size, status: "queued", retryable: false } }));
      options.onChange?.(snapshot());
      return run();
    },
    retry(operationIds?: readonly string[]): Promise<readonly PhotoUploadItem[]> {
      if (disposed) return Promise.resolve(snapshot());
      if (cancelling) return cancelling;
      if (running) return running;
      for (const entry of entries) {
        if ((!operationIds || operationIds.includes(entry.item.operationId)) && entry.item.retryable
          && (entry.item.status === "failed" || entry.item.status === "cleanup_required")) {
          update(entry, { status: "queued" });
        }
      }
      return run();
    },
    cancel(operationIds?: readonly string[]): Promise<readonly PhotoUploadItem[]> {
      if (disposed) return Promise.resolve(snapshot());
      for (const entry of entries) {
        if ((operationIds && !operationIds.includes(entry.item.operationId))
          || entry.item.status === "confirmed" || entry.item.status === "cancelled") continue;
        cancellationTargets.add(entry);
        entry.cancelRequested = true;
        entry.controller?.abort();
        if (entry.item.status === "queued") terminal(entry, { status: "cancelled" });
      }
      if (cancelling) return cancelling;
      const cleanup = async () => {
        if (running) await running;
        // Sequential recovery keeps cancellation within the same two-request cap.
        // Set iteration includes another file cancelled while cleanup is pending.
        for (const entry of cancellationTargets) await cancelEntry(entry);
        return snapshot();
      };
      cancelling = cleanup().finally(() => { cancellationTargets.clear(); cancelling = null; });
      return cancelling;
    },
    dispose(): void {
      // Logout/unmount is not authorization to delete a committed object. Stop
      // client IO only; durable unfinished intents remain for reconciliation.
      disposed = true;
      for (const entry of entries) {
        entry.controller?.abort();
        if (entry.item.status !== "confirmed" && entry.item.status !== "cancelled") {
          entry.item = { ...entry.item, status: entry.begun ? "cleanup_required" : "cancelled", retryable: false };
        }
        entry.file = undefined;
        entry.intent = undefined;
      }
    },
  };
}
