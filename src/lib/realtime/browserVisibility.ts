"use client";

import { useSyncExternalStore } from "react";

/** No browser globals are read at import time (SSR uses the closed snapshot). */
export function isPortalVisible(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible";
}
export function subscribePortalVisibility(listener: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}
export function usePortalVisibility(): boolean {
  return useSyncExternalStore(subscribePortalVisibility, isPortalVisible, () => false);
}

export type PortalVisibility = {
  visible(): boolean;
  online(): boolean;
  subscribe(listener: () => void): () => void;
};
export const browserVisibility: PortalVisibility = {
  visible: isPortalVisible,
  online: () => typeof navigator !== "undefined" && navigator.onLine,
  subscribe(listener) {
    if (typeof window === "undefined") return () => undefined;
    document.addEventListener("visibilitychange", listener);
    window.addEventListener("focus", listener);
    window.addEventListener("online", listener);
    window.addEventListener("offline", listener);
    return () => {
      document.removeEventListener("visibilitychange", listener);
      window.removeEventListener("focus", listener);
      window.removeEventListener("online", listener);
      window.removeEventListener("offline", listener);
    };
  },
};
