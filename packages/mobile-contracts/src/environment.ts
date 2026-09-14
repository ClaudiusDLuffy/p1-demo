import { z } from "zod";
import { MobileContractError } from "./errors";

export const MOBILE_PUBLIC_ENV_NAMES = [
  "EXPO_PUBLIC_P1_APP_ENV", "EXPO_PUBLIC_SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_API_BASE_URL", "EXPO_PUBLIC_RELEASE_SHA",
] as const;
export const SERVER_SECRET_NAME = /(service.role|service_role|database.*password|jwt.*secret|cron.*secret|graph.*secret|twilio|quickbooks|provider.*token|vercel.*secret)/i;
const schema = z.object({
  EXPO_PUBLIC_P1_APP_ENV: z.enum(["development", "preview", "production"]),
  EXPO_PUBLIC_SUPABASE_URL: z.url().refine(value => new URL(value).protocol === "https:"),
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20).refine(value => !/service[_-]?role/i.test(value)),
  EXPO_PUBLIC_API_BASE_URL: z.url().refine(value => new URL(value).protocol === "https:"),
  EXPO_PUBLIC_RELEASE_SHA: z.string().regex(/^(?:unknown|[0-9a-f]{7,40})$/i),
}).strict();
export type MobileEnvironment = z.infer<typeof schema> & { supabaseProjectRef: string };

export function supabaseProjectRef(url: string): string {
  const match = /^([a-z0-9-]+)\.supabase\.(?:co|in)$/.exec(new URL(url).hostname.toLowerCase());
  if (!match?.[1]) throw new MobileContractError("profile_invalid", "Supabase project URL is malformed.");
  return match[1];
}
export function parseMobileEnvironment(input: Record<string, unknown>, expectedProjectRef?: string): MobileEnvironment {
  for (const name of Object.keys(input)) if (SERVER_SECRET_NAME.test(name)) {
    throw new MobileContractError("profile_invalid", "A server secret name was supplied to the mobile environment.");
  }
  const result = schema.safeParse(input);
  if (!result.success) throw new MobileContractError("profile_invalid", "Mobile environment configuration is incomplete or malformed.");
  const projectRef = supabaseProjectRef(result.data.EXPO_PUBLIC_SUPABASE_URL);
  if (expectedProjectRef && projectRef !== expectedProjectRef.toLowerCase()) {
    throw new MobileContractError("profile_invalid", "Supabase project does not match this build.");
  }
  return { ...result.data, supabaseProjectRef: projectRef };
}
