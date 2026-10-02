import { z } from "zod";

// Shared persisted vocabulary. Financial review may preserve an active field
// or capital status; accepting its receipt must not force a billing transition.
export const workOrderStatusSchema = z.enum([
  "unassigned", "assigned", "wip", "parts", "capital", "pending_capital_completion",
  "completed", "pending_invoice", "pending_approval", "pending_payment", "closed",
]);
