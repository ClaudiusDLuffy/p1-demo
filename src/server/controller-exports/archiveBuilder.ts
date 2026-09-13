import "server-only";
import { createHash } from "node:crypto";
import { AppError } from "../../lib/errors/AppError";
import { createZipArchive, zipArchiveByteLength, type ZipArchiveEntry } from "../../lib/zipArchive";

export const MAX_CONTROLLER_ARCHIVE_BYTES = 95 * 1024 * 1024;
export type ControllerExportArchive = { bytes: Uint8Array; sha256: string; byteLength: number };
export interface ControllerExportArchiveBuilder {
  build(entries: readonly ZipArchiveEntry[]): Promise<ControllerExportArchive>;
}

/** Stored ZIP32 and exact overhead stay owned by the existing ZIP policy. */
export function createArchiveBuilder(signal: AbortSignal | null, dependencies: { now?: () => Date } = {}): ControllerExportArchiveBuilder {
  return { async build(entries) {
    signal?.throwIfAborted();
    if (entries.length < 2 || entries.length > 501 || new Set(entries.map(entry => entry.name)).size !== entries.length) throw new AppError("INVALID_REQUEST");
    if (entries.some(entry => entry.name.startsWith("/") || entry.name.includes("\\") || entry.name.split("/").some(part => !part || part === "." || part === ".."))) throw new AppError("INVALID_REQUEST");
    const inputs = entries.map(entry => ({ ...entry, ...(dependencies.now && !entry.modifiedAt ? { modifiedAt: dependencies.now() } : {}) }));
    const expected = zipArchiveByteLength(inputs);
    if (expected > MAX_CONTROLLER_ARCHIVE_BYTES) throw new AppError("CONFLICT");
    // Synchronous CRC/ZIP generation is non-preemptible; input/output are bounded.
    const bytes = createZipArchive(inputs);
    signal?.throwIfAborted();
    if (bytes.byteLength !== expected) throw new AppError("INTERNAL_ERROR");
    return { bytes, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  } };
}
