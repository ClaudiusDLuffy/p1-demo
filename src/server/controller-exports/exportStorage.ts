import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../lib/errors/AppError";
import { MAX_CONTROLLER_ARCHIVE_BYTES } from "./archiveBuilder";
import { consumeBoundedObjectStream, type ControllerExportDownload } from "./boundedObjectDownload";

export type ControllerExportObjectAttempt = { batchId: string; objectPath: string };
export type ControllerExportUploadResult =
  | { status: "confirmed"; ownership: "exact_attempt_object" }
  | { status: "known_failed" | "unknown" | "not_dispatched"; ownership: "unverified"; cause?: unknown };
export type ControllerExportCleanupResult = { status: "confirmed" | "not_found" | "known_failed" | "unknown" | "not_attempted"; cause?: unknown };
export type ControllerExportSignedResult = { status: "confirmed"; url: string } | { status: "failed"; cause?: unknown };
export type ControllerExportStorageSession = {
  storage: { from(bucket: "controller-exports"): {
    upload(path: string, bytes: Uint8Array, options: { contentType: "application/zip"; upsert: false }): PromiseLike<unknown>;
    download(path: string, options: Record<string, never>, parameters?: { signal: AbortSignal }): ControllerExportDownload;
    remove(paths: string[]): PromiseLike<unknown>;
    createSignedUrl(path: string, seconds: number, options: { download: string }): PromiseLike<unknown>;
  } };
};
export interface ControllerExportStorage {
  upload(attempt: ControllerExportObjectAttempt, bytes: Uint8Array): Promise<ControllerExportUploadResult>;
  reconcileUpload(attempt: ControllerExportObjectAttempt, sha256: string, byteLength: number): Promise<ControllerExportUploadResult>;
  cleanup(attempt: ControllerExportObjectAttempt): Promise<ControllerExportCleanupResult>;
  sign(attempt: ControllerExportObjectAttempt, filename: string): Promise<ControllerExportSignedResult>;
}
const envelope = z.object({ data: z.unknown(), error: z.unknown() })
  .refine(value => Object.hasOwn(value, "data") && Object.hasOwn(value, "error"));
const providerError = z.object({ status: z.number().int().optional(), statusCode: z.union([z.number().int(), z.string().regex(/^\d{3}$/)]).optional() });
const confirmedUpload = z.object({ id: z.uuid(), path: z.string(), fullPath: z.string() });
const removedObjects = z.array(z.object({ name: z.string() })).max(1);
const signedResult = z.object({ signedUrl: z.string().max(16384) });

function assertAttempt(attempt: ControllerExportObjectAttempt) {
  const match = /^(\d{4}-\d{2}-\d{2})\/([0-9a-f-]+)\.zip$/i.exec(attempt.objectPath);
  if (!z.uuid().safeParse(attempt.batchId).success || !match || !z.iso.date().safeParse(match[1]).success || match[2] !== attempt.batchId) throw new AppError("INVALID_REQUEST");
}
function statusOf(error: unknown): number | null {
  const parsed = providerError.safeParse(error);
  if (!parsed.success) return null;
  const status = parsed.data.status ?? parsed.data.statusCode;
  return status === undefined ? null : Number(status);
}
const rejected = (error: unknown) => [400, 401, 403, 404, 409, 413, 415, 422].includes(statusOf(error) ?? 0);

