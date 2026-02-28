import path from "node:path";

/**
 * Get the path to a strategy source file in the backtest package.
 * Maps factory name -> source file in packages/backtest/src/strategies/.
 */
export function getStrategySourcePath(repoRoot: string, factoryName: string): string {
  const nameMap: Record<string, string> = {
    createDonchianAdx: "donchian-adx.ts",
    createKeltnerRsi2: "keltner-rsi2.ts",
  };
  const filename = nameMap[factoryName];
  if (!filename) {
    throw new Error(`Unknown strategy factory: ${factoryName}`);
  }
  // repoRoot is the breaker package root; go up 2 levels to monorepo root
  const monorepoRoot = path.resolve(repoRoot, "../..");
  return path.join(monorepoRoot, "packages", "backtest", "src", "strategies", filename);
}
