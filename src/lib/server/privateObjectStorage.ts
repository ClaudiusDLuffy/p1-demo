import "server-only";
import { PrivateObjectError } from "../privateObjectContracts";

export type BoundObject = { bucket: string; objectPath: string };
export type RemovalOutcome = "deleted" | "absent" | "unknown" | "failed";
export interface PrivateObjectStorage {
  download(object: BoundObject, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array | null>;
  remove(object: BoundObject): Promise<RemovalOutcome>;
}

/** Reads a bounded stream; Content-Length is only an early check, not proof. */
export async function readBoundedBytes(response: Response, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) throw new PrivateObjectError("OBJECT_DOWNLOAD_FAILED");
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel(); throw new PrivateObjectError("FILE_TOO_LARGE", "The file exceeds the supported size.", 422);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new PrivateObjectError("OBJECT_DOWNLOAD_FAILED");
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (signal?.aborted) throw new PrivateObjectError("OBJECT_DOWNLOAD_FAILED");
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new PrivateObjectError("FILE_TOO_LARGE", "The file exceeds the supported size.", 422);
      chunks.push(next.value);
    }
  } catch (error: unknown) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

// Only services which have resolved a database-owned intent/binding may use
// this adapter. It is deliberately not a route accepting a caller's path.
export function createPrivateObjectStorage(options: {
  url: string; secret: string; fetch?: typeof fetch; timeoutMs?: number;
}): PrivateObjectStorage {
  const fetcher = options.fetch ?? fetch;
  const timeout = () => AbortSignal.timeout(options.timeoutMs ?? 10_000);
  // Supabase's current sb_secret keys are opaque API keys, not JWTs, and must
  // not be presented as Bearer tokens. Legacy service_role JWTs still require
  // the Authorization header for Storage compatibility during migration.
  const headers = options.secret.startsWith("sb_secret_")
    ? { apikey: options.secret }
    : { apikey: options.secret, Authorization: `Bearer ${options.secret}` };
  const path = (object: BoundObject) => {
    if (!["photos", "invoice-pdfs", "contractor-estimate-attachments"].includes(object.bucket)
      || !object.objectPath || /[\\%?#\u0000-\u001f]/u.test(object.objectPath)
      || object.objectPath.split("/").some(part => !part || part === "." || part === "..")) {
      throw new PrivateObjectError("INVALID_OBJECT_BINDING");
    }
    return `${options.url}/storage/v1/object/${object.bucket}/${object.objectPath.split("/").map(encodeURIComponent).join("/")}`;
  };
  const exists = async (object: BoundObject): Promise<boolean | null> => {
    try {
      const response = await fetcher(path(object), { method: "HEAD", headers, signal: timeout(), cache: "no-store" });
      return response.ok ? true : response.status === 404 ? false : null;
    } catch { return null; }
  };
  return {
    async download(object, maximumBytes, signal) {
      try {
        const deadline = signal ? AbortSignal.any([signal, timeout()]) : timeout();
        const response = await fetcher(path(object), { headers, cache: "no-store",
          signal: deadline });
        if (response.status === 404) { await response.body?.cancel(); return null; }
        if (!response.ok) { await response.body?.cancel(); throw new PrivateObjectError("OBJECT_DOWNLOAD_FAILED"); }
        return await readBoundedBytes(response, maximumBytes, deadline);
      } catch (error: unknown) {
        if (error instanceof PrivateObjectError) throw error;
        throw new PrivateObjectError("OBJECT_DOWNLOAD_FAILED");
      }
    },
    async remove(object) {
      path(object); // validate even when the exact object is already missing
      const before = await exists(object);
      if (before === false) return "absent";
      if (before === null) return "unknown";
      let accepted = false;
      try {
        const response = await fetcher(`${options.url}/storage/v1/object/${object.bucket}`, {
          method: "DELETE", headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ prefixes: [object.objectPath] }), signal: timeout(), cache: "no-store",
        });
        accepted = response.ok;
        await response.body?.cancel();
      } catch { /* A transport error does not establish the provider outcome. */ }
      const after = await exists(object);
      if (after === false) return "deleted";
      return after === null || accepted ? "unknown" : "failed";
    },
  };
}
