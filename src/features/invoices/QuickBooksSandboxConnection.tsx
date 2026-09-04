"use client";

import { useCallback, useEffect, useState } from "react";

import { T } from "../../lib/constants";
import { supabase } from "../../lib/supabase/client";

type ConnectionStatus = {
  environment: "sandbox" | "production";
  configured: boolean;
  connected: boolean;
  disconnecting: boolean;
  companyName: string | null;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  refreshTokenExpiresAt: string | null;
  requiresReconnect: boolean;
  billWritesEnabled: boolean;
};

type ErrorPayload = { error?: string };

const quickBooksRequest = async (path: string, init?: RequestInit) => {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired. Sign in again.");
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
};

const dateTime = (value: string | null) => value
  ? new Date(value).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  : "—";

export default function QuickBooksSandboxConnection({ visible }: { visible: boolean }) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"connect" | "disconnect" | "">("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async (clearExistingError = true) => {
    if (!visible) return;
    setLoading(true);
    if (clearExistingError) setError(null);
    try {
      const response = await quickBooksRequest("/api/quickbooks/connection");
      const payload = await response.json().catch(() => ({})) as ConnectionStatus & ErrorPayload;
      if (!response.ok) throw new Error(payload.error || "Could not load QuickBooks status");
      setStatus(payload);
    } catch (loadError) {
      setStatus(null);
      setError(loadError instanceof Error ? loadError.message : "Could not load QuickBooks status");
    } finally {
      setLoading(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const url = new URL(window.location.href);
    const result = url.searchParams.get("quickbooks");
    if (result === "connected") {
      setNotice("QuickBooks sandbox connected and company access verified.");
    } else if (result === "pending") {
      setNotice("QuickBooks authorization is pending verification. Check the connection status below before trying again.");
    } else if (result === "cancelled") {
      setNotice("QuickBooks authorization was cancelled; nothing changed.");
    } else if (result === "error") {
      setError("QuickBooks could not be connected. Start a new authorization attempt or check the server configuration.");
    }
    if (result) {
      url.searchParams.delete("quickbooks");
      url.searchParams.delete("reason");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    void loadStatus(result !== "error");
  }, [loadStatus, visible]);

  const connect = async () => {
    if (busy) return;
    setBusy("connect");
    setError(null);
    setNotice(null);
    try {
      const response = await quickBooksRequest("/api/quickbooks/connect", { method: "POST" });
      const payload = await response.json().catch(() => ({})) as {
        authorizationUrl?: string;
        error?: string;
      };
      if (!response.ok || !payload.authorizationUrl) {
        throw new Error(payload.error || "QuickBooks authorization could not start");
      }
      window.location.assign(payload.authorizationUrl);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "QuickBooks authorization could not start");
      setBusy("");
    }
  };

  const disconnect = async () => {
    const confirmation = status?.disconnecting
      ? "Retry the pending QuickBooks sandbox disconnect? This safely resumes the existing revocation attempt."
      : "Disconnect this QuickBooks sandbox company? Intuit access will be revoked and the stored credentials erased.";
    if (busy || !window.confirm(confirmation)) return;
    setBusy("disconnect");
    setError(null);
    setNotice(null);
    try {
      const response = await quickBooksRequest("/api/quickbooks/connection", { method: "DELETE" });
      const payload = await response.json().catch(() => ({})) as ErrorPayload;
      if (!response.ok) throw new Error(payload.error || "QuickBooks could not be disconnected safely");
      setNotice("QuickBooks sandbox disconnected. Stored credentials were erased.");
      await loadStatus();
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : "QuickBooks could not be disconnected safely");
    } finally {
      setBusy("");
    }
  };

  if (!visible) return null;

  const companyName = status?.companyName || "QuickBooks company";
  const statusText = loading
    ? "Checking the accounting connection…"
    : !status
      ? "Connection status is unavailable."
      : status.disconnecting
        ? `${companyName} · disconnect pending`
        : status.connected
          ? `${companyName} · verified ${dateTime(status.lastVerifiedAt)}`
          : status.configured
            ? "Ready for Emily to authorize the sandbox company."
            : "Server credentials still need to be configured before authorization.";

  return (
    <div
      aria-busy={loading || Boolean(busy)}
      style={{ marginTop: 12, border: `1px solid ${T.border}`, background: T.surface, borderRadius: 10, padding: 12 }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: T.ink, fontSize: 12, fontWeight: 800 }}>
            QuickBooks Online sandbox
          </div>
          <div role="status" aria-live="polite" style={{ color: T.muted, fontSize: 11, lineHeight: 1.5, marginTop: 3 }}>
            {statusText}
          </div>
        </div>
        {!loading && !status && (
          <button type="button" className="btn-soft" disabled={Boolean(busy)} onClick={() => void loadStatus()}>
            Check status again
          </button>
        )}
        {!loading && status?.configured && (
          status.connected || status.disconnecting
            ? (
              <button type="button" className="btn-soft" disabled={Boolean(busy)} onClick={() => void disconnect()}>
                {busy === "disconnect"
                  ? "Disconnecting…"
                  : status.disconnecting
                    ? "Retry disconnect"
                    : status.requiresReconnect
                      ? "Disconnect to reconnect"
                      : "Disconnect sandbox"}
              </button>
            )
            : (
              <button type="button" className="btn-primary" disabled={Boolean(busy)} onClick={() => void connect()}>
                {busy === "connect" ? "Opening QuickBooks…" : "Connect sandbox"}
              </button>
            )
        )}
      </div>
      {status?.disconnecting && (
        <div role="alert" style={{ color: T.danger, fontSize: 11, lineHeight: 1.5, marginTop: 8 }}>
          A previous disconnect has not finished. Retry it before connecting the sandbox again.
        </div>
      )}
      {status?.connected && !status.disconnecting && status.requiresReconnect && (
        <div role="alert" style={{ color: T.danger, fontSize: 11, lineHeight: 1.5, marginTop: 8 }}>
          This connection cannot be used with the current authorization or encryption configuration. Disconnect it safely, then connect the sandbox again.
        </div>
      )}
      <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.5, marginTop: 8 }}>
        Read-only company verification is enabled. Automatic Bill creation, payments, tax sync, vendor matching, and custom-field writes remain locked until Emily&apos;s mappings and tax source are approved.
      </div>
      {notice && <div role="status" style={{ color: T.success, fontSize: 11, lineHeight: 1.5, marginTop: 8 }}>{notice}</div>}
      {error && <div role="alert" style={{ color: T.danger, fontSize: 11, lineHeight: 1.5, marginTop: 8 }}>{error}</div>}
    </div>
  );
}
