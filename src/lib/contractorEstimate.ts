import { LINE_TYPES } from "./constants";

export const CONTRACTOR_ESTIMATE_LINE_TYPES = LINE_TYPES;
export const CONTRACTOR_ESTIMATE_MAX_LINES = 100;
export const CONTRACTOR_ESTIMATE_MAX_AMOUNT = 99_999_999.99;
export const CONTRACTOR_ESTIMATE_MAX_TERMS_LENGTH = 100;
export const CONTRACTOR_ESTIMATE_MAX_NOTES_LENGTH = 4_000;
export const CONTRACTOR_ESTIMATE_MAX_DESCRIPTION_LENGTH = 1_000;

export type ContractorEstimateState = "draft" | "submitted" | "converted";
export type ContractorEstimateLineType = (typeof CONTRACTOR_ESTIMATE_LINE_TYPES)[number];

export type ContractorEstimateLine = {
  id?: string;
  position: number;
  type: ContractorEstimateLineType;
  description: string;
  qty: number;
  rate: number;
  amount: number;
};

export type ContractorEstimate = {
  id: string;
  quoteNum: string;
  workOrderId: string;
  contractorId: string;
  contractorAssignmentVersion: number;
  quoteDate: string;
  validUntil: string | null;
  terms: string;
  notes: string | null;
  state: ContractorEstimateState;
  subtotal: number;
  salesTax: number;
  total: number;
  submittedAt: string | null;
  submittedBy: string | null;
  convertedAt: string | null;
  convertedBy: string | null;
  convertedInvoiceId: string | null;
  createdAt: string;
  updatedAt: string;
  lines: ContractorEstimateLine[];
};

export type EditableContractorEstimateLine = {
  type: ContractorEstimateLineType;
  description: string;
  qty: number | string;
  rate: number | string;
};

export type EditableContractorEstimate = {
  quoteDate: string;
  validUntil?: string | null;
  terms: string;
  notes?: string | null;
  salesTax: number | string;
  lines: EditableContractorEstimateLine[];
};

export type ContractorEstimateTotals = {
  subtotal: number;
  salesTax: number;
  total: number;
};

const roundMoney = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

export function contractorEstimateLineAmount(
  line: Pick<EditableContractorEstimateLine, "qty" | "rate">,
): number {
  const qty = Number(line.qty);
  const rate = Number(line.rate);
  if (!Number.isFinite(qty) || !Number.isFinite(rate)) return 0;
  return roundMoney(roundMoney(qty) * roundMoney(rate));
}

export function contractorEstimateTotals(
  lines: EditableContractorEstimateLine[],
  salesTax: number | string,
): ContractorEstimateTotals {
  const subtotal = roundMoney(lines.reduce(
    (sum, line) => sum + contractorEstimateLineAmount(line),
    0,
  ));
  const parsedTax = Number(salesTax);
  const tax = Number.isFinite(parsedTax) ? roundMoney(parsedTax) : 0;
  return {
    subtotal,
    salesTax: tax,
    total: roundMoney(subtotal + tax),
  };
}

export function normalizeContractorEstimateLines(
  lines: EditableContractorEstimateLine[],
): EditableContractorEstimateLine[] {
  return lines.map(line => ({
    type: CONTRACTOR_ESTIMATE_LINE_TYPES.includes(line.type)
      ? line.type
      : "Other",
    description: String(line.description || "").trim(),
    qty: roundMoney(Number(line.qty)),
    rate: roundMoney(Number(line.rate || 0)),
  }));
}

