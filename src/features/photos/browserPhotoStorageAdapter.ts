"use client";

import { z } from "zod";
import { supabase } from "../../lib/supabase/client";
import { getPublicSupabaseConfig } from "../../lib/config/public";
import { normalizeUnknownError } from "../../lib/errors/normalizeUnknown";
import { uploadIntentSchema, type UploadIntent } from "../../lib/privateObjectContracts";
import { createPhotoObjectUrl, photoContentType, requirePhotoBlob } from "./browserPhotoFileAdapter";
import { PhotoUploadError } from "./photoUploadError";

export type BrowserPhotoStorageDependencies = {
  session: () => Promise<unknown>;
  download: (path: string) => Promise<unknown>;
  configuration: () => { url: string; publishableKey: string };
  fetch: (target: string, init?: RequestInit) => Promise<Response>;
};
const sessionSchema = z.object({
  data: z.object({ session: z.object({ access_token: z.string().min(1) }).nullable() }), error: z.unknown(),
});
const downloadSchema = z.object({ data: z.unknown(), error: z.unknown() });
const defaultDependencies: BrowserPhotoStorageDependencies = {
  session: () => supabase().auth.getSession(),
  download: path => supabase().storage.from("photos").download(path),
  configuration: getPublicSupabaseConfig,
  fetch: (target, init) => fetch(target, init),
};

/** Exact private transport only. Reservation/finalization/delete/replay remain authoritative commands.
 * No raw browser removal is exposed: the server's deletion operation resolves and removes its exact object.
 */
export function createBrowserPhotoStorageAdapter(dependencies: BrowserPhotoStorageDependencies = defaultDependencies) {
  const loadPhotoPreviewBlob = async (url: string): Promise<Blob> => {
    const response = await dependencies.fetch(url);
    if (!(response instanceof Response)) throw new Error("Empty photo response from storage");
    if (!response.ok) throw new Error(`Photo download failed (${response.status})`);
    return requirePhotoBlob(await response.blob());
  };
  const loadPhotoBlob = async (path: string): Promise<Blob> => {
    if (!path) throw new Error("A photo path is required");
    // Preserve existing legacy read compatibility; never infer a new upload/removal binding.
    if (path.startsWith("data:") || path.startsWith("http")) return loadPhotoPreviewBlob(path);
    const result = downloadSchema.safeParse(await dependencies.download(path));
    if (!result.success) throw new Error("Empty photo response from storage");
    if (result.data.error) throw normalizeUnknownError(result.data.error);
    return requirePhotoBlob(result.data.data);
  };
  return {
    loadPhotoBlob, loadPhotoPreviewBlob,
    async getPhotoUrl(path: string): Promise<string | null> {
      if (!path) return null;
      if (path.startsWith("data:") || path.startsWith("http")) return path;
      return createPhotoObjectUrl(await loadPhotoBlob(path));
    },
    async uploadReservedPhoto(intent: UploadIntent, file: Blob, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      const reservation = uploadIntentSchema.safeParse(intent);
      if (!reservation.success || reservation.data.purpose !== "photo") {
        throw new PhotoUploadError("The upload reservation could not be verified.");
      }
      const contentType = await photoContentType(file, signal);
      const session = sessionSchema.safeParse(await dependencies.session());
      if (!session.success || session.data.error || !session.data.data.session) throw new PhotoUploadError("Please sign in again.");
      const configuration = dependencies.configuration();
      signal?.throwIfAborted();
      const response = await dependencies.fetch(
        `${configuration.url}/storage/v1/object/${reservation.data.bucket}/${reservation.data.objectPath.split("/").map(encodeURIComponent).join("/")}`, {
          method: "POST", body: file, headers: { "Content-Type": contentType, "x-upsert": "false",
            apikey: configuration.publishableKey, Authorization: `Bearer ${session.data.data.session.access_token}` },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
        });
      if (!(response instanceof Response)) throw new PhotoUploadError("Upload was not confirmed. Retry this file to check the same reserved object.");
      await response.body?.cancel();
      if (!response.ok) throw new PhotoUploadError("Upload was not confirmed. Retry this file to check the same reserved object.");
      // Acknowledged transport is not metadata confirmation. Do not retry or clean up here,
      // including when cancellation arrives after acknowledgement; the workflow reconciles.
    },
  };
}
const production = createBrowserPhotoStorageAdapter();
export const loadPhotoBlob = production.loadPhotoBlob;
export const getPhotoUrl = production.getPhotoUrl;
export const loadPhotoPreviewBlob = production.loadPhotoPreviewBlob;
