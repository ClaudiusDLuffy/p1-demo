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
  loadingMessage,
  errorMessage,
  emptyMessage,
  onRetry,
  retryLabel = "Retry",
  retrying = false,
  className,
  style,
}: {
  state: WorkOrderCollectionState;
  loadingMessage: string;
  errorMessage: string;
  emptyMessage: string;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
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
        padding: "24px 20px",
        textAlign: "center",
        color: failed ? T.danger : T.subtle,
        background: failed ? T.dangerSoft : undefined,
        borderRadius: 10,
        fontSize: 13,
        lineHeight: 1.5,
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
