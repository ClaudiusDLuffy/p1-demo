"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  deploymentChanged,
  deploymentRefreshUrl,
  formatDeploymentUpdatedAt,
  normalizeDeploymentVersion,
  RUNNING_DEPLOYMENT_UPDATED_AT,
  RUNNING_DEPLOYMENT_VERSION,
  RUNNING_DISPLAY_VERSION,
  shortDeploymentVersion,
} from "../lib/deploymentVersion";
import { beginForcedDeploymentReload, cancelForcedDeploymentReload } from "../lib/deploymentReload";
import { revokeBrowserDraftSession } from "../lib/drafts/browserDraftSession";
import { signOut } from "../lib/db";

const CHECK_INTERVAL_MS = 60 * 1000;
const MIN_CHECK_GAP_MS = 15 * 1000;
const REQUEST_TIMEOUT_MS = 8 * 1000;
const RETRY_DELAY_MS = 3 * 1000;

type VersionResponse = { deploymentVersion?: unknown; displayVersion?: unknown };
type AvailableDeployment = { id: string; display: string };

export default function DeploymentVersionGuard({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const buildUpdatedAt = formatDeploymentUpdatedAt(RUNNING_DEPLOYMENT_UPDATED_AT);
  const [available, setAvailable] = useState<AvailableDeployment | null>(null);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const lastCheckAt = useRef(0);
  const requestInFlight = useRef(false);
  const replacementInFlight = useRef(false);
  const retryTimer = useRef<number | null>(null);

  const replaceDeployment = useCallback(async (deployment: AvailableDeployment) => {
    if (replacementInFlight.current) return;
    replacementInFlight.current = true;
    setSignOutFailed(false);
    beginForcedDeploymentReload();
    revokeBrowserDraftSession();
    await queryClient.cancelQueries();
    queryClient.clear();
    try {
      await signOut("local");
      window.location.replace(deploymentRefreshUrl(window.location.href, deployment.id));
    } catch {
      cancelForcedDeploymentReload();
      replacementInFlight.current = false;
      setSignOutFailed(true);
      retryTimer.current = window.setTimeout(() => {
        retryTimer.current = null;
        void replaceDeployment(deployment);
      }, RETRY_DELAY_MS);
    }
  }, [queryClient]);

  const checkVersion = useCallback(async (force = false) => {
    const now = Date.now();
    if (requestInFlight.current || replacementInFlight.current
      || (!force && now - lastCheckAt.current < MIN_CHECK_GAP_MS)) return;
    requestInFlight.current = true;
    lastCheckAt.current = now;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`/api/version?t=${now}`, {
        cache: "no-store", credentials: "same-origin",
        headers: { "Cache-Control": "no-cache" }, signal: controller.signal,
      });
      if (!response.ok) return;
      const body = await response.json() as VersionResponse;
      if (deploymentChanged(RUNNING_DEPLOYMENT_VERSION, body.deploymentVersion)) {
        const id = normalizeDeploymentVersion(body.deploymentVersion);
        if (!id) return;
        setAvailable({ id, display: normalizeDeploymentVersion(body.displayVersion) || shortDeploymentVersion(id) });
      }
    } catch {
      // Offline, suspended, and transient checks must never interrupt portal work.
    } finally {
      window.clearTimeout(timeout);
      requestInFlight.current = false;
    }
  }, []);

  useEffect(() => { if (available) void replaceDeployment(available); }, [available, replaceDeployment]);
  useEffect(() => {
    void checkVersion(true);
    const interval = window.setInterval(() => { void checkVersion(true); }, CHECK_INTERVAL_MS);
    const onFocus = () => { void checkVersion(); };
    const onVisible = () => { if (document.visibilityState === "visible") void checkVersion(); };
    const onPageShow = () => { void checkVersion(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [checkVersion]);

  return <>
    {children}
    <div aria-label={`Portal version ${RUNNING_DISPLAY_VERSION}`} title={`Portal deployment ${RUNNING_DEPLOYMENT_VERSION}`}
      style={{ position: "fixed", left: 8, bottom: 5, zIndex: 4, color: "#78716c", fontSize: 9,
        lineHeight: 1.25, opacity: 0.72, pointerEvents: "none" }}>
      <div>Version {RUNNING_DISPLAY_VERSION}</div>
      {buildUpdatedAt && <div style={{ marginTop: 2, fontSize: 8 }}>Last updated {buildUpdatedAt} · Miami</div>}
    </div>
    {available && <section role="alert" aria-label="Updating the P1 Portal"
      style={{ position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center",
        justifyContent: "center", padding: 20, background: "rgba(28, 25, 23, 0.94)", color: "#fff" }}>
      <div style={{ width: "min(420px, 100%)", textAlign: "center" }}>
        <div aria-hidden="true" style={{ width: 38, height: 38, margin: "0 auto 18px", borderRadius: "50%",
          border: "4px solid rgba(255,255,255,.25)", borderTopColor: "#fff", animation: "spin 0.8s linear infinite" }} />
        <div style={{ fontSize: 20, fontWeight: 800 }}>Updating the P1 Portal</div>
        <p style={{ margin: "9px 0 0", color: "#e7e5e4", fontSize: 13, lineHeight: 1.55 }}>
          A new deployment is available. You are being signed out so the latest version loads cleanly.
        </p>
        <div style={{ marginTop: 12, color: "#a8a29e", fontSize: 11 }}>
          {RUNNING_DISPLAY_VERSION} → {available.display}
        </div>
        {signOutFailed && <div style={{ marginTop: 18 }}>
          <p role="status" style={{ color: "#fed7aa", fontSize: 12 }}>
            Sign-out did not finish. The portal is blocked to prevent stale changes and will retry automatically.
          </p>
          <button type="button" className="btn-primary" onClick={() => void replaceDeployment(available)}>Retry now</button>
        </div>}
      </div>
    </section>}
  </>;
}
