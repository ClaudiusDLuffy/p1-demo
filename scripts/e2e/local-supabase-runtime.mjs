import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";

const DEFAULT_ENV_FILE = ".env.e2e.local";
const DEFAULT_GATEWAY = "supabase_kong_p1-demo-e2e";

function uniqueMatch(source, pattern, label) {
  const matches = [...new Set(source.match(pattern) || [])];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one generated local ${label}; found ${matches.length}.`);
  }
  return matches[0];
}

function localhostUrl(value) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Synthetic E2E refuses to use a non-local Supabase URL.");
  }
  return url.origin;
}

/**
 * Resolve credentials from the disposable local gateway without persisting or
 * printing them. The checked-in application continues to use the modern
 * publishable/secret variable names; only the child test process receives the
 * generated values.
 */
export function localSupabaseRuntime(options = {}) {
  const envFile = resolve(process.cwd(), options.envFile || DEFAULT_ENV_FILE);
  const configured = parse(readFileSync(envFile));
  const url = localhostUrl(configured.NEXT_PUBLIC_SUPABASE_URL || "");
  const gateway = configured.P1_E2E_SUPABASE_GATEWAY || DEFAULT_GATEWAY;
  const kongConfig = execFileSync(
    "docker",
    ["exec", gateway, "cat", "/home/kong/kong.yml"],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  const publishableKey = uniqueMatch(kongConfig, /\bsb_publishable_[A-Za-z0-9_-]+\b/g, "publishable key");
  const secretKey = uniqueMatch(kongConfig, /\bsb_secret_[A-Za-z0-9_-]+\b/g, "secret key");

  return {
    ...configured,
    NEXT_PUBLIC_SUPABASE_URL: url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    SUPABASE_SECRET_KEY: secretKey,
    NEXT_PUBLIC_APP_URL: configured.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3000",
    NEXT_PUBLIC_P1_APP_ENV: configured.NEXT_PUBLIC_P1_APP_ENV || "development",
    P1_APP_ENV: configured.P1_APP_ENV || "development",
  };
}

export const syntheticPassword = "P1-Synthetic-E2E-Only-2026";

