import { cac } from "cac";
import type { LoopConfig, LoopPhase } from "./types.js";

/**
 * Parse CLI arguments and environment variables for the orchestrator.
 */
export function parseArgs(): Partial<LoopConfig> & { initialPhase?: LoopPhase } {
  const cli = cac("breaker");
  cli.option("--asset <asset>", "Asset to optimize (e.g. BTC, ETH)");
  cli.option("--strategy <name>", "Strategy name (e.g. breakout, mean-reversion)");
  cli.option("--max-iter <n>", "Maximum optimization iterations");
  cli.option("--repo-root <path>", "Repository root path");
  cli.option("--auto-commit", "Auto-commit strategy changes after each iteration");
  cli.option("--phase <phase>", "Starting phase (refine|research|restructure)");
  cli.help();

  const { options } = cli.parse(process.argv);

  return {
    asset: options.asset || process.env.ASSET,
    strategy: options.strategy || process.env.STRATEGY || "breakout",
    maxIter: parseInt(String(options.maxIter || process.env.MAX_ITER || "10")),
    repoRoot: options.repoRoot || process.env.REPO_ROOT,
    autoCommit: Boolean(options.autoCommit) || process.env.AUTO_COMMIT === "true",
    initialPhase: (options.phase as LoopPhase) || undefined,
  };
}
