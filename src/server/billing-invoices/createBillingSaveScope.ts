import type { AuthorizedBillingSaveContext } from "./billingMutationContext";
import { createBillingSourceRepository, type BillingSourceRepository, type BillingSourceDataSession } from "./billingSourceRepository";
import { createBillingFinancialInputRepository, type BillingFinancialInputRepository, type BillingFinancialInputDataSession } from "./billingFinancialInputRepository";
import { createBillingSaveCommandRepository, type BillingSaveCommandRepository } from "./billingSaveCommandRepository";
import { canonicalizeBillingSaveCommand } from "./billingSaveCanonicalizer";
import type { CanonicalBillingSaveCommand } from "./billingSaveCanonicalizer";

export type BillingSaveInputDependencies = {
  sourceRepository: BillingSourceRepository;
  financialInputRepository: BillingFinancialInputRepository;
  canonicalizer: { canonicalize(command: Parameters<typeof canonicalizeBillingSaveCommand>[0], source: Parameters<typeof canonicalizeBillingSaveCommand>[1], financial: Parameters<typeof canonicalizeBillingSaveCommand>[2]): CanonicalBillingSaveCommand };
  commandRepository: BillingSaveCommandRepository;
};
export function createBillingSaveScope(context: AuthorizedBillingSaveContext): BillingSaveInputDependencies {
  // The authorized value is the installed Supabase client. Narrow its generic
  // overloads to the exact, executable-tested request ports; TypeScript otherwise
  // expands its recursive select/filter types beyond its instantiation limit.
  // This is a client capability assertion, never a cast of returned wire data.
  const sourceSession = context.dataSession as unknown as BillingSourceDataSession;
  const financialSession = context.dataSession as unknown as BillingFinancialInputDataSession;
  return {
    sourceRepository: createBillingSourceRepository(sourceSession),
    financialInputRepository: createBillingFinancialInputRepository(financialSession),
    canonicalizer: { canonicalize: canonicalizeBillingSaveCommand },
    commandRepository: createBillingSaveCommandRepository(context.dataSession),
  };
}
