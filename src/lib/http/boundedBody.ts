import { AppError } from "../errors/AppError";

/** Byte accounting precedes JSON parsing. A deadline also settles a reader or
 * fake transport that ignores cancellation; cancellation itself is best effort. */
export async function readBoundedBody(stream: ReadableStream<Uint8Array> | null, options: {
  maximum: number; timeoutMs: number; signal?: AbortSignal;
}): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const bytes = new Uint8Array(options.maximum);
  let size = 0; let complete = false;
  let rejectDeadline: (error: AppError) => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  const abort = () => { rejectDeadline(new AppError("REQUEST_ABORTED")); cancel(); };
  const timer = setTimeout(() => { rejectDeadline(new AppError("TIMEOUT")); cancel(); }, options.timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) throw new AppError("REQUEST_ABORTED");
    for (;;) {
      const chunk = await Promise.race([reader.read(), stopped]);
      if (options.signal?.aborted) throw new AppError("REQUEST_ABORTED");
      if (chunk.done) { complete = true; break; }
      if (size + chunk.value.byteLength > bytes.byteLength) throw new AppError("PAYLOAD_TOO_LARGE");
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
    if (!complete) cancel();
    try { reader.releaseLock(); } catch { /* cancellation may still be settling */ }
  }
}
