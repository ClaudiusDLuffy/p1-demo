import process from "node:process";
import { timingSafeEqual } from "node:crypto";
import { ConfigurationError, requiredValue, type EnvironmentValues } from "../shared";
export { assertScheduledJobsAllowed } from "./appEnvironment";

export function isCronAuthorized(request: Request, values: EnvironmentValues = process.env): boolean {
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(\S{1,4096})$/i)?.[1];
  if (!supplied) return false;
  const expected = getCronConfig(values).secret;
  const left = Buffer.from(expected); const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function getCronConfig(values: EnvironmentValues = process.env): { secret: string } {
  const secret = requiredValue(values, "CRON_SECRET", "cron", 4096);
  // One unambiguous bearer token. Minimum entropy is an operational secret-
  // generation gate, not guessed from a credential's apparent characters.
  if (/\s/.test(secret)) throw new ConfigurationError("CONFIG_INVALID", "cron", ["CRON_SECRET"]);
  return { secret };
}
