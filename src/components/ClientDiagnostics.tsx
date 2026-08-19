"use client";

import { useEffect, useRef } from "react";
import {
  diagnosticRequestPath,
  rememberFailedRequest,
  reportClientFailure,
} from "../lib/clientDiagnostics";

type Props = {
  portalView: string;
};

const CLIENT_SESSION_KEY = "p1:client-session";

const errorMessage = (value: unknown) => {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Unknown client error";
  }
};

export default function ClientDiagnostics({ portalView }: Props) {
  const portalViewRef = useRef(portalView);

  useEffect(() => {
    portalViewRef.current = portalView;
  }, [portalView]);

  useEffect(() => {
    const originalFetch = window.fetch.bind(window);
    const instrumentedFetch: typeof window.fetch = async (input, init) => {
      const path = diagnosticRequestPath(input);
      const isDiagnosticRequest = path.endsWith("/api/client-errors");
      try {
        const response = await originalFetch(input, init);
        if (!response.ok && !isDiagnosticRequest) {
          rememberFailedRequest({
            method: String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase(),
            path,
            status: response.status,
            occurredAt: new Date().toISOString(),
          });
        }
        return response;
      } catch (error) {
        if (!isDiagnosticRequest) {
          rememberFailedRequest({
            method: String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase(),
            path,
            status: null,
            occurredAt: new Date().toISOString(),
          });
        }
        throw error;
      }
    };

    window.fetch = instrumentedFetch;

    try {
      const previous = JSON.parse(
        window.sessionStorage.getItem(CLIENT_SESSION_KEY) || "null",
      );
      if (
        previous?.active === true
        && Date.now() - Number(previous.startedAt || 0) < 12 * 60 * 60 * 1000
      ) {
        void reportClientFailure({
          source: "unclean_previous_session",
          message: "The previous portal session ended without a normal page-hide event",
          portalView: previous.portalView || portalViewRef.current,
        });
      }
      window.sessionStorage.setItem(CLIENT_SESSION_KEY, JSON.stringify({
        active: true,
        startedAt: Date.now(),
        portalView: portalViewRef.current,
      }));
    } catch {
      // Session markers are best-effort only.
    }

    const markSessionClean = () => {
      try {
        window.sessionStorage.setItem(CLIENT_SESSION_KEY, JSON.stringify({
          active: false,
          endedAt: Date.now(),
          portalView: portalViewRef.current,
        }));
      } catch {
        // Session markers are best-effort only.
      }
    };

    const onWindowError = (event: ErrorEvent) => {
      void reportClientFailure({
        source: "window_error",
        message: event.message || "Browser runtime error",
        stack: event.error instanceof Error ? event.error.stack : null,
        portalView: portalViewRef.current,
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      void reportClientFailure({
        source: "unhandled_rejection",
        message: errorMessage(event.reason),
        stack: event.reason instanceof Error ? event.reason.stack : null,
        portalView: portalViewRef.current,
      });
    };

    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    window.addEventListener("pagehide", markSessionClean);

    return () => {
      markSessionClean();
      if (window.fetch === instrumentedFetch) window.fetch = originalFetch;
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      window.removeEventListener("pagehide", markSessionClean);
    };
  }, []);

  return null;
}
