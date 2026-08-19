export type BillingBucketId =
  | "all"
  | "draft"
  | "submitted"
  | "sent"
  | "recently_approved";

export interface BillingBucketInvoice {
  id?: string;
  invoiceType?: string | null;
  state?: string | null;
  num?: string | null;
  wot?: string | null;
  store?: string | null;
  storeAddr?: string | null;
  cme?: string | null;
  territory?: string | null;
  documentKind?: string | null;
  sourceInvoices?: Array<{ num?: string | null }>;
}

export interface BillingReadyWorkOrder {
  id?: string;
  store?: string | null;
  city?: string | null;
  addr?: string | null;
  summary?: string | null;
  description?: string | null;
  status?: string | null;
}

export interface BillingBucket<T extends BillingBucketInvoice> {
  id: BillingBucketId;
  label: string;
  description: string;
  color: string;
  kind: "staff" | "contractor";
  invoices: T[];
}

const searchable = (values: unknown[], search: string) => {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return values.filter(Boolean).join(" ").toLowerCase().includes(query);
};

export function billingInvoiceMatchesSearch(
  invoice: BillingBucketInvoice,
  search: string,
): boolean {
  return searchable([
    invoice.num,
    invoice.wot,
    invoice.store,
    invoice.storeAddr,
    invoice.cme,
    invoice.territory,
    invoice.documentKind === "capital_quote" ? "capital quote" : "invoice",
    ...(invoice.sourceInvoices || []).map(source => source.num),
  ], search);
}

export function billingReadyWorkOrderMatchesSearch(
  workOrder: BillingReadyWorkOrder,
  search: string,
): boolean {
  return searchable([
    workOrder.id,
    workOrder.store,
    workOrder.city,
    workOrder.addr,
    workOrder.summary,
    workOrder.description,
    workOrder.status,
  ], search);
}

export function buildBillingBuckets<T extends BillingBucketInvoice>(
  invoices: readonly T[],
  contractorInvoices: readonly T[],
): BillingBucket<T>[] {
  const staff = invoices.filter(invoice =>
    (invoice.invoiceType || "staff") === "staff",
  );
  const approvedContractor = contractorInvoices.filter(invoice =>
    invoice.invoiceType === "contractor" && invoice.state === "approved",
  );

  return [
    {
      id: "all",
      label: "All",
      description: "P1 billing documents still being prepared or waiting to be sent.",
      color: "#2563EB",
      kind: "staff",
      invoices: staff.filter(invoice => !["approved", "paid"].includes(String(invoice.state))),
    },
    {
      id: "draft",
      label: "Drafts",
      description: "Billing documents that still need to be completed.",
      color: "#6B7280",
      kind: "staff",
      invoices: staff.filter(invoice => invoice.state === "draft"),
    },
    {
      id: "submitted",
      label: "Please send to 7-Eleven",
      description: "Completed billing documents waiting for the 7-Eleven submission step.",
      color: "#B8478A",
      kind: "staff",
      invoices: staff.filter(invoice => invoice.state === "submitted"),
    },
    {
      id: "sent",
      label: "Sent to 7-Eleven",
      description: "Finished submissions, retained here without cluttering All.",
      color: "#2F7D4A",
      kind: "staff",
      invoices: staff.filter(invoice => ["approved", "paid"].includes(String(invoice.state))),
    },
    {
      id: "recently_approved",
      label: "Recently Approved",
      description: "Approved contractor invoices available as sources for P1 billing.",
      color: "#B86B32",
      kind: "contractor",
      invoices: approvedContractor,
    },
  ];
}
