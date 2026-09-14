import type {
  InvoiceTotalExtraction, InvoiceLineExtraction, InvoiceNumberExtraction,
  InvoicePdfExtraction, PositionedText,
} from "./invoicePdfTypes";
import type { InvoicePdfBudget } from "./invoicePdfBudget";

export const INVOICE_PDF_PAGE_LIMIT = 25;
const INVOICE_PDF_TEXT_LIMIT = 250_000;

type TotalCandidate = {
  amount: number;
  score: number;
  index: number;
  label: string;
};

type TextRow = {
  y: number;
  items: PositionedText[];
};

type InvoiceTableColumns = {
  descriptionEnd: number;
  qtyEnd: number;
  amountStart: number;
  hasQtyColumn: boolean;
  hasRateColumn: boolean;
};

type InvoicePageLineResult = {
  lines: InvoiceLineExtraction[];
  columns: InvoiceTableColumns | null;
  tableEnded: boolean;
};

const MONEY_CAPTURE = String.raw`(\(?-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})\)?)`;

const parseMoney = (raw: string) => {
  const trimmed = raw.trim();
  const negative = trimmed.startsWith("(") && trimmed.endsWith(")");
  const amount = Number(
    trimmed
      .replace(/\bUSD\b/gi, "")
      .replace(/[$,\s()]/g, ""),
  );
  if (!Number.isFinite(amount)) return null;
  return Math.round((negative ? -amount : amount) * 100) / 100;
};

const roundMoney = (value: number) => Math.round(value * 100) / 100;

const normalizeInvoiceNumberCandidate = (raw: string) => {
  const value = raw
    .trim()
    .replace(/^[#:=\s-]+/, "")
    .replace(/[.,;:)\]}]+$/, "")
    .trim();
  if (!value || value.length > 64 || !/\d/.test(value)) return null;
  if (/^(?:date|total|due|number|no)$/i.test(value)) return null;
  if (/^(?:WOT|INC)\d+$/i.test(value)) return null;
  if (/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(value)) return null;
  return value;
};

