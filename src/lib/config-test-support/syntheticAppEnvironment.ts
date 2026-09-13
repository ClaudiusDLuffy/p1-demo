import { afterEach, beforeEach } from "node:test";

/** Real template/auth characterization tests explicitly configure their local
 * synthetic app identity. This does not provide credentials or a transport. */
export function installSyntheticAppEnvironment() {
  const configured: Record<string, string | undefined> = {
    NODE_ENV: "test", P1_APP_ENV: "development", NEXT_PUBLIC_P1_APP_ENV: "development",
    NEXT_PUBLIC_APP_URL: "https://portal.example.invalid", PORTAL_URL: undefined,
    VERCEL_ENV: undefined, P1_EXPECTED_SUPABASE_PROJECT_REF: undefined,
  };
  let previous: Record<string, string | undefined> = {};
  beforeEach(() => {
    previous = Object.fromEntries(Object.keys(configured).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(configured)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}
