import "server-only";
import { AppError } from "../../lib/errors/AppError";

export interface ControllerExportDownload {
  asStream(): PromiseLike<unknown>;
}

/** Bound transport bytes before retention, not after an SDK Blob allocation. */
export async function consumeBoundedObjectStream(raw: unknown, maximum: number, signal: AbortSignal | null,
  consume: (chunk: Uint8Array) => void): Promise<number> {
  signal?.throwIfAborted();
  if (!(raw instanceof ReadableStream) || !Number.isSafeInteger(maximum) || maximum < 0) throw new AppError("INTERNAL_ERROR");
  const reader = raw.getReader();
  let completed = false; let size = 0;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const result: ReadableStreamReadResult<unknown> = await reader.read();
      signal?.throwIfAborted();
      if (result.done) { completed = true; return size; }
      if (!(result.value instanceof Uint8Array)) throw new AppError("INTERNAL_ERROR");
      if (result.value.byteLength > maximum - size) throw new AppError("CONFLICT");
      size += result.value.byteLength;
      consume(result.value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    // Cancellation acknowledgement is secondary and may itself be unavailable.
    // Dispatch it, but never let it delay the primary byte-limit/abort outcome.
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readBoundedObjectBytes(raw: unknown, maximum: number, signal: AbortSignal | null): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const size = await consumeBoundedObjectStream(raw, maximum, signal, chunk => { chunks.push(chunk); });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
