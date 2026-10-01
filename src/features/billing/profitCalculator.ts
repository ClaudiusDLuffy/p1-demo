const nonnegativeNumber = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};
const money = (value: number) => Math.round(value * 100) / 100;

/** Local scratch calculation only; never part of an invoice or saved draft. */
export function calculateProfit(cost: string, sell: string, targetMargin: string) {
  const costValue = nonnegativeNumber(cost);
  const sellValue = nonnegativeNumber(sell);
  const requestedMargin = Math.min(nonnegativeNumber(targetMargin), 99.99);
  const profit = money(sellValue - costValue);
  return {
    profit,
    actualMargin: sellValue > 0 ? (profit / sellValue) * 100 : null,
    targetSell: money(costValue / (1 - requestedMargin / 100)),
  };
}
