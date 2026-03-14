export interface StrategyComponent {
  label: string;
  value: string;
  detail?: string;
}

export interface StrategyMeta {
  components: StrategyComponent[];
}

/**
 * Hand-curated metadata for deployed strategies.
 * Keyed by strategy config name (kebab-case, as returned by /config endpoint).
 *
 * Each component describes a functional slot of the strategy:
 *   - Direction: which side(s) the strategy trades
 *   - Entry: what triggers a new position
 *   - Regime: higher-timeframe alignment / trend filter
 *   - Filter: additional confirmation gates
 *   - Exit: how the position is closed
 */
const STRATEGY_META: Record<string, StrategyMeta> = {
  "short-range-retest-ema-macd-partial-tp": {
    components: [
      { label: "Direction", value: "Short only" },
      { label: "Entry", value: "Range Retest", detail: "Breakout below consolidation range, then waits for pullback retest of broken support" },
      { label: "Regime", value: "EMA 50 (4H)", detail: "Only shorts when price is below 4H EMA — confirms bearish structure" },
      { label: "Filter", value: "MACD + Volume", detail: "MACD histogram negative on retest + volume spike above SMA(20) on breakout" },
      { label: "Exit", value: "Partial TP + ATR Trail", detail: "40% at 1.75R, 50% at 3R, remaining 10% trails via ATR on 1H lowest-low" },
    ],
  },
  "macd-htf-adx-high-chandelier": {
    components: [
      { label: "Direction", value: "Long & Short" },
      { label: "Entry", value: "MACD Cross (4H)", detail: "MACD line crosses signal on 4H — triggers entry in direction of cross" },
      { label: "Regime", value: "Daily MACD + ADX", detail: "Daily MACD aligned with 4H direction + ADX(14) ≥ 29 confirms trending market" },
      { label: "Exit", value: "EMA Cross + Timeout", detail: "EMA(12) crosses EMA(50) against position after 3-bar hold minimum. Hard exit at 120 bars (20d)" },
    ],
  },
  "macd-htf-adx-high-ma-exit": {
    components: [
      { label: "Direction", value: "Long & Short" },
      { label: "Entry", value: "MACD Cross (4H)", detail: "MACD line crosses signal on 4H — triggers entry in direction of cross" },
      { label: "Regime", value: "Daily MACD + ADX", detail: "Daily MACD aligned with 4H direction + ADX(14) ≥ 29 confirms trending market" },
      { label: "Exit", value: "MA Crossover", detail: "Fast EMA(12) crosses slow EMA(50) against position direction. Hard exit at 120 bars" },
    ],
  },
};

export function getStrategyMeta(strategyName: string): StrategyMeta | undefined {
  return STRATEGY_META[strategyName];
}
