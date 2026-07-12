export const GOLD_CURRENCY = {
  symbol: 'GOLD',
  displayDecimals: 2,
  displayName: 'Gold',
};

export function formatGold(gold: number, compact: boolean = false, withSymbol: boolean = true): string {
  if (compact) {
    if (gold >= 1_000_000) {
      const formatted = `${(gold / 1_000_000).toFixed(1)}M`;
      return withSymbol ? `${formatted} ${GOLD_CURRENCY.symbol}` : formatted;
    }
    if (gold >= 1_000) {
      const formatted = `${(gold / 1_000).toFixed(1)}K`;
      return withSymbol ? `${formatted} ${GOLD_CURRENCY.symbol}` : formatted;
    }
  }
  const formatted = gold.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: GOLD_CURRENCY.displayDecimals,
  });
  return withSymbol ? `${formatted} ${GOLD_CURRENCY.symbol}` : formatted;
}
