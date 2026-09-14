import type { MobileCapability } from "@p1/mobile-contracts";
export const capabilityHome = (capability: MobileCapability): "/jobs" | "/company" | "/unsupported-role" =>
  capability === "technician" ? "/jobs" : capability === "company_admin" ? "/company" : "/unsupported-role";
