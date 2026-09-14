"use client";

import { useBoundaryReport } from "../lib/observability/useBoundaryReport";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const reporting = useBoundaryReport(error, "global_error_boundary");

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, background: "#FAF7F2", color: "#1F1E1C" }}>
          <section style={{ width: "min(440px, 100%)", padding: 28, borderRadius: 18, border: "1px solid #DDD7CE", background: "#FFF" }}>
            <h1 style={{ margin: "0 0 8px", fontSize: 24 }}>The portal couldn&apos;t load</h1>
            <p style={{ margin: 0, color: "#68635C", lineHeight: 1.55 }}>Try loading the portal again.</p>
            <p role="status">{reporting}</p>
            <button type="button" onClick={() => unstable_retry()} style={{ minHeight: 44, marginTop: 22, padding: "10px 16px", border: 0, borderRadius: 10, background: "#1F1E1C", color: "#FFF", fontWeight: 700, cursor: "pointer" }}>Reload portal</button>
          </section>
        </main>
      </body>
    </html>
  );
}
