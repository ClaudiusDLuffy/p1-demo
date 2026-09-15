"use client";

import type { CSSProperties } from "react";
import { T } from "../../lib/constants";

export type WorkOrderCollectionState = "ready" | "loading" | "error" | "empty";

export function resolveWorkOrderCollectionState({
  itemCount,
  isPending,
  isFetching,
  isError,
}: {
  itemCount: number;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
}): WorkOrderCollectionState {
  if (isError) return "error";
  if (itemCount > 0) return "ready";
  if (isPending || isFetching) return "loading";
  return "empty";
}

export function WorkOrderCollectionNotice({
  state,
  loadingMessage = "Loading work orders…",
  errorMessage = "Work orders could not be loaded. Please try again.",
  emptyMessage = "No work orders match the current filters.",
  onRetry,
  retrying = false,
  retryLabel = "Retry",
  className,
  style,
}: {
  state: WorkOrderCollectionState;
  loadingMessage?: string;
  errorMessage?: string;
  emptyMessage?: string;
  onRetry?: () => void;
  retrying?: boolean;
  retryLabel?: string;
  className?: string;
  style?: CSSProperties;
}) {
  if (state === "ready") return null;

  const failed = state === "error";
  const message = failed
    ? errorMessage
    : state === "loading"
      ? loadingMessage
      : emptyMessage;

  return (
    <div
      className={className}
      role={failed ? "alert" : "status"}
      aria-live={failed ? "assertive" : "polite"}
      style={{
        padding: "28px 20px",
        borderRadius: 10,
        border: `1px solid ${failed ? `${T.danger}55` : T.borderSoft}`,
        background: failed ? T.dangerSoft : T.surface,
        color: failed ? T.danger : T.muted,
        fontSize: 13,
        lineHeight: 1.5,
        textAlign: "center",
        ...style,
      }}
    >
      <div>{message}</div>
      {failed && onRetry && (
        <button
          type="button"
          className="btn-soft"
          onClick={onRetry}
          disabled={retrying}
          style={{ marginTop: 12 }}
        >
          {retrying ? "Retrying…" : retryLabel}
        </button>
      )}
    </div>
  );
}
