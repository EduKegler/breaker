import type { StoreState } from "./types.js";
import type { CandleData, ReplaySignal, SignalRow, LivePosition, PricesEvent } from "../types/api.js";

// ── Stable empty arrays (prevent new refs each call) ──
const EMPTY_CANDLES: CandleData[] = [];
const EMPTY_REPLAY: ReplaySignal[] = [];
const EMPTY_SIGNALS: SignalRow[] = [];
const EMPTY_POSITIONS: LivePosition[] = [];
const EMPTY_STRINGS: string[] = [];

// ── Memoization utility ───────────────────────
// Caches result by shallow-comparing dependency array.
// Selectors that call .map()/.filter() MUST use this to avoid
// creating new array references on every Zustand subscription check.
function createSelector<Deps extends readonly unknown[], R>(
  getDeps: (s: StoreState) => [...Deps],
  compute: (...deps: Deps) => R,
): (s: StoreState) => R {
  let cachedDeps: unknown[] | undefined;
  let cachedResult: R;
  return (s: StoreState) => {
    const deps = getDeps(s);
    if (cachedDeps && deps.length === cachedDeps.length && deps.every((d, i) => Object.is(d, cachedDeps![i]))) {
      return cachedResult;
    }
    cachedDeps = deps;
    cachedResult = compute(...(deps as unknown as Deps));
    return cachedResult;
  };
}

// ── Coin list ─────────────────────────────────
export const selectCoinList = createSelector(
  (s) => [s.config?.coins] as const,
  (coins) => coins?.map((c) => c.coin) ?? EMPTY_STRINGS,
);

// ── Selected coin strategies ──────────────────
export const selectSelectedCoinStrategies = createSelector(
  (s) => [s.config?.coins, s.selectedCoin] as const,
  (coins, selectedCoin) => {
    if (!coins || !selectedCoin) return EMPTY_STRINGS;
    const cc = coins.find((c) => c.coin === selectedCoin);
    return cc ? cc.strategies.map((st) => st.name) : EMPTY_STRINGS;
  },
);

// ── Selected coin interval (streaming) ────────
export const selectSelectedCoinInterval = createSelector(
  (s) => [s.config?.coins, s.selectedCoin] as const,
  (coins, selectedCoin) => {
    if (!coins || !selectedCoin) return null;
    const cc = coins.find((c) => c.coin === selectedCoin);
    return cc?.strategies[0]?.interval ?? null;
  },
);

// ── Candles (streaming or alt) ────────────────
// Returns store references directly — stable when underlying data is stable.
export const selectCandles = (s: StoreState): CandleData[] => {
  if (s.selectedInterval === null) return s.coinCandles[s.selectedCoin] ?? EMPTY_CANDLES;
  return s.altCandles;
};

export const selectIsLiveInterval = (s: StoreState): boolean =>
  s.selectedInterval === null;

// ── Replay signals (filtered by enabled strategies) ──
export const selectFilteredReplaySignals = createSelector(
  (s) => [
    s.coinReplaySignals[s.selectedCoin],
    s.enabledStrategies[s.selectedCoin],
  ] as const,
  (rs, enabled) => {
    const signals = rs ?? EMPTY_REPLAY;
    const strats = enabled ?? EMPTY_STRINGS;
    if (strats.length === 0) return signals;
    return signals.filter((sig) => strats.includes(sig.strategyName));
  },
);

// ── Signals (filtered by coin + enabled strategies) ──
export const selectFilteredSignals = createSelector(
  (s) => [s.signals, s.selectedCoin, s.enabledStrategies[s.selectedCoin]] as const,
  (signals, selectedCoin, enabled) => {
    if (!selectedCoin) return signals.length > 0 ? signals : EMPTY_SIGNALS;
    const strats = enabled ?? EMPTY_STRINGS;
    return signals.filter((sig) => {
      if (sig.asset !== selectedCoin) return false;
      if (!sig.strategy_name) return true;
      return strats.includes(sig.strategy_name);
    });
  },
);

// ── Coin positions ────────────────────────────
export const selectCoinPositions = createSelector(
  (s) => [s.positions, s.selectedCoin] as const,
  (positions, selectedCoin) => {
    if (!selectedCoin) return positions.length > 0 ? positions : EMPTY_POSITIONS;
    return positions.filter((p) => p.coin === selectedCoin);
  },
);

// ── Selected prices ───────────────────────────
export const selectSelectedPrices = (s: StoreState): PricesEvent | null =>
  s.coinPrices[s.selectedCoin] ?? null;

// ── Watermark ─────────────────────────────────
// Memoized so we don't create a new { asset } object on every check.
export const selectWatermark = createSelector(
  (s) => [s.selectedCoin] as const,
  (selectedCoin) => (selectedCoin ? { asset: selectedCoin } : undefined),
);

// ── Enabled strategies for selected coin ──────
// Returns store value directly — stable reference.
export const selectCurrentEnabledStrategies = (s: StoreState): string[] =>
  s.enabledStrategies[s.selectedCoin] ?? EMPTY_STRINGS;
