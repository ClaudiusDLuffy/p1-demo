import { z } from "zod";
import { FINANCIAL_BODY_BYTES } from "./staffInvoiceContracts";
import { normalizeUnknownError } from "./errors/normalizeUnknown";
import { ConfigurationError } from "./config/shared";

export class FinancialRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly fields?: { path: string; message: string }[]) {
    super(message);
    this.name = "FinancialRequestError";
  }
}

export async function parseFinancialRequest<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new FinancialRequestError("FINANCIAL_VALIDATION_FAILED", "A JSON financial command is required", 400);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new FinancialRequestError("FINANCIAL_VALIDATION_FAILED", "A financial command is required", 400);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "";
  let bytes = 0;
  let value: unknown;
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      bytes += chunk.byteLength;
      if (bytes > FINANCIAL_BODY_BYTES) {
        await reader.cancel();
        throw new FinancialRequestError("FINANCIAL_REQUEST_TOO_LARGE", "Financial command exceeds the size limit", 413);
      }
      body += decoder.decode(chunk, { stream: true });
    }
    body += decoder.decode();
    value = JSON.parse(body);
  } catch (error) {
    if (error instanceof FinancialRequestError) throw error;
    throw new FinancialRequestError("FINANCIAL_VALIDATION_FAILED", "Financial command is not valid JSON", 400);
  } finally {
    reader.releaseLock();
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new FinancialRequestError("FINANCIAL_VALIDATION_FAILED", "Financial command contains invalid fields", 422,
      parsed.error.issues.slice(0, 20).map(issue => ({ path: issue.path.join("."), message: issue.message })));
  }
  return parsed.data;
}

export function financialErrorResponse(error: unknown): Response {
  if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") {
    const safe = normalizeUnknownError(error);
    return Response.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
  if (error instanceof ConfigurationError) {
    const safe = normalizeUnknownError(error);
    return Response.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
  if (error instanceof FinancialRequestError) return Response.json({ error: error.message, code: error.code, ...(error.fields ? { fields: error.fields } : {}) }, { status: error.status });
  // Provider messages are deliberately not part of the browser contract.
  const providerCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
  const mapping: Record<string, [number, string, string]> = {
    "42501": [403, "FINANCIAL_FORBIDDEN", "This financial action is not permitted"],
    "P0002": [404, "FINANCIAL_NOT_FOUND", "The invoice or linked record was not found"],
    "23505": [409, "FINANCIAL_CONFLICT", "The invoice number or operation already exists. Refresh and check the saved invoice"],
    "55000": [409, "FINANCIAL_CONFLICT", "The invoice or work order changed. Refresh before trying again"],
    "40001": [409, "FINANCIAL_CONFLICT", "The invoice or work order changed. Refresh before trying again"],
    "PT409": [409, "FINANCIAL_CONFLICT", "The invoice, assignment, or operation changed. Refresh and check the saved invoice before retrying"],
    "40P01": [409, "FINANCIAL_CONFLICT", "Another financial action is in progress. Refresh and check the invoice"],
    "22023": [422, "FINANCIAL_VALIDATION_FAILED", "The financial command is invalid or incomplete"],
    "23514": [422, "FINANCIAL_VALIDATION_FAILED", "The financial command does not meet the invoice requirements"],
    "23503": [422, "FINANCIAL_VALIDATION_FAILED", "A linked financial record is unavailable"],
    "PGRST202": [503, "FINANCIAL_COMMAND_UNAVAILABLE", "Invoice changes are temporarily unavailable during the release. Please refresh later"],
    "42883": [503, "FINANCIAL_COMMAND_UNAVAILABLE", "Invoice changes are temporarily unavailable during the release. Please refresh later"],
  };
  const [status, code, message] = mapping[providerCode] || [500, "FINANCIAL_COMMAND_FAILED", "The financial command could not be completed. Check the invoice before retrying"];
  return Response.json({ error: message, code }, { status });
}