/** The caller owns compensation. This adapter never stages or guesses rollback. */
export function createExportStorage(session: ControllerExportStorageSession, signal: AbortSignal | null,
  options: { expectedOrigin?: string } = {}): ControllerExportStorage {
  const storage = () => session.storage.from("controller-exports");
  const configuredUrl: unknown = options.expectedOrigin ?? Reflect.get(session.storage, "url");
  const configured = z.string().url().safeParse(configuredUrl);
  if (!configured.success) throw new AppError("INTERNAL_ERROR");
  const expectedOrigin = new URL(configured.data).origin;
  return {
    async upload(attempt, bytes) {
      assertAttempt(attempt);
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_CONTROLLER_ARCHIVE_BYTES) throw new AppError("INVALID_REQUEST");
      if (signal?.aborted) return { status: "not_dispatched", ownership: "unverified" };
      try {
        const parsed = envelope.safeParse(await storage().upload(attempt.objectPath, bytes, { contentType: "application/zip", upsert: false }));
        if (!parsed.success) return { status: "unknown", ownership: "unverified", cause: parsed.error };
        if (parsed.data.error !== null) return { status: rejected(parsed.data.error) ? "known_failed" : "unknown", ownership: "unverified", cause: parsed.data.error };
        const receipt = confirmedUpload.safeParse(parsed.data.data);
        if (!receipt.success || receipt.data.path !== attempt.objectPath || receipt.data.fullPath !== `controller-exports/${attempt.objectPath}`) return { status: "unknown", ownership: "unverified" };
        // A validated upload receipt survives late cancellation; later work may stop.
        return { status: "confirmed", ownership: "exact_attempt_object" };
      } catch (cause) { return { status: "unknown", ownership: "unverified", cause }; }
    },
    async reconcileUpload(attempt, sha256, byteLength) {
      assertAttempt(attempt);
      if (!/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_CONTROLLER_ARCHIVE_BYTES) throw new AppError("INVALID_REQUEST");
      if (signal?.aborted) return { status: "unknown", ownership: "unverified" };
      try {
        const parsed = envelope.safeParse(await storage().download(attempt.objectPath, {}, signal ? { signal } : undefined).asStream());
        if (!parsed.success || parsed.data.error !== null) return { status: "unknown", ownership: "unverified" };
        // Exact server-generated batch path + full size/hash proof, not mere existence.
        const hash = createHash("sha256");
        const received = await consumeBoundedObjectStream(parsed.data.data, byteLength, signal, chunk => { hash.update(chunk); });
        if (received !== byteLength || hash.digest("hex") !== sha256) return { status: "unknown", ownership: "unverified" };
        return { status: "confirmed", ownership: "exact_attempt_object" };
      } catch (cause) { return { status: "unknown", ownership: "unverified", cause }; }
    },
    async cleanup(attempt) {
      assertAttempt(attempt);
      if (signal?.aborted) return { status: "not_attempted" };
      try {
        const parsed = envelope.safeParse(await storage().remove([attempt.objectPath]));
        if (!parsed.success) return { status: "unknown", cause: parsed.error };
        if (parsed.data.error !== null) return { status: statusOf(parsed.data.error) === 404 ? "not_found" : rejected(parsed.data.error) ? "known_failed" : "unknown", cause: parsed.data.error };
        const rows = removedObjects.safeParse(parsed.data.data);
        if (!rows.success || rows.data.some(row => row.name !== attempt.objectPath)) return { status: "unknown" };
        return { status: rows.data.length ? "confirmed" : "not_found" };
      } catch (cause) { return { status: "unknown", cause }; }
    },
    async sign(attempt, filename) {
      assertAttempt(attempt);
      if (signal?.aborted) return { status: "failed" };
      if (!filename || filename.length > 255 || /[\u0000-\u001f\\/]/.test(filename)) throw new AppError("INVALID_REQUEST");
      try {
        const parsed = envelope.safeParse(await storage().createSignedUrl(attempt.objectPath, 120, { download: filename }));
        if (!parsed.success || parsed.data.error !== null) return { status: "failed" };
        const value = signedResult.safeParse(parsed.data.data);
        if (!value.success) return { status: "failed" };
        const url = new URL(value.data.signedUrl);
        if (!["http:", "https:"].includes(url.protocol) || url.origin !== expectedOrigin || url.username || url.password
          || decodeURIComponent(url.pathname) !== `/storage/v1/object/sign/controller-exports/${attempt.objectPath}`
          || !url.searchParams.get("token")) return { status: "failed" };
        return { status: "confirmed", url: value.data.signedUrl };
      } catch (cause) { return { status: "failed", cause }; }
    },
  };
}
