"use client";

import { useEffect } from "react";
import { reportClientFailure } from "../lib/clientDiagnostics";

export default function ErrorPage({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    void reportClientFailure({
      source: "app_error_boundary",
      message: error.message,
      stack: error.stack,
    });
  }, [error]);

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, background: "#FAF7F2", color: "#1F1E1C" }}>
      <section style={{ width: "min(440px, 100%)", padding: 28, borderRadius: 18, border: "1px solid #DDD7CE", background: "#FFF", boxShadow: "0 10px 35px rgba(31,30,28,0.08)" }}>
        <div style={{ fontSize: 28, lineHeight: 1 }}>⚠</div>
        <h1 style={{ margin: "18px 0 8px", fontSize: 24 }}>This page couldn&apos;t load</h1>
        <p style={{ margin: 0, color: "#68635C", lineHeight: 1.55 }}>The error was recorded. Reload this view, or return to the portal dashboard.</p>
        <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
          <button type="button" onClick={() => unstable_retry()} style={{ minHeight: 44, padding: "10px 16px", border: 0, borderRadius: 10, background: "#1F1E1C", color: "#FFF", fontWeight: 700, cursor: "pointer" }}>Reload</button>
          <button type="button" onClick={() => { window.location.href = "/"; }} style={{ minHeight: 44, padding: "10px 16px", border: "1px solid #DDD7CE", borderRadius: 10, background: "#FFF", color: "#1F1E1C", fontWeight: 700, cursor: "pointer" }}>Dashboard</button>
        </div>
      </section>
    </main>
  );
}
