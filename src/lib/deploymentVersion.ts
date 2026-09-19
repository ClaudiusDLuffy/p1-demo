const FALLBACK_VERSION = "local-development";
const MAX_VERSION_LENGTH = 120;
const SAFE_VERSION = /^[A-Za-z0-9._-]+$/;

export function normalizeDeploymentVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_VERSION_LENGTH || !SAFE_VERSION.test(normalized)) return null;
  return normalized;
}

export function shortDeploymentVersion(value: string): string {
  if (value === FALLBACK_VERSION) return "local";
  const withoutVercelPrefix = value.startsWith("dpl_") ? value.slice(4) : value;
  return withoutVercelPrefix.slice(0, 10);
}

export function deploymentChanged(running: string, available: unknown): available is string {
  const normalized = normalizeDeploymentVersion(available);
  return normalized !== null && normalized !== running;
}

export const RUNNING_DEPLOYMENT_VERSION =
  normalizeDeploymentVersion(process.env.NEXT_PUBLIC_P1_BUILD_VERSION) || FALLBACK_VERSION;
