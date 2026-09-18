import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import { getCspReportOnlyHeaders } from "./src/lib/config/server/browserSecurity";

const deploymentVersion = (
  process.env.VERCEL_DEPLOYMENT_ID
  || process.env.VERCEL_GIT_COMMIT_SHA
  || process.env.NEXT_DEPLOYMENT_ID
  || process.env.VERCEL_URL
  || "local-development"
).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);

function localE2eConnectSources() {
  if (process.env.P1_E2E_ALLOW_LOCAL_CSP !== "true") return "";
  if (process.env.NODE_ENV !== "development") {
    throw new Error("Local E2E CSP access is development-only.");
  }
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  let origin: URL;
  try { origin = new URL(raw); }
  catch { throw new Error("Local E2E Supabase URL is invalid."); }
  if (origin.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Local E2E CSP access requires an exact loopback HTTP origin.");
  }
  const websocket = new URL(origin.origin);
  websocket.protocol = "ws:";
  return ` ${origin.origin} ${websocket.origin}`;
}

const e2eConnectSources = localE2eConnectSources();

const nextConfig: NextConfig = {
  /* config options here */
  // Next.js uses this for asset cache-busting and automatic hard navigation
  // when a client-side request crosses deployment versions.
  deploymentId: deploymentVersion,
  env: {
    NEXT_PUBLIC_P1_BUILD_VERSION: deploymentVersion,
  },
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  outputFileTracingIncludes: {
    "/api/invoice-pdf/parse-total": [
      "./node_modules/.cache/p1-invoice-pdf-runtime/*.mjs",
      "./node_modules/.cache/p1-invoice-pdf-runtime/manifest.json",
      "./node_modules/pdfjs-dist/legacy/build/pdf.mjs",
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/pdfjs-dist/package.json",
      "./node_modules/@napi-rs/canvas/**/*",
      "./node_modules/@napi-rs/canvas-*/**/*",
    ],
    "/api/private-objects/*": [
      "./src/lib/server/photoImageInspectionWorker.mjs",
      "./node_modules/sharp/**/*",
      "./node_modules/@img/**/*",
      "./node_modules/detect-libc/**/*",
    ],
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
      },
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' blob: https://*.supabase.co wss://*.supabase.co${e2eConnectSources}; frame-src 'self' blob:; object-src 'none'`,
          },
          ...getCspReportOnlyHeaders(),
        ],
      },
    ];
  },
};

export default async function configuration(phase: string): Promise<NextConfig> {
  if (phase === PHASE_DEVELOPMENT_SERVER || phase === PHASE_PRODUCTION_BUILD) {
    const { buildInvoicePdfRuntime } = await import("./scripts/invoice-pdf-runtime-build.mjs");
    buildInvoicePdfRuntime();
  }
  return nextConfig;
}
