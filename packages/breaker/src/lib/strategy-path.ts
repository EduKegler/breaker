import fs from "node:fs";
import path from "node:path";

/**
 * Build the absolute path to a strategy directory.
 * Example: buildStrategyDir("/repo", "BTC", "breakout") → "/repo/assets/btc/breakout"
 */
export function buildStrategyDir(repoRoot: string, asset: string, strategy: string): string {
  return path.join(repoRoot, "assets", asset.toLowerCase(), strategy);
}

/**
 * Get the path to a strategy source file in the backtest package.
 * Maps factory name → source file in packages/backtest/src/strategies/.
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

/**
 * Find the single active .pine file in a strategy directory.
 * Active = any .pine file that does NOT end with `-archived.pine`.
 * Throws if: directory doesn't exist, 0 active files, or 2+ active files.
 *
 * @deprecated Kept for backward compat during migration. New code uses getStrategySourcePath.
 */
export function findActiveStrategyFile(strategyDir: string): string {
  if (!fs.existsSync(strategyDir)) {
    throw new Error(`Strategy directory does not exist: ${strategyDir}`);
  }

  const entries = fs.readdirSync(strategyDir);
  const pineFiles = entries.filter(
    (f) => f.endsWith(".pine") && !f.endsWith("-archived.pine"),
  );

  if (pineFiles.length === 0) {
    throw new Error(`No active .pine file found in ${strategyDir}`);
  }

  if (pineFiles.length > 1) {
    throw new Error(
      `Multiple active .pine files in ${strategyDir}: ${pineFiles.join(", ")}. Archive extras with -archived.pine suffix.`,
    );
  }

  return path.join(strategyDir, pineFiles[0]);
}
