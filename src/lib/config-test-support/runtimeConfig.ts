import { resolvePublicSupabaseConfig } from "../config/public";
import { getServerPublicSupabaseConfig, getServerSupabaseConfig } from "../config/server/supabase";
import { isCronAuthorized, assertScheduledJobsAllowed } from "../config/server/cron";
import { graphDeliveryConfigurationError } from "../config/server/graph";
import { getEmailIntakeConfig } from "../config/server/emailIntake";
import type { EnvironmentValues } from "../config/shared";

/** VM tests inject their synthetic environment into real lazy parsers. No
 * getter reads the host environment and no DB/provider transport is created. */
export function configurationFixture(name: string, environment: EnvironmentValues = {}): unknown {
  const values = (): EnvironmentValues => ({ NODE_ENV: "test", NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-public-key", SUPABASE_SECRET_KEY: "synthetic-service-key",
    NEXT_PUBLIC_APP_URL: "https://portal.example.invalid", EMAIL_INTAKE_START_AT: "2026-09-10T00:00:00Z", ...environment });
  if (name.endsWith("/config/public")) return { getPublicSupabaseConfig: () => resolvePublicSupabaseConfig(values()) };
  if (name.endsWith("/config/server/supabase")) return {
    getServerPublicSupabaseConfig: () => getServerPublicSupabaseConfig(values()), getServerSupabaseConfig: () => getServerSupabaseConfig(values()),
  };
  if (name.endsWith("/config/server/cron")) return {
    isCronAuthorized: (request: Request) => isCronAuthorized(request, values()), assertScheduledJobsAllowed: () => assertScheduledJobsAllowed(values()),
  };
  if (name.endsWith("/config/server/graph")) return {
    graphDeliveryConfigurationError: (_values: unknown, options?: { includeOwnerRecipients?: boolean }) => graphDeliveryConfigurationError(values(), options),
  };
  if (name.endsWith("/config/server/emailIntake")) return { getEmailIntakeConfig: () => getEmailIntakeConfig(values()) };
  return undefined;
}
