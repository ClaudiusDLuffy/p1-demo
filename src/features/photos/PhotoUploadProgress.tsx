"use client";

import type { PhotoUploadItem, PhotoUploadStatus } from "./photoUploadController";

const labels: Record<PhotoUploadStatus, string> = {
  queued: "Queued", authorizing: "Checking permission", uploading: "Uploading",
  validating: "Validating image", finalizing: "Saving photo", confirmed: "Confirmed",
  failed: "Not confirmed", cleanup_required: "Cleanup pending", cancelled: "Cancelled",
};

export type PhotoUploadProgressProps = {
  items: readonly PhotoUploadItem[];
  cancelUploads?: (operationIds?: readonly string[]) => void | Promise<unknown>;
  retryUploads?: (operationIds?: readonly string[]) => void | Promise<unknown>;
};

export function PhotoUploadProgress({ items, cancelUploads, retryUploads }: PhotoUploadProgressProps) {
  if (!items.length) return null;
  const busy = items.some(item => ["queued", "authorizing", "uploading", "validating", "finalizing"].includes(item.status));
  return <section aria-label="Photo upload progress" style={{ marginBottom: 12, fontSize: 12 }}>
    <p role="status" aria-live="polite" aria-atomic="true">
      {items.filter(item => item.status === "confirmed").length} of {items.length} photos confirmed.
    </p>
    <ul style={{ paddingLeft: 18, margin: 0 }}>
      {items.map(item => <li key={item.operationId} style={{ marginBottom: 8, overflowWrap: "anywhere" }}>
        <span>{item.name}: {labels[item.status]}</span>
        {item.message && <div>{item.message}</div>}
        {item.retryable && retryUploads && <button type="button" className="btn-soft" disabled={busy}
          onClick={() => void retryUploads([item.operationId])} style={{ padding: "8px 10px", margin: "4px 6px 0 0" }}>
          {item.status === "cleanup_required" ? "Check cleanup" : "Retry photo"}
        </button>}
        {item.status !== "confirmed" && item.status !== "cancelled" && cancelUploads && <button type="button"
          className="btn-soft" onClick={() => void cancelUploads([item.operationId])} style={{ padding: "8px 10px", marginTop: 4 }}>
          Cancel photo
        </button>}
      </li>)}
    </ul>
  </section>;
}
