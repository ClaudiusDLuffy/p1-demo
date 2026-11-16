/** UI-only feedback. Never included in a financial command or provider payload. */
export type InvoiceActionFeedback = {
  kind: "error" | "warning";
  message: string;
};

export type InvoiceFeedbackReporter = (feedback: InvoiceActionFeedback) => void;
