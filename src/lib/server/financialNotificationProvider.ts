import { getAccessToken, isGraphHttpError, sendEmail } from "../graphClient";
import { receivingDispatchProviderFailure } from "./receivingDispatchWorker";
import { getGraphConfig, requireGraphConfig } from "../config/server/graph";
import { getPortalOrigin } from "../config/server/appEnvironment";

// Reuse the already characterized classification without changing the receiving
// worker, its ledger, or its retry behavior. These exports are server-only inputs.
export const FINANCIAL_PROVIDER_TIMEOUT_MS = 15_000;
export type FinancialProviderOutcome = ReturnType<typeof receivingDispatchProviderFailure> & {
  retryAfterSeconds: number | null;
};

export function financialProviderFailure(error: unknown, sendStarted: boolean): FinancialProviderOutcome {
  const abortBeforeSend = !sendStarted && error instanceof Error
    && (error.name === "AbortError" || error.name === "TimeoutError");
  const result = receivingDispatchProviderFailure(abortBeforeSend ? new Error("Graph token request timed out") : error, sendStarted);
  const retryAfterSeconds = isGraphHttpError(error) && error.retryable ? error.retryAfterSeconds : null;
  // A very long provider embargo requires operator review rather than retrying
  // earlier than Graph requested or accepting an unbounded scheduling delay.
  if (result.code === "GRAPH_RATE_LIMITED" && retryAfterSeconds !== null && retryAfterSeconds > 86_400) {
    return { status: "failed", code: "GRAPH_RETRY_WINDOW_EXCEEDED", providerStatus: result.providerStatus, retryAfterSeconds: null };
  }
  return { ...result, retryAfterSeconds };
}

export function financialProviderConfigured(): boolean {
  return getGraphConfig().status === "configured";
}

export function financialProviderAccessToken(): Promise<string> {
  requireGraphConfig();
  getPortalOrigin();
  // The outer signal remains alive while the token response body is read, not
  // just until response headers arrive. Native fetch owns actual cancellation.
  return getAccessToken(AbortSignal.timeout(FINANCIAL_PROVIDER_TIMEOUT_MS));
}

export function sendFinancialProviderEmail(token: string, recipient: string, subject: string, body: string): Promise<void> {
  return sendEmail(token, [recipient], subject, body, AbortSignal.timeout(FINANCIAL_PROVIDER_TIMEOUT_MS), true);
}
