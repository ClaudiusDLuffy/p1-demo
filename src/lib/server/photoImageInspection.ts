import "server-only";

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  detectPhotoSignature, PHOTO_ACCEPTED_FORMAT_GUIDANCE, PHOTO_CONTENT_LIMITS,
  PHOTO_IMAGE_FORMATS, type PhotoImageFormat, type PhotoImageMetadata,
} from "../photoContentPolicy";

export type PhotoContentErrorCode =
  | "EMPTY_IMAGE" | "IMAGE_TOO_LARGE" | "UNSUPPORTED_IMAGE_FORMAT"
  | "INVALID_IMAGE_CONTENT" | "IMAGE_RESOURCE_LIMIT" | "IMAGE_INSPECTION_BUSY"
  | "IMAGE_INSPECTION_TIMEOUT" | "IMAGE_INSPECTION_ABORTED" | "IMAGE_INSPECTION_FAILED";

const messages: Record<PhotoContentErrorCode, string> = {
  EMPTY_IMAGE: "The image file is empty.",
  IMAGE_TOO_LARGE: "The image must be 10 MB or smaller.",
  UNSUPPORTED_IMAGE_FORMAT: PHOTO_ACCEPTED_FORMAT_GUIDANCE,
  INVALID_IMAGE_CONTENT: "The image could not be fully read. Export a new JPEG or PNG copy and try again.",
  IMAGE_RESOURCE_LIMIT: "The image exceeds the supported dimensions or frame limit. Export a smaller JPEG or PNG copy.",
  IMAGE_INSPECTION_BUSY: "Image verification is busy. Retry this upload shortly.",
  IMAGE_INSPECTION_TIMEOUT: "Image verification took too long. Try a smaller JPEG or PNG copy.",
  IMAGE_INSPECTION_ABORTED: "Image verification was cancelled. The upload has not been finalized.",
  IMAGE_INSPECTION_FAILED: "Image verification is temporarily unavailable. Retry this upload shortly.",
};

