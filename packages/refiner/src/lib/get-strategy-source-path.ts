import path from "node:path";

/**
 * Get the path to a strategy source file in the backtest package.
 * Maps factory name -> source file in packages/backtest/src/strategies/{asset}/.
 */
export function getStrategySourcePath(repoRoot: string, factoryName: string): string {
  const nameMap: Record<string, { filename: string; asset: string }> = {
    createDonchianAdx: { filename: "donchian-adx.ts", asset: "btc" },
    createKeltnerRsi2: { filename: "keltner-rsi2.ts", asset: "btc" },
    createEmaPullback: { filename: "ema-pullback.ts", asset: "sol" },
  };
  const entry = nameMap[factoryName];
  if (!entry) {
    throw new Error(`Unknown strategy factory: ${factoryName}`);
  }
  // repoRoot is the breaker package root; go up 2 levels to monorepo root
  const monorepoRoot = path.resolve(repoRoot, "../..");
  return path.join(monorepoRoot, "packages", "backtest", "src", "strategies", entry.asset, entry.filename);
}
