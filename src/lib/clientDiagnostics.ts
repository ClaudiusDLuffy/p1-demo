"use client";

import { supabase } from "./supabase/client";

const LAST_FAILED_REQUEST_KEY = "p1:last-failed-request";
const LAST_CLIENT_ERROR_KEY = "p1:last-client-error";

export type ClientFailureContext = {
  source: string;
  message: string;
  stack?: string | null;
  portalView?: string | null;
};

export type LastFailedRequest = {
  method: string;
  path: string;
  status: number | null;
  occurredAt: string;
};

const trimText = (value: unknown, maxLength: number) =>
  String(value || "").slice(0, maxLength);

export function diagnosticRequestPath(input: RequestInfo | URL) {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.origin);
    return `${url.hostname}${url.pathname}`.slice(0, 500);
  } catch {
    return "unknown-request";
  }
}

export function rememberFailedRequest(request: LastFailedRequest) {
  try {
    window.sessionStorage.setItem(
      LAST_FAILED_REQUEST_KEY,
      JSON.stringify(request),
    );
  } catch {
    // Diagnostics must never interfere with the portal itself.
  }
}

export function readLastFailedRequest(): LastFailedRequest | null {
  try {
    const raw = window.sessionStorage.getItem(LAST_FAILED_REQUEST_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const shouldReport = (source: string, message: string) => {
  const signature = `${source}:${message}`.slice(0, 500);
  const now = Date.now();
  try {
    const previous = JSON.parse(
      window.sessionStorage.getItem(LAST_CLIENT_ERROR_KEY) || "null",
    );
    if (previous?.signature === signature && now - Number(previous.at || 0) < 30_000) {
      return false;
    }
    window.sessionStorage.setItem(
      LAST_CLIENT_ERROR_KEY,
      JSON.stringify({ signature, at: now }),
    );
  } catch {
    // Continue reporting if browser storage is unavailable.
  }
  return true;
};

export async function reportClientFailure(context: ClientFailureContext) {
  if (typeof window === "undefined") return;
  const message = trimText(context.message, 2_000) || "Unknown client error";
  if (!shouldReport(context.source, message)) return;

  try {
    const sb = supabase();
    const { data } = await sb.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;

    await fetch("/api/client-errors", {
      method: "POST",
      keepalive: true,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: trimText(context.source, 120),
        message,
        stack: trimText(context.stack, 8_000) || null,
        portalView: trimText(context.portalView, 120) || null,
        route: window.location.pathname.slice(0, 500),
        lastFailedRequest: readLastFailedRequest(),
        userAgent: trimText(window.navigator.userAgent, 600),
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        standalone: window.matchMedia?.("(display-mode: standalone)").matches
          || (window.navigator as Navigator & { standalone?: boolean }).standalone === true,
        occurredAt: new Date().toISOString(),
      }),
    });
  } catch (reportError) {
    console.warn("Client diagnostic could not be sent", reportError);
  }
}
