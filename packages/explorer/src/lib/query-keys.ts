export const queryKeys = {
  health: () => ["server", "health"] as const,
  config: () => ["server", "config"] as const,
  account: () => ["server", "account"] as const,
  positionHistory: () => ["server", "position-history"] as const,
  altCandles: (coin: string, interval: string) =>
    ["market", "alt-candles", coin, interval] as const,
  coinCandles: (coin: string) => ["market", "coin-candles", coin] as const,
  strategySignals: (coin: string, strategy: string) =>
    ["market", "strategy-signals", coin, strategy] as const,
} as const;
