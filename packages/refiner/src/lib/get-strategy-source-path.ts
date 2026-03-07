import path from "node:path";

/**
 * Convert a camelCase factory name to a kebab-case filename.
 * Removes the "create" prefix, then converts camelCase to kebab-case.
 * e.g., "createDonchianAdx" → "donchian-adx"
 */
export function factoryToKebab(factoryName: string): string {
  let name = factoryName.replace(/^create/, "");
  name = name.replace(/([A-Z])/g, (_, ch: string) => `-${ch.toLowerCase()}`);
  if (name.startsWith("-")) name = name.slice(1);
  return name;
}

/**
 * Get the path to a strategy source file in the backtest package.
 * Uses convention: factoryName → kebab-case filename.
 * Path: packages/backtest/src/strategies/{asset}/{category}/{filename}.ts
 */
export function getStrategySourcePath(
  repoRoot: string,
  factoryName: string,
  coin: string,
  strategy: string,
): string {
  const filename = factoryToKebab(factoryName) + ".ts";
  const asset = coin.toLowerCase();
  // repoRoot is the refiner package root; go up 2 levels to monorepo root
  const monorepoRoot = path.resolve(repoRoot, "../..");
  return path.join(monorepoRoot, "packages", "backtest", "src", "strategies", asset, strategy, filename);
}