export function findInvoiceNumber(text: string, budget?: InvoicePdfBudget): InvoiceNumberExtraction {
  budget?.checkText(text.length);
  const lines: string[] = [];
  let lineCount = 0;
  let start = 0;
  // Scan before allocating normalized lines: even empty raw lines consume the
  // finite logical-line budget. This preserves split(/\r?\n/), trim and filter
  // semantics without creating a 250,000-entry intermediate split array.
  while (start <= text.length) {
    budget?.checkTextLines(++lineCount);
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(start, end).replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
    if (line) lines.push(line);
    if (newline < 0) break;
    start = newline + 1;
  }

  const explicit = /\binvoice\s*(number|no\.?|num\.?|#)\s*(?:[:#=-]\s*)?([A-Z0-9][A-Z0-9._/-]{0,63})\b/i;
  for (const line of lines) {
    budget?.checkpoint();
    const match = line.match(explicit);
    const invoiceNumber = match ? normalizeInvoiceNumberCandidate(match[2]) : null;
    if (invoiceNumber) {
      return {
        invoiceNumber,
        invoiceNumberConfidence: "high",
        matchedNumberLabel: `invoice ${match![1].toLowerCase()}`,
      };
    }
  }

  const invoiceHeader = /\binvoice\s*(?:number|no\.?|num\.?|#)(?=\s|:|$)/i;
  for (let index = 0; index < lines.length - 1; index += 1) {
    budget?.checkpoint();
    if (!invoiceHeader.test(lines[index])) continue;

    const invoiceNumber = lines[index + 1]
      .split(/\s+/)
      .map(normalizeInvoiceNumberCandidate)
      .find((candidate): candidate is string => !!candidate);
    if (invoiceNumber) {
      return {
        invoiceNumber,
        invoiceNumberConfidence: "high",
        matchedNumberLabel: "invoice header",
      };
    }
  }

  // Group the optional delimiter so two adjacent whitespace quantifiers cannot
  // backtrack quadratically over a long nonmatching whitespace run.
  const bare = /^\s*invoice(?:\s*[:=-])?\s+([A-Z0-9][A-Z0-9._/-]{0,63})\b/i;
  for (const line of lines) {
    budget?.checkpoint();
    const match = line.match(bare);
    const invoiceNumber = match ? normalizeInvoiceNumberCandidate(match[1]) : null;
    if (invoiceNumber) {
      return {
        invoiceNumber,
        invoiceNumberConfidence: "medium",
        matchedNumberLabel: "invoice",
      };
    }
  }

  const jobNumber = /\bjob\s*(number|no\.?|#)\s*(?:[:#=-]\s*)?([A-Z0-9][A-Z0-9._/-]{0,63})\b/i;
  for (const line of lines) {
    budget?.checkpoint();
    const match = line.match(jobNumber);
    const invoiceNumber = match ? normalizeInvoiceNumberCandidate(match[2]) : null;
    if (invoiceNumber) {
      return {
        invoiceNumber,
        invoiceNumberConfidence: "medium",
        matchedNumberLabel: `job ${match![1].toLowerCase()}`,
      };
    }
  }

  return {
    invoiceNumber: null,
    invoiceNumberConfidence: "none",
    matchedNumberLabel: null,
  };
}

const rowText = (row: TextRow) =>
  row.items
    .slice()
    .sort((a, b) => a.x - b.x)
    .map(item => item.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

const joinCell = (items: PositionedText[]) =>
  items
    .slice()
    .sort((a, b) => a.x - b.x)
    .map(item => item.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\$\s+/g, "$")
    .replace(/\s+/g, " ")
    .trim();

const buildRows = (items: PositionedText[], budget?: InvoicePdfBudget) => {
  const rows: TextRow[] = [];
  const sorted = items
    .filter(item => item.text.trim())
    .sort((a, b) => b.y - a.y || a.x - b.x);

  for (const item of sorted) {
    budget?.checkpoint();
    const current = rows.at(-1);
    if (current && Math.abs(current.y - item.y) <= 2.5) {
      current.items.push(item);
      current.y = (current.y * (current.items.length - 1) + item.y) / current.items.length;
    } else {
      budget?.addRow();
      rows.push({ y: item.y, items: [item] });
    }
  }

  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  return rows;
};

const inferLineType = (description: string): InvoiceLineExtraction["type"] => {
  const value = description.toLowerCase();
  if (/^(?:commercial\s+)?labou?r\b/.test(value)) return "Labor";
  if (/^(?:misc\.?\s+)?materials?\b/.test(value)) return "Parts/Hardware";
  if (/\b(freight|shipping|delivery|postage|courier)\b/.test(value)) return "Shipping";
  if (/\b(truck|trip charge|vehicle charge|mileage|mobilization)\b/.test(value)) return "Truck Charge";
  if (
    /\b(part|material|hardware|electrical|motor|compressor|condenser|evaporator|fan|gasket|filter|belt|bearing|valve|relay|contactor|thermostat|refrigerant|r-?410a|r-?22|wire|fuse)\b/.test(value)
  ) {
    return "Parts/Hardware";
  }
  if (
    /\b(labor|labour|technician|diagnos(?:is|tic|e)?|inspection|service call|troubleshoot|hour|hrs?|repair|install|clean(?:ing)?|maintenance)\b/.test(value)
  ) {
    return "Labor";
  }
  return "Other";
};

const findHeaderColumn = (row: TextRow, pattern: RegExp, fromEnd = false) => {
  const items = fromEnd ? row.items.slice().reverse() : row.items;
  return items.find(item => pattern.test(item.text.trim()));
};

const parseQuantity = (raw: string) => {
  const match = raw.replace(/,/g, "").match(/-?(?:\d+(?:\.\d+)?|\.\d+)/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
};

function findTableColumns(header: TextRow): InvoiceTableColumns | null {
    const descriptionHeader = findHeaderColumn(
      header,
      /\b(description|items?(?:\s*\/\s*services?)?|services?|products?|materials?|labou?r)\b/i,
    );
    const qtyHeader = findHeaderColumn(header, /\b(qty|quantity|hours?|units?)\b/i);
    const rateHeader = findHeaderColumn(header, /\b(rate|unit price|price|unit cost)\b/i);
    const amountHeader = findHeaderColumn(
      header,
      /\b(amount|extended|line total|total)\b/i,
      true,
    );
    if (!descriptionHeader || !amountHeader || (!qtyHeader && !rateHeader) || amountHeader.x <= descriptionHeader.x) {
      return null;
    }

    const orderedNumericHeaders = [qtyHeader, rateHeader, amountHeader]
      .filter((item): item is PositionedText => !!item)
      .sort((a, b) => a.x - b.x);
    const firstNumericX = orderedNumericHeaders[0]?.x ?? amountHeader.x;
    const descriptionEnd = (descriptionHeader.x + firstNumericX) / 2;
    const qtyEnd = qtyHeader
      ? (qtyHeader.x + (rateHeader?.x ?? amountHeader.x)) / 2
      : descriptionEnd;
    const amountStart = rateHeader
      ? (rateHeader.x + amountHeader.x) / 2
      : qtyHeader
        ? qtyEnd
        : descriptionEnd;
    return {
      descriptionEnd,
      qtyEnd,
      amountStart,
      hasQtyColumn: !!qtyHeader,
      hasRateColumn: !!rateHeader,
    };
}

function extractLinesFromPage(
  rows: TextRow[],
  continuedColumns: InvoiceTableColumns | null = null,
  budget?: InvoicePdfBudget,
): InvoicePageLineResult {
  let columns = continuedColumns;
  const extracted: InvoiceLineExtraction[] = [];
  let tableEnded = false;
  for (const row of rows) {
    budget?.checkpoint();
    // Preserve upstream's row-order parsing across continuation/section headers
    // without bypassing the shared row, line, text, or deadline budgets.
    const headerColumns = findTableColumns(row);
    if (headerColumns) {
      columns = headerColumns;
      tableEnded = false;
      continue;
    }
    if (!columns) continue;
    const fullText = rowText(row);
    const normalized = fullText.toLowerCase();
    if (
      /^(?:sub\s*total|sales\s+tax|tax(?:\s*\(|\s*:|\s+\d|$)|total\s+due|amount\s+due|balance\s+due|grand\s+total|invoice\s+total|work\s+summary|payment\s+terms)\b/.test(normalized)
    ) {
      columns = null;
      tableEnded = true;
      continue;
    }

    const rowColumns = columns;
    const descriptionItems = row.items.filter(item => item.x < rowColumns.descriptionEnd);
    const qtyItems = rowColumns.hasQtyColumn
      ? row.items.filter(item => item.x >= rowColumns.descriptionEnd && item.x < rowColumns.qtyEnd)
      : [];
    const rateItems = rowColumns.hasRateColumn
      ? row.items.filter(item => item.x >= rowColumns.qtyEnd && item.x < rowColumns.amountStart)
      : [];
    const amountItems = row.items.filter(item => item.x >= rowColumns.amountStart);

    const description = joinCell(descriptionItems);
    const amount = parseMoney(joinCell(amountItems));
    if (amount == null || amount <= 0) {
      if (
        description
        && extracted.length > 0
        && row.y > 40
        && !/\b(page|invoice|continued)\b|https?:\/\/|\b\d+\s+of\s+\d+\b/i.test(description)
      ) {
        budget?.checkDescription(extracted[extracted.length - 1].desc.length + 1 + description.length);
        extracted[extracted.length - 1].desc = `${extracted[extracted.length - 1].desc} ${description}`.trim();
        extracted[extracted.length - 1].type = inferLineType(extracted[extracted.length - 1].desc);
      }
      continue;
    }
    if (!description) continue;

    const parsedQty = parseQuantity(joinCell(qtyItems));
    const parsedRate = parseMoney(joinCell(rateItems));
    const qty = parsedQty ?? (
      parsedRate != null && parsedRate > 0
        ? Math.max(amount / parsedRate, 0.01)
        : 1
    );
    const rate = parsedRate ?? amount / qty;
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(rate) || rate < 0) continue;

    const computedAmount = qty * rate;
    const tolerance = Math.max(0.05, amount * 0.02);
    const hasCompleteSourceValues = parsedQty != null && parsedRate != null;
    budget?.addLine(description.length);
    extracted.push({
      type: inferLineType(description),
      desc: description,
      qty: Math.round(qty * 1000) / 1000,
      rate: roundMoney(rate),
      amount: roundMoney(amount),
      confidence: hasCompleteSourceValues && Math.abs(computedAmount - amount) <= tolerance
        ? "high"
        : "medium",
    });
  }

  return { lines: extracted, columns, tableEnded };
}

export function findInvoiceTotal(text: string, budget?: InvoicePdfBudget): InvoiceTotalExtraction {
  budget?.checkText(text.length);
  const normalized = text.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ");
  const candidates: TotalCandidate[] = [];
  const labels = [
    { label: "balance due", pattern: String.raw`balance\s+due`, score: 120 },
    { label: "total due", pattern: String.raw`total\s+due`, score: 115 },
    { label: "amount due", pattern: String.raw`amount\s+due`, score: 110 },
    { label: "invoice total", pattern: String.raw`invoice\s+total`, score: 105 },
    { label: "grand total", pattern: String.raw`grand\s+total`, score: 100 },
    { label: "total amount", pattern: String.raw`total\s+amount`, score: 95 },
    { label: "total", pattern: String.raw`(?<!sub)(?<!tax\s)\btotal\b`, score: 75 },
  ];

  for (const label of labels) {
    const expression = new RegExp(
      // Each optional token owns only its trailing whitespace. The language is
      // unchanged, without adjacent ambiguous whitespace when "$" is absent.
      String.raw`${label.pattern}\s*(?:[:=\-]\s*)?(?:USD\s*)?(?:\$\s*)?${MONEY_CAPTURE}`,
      "gi",
    );
    for (const match of normalized.matchAll(expression)) {
      budget?.addCandidate();
      const amount = parseMoney(match[1]);
      if (amount == null || amount <= 0 || amount > 1_000_000_000) continue;
      candidates.push({
        amount,
        score: label.score,
        index: match.index || 0,
        label: label.label,
      });
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score || b.index - a.index);
    const best = candidates[0];
    return { total: best.amount, confidence: "high", matchedLabel: best.label };
  }

  const currencyAmounts: number[] = [];
  for (const match of normalized.matchAll(new RegExp(String.raw`(?:USD\s*)?\$\s*${MONEY_CAPTURE}`, "gi"))) {
    budget?.addCandidate();
    const amount = parseMoney(match[1]);
    if (amount != null && amount > 0 && amount <= 1_000_000_000) currencyAmounts.push(amount);
  }
  const uniqueAmounts = [...new Set(currencyAmounts)];

  if (uniqueAmounts.length === 1) {
    return { total: uniqueAmounts[0], confidence: "medium", matchedLabel: null };
  }

  return { total: null, confidence: "none", matchedLabel: null };
}

/** Extraction only: the same positioned text produces the same result on either runtime. */
export function parseInvoicePdfPages(pages: readonly PositionedText[][], budget?: InvoicePdfBudget): InvoicePdfExtraction {
  budget?.checkPages(pages.length);
  const pageText: string[] = [];
  const pageRowText: string[] = [];
  const lines: InvoiceLineExtraction[] = [];
  let continuedColumns: InvoiceTableColumns | null = null;

  for (const positionedItems of pages.slice(0, INVOICE_PDF_PAGE_LIMIT)) {
    budget?.beginParsedPage();
    if (budget) for (const item of positionedItems) budget.addParsedItem(item.text.length);
    const rows = buildRows(positionedItems, budget);
    pageText.push(positionedItems.map(item => `${item.text} `).join(""));
    pageRowText.push(rows.map(rowText).join("\n"));
    const pageLines = extractLinesFromPage(rows, continuedColumns, budget);
    for (const line of pageLines.lines) lines.push(line);
    continuedColumns = pageLines.tableEnded ? null : pageLines.columns;
  }

  const total = findInvoiceTotal(pageText.join("\n").slice(0, INVOICE_PDF_TEXT_LIMIT), budget);
  const invoiceNumber = findInvoiceNumber(
    `${pageRowText.join("\n")}\n${pageText.join("\n")}`.slice(0, INVOICE_PDF_TEXT_LIMIT), budget,
  );
  const lineConfidence = lines.length === 0
    ? "none"
    : lines.every(line => line.confidence === "high") ? "high" : "medium";
  budget?.checkpoint();
  return { ...total, ...invoiceNumber, lines, lineConfidence };
}
