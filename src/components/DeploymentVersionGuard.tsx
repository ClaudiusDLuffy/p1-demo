"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  deploymentChanged,
  normalizeDeploymentVersion,
  RUNNING_DEPLOYMENT_VERSION,
  shortDeploymentVersion,
} from "../lib/deploymentVersion";
import { hasDirtySensitiveForms } from "../lib/forms/dirtyFormRegistry";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MIN_CHECK_GAP_MS = 15 * 1000;
const REQUEST_TIMEOUT_MS = 8 * 1000;

type VersionResponse = {
  deploymentVersion?: unknown;
};

export default function DeploymentVersionGuard({ children }: { children: React.ReactNode }) {
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [dirtyWarning, setDirtyWarning] = useState(false);
  const lastCheckAt = useRef(0);
  const requestInFlight = useRef(false);

  const checkVersion = useCallback(async (force = false) => {
    const now = Date.now();
    if (requestInFlight.current || (!force && now - lastCheckAt.current < MIN_CHECK_GAP_MS)) return;
    requestInFlight.current = true;
    lastCheckAt.current = now;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`/api/version?t=${now}`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Cache-Control": "no-cache" },
        signal: controller.signal,
      });
      if (!response.ok) return;
      const body = await response.json() as VersionResponse;
      if (deploymentChanged(RUNNING_DEPLOYMENT_VERSION, body.deploymentVersion)) {
        setAvailableVersion(normalizeDeploymentVersion(body.deploymentVersion));
      }
    } catch {
      // Offline, suspended, and transient checks must never interrupt portal work.
    } finally {
      window.clearTimeout(timeout);
      requestInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void checkVersion(true);
    const interval = window.setInterval(() => { void checkVersion(true); }, CHECK_INTERVAL_MS);
    const onFocus = () => { void checkVersion(); };
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkVersion();
    };
    const onPageShow = () => { void checkVersion(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [checkVersion]);

  const updateNow = () => {
    if (hasDirtySensitiveForms()) {
      setDirtyWarning(true);
      return;
    }
    window.location.reload();
  };

  return (
    <>
      {children}
      <div
        aria-label={`Portal build ${shortDeploymentVersion(RUNNING_DEPLOYMENT_VERSION)}`}
        title={`Portal build ${RUNNING_DEPLOYMENT_VERSION}`}
        style={{
          position: "fixed",
          left: 8,
          bottom: 5,
          zIndex: 4,
          color: "#78716c",
          fontSize: 9,
          lineHeight: 1,
          opacity: 0.72,
          pointerEvents: "none",
        }}
      >
        Build {shortDeploymentVersion(RUNNING_DEPLOYMENT_VERSION)}
      </div>
      {availableVersion && (
        <section
          role="alert"
          aria-label="Portal update available"
          style={{
            position: "fixed",
            right: 16,
            bottom: 16,
            zIndex: 200,
            width: 360,
            maxWidth: "calc(100vw - 32px)",
            padding: 16,
            borderRadius: 12,
            border: "1px solid #d97706",
            background: "#fffbeb",
            color: "#292524",
            boxShadow: "0 20px 50px rgba(41,37,36,0.24)",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 800 }}>Portal update available</div>
          <p style={{ margin: "7px 0 12px", fontSize: 12, lineHeight: 1.5 }}>
            A newer portal build is ready. Update before starting another action so you are not working on stale code.
          </p>
          {dirtyWarning && (
            <p role="status" style={{ margin: "0 0 12px", fontSize: 12, lineHeight: 1.5, color: "#b45309", fontWeight: 700 }}>
              Save or discard the form you are editing, then choose Update now again.
            </p>
          )}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span style={{ color: "#78716c", fontSize: 10 }}>
              {shortDeploymentVersion(RUNNING_DEPLOYMENT_VERSION)} → {shortDeploymentVersion(availableVersion)}
            </span>
            <button type="button" className="btn-primary" onClick={updateNow}>
              Update now
            </button>
          </div>
        </section>
      )}
    </>
  );
}