export class PhotoContentError extends Error {
  readonly code: PhotoContentErrorCode;
  constructor(code: PhotoContentErrorCode) {
    super(messages[code]);
    this.name = "PhotoContentError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInspectionResult(output: string, format: PhotoImageFormat, bytes: Buffer): PhotoImageMetadata {
  let value: unknown;
  try { value = JSON.parse(output); }
  catch { throw new PhotoContentError("IMAGE_INSPECTION_FAILED"); }
  if (!isRecord(value)) throw new PhotoContentError("IMAGE_INSPECTION_FAILED");
  if (value.ok === false) {
    for (const code of ["EMPTY_IMAGE", "IMAGE_TOO_LARGE", "INVALID_IMAGE_CONTENT", "IMAGE_RESOURCE_LIMIT"] as const) {
      if (value.code === code) throw new PhotoContentError(code);
    }
    throw new PhotoContentError("IMAGE_INSPECTION_FAILED");
  }
  const { width, height, frames, sizeBytes, sha256 } = value;
  if (value.ok !== true || value.format !== format || sizeBytes !== bytes.length
    || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
    || sha256 !== createHash("sha256").update(bytes).digest("hex")
    || typeof width !== "number" || typeof height !== "number" || typeof frames !== "number"
    || ![width, height, frames].every(dimension => Number.isSafeInteger(dimension) && dimension > 0)
    || width > PHOTO_CONTENT_LIMITS.maxWidth || height > PHOTO_CONTENT_LIMITS.maxHeight
    || frames > PHOTO_CONTENT_LIMITS.maxFrames || width * height * frames > PHOTO_CONTENT_LIMITS.maxTotalPixels
    || Object.keys(value).some(key => !["ok", "format", "sizeBytes", "sha256", "width", "height", "frames"].includes(key))) {
    throw new PhotoContentError("IMAGE_INSPECTION_FAILED");
  }
  const { mimeType, extension } = PHOTO_IMAGE_FORMATS[format];
  return { format, mimeType, extension, sizeBytes: bytes.length, sha256, width, height, frames };
}

let activeInspections = 0;

/**
 * No input queue: at most one bounded input/child per Node instance. Each
 * worker disables Sharp's operation cache and uses one native processing
 * thread. A process deadline terminates native work; it is not Promise.race.
 * This does not impose an OS RSS cap or a deployment-wide concurrency limit.
 * Caller must authorize the immutable upload intent before downloading bytes.
 */
export async function inspectPhotoImage(input: Uint8Array, signal?: AbortSignal): Promise<PhotoImageMetadata> {
  if (signal?.aborted) throw new PhotoContentError("IMAGE_INSPECTION_ABORTED");
  if (input.byteLength === 0) throw new PhotoContentError("EMPTY_IMAGE");
  if (input.byteLength > PHOTO_CONTENT_LIMITS.maxBytes) throw new PhotoContentError("IMAGE_TOO_LARGE");
  const signature = detectPhotoSignature(input);
  if (signature.status !== "accepted") throw new PhotoContentError("UNSUPPORTED_IMAGE_FORMAT");
  if (activeInspections >= PHOTO_CONTENT_LIMITS.maxConcurrentInspections) throw new PhotoContentError("IMAGE_INSPECTION_BUSY");
  activeInspections += 1;
  try {
    // Snapshot mutable caller buffers only after admission; never hold an
    // unbounded queue of files while native inspection is running.
    const bytes = Buffer.from(input);
    return await new Promise<PhotoImageMetadata>((fulfill, reject) => {
      const workerPath = resolve(process.cwd(), "src/lib/server/photoImageInspectionWorker.mjs");
      const child = spawn(process.execPath, [workerPath, JSON.stringify(PHOTO_CONTENT_LIMITS), signature.format], {
        stdio: ["pipe", "pipe", "pipe"],
        // No Supabase/provider credentials, NODE_OPTIONS or end-user data in
        // inherited environment. The worker only decodes stdin byte buffers.
        env: { NODE_ENV: "production", VIPS_CONCURRENCY: "1", UV_THREADPOOL_SIZE: "1" },
      });
      const chunks: Buffer[] = [];
      let outputSize = 0;
      let pendingError: PhotoContentError | null = null;
      let settled = false;
      const kill = (code: PhotoContentErrorCode) => {
        if (!pendingError) pendingError = new PhotoContentError(code);
        child.kill("SIGKILL");
      };
      const onAbort = () => kill("IMAGE_INSPECTION_ABORTED");
      const timer = setTimeout(() => kill("IMAGE_INSPECTION_TIMEOUT"), PHOTO_CONTENT_LIMITS.timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: unknown) => {
        if (!Buffer.isBuffer(chunk)) { kill("IMAGE_INSPECTION_FAILED"); return; }
        outputSize += chunk.length;
        if (outputSize > 4096) { kill("IMAGE_INSPECTION_FAILED"); return; }
        chunks.push(chunk);
      });
      // Consume/discard bounded diagnostic chunks immediately; never return
      // native paths, stack details or input contents through the API.
      child.stderr.on("data", () => undefined);
      child.stdin.on("error", () => {
        if (!pendingError) pendingError = new PhotoContentError("IMAGE_INSPECTION_FAILED");
      });
      child.once("error", () => { if (!pendingError) pendingError = new PhotoContentError("IMAGE_INSPECTION_FAILED"); });
      child.once("close", (code, terminationSignal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (pendingError) { reject(pendingError); return; }
        if (code !== 0 || terminationSignal) { reject(new PhotoContentError("IMAGE_INSPECTION_FAILED")); return; }
        try { fulfill(parseInspectionResult(Buffer.concat(chunks, outputSize).toString("utf8"), signature.format, bytes)); }
        catch (error) { reject(error instanceof PhotoContentError ? error : new PhotoContentError("IMAGE_INSPECTION_FAILED")); }
      });
      if (signal?.aborted) onAbort();
      else child.stdin.end(bytes);
    });
  } catch (error) {
    throw error instanceof PhotoContentError ? error : new PhotoContentError("IMAGE_INSPECTION_FAILED");
  } finally {
    activeInspections -= 1;
  }
}