export function validateContractorEstimate(
  estimate: EditableContractorEstimate,
  options: { submitting?: boolean } = {},
): string[] {
  const errors: string[] = [];
  const terms = String(estimate.terms || "").trim();
  const notes = String(estimate.notes || "").trim();
  const tax = Number(estimate.salesTax || 0);

  if (!estimate.quoteDate) errors.push("Estimate date is required.");
  if (estimate.validUntil && estimate.quoteDate && estimate.validUntil < estimate.quoteDate) {
    errors.push("Valid-until date cannot be before the estimate date.");
  }
  if (!terms) errors.push("Terms are required.");
  if (terms.length > CONTRACTOR_ESTIMATE_MAX_TERMS_LENGTH) {
    errors.push(`Terms cannot exceed ${CONTRACTOR_ESTIMATE_MAX_TERMS_LENGTH} characters.`);
  }
  if (notes.length > CONTRACTOR_ESTIMATE_MAX_NOTES_LENGTH) {
    errors.push(`Notes cannot exceed ${CONTRACTOR_ESTIMATE_MAX_NOTES_LENGTH.toLocaleString()} characters.`);
  }
  if (!Number.isFinite(tax) || tax < 0 || tax > CONTRACTOR_ESTIMATE_MAX_AMOUNT) {
    errors.push("Sales tax must be a valid nonnegative amount.");
  }
  if (estimate.lines.length > CONTRACTOR_ESTIMATE_MAX_LINES) {
    errors.push(`An estimate cannot contain more than ${CONTRACTOR_ESTIMATE_MAX_LINES} lines.`);
  }

  estimate.lines.forEach((line, index) => {
    const qty = Number(line.qty);
    const rate = Number(line.rate);
    const normalizedQty = roundMoney(qty);
    const normalizedRate = roundMoney(rate);
    const label = `Line ${index + 1}`;
    if (!CONTRACTOR_ESTIMATE_LINE_TYPES.includes(line.type)) {
      errors.push(`${label} has an invalid type.`);
    }
    if (
      !Number.isFinite(qty)
      || normalizedQty <= 0
      || normalizedQty > CONTRACTOR_ESTIMATE_MAX_AMOUNT
    ) {
      errors.push(`${label} needs a valid quantity greater than zero.`);
    }
    if (
      !Number.isFinite(rate)
      || normalizedRate < 0
      || normalizedRate > CONTRACTOR_ESTIMATE_MAX_AMOUNT
    ) {
      errors.push(`${label} needs a valid nonnegative rate.`);
    }
    if (contractorEstimateLineAmount(line) > CONTRACTOR_ESTIMATE_MAX_AMOUNT) {
      errors.push(`${label} amount is too large.`);
    }
    if (String(line.description || "").length > CONTRACTOR_ESTIMATE_MAX_DESCRIPTION_LENGTH) {
      errors.push(`${label} description cannot exceed ${CONTRACTOR_ESTIMATE_MAX_DESCRIPTION_LENGTH.toLocaleString()} characters.`);
    }
    if (
      options.submitting
      && line.type !== "Truck Charge"
      && !String(line.description || "").trim()
    ) {
      errors.push(`${label} needs a description before submission.`);
    }
  });

  const totals = contractorEstimateTotals(estimate.lines, estimate.salesTax);
  if (totals.subtotal > CONTRACTOR_ESTIMATE_MAX_AMOUNT
      || totals.total > CONTRACTOR_ESTIMATE_MAX_AMOUNT) {
    errors.push("Estimate total is too large.");
  }
  if (options.submitting && (estimate.lines.length === 0 || totals.subtotal <= 0)) {
    errors.push("A submitted estimate needs at least one priced line.");
  }

  return [...new Set(errors)];
}

export function canCreateContractorEstimate(input: {
  isManager: boolean;
  canInvoice: boolean;
  workOrderStatus: string;
}): boolean {
  return !input.isManager && input.canInvoice && input.workOrderStatus !== "closed";
}

export function canEditContractorEstimate(
  estimate: Pick<ContractorEstimate, "state">,
  access: Parameters<typeof canCreateContractorEstimate>[0],
): boolean {
  return estimate.state === "draft" && canCreateContractorEstimate(access);
}

export function canConvertContractorEstimate(
  estimate: Pick<ContractorEstimate, "state">,
  access: Parameters<typeof canCreateContractorEstimate>[0],
): boolean {
  return estimate.state === "submitted" && canCreateContractorEstimate(access);
}

export const CONTRACTOR_ESTIMATE_STATE_LABELS: Record<ContractorEstimateState, string> = {
  draft: "Draft",
  submitted: "Submitted estimate",
  converted: "Converted to invoice",
};
