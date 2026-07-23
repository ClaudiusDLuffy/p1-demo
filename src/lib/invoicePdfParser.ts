import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type InvoiceTotalExtraction = {
  total: number | null;
  confidence: "high" | "medium" | "none";
  matchedLabel: string | null;
};

export type InvoiceLineExtraction = {
  type: "Truck Charge" | "Labor" | "Parts/Hardware" | "Shipping" | "Other";
  desc: string;
  qty: number;
  rate: number;
  amount: number;
  confidence: "high" | "medium";
};

export type InvoicePdfExtraction = InvoiceTotalExtraction & {
  lines: InvoiceLineExtraction[];
  lineConfidence: "high" | "medium" | "none";
};

type TotalCandidate = {
  amount: number;
  score: number;
  index: number;
  label: string;
};

type PositionedText = {
  text: string;
  x: number;
  y: number;
  width: number;
};

type TextRow = {
  y: number;
  items: PositionedText[];
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

const buildRows = (items: PositionedText[]) => {
  const rows: TextRow[] = [];
  const sorted = items
    .filter(item => item.text.trim())
    .sort((a, b) => b.y - a.y || a.x - b.x);

  for (const item of sorted) {
    const current = rows.at(-1);
    if (current && Math.abs(current.y - item.y) <= 2.5) {
      current.items.push(item);
      current.y = (current.y * (current.items.length - 1) + item.y) / current.items.length;
    } else {
      rows.push({ y: item.y, items: [item] });
    }
  }

  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  return rows;
};

const inferLineType = (description: string): InvoiceLineExtraction["type"] => {
  const value = description.toLowerCase();
  if (/\b(freight|shipping|delivery|postage|courier)\b/.test(value)) return "Shipping";
  if (/\b(truck|trip charge|vehicle charge|mileage|mobilization)\b/.test(value)) return "Truck Charge";
  if (
    /\b(part|hardware|motor|compressor|condenser|evaporator|fan|gasket|filter|belt|bearing|valve|relay|contactor|thermostat|refrigerant|r-?410a|r-?22|wire|fuse)\b/.test(value)
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

function extractLinesFromPage(items: PositionedText[]): InvoiceLineExtraction[] {
  const rows = buildRows(items);
  const headerIndex = rows.findIndex(row => {
    const text = rowText(row).toLowerCase();
    const hasDescription = /\b(description|item|service|product)\b/.test(text);
    const hasAmount = /\b(amount|extended|line total|total)\b/.test(text);
    const hasNumericColumn = /\b(qty|quantity|hours?|units?|rate|unit price|price|unit cost)\b/.test(text);
    return hasDescription && hasAmount && hasNumericColumn;
  });
  if (headerIndex < 0) return [];

  const header = rows[headerIndex];
  const descriptionHeader = findHeaderColumn(
    header,
    /\b(description|item(?:\s*\/\s*service)?|service|product)\b/i,
  );
  const qtyHeader = findHeaderColumn(header, /\b(qty|quantity|hours?|units?)\b/i);
  const rateHeader = findHeaderColumn(header, /\b(rate|unit price|price|unit cost)\b/i);
  const amountHeader = findHeaderColumn(
    header,
    /\b(amount|extended|line total|total)\b/i,
    true,
  );
  if (!descriptionHeader || !amountHeader || amountHeader.x <= descriptionHeader.x) return [];

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

  const extracted: InvoiceLineExtraction[] = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const fullText = rowText(row);
    const normalized = fullText.toLowerCase();
    if (
      /^(?:sub\s*total|sales\s+tax|tax(?:\s*\(|\s*:|\s+\d|$)|total\s+due|amount\s+due|balance\s+due|grand\s+total|invoice\s+total|work\s+summary|payment\s+terms)\b/.test(normalized)
    ) {
      break;
    }

    const descriptionItems = row.items.filter(item => item.x < descriptionEnd);
    const qtyItems = qtyHeader
      ? row.items.filter(item => item.x >= descriptionEnd && item.x < qtyEnd)
      : [];
    const rateItems = rateHeader
      ? row.items.filter(item => item.x >= qtyEnd && item.x < amountStart)
      : [];
    const amountItems = row.items.filter(item => item.x >= amountStart);

    const description = joinCell(descriptionItems);
    const amount = parseMoney(joinCell(amountItems));
    if (amount == null || amount <= 0) {
      if (description && extracted.length > 0 && !/\b(page|invoice|continued)\b/i.test(description)) {
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

  return extracted;
}

export function findInvoiceTotal(text: string): InvoiceTotalExtraction {
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
      String.raw`${label.pattern}\s*(?:[:=\-]\s*)?(?:USD\s*)?\$?\s*${MONEY_CAPTURE}`,
      "gi",
    );
    for (const match of normalized.matchAll(expression)) {
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

  const currencyAmounts = Array.from(
    normalized.matchAll(new RegExp(String.raw`(?:USD\s*)?\$\s*${MONEY_CAPTURE}`, "gi")),
  )
    .map(match => parseMoney(match[1]))
    .filter((amount): amount is number => amount != null && amount > 0 && amount <= 1_000_000_000);
  const uniqueAmounts = [...new Set(currencyAmounts)];

  if (uniqueAmounts.length === 1) {
    return { total: uniqueAmounts[0], confidence: "medium", matchedLabel: null };
  }

  return { total: null, confidence: "none", matchedLabel: null };
}

export async function extractInvoiceDataFromPdf(data: Uint8Array): Promise<InvoicePdfExtraction> {
  const loadingTask = getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;

  try {
    const pageText: string[] = [];
    const lines: InvoiceLineExtraction[] = [];
    const pageLimit = Math.min(pdf.numPages, 25);

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const positionedItems = content.items
        .filter(item => "str" in item && item.str.trim())
        .map(item => ({
          text: "str" in item ? item.str : "",
          x: "transform" in item ? item.transform[4] : 0,
          y: "transform" in item ? item.transform[5] : 0,
          width: "width" in item ? item.width : 0,
        }));
      const text = positionedItems.map(item => `${item.text} `).join("");
      pageText.push(text);
      lines.push(...extractLinesFromPage(positionedItems));
    }

    const total = findInvoiceTotal(pageText.join("\n").slice(0, 250_000));
    const lineConfidence = lines.length === 0
      ? "none"
      : lines.every(line => line.confidence === "high")
        ? "high"
        : "medium";
    return { ...total, lines, lineConfidence };
  } finally {
    await pdf.destroy();
  }
}

export async function extractInvoiceTotalFromPdf(data: Uint8Array): Promise<InvoiceTotalExtraction> {
  const result = await extractInvoiceDataFromPdf(data);
  return {
    total: result.total,
    confidence: result.confidence,
    matchedLabel: result.matchedLabel,
  };
}
