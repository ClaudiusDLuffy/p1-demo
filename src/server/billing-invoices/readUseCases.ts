import type { BillingReadInput } from "../../features/billing/billingReadContracts";
import type { CompactBillingRead } from "../../lib/server/billingCompactReadInput";
import type { BillingReadRepository } from "./readRepository";

export function createBillingReadUseCases(repository: BillingReadRepository) {
  return {
    page: (input: BillingReadInput, signal: AbortSignal) => repository.execute({ kind: "page", page: input }, signal),
    summary: (invoiceId: string, signal: AbortSignal) => repository.execute({ kind: "summary", invoiceId }, signal),
    lines: (input: Extract<CompactBillingRead, { kind: "lines" }>, signal: AbortSignal) => repository.execute(input, signal),
    sources: (input: Extract<CompactBillingRead, { kind: "sources" }>, signal: AbortSignal) => repository.execute(input, signal),
    count: (input: BillingReadInput, signal: AbortSignal) => repository.count(input, signal),
  };
}
