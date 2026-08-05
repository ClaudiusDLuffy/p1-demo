export type InvoiceSortKey =
  | "recent"
  | "invoice"
  | "work_order"
  | "contractor"
  | "status"
  | "date"
  | "store"
  | "lines"
  | "total";

export type SortDirection = "asc" | "desc";

const natural = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

const timestamp = (value: unknown) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const numeric = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const compareNumber = (left: number, right: number) => left - right;

export interface SortableInvoice {
  id?: string | number;
  createdAt?: string | number | Date | null;
  updatedAt?: string | number | Date | null;
  num?: string | number;
  wot?: string;
  contractor?: string | null;
  state?: string;
  date?: string;
  invoiceDateRaw?: string | number | Date | null;
  invoiceDate?: string | number | Date | null;
  store?: string | number;
  lines?: readonly unknown[];
  total?: number;
}

export function sortInvoices<T extends SortableInvoice>(
  invoices: readonly T[],
  key: InvoiceSortKey,
  direction: SortDirection,
  contractorName: (contractorId: string | null | undefined) => string,
): T[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...invoices].sort((left, right) => {
    let compared = 0;

    switch (key) {
      case "recent":
        compared = compareNumber(
          timestamp(left.createdAt || left.updatedAt),
          timestamp(right.createdAt || right.updatedAt),
        );
        break;
      case "invoice":
        compared = natural.compare(String(left.num || ""), String(right.num || ""));
        break;
      case "work_order":
        compared = natural.compare(String(left.wot || ""), String(right.wot || ""));
        break;
      case "contractor":
        compared = natural.compare(
          contractorName(left.contractor),
          contractorName(right.contractor),
        );
        break;
      case "status":
        compared = natural.compare(String(left.state || ""), String(right.state || ""));
        break;
      case "date":
        compared = compareNumber(
          timestamp(left.invoiceDateRaw || left.invoiceDate),
          timestamp(right.invoiceDateRaw || right.invoiceDate),
        );
        break;
      case "store":
        compared = natural.compare(String(left.store || ""), String(right.store || ""));
        break;
      case "lines":
        compared = compareNumber((left.lines || []).length, (right.lines || []).length);
        break;
      case "total":
        compared = compareNumber(numeric(left.total), numeric(right.total));
        break;
    }

    if (compared === 0) {
      compared = compareNumber(timestamp(left.createdAt), timestamp(right.createdAt));
    }
    if (compared === 0) {
      compared = natural.compare(String(left.id || ""), String(right.id || ""));
    }
    return compared * multiplier;
  });
}
