import path from "node:path";

/**
 * Build the absolute path to a strategy directory.
 * Example: buildStrategyDir("/repo", "BTC", "breakout") -> "/repo/assets/btc/breakout"
 */
export function buildStrategyDir(repoRoot: string, asset: string, strategy: string): string {
  return path.join(repoRoot, "assets", asset.toLowerCase(), strategy);
}
