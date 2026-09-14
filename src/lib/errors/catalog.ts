import { coreErrorCodes, type ErrorMetadata } from "./codes";
import { domainErrorCodes } from "./domainCodes";
export type PublicErrorCode = keyof typeof coreErrorCodes | keyof typeof domainErrorCodes;
export function isPublicErrorCode(value: unknown): value is PublicErrorCode {
  return typeof value === "string" && (Object.hasOwn(coreErrorCodes, value) || Object.hasOwn(domainErrorCodes, value));
}
export function errorMetadata(code: PublicErrorCode): ErrorMetadata {
  if (Object.hasOwn(coreErrorCodes, code)) return coreErrorCodes[code as keyof typeof coreErrorCodes];
  return Object.hasOwn(domainErrorCodes, code)
    ? coreErrorCodes[domainErrorCodes[code as keyof typeof domainErrorCodes]]
    : coreErrorCodes.INTERNAL_ERROR;
}
