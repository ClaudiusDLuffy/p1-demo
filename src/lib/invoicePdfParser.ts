import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type InvoiceTotalExtraction = {
  total: number | null;
  confidence: "high" | "medium" | "none";
  matchedLabel: string | null;
};

type TotalCandidate = {
  amount: number;
  score: number;
  index: number;
  label: string;
};

const MONEY_CAPTURE = String.raw`(\(?-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})\)?)`;

const parseMoney = (raw: string) => {
  const trimmed = raw.trim();
  const negative = trimmed.startsWith("(") && trimmed.endsWith(")");
  const amount = Number(trimmed.replace(/[(),]/g, ""));
  if (!Number.isFinite(amount)) return null;
  return Math.round((negative ? -amount : amount) * 100) / 100;
};

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

export async function extractInvoiceTotalFromPdf(data: Uint8Array): Promise<InvoiceTotalExtraction> {
  const loadingTask = getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;

  try {
    const pageText: string[] = [];
    const pageLimit = Math.min(pdf.numPages, 25);

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map(item => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : ""))
        .join("");
      pageText.push(text);
    }

    return findInvoiceTotal(pageText.join("\n").slice(0, 250_000));
  } finally {
    await pdf.destroy();
  }
}
